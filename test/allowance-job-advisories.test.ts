/**
 * CS-3979: review 40045 advisories A1, A2 and A4, and the alert markers asked for
 * in review 40015 (optional 2 and 3) and review 40503 item 6. In-memory BOB and
 * MongoDB, as in allowance-job.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from 'mongodb'
import { AllowanceCycleService, CYCLES, MAX_MISMATCH_ATTEMPTS, type AllowanceCycleDoc } from '../src/allowance/cycle.js'
import { BobAllowanceExecutor } from '../src/bob/allowance.js'
import { BobHttp } from '../src/bob/http.js'
import { ALERT, ALLOWANCE_TICK_EVENT } from '../src/jobs/alerts.js'
import { AllowanceCycleJob, RETRY_AFTER_MS } from '../src/jobs/allowance-job.js'
import { JobRunner, schedulerLeaseFor } from '../src/jobs/runner.js'
import { CYCLE_CHILD_STATUS_INDEX } from '../src/migrations/002-cycle-child-status.js'
import { MIGRATIONS, runMigrations } from '../src/migrations/index.js'
import { FakeBob } from './fakes/bob.js'
import { BOB_URL, buildTestApi } from './helpers/api.js'
import { LEO, MIA, SARAH, seedFamily } from './helpers/family.js'
import { startMongo, type TestMongo } from './helpers/mongo.js'

let mongo: TestMongo
let db: Db
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})

const syd = (d: string, hh = 12, mm = 0) => Date.parse(`${d}T00:00:00Z`) + (hh - 11) * 3_600_000 + mm * 60_000
const START = '2026-11-09'
const P1 = START
const P2 = '2026-11-16'
const P3 = '2026-11-23'
const TENANT = 'bank_bilgola'

let bob: FakeBob
let t: number
let credential: string
let fromAcct: string
let logs: { level: string; msg: string; o: Record<string, unknown> }[]
beforeEach(async () => {
  db = mongo.db()
  await runMigrations(db, { holder: 'test' })
  t = syd('2026-11-05')
  bob = new FakeBob()
  bob.clock = () => new Date(t)
  ;({ funding: fromAcct } = seedFamily(bob))
  credential = bob.issueAllowanceCredential()
  logs = []
})

const log = {
  info: (o: Record<string, unknown>, msg: string) => void logs.push({ level: 'info', msg, o }),
  warn: (o: Record<string, unknown>, msg: string) => void logs.push({ level: 'warn', msg, o }),
  error: (o: Record<string, unknown>, msg: string) => void logs.push({ level: 'error', msg, o }),
}
const clock = () => new Date(t)
const service = () => new AllowanceCycleService(db, new BobAllowanceExecutor(new BobHttp({ baseUrl: BOB_URL, timeoutMs: 1_000, fetch: bob.fetch }), credential), clock)
const tick = () => new JobRunner(db, schedulerLeaseFor(TENANT), 'jobs:a', 30_000, [new AllowanceCycleJob(db, TENANT, service())], log as never, clock).tick()
const api = () => buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })

const SET = `mutation($c: ID!, $m: CsAllowanceMode!, $lc: CsLinkedCondition, $a: String!, $key: ID!, $f: ID, $v: Int) {
  setAllowance(childId: $c, mode: $m, amount: { amount: $a, currency: "AUD" }, cadence: WEEKLY, startDate: "${START}", timezone: "Australia/Sydney", defaultSplit: { spendPercent: 50, savePercent: 30, givePercent: 20 }, linkedCondition: $lc, expectedVersion: $v, idempotencyKey: $key, fromAccountId: $f) { version amount { amount } }
}`
type SetBody = { data?: { setAllowance: { version: number; amount: { amount: string } } } | null; errors?: { message: string; extensions?: { code?: string } }[] }
async function setAllowance(child: string, o: { mode?: string; amount?: string; key: string; v?: number }): Promise<SetBody> {
  const x = api()
  const mode = o.mode ?? 'FREE'
  const r = await x.gql(bob.signIn(SARAH), SET, { c: child, m: mode, lc: mode === 'LINKED' ? 'WEEK_CHORES_DONE' : null, a: o.amount ?? '10.00', key: o.key, f: o.v ? null : fromAcct, v: o.v ?? null })
  await x.app.close()
  return r.body as SetBody
}
async function setUp(child: string, mode = 'FREE') {
  const r = await setAllowance(child, { mode, key: `adv-setup-${child}` })
  if (r.errors) throw new Error(JSON.stringify(r.errors))
}
const codeOf = (b: SetBody) => b.errors?.[0]?.extensions?.code
const execCalls = () => bob.calls.filter((c) => /\/service\/standing-authorities\/[^/]+\/executions$/.test(c.path))
const cycleOf = (child: string, p: string) => db.collection<AllowanceCycleDoc>(CYCLES).findOne({ cycleKey: `${child}:${p}` }, { projection: { _id: 0 } })
const alerts = (name: string) => logs.filter((l) => l.o.alert === name)

describe('review 40045 A1: the mismatch hold is set from the stored count, not a stale copy', () => {
  it('a sender holding a copy read before two other mismatches were recorded still sets the hold at the third', async () => {
    await setUp(LEO)
    bob.mutateFamily = (d) => {
      if ('execution_id' in d) d.amount_cents = 1100 // every answer disagrees with what was asked
    }
    t = syd(P2, 0, 1)
    await tick()
    // The copy a deposed sender read after the decision, before any mismatch was recorded.
    const stale = (await cycleOf(LEO, P1))!
    expect(stale).toMatchObject({ mismatches: 1 })
    const beforeAny = { ...stale, mismatches: 0 }
    t += RETRY_AFTER_MS
    await tick()
    expect(await cycleOf(LEO, P1)).toMatchObject({ mismatches: 2, operatorHold: null })
    // That sender now claims and sends with its old copy (claim free, retry interval passed).
    t += RETRY_AFTER_MS
    const svc = service() as unknown as { execute(c: AllowanceCycleDoc, correlation: string): Promise<AllowanceCycleDoc> }
    const after = await svc.execute(beforeAny, 'probe:a1')
    expect(after).toMatchObject({ status: 'DECIDED', mismatches: MAX_MISMATCH_ATTEMPTS, operatorHold: 'UPSTREAM_MISMATCH', claimUntil: null })
    expect(await db.collection('audit').countDocuments({ action: 'allowance.cycle_operator_hold', subject: `${LEO}:${P1}` })).toBe(1)
    // Held: nothing sends again.
    t += 5 * RETRY_AFTER_MS
    await tick()
    expect(execCalls()).toHaveLength(MAX_MISMATCH_ATTEMPTS)
  })
})

describe('review 40045 A2: a Linked SKIP week stays DECIDED and never blocks an allowance change', () => {
  it('Mia’s skipped week is DECIDED/SKIP, and Sarah can still change her amount', async () => {
    await setUp(MIA, 'LINKED')
    t = syd('2026-11-11')
    const x = api()
    await x.gql(bob.signIn(SARAH), `mutation($c: ID!, $key: ID!) { createJob(childId: $c, kind: HOME_JOB, title: "Make the bed", idempotencyKey: $key) { jobId } }`, { c: MIA, key: 'adv-a2-chore' })
    await x.app.close()
    t = syd(P2, 0, 1)
    await tick()
    expect(await cycleOf(MIA, P1)).toMatchObject({ decision: 'SKIP', status: 'DECIDED', reason: 'CHORES_NOT_DONE:1/1' })
    const r = await setAllowance(MIA, { mode: 'LINKED', amount: '12.00', key: 'adv-a2-change', v: 1 })
    expect(r.errors).toBeUndefined()
    expect(r.data!.setAllowance).toMatchObject({ version: 2, amount: { amount: '12.00' } })
  })
})

describe('review 40045 A4: the unsettled-payment check is bounded by unsettled cycles, not weeks', () => {
  it('migration 002 adds the child_decision_status index, additively and idempotently', async () => {
    expect(MIGRATIONS.map((m) => m.id)).toEqual(['001-initial-collections', '002-cycle-child-status'])
    const idx = (await db.collection(CYCLES).indexes()).find((i) => i.name === CYCLE_CHILD_STATUS_INDEX.name)
    expect(idx?.key).toEqual({ childCustomerId: 1, decision: 1, status: 1 })
    expect(idx?.unique).toBeFalsy()
    expect(await runMigrations(db, { holder: 'again' })).toEqual([])
  })

  it('the check reads that index, and only the changing child’s unsettled PAY cycles block a change', async () => {
    await setUp(LEO)
    await setUp(MIA)
    const doc = (child: string, p: string, decision: 'PAY' | 'SKIP', status: 'DECIDED' | 'EXECUTED') => ({ cycleKey: `${child}:${p}`, childCustomerId: child, tenantId: TENANT, periodStart: p, decision, status, reason: null, ruleVersion: 1, amountCents: 1000, splitCents: { spend: 500, save: 300, give: 200 }, authorityId: 'sta_x', bobReason: 'UPSTREAM_UNAVAILABLE', bobOperationRef: null, attempts: 1, decidedAt: new Date(t), updatedAt: new Date(t) })
    // Mia has an unsettled payment; Leo has only settled ones.
    await db.collection(CYCLES).insertMany([doc(MIA, P1, 'PAY', 'DECIDED'), doc(LEO, P1, 'PAY', 'EXECUTED'), doc(LEO, P2, 'SKIP', 'DECIDED')])
    t = syd(P3, 9)
    const plan = JSON.stringify(await db.collection(CYCLES).find({ childCustomerId: LEO, decision: 'PAY', status: 'DECIDED' }).sort({ periodStart: 1 }).explain())
    expect(plan).toContain(CYCLE_CHILD_STATUS_INDEX.name)
    expect(codeOf(await setAllowance(LEO, { amount: '15.00', key: 'adv-a4-leo', v: 1 }))).toBeUndefined()
    const mia = await setAllowance(MIA, { amount: '15.00', key: 'adv-a4-mia', v: 1 })
    expect(codeOf(mia)).toBe('NOT_ALLOWED_IN_STATE')
    expect(mia.errors![0]!.message).toMatch(/week starting 2026-11-09 is still being paid/)
  })

  it('an unsettled cycle two years back still blocks the change', async () => {
    await setUp(LEO)
    await db.collection(CYCLES).insertOne({ cycleKey: `${LEO}:${P1}`, childCustomerId: LEO, tenantId: TENANT, periodStart: P1, decision: 'PAY', status: 'DECIDED', operatorHold: 'UPSTREAM_MISMATCH', amountCents: 1000 })
    t = syd('2028-11-20', 9)
    const r = await setAllowance(LEO, { amount: '15.00', key: 'adv-a4-old', v: 1 })
    expect(codeOf(r)).toBe('NOT_ALLOWED_IN_STATE')
    expect(r.errors![0]!.message).toMatch(/being checked by support/)
  })
})

describe('alerts: stable markers a log metric filter can count', () => {
  it('every tick of the leader emits the heartbeat, with its bank', async () => {
    await setUp(LEO)
    t = syd(P2, 0, 1)
    await tick()
    expect(logs.filter((l) => l.o.event === ALLOWANCE_TICK_EVENT).map((l) => [l.level, l.o.tenantId])).toEqual([['info', TENANT]])
  })

  it('a missed run is alerted once per late cycle', async () => {
    await setUp(LEO)
    t = syd(P3, 9) // down across P1’s and P2’s cut-offs
    await tick()
    expect(alerts(ALERT.MISSED_RUN).map((l) => [l.level, l.o.cycleKey, l.o.tenantId])).toEqual([['warn', `${LEO}:${P1}`, TENANT]])
  })

  it('a FAILED other than AUTHORITY_REVOKED is alerted; a revoked authority is not', async () => {
    await setUp(LEO)
    await setUp(MIA)
    bob.revokeAuthority([...bob.authorities.values()].find((a) => a.child === MIA)!.authorityId)
    bob.failBefore = { re: /\/executions$/, count: 1, status: 422, code: 'INSUFFICIENT_FUNDS' }
    t = syd(P2, 0, 1)
    await tick()
    const failed = (await db.collection<AllowanceCycleDoc>(CYCLES).find({}, { projection: { _id: 0, cycleKey: 1, status: 1, bobReason: 1 } }).sort({ cycleKey: 1 }).toArray()).map((c) => [c.cycleKey, c.status, c.bobReason])
    expect(failed).toEqual([
      [`${LEO}:${P1}`, 'FAILED', 'INSUFFICIENT_FUNDS'],
      [`${MIA}:${P1}`, 'FAILED', 'AUTHORITY_REVOKED'],
    ])
    expect(alerts(ALERT.UNEXPECTED_FAILED).map((l) => [l.level, l.o.cycleKey, l.o.bobReason])).toEqual([['warn', `${LEO}:${P1}`, 'INSUFFICIENT_FUNDS']])
  })

  it('an operator hold is alerted once, at error level', async () => {
    await setUp(LEO)
    bob.mutateFamily = (d) => {
      if ('execution_id' in d) d.amount_cents = 1100
    }
    t = syd(P2, 0, 1)
    for (let i = 0; i < MAX_MISMATCH_ATTEMPTS + 2; i++) {
      await tick()
      t += RETRY_AFTER_MS
    }
    expect(alerts(ALERT.OPERATOR_HOLD).map((l) => [l.level, l.o.cycleKey])).toEqual([['error', `${LEO}:${P1}`]])
  })

  it('a leader that loses its lease mid-tick is alerted and stops', async () => {
    await setUp(LEO)
    t = syd(P2, 0, 1)
    const j = new AllowanceCycleJob(db, TENANT, service())
    await j.run({ db, fencingToken: 3, now: new Date(t), log: log as never, stillLeader: async () => false })
    expect(alerts(ALERT.LEASE_LOST).map((l) => [l.level, l.o.tenantId])).toEqual([['warn', TENANT]])
    expect(execCalls()).toHaveLength(0)
  })

  it('a job that throws out of its run is alerted by the runner with its lease', async () => {
    const res = await new JobRunner(db, schedulerLeaseFor(TENANT), 'jobs:a', 30_000, [{ name: 'boom', run: () => Promise.reject(new Error('x')) }], log as never, clock).tick()
    expect(res.failed).toEqual(['boom'])
    expect(alerts(ALERT.JOB_FAILED).map((l) => [l.level, l.o.job, l.o.lease])).toEqual([['error', 'boom', schedulerLeaseFor(TENANT)]])
  })
})
