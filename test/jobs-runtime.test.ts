/**
 * CS-3979 / CS-3992 jobs runtime: audited hold recovery (review 40045 A3), the
 * jobs liveness heartbeat and health check, and the monitoring spec's coverage
 * of every alert marker. In-memory BOB and MongoDB.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from 'mongodb'
import { AllowanceCycleService, answerMatches, CYCLES, MAX_MISMATCH_ATTEMPTS, type AllowanceCycleDoc } from '../src/allowance/cycle.js'
import type { Execution } from '../src/bob/allowance.js'
import { BobAllowanceExecutor } from '../src/bob/allowance.js'
import { BobHttp } from '../src/bob/http.js'
import { ALERT, ALLOWANCE_TICK_EVENT } from '../src/jobs/alerts.js'
import { AllowanceCycleJob, RETRY_AFTER_MS } from '../src/jobs/allowance-job.js'
import { heartbeatFresh, touchHeartbeat } from '../src/jobs/heartbeat.js'
import { exitCodeOf, parseRecoverArgs, recoverCycle, type RecoverArgs } from '../src/jobs/recover.js'
import { JobRunner, schedulerLeaseFor } from '../src/jobs/runner.js'
import { runMigrations } from '../src/migrations/index.js'
import { FakeBob } from './fakes/bob.js'
import { BOB_URL, buildTestApi } from './helpers/api.js'
import { LEO, SARAH, seedFamily } from './helpers/family.js'
import { startMongo, type TestMongo } from './helpers/mongo.js'
import { run } from './helpers/run.js'

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
const TENANT = 'bank_bilgola'
const KEY = `${LEO}:${P1}`

let bob: FakeBob
let t: number
let credential: string
let fromAcct: string
beforeEach(async () => {
  db = mongo.db()
  await runMigrations(db, { holder: 'test' })
  t = syd('2026-11-05')
  bob = new FakeBob()
  bob.clock = () => new Date(t)
  ;({ funding: fromAcct } = seedFamily(bob))
  credential = bob.issueAllowanceCredential()
})
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }
const clock = () => new Date(t)
const service = () => new AllowanceCycleService(db, new BobAllowanceExecutor(new BobHttp({ baseUrl: BOB_URL, timeoutMs: 1_000, fetch: bob.fetch }), credential), clock)
const tick = () => new JobRunner(db, schedulerLeaseFor(TENANT), 'jobs:a', 30_000, [new AllowanceCycleJob(db, TENANT, service())], silent as never, clock).tick()
const execCalls = () => bob.calls.filter((c) => /\/service\/standing-authorities\/[^/]+\/executions$/.test(c.path))
const funding = () => bob.ledger.filter((l) => l.purpose === 'allowance_funding')
const cycle = () => db.collection<AllowanceCycleDoc>(CYCLES).findOne({ cycleKey: KEY }, { projection: { _id: 0 } })
const actions = async () => (await db.collection('audit').find({ subject: KEY }, { projection: { _id: 0, action: 1, actor: 1 } }).sort({ at: 1 }).toArray()).map((a) => a.action)

async function setUpLeo() {
  const x = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
  const r = await x.gql(
    bob.signIn(SARAH),
    `mutation($c: ID!, $key: ID!, $f: ID) { setAllowance(childId: $c, mode: FREE, amount: { amount: "10.00", currency: "AUD" }, cadence: WEEKLY, startDate: "${START}", timezone: "Australia/Sydney", defaultSplit: { spendPercent: 50, savePercent: 30, givePercent: 20 }, idempotencyKey: $key, fromAccountId: $f) { version } }`,
    { c: LEO, key: 'rt-setup', f: fromAcct },
  )
  await x.app.close()
  if (r.body.errors) throw new Error(JSON.stringify(r.body.errors))
}
async function changeLeo(amount: string, key: string) {
  const x = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
  const r = await x.gql(
    bob.signIn(SARAH),
    `mutation($c: ID!, $key: ID!) { setAllowance(childId: $c, mode: FREE, amount: { amount: "${amount}", currency: "AUD" }, cadence: WEEKLY, startDate: "${START}", timezone: "Australia/Sydney", defaultSplit: { spendPercent: 50, savePercent: 30, givePercent: 20 }, expectedVersion: 1, idempotencyKey: $key) { version } }`,
    { c: LEO, key },
  )
  await x.app.close()
  return r.body as { data?: unknown; errors?: { extensions?: { code?: string } }[] }
}
/** Leo's P1 held after MAX_MISMATCH_ATTEMPTS mismatched answers. BOB paid once; the replays moved nothing. */
async function holdP1() {
  await setUpLeo()
  bob.mutateFamily = (d) => {
    if ('execution_id' in d) d.amount_cents = 1100
  }
  t = syd(P2, 0, 1)
  for (let i = 0; i < MAX_MISMATCH_ATTEMPTS; i++) {
    await tick()
    t += RETRY_AFTER_MS
  }
  expect(await cycle()).toMatchObject({ status: 'DECIDED', operatorHold: 'UPSTREAM_MISMATCH' })
  expect(execCalls()).toHaveLength(MAX_MISMATCH_ATTEMPTS)
}
const args = (o: Partial<RecoverArgs> = {}): RecoverArgs => ({ cycleKey: KEY, operator: 'colin', reason: 'BOB confirmed the split fix; recheck', recheck: true, ...o })
const recover = (o: Partial<RecoverArgs> = {}, tenant = TENANT) => recoverCycle(db, tenant, service(), args(o), 'recover:test')

describe('jobs-recover arguments', () => {
  it('needs a cycle key, an operator and a real reason; refuses unknown options', () => {
    expect(parseRecoverArgs(['--cycle', KEY, '--operator', 'colin', '--reason', 'checked with BOB support'])).toEqual({ cycleKey: KEY, operator: 'colin', reason: 'checked with BOB support', recheck: false })
    expect(parseRecoverArgs(['--cycle', KEY, '--operator', 'colin', '--reason', 'checked with BOB support', '--recheck'])).toMatchObject({ recheck: true })
    expect(parseRecoverArgs(['--operator', 'colin', '--reason', 'checked with BOB support'])).toMatch(/--cycle/)
    expect(parseRecoverArgs(['--cycle', 'not-a-key', '--operator', 'colin', '--reason', 'checked with BOB support'])).toMatch(/--cycle/)
    expect(parseRecoverArgs(['--cycle', KEY, '--reason', 'checked with BOB support'])).toMatch(/--operator/)
    expect(parseRecoverArgs(['--cycle', KEY, '--operator', 'colin', '--reason', 'short'])).toMatch(/--reason/)
    // No way to clear a hold, set an amount or pick a key.
    for (const flag of ['--clear', '--force', '--amount', '--key', '--new-key'])
      expect(parseRecoverArgs(['--cycle', KEY, '--operator', 'colin', '--reason', 'checked with BOB support', flag, 'x'])).toMatch(/unknown option/)
  })
})

describe('review 40045 A3: audited recovery of a held cycle, original key only', () => {
  it('diagnose (no --recheck) reads the record and its audit trail and calls nothing', async () => {
    await holdP1()
    const before = bob.calls.length
    const r = await recover({ recheck: false })
    expect(r.kind).toBe('DIAGNOSED')
    if (r.kind !== 'DIAGNOSED') return
    expect(r.cycle).toMatchObject({ cycleKey: KEY, status: 'DECIDED', operatorHold: 'UPSTREAM_MISMATCH', mismatches: MAX_MISMATCH_ATTEMPTS, amountCents: 1000 })
    expect(r.audit.map((a) => a.action)).toContain('allowance.cycle_operator_hold')
    expect(bob.calls.length).toBe(before)
    expect(exitCodeOf(r)).toBe(0)
  })

  it('BOB now answers as asked: the recheck re-sends the original key and amount once, records EXECUTED, clears the hold, and Sarah can change the allowance', async () => {
    await holdP1()
    bob.mutateFamily = null // e.g. BOB fixed what made its answer disagree
    expect((await changeLeo('15.00', 'rt-blocked')).errors?.[0]?.extensions?.code).toBe('NOT_ALLOWED_IN_STATE')
    const r = await recover()
    expect(r).toMatchObject({ kind: 'RECHECKED', outcome: 'RESOLVED_EXECUTED', cycle: { status: 'EXECUTED', operatorHold: null } })
    expect(exitCodeOf(r)).toBe(0)
    const sent = execCalls()
    expect(sent).toHaveLength(MAX_MISMATCH_ATTEMPTS + 1)
    expect(new Set(sent.map((c) => c.key))).toEqual(new Set([`cs:${KEY}:allowance`]))
    expect(new Set(sent.map((c) => c.body.amount_cents))).toEqual(new Set([1000]))
    expect(funding()).toHaveLength(1) // still one payment: the recheck is a replay
    expect(await actions()).toEqual(expect.arrayContaining(['allowance.cycle_hold_recheck', 'allowance.cycle_hold_resolved']))
    const resolved = await db.collection('audit').findOne({ subject: KEY, action: 'allowance.cycle_hold_resolved' })
    expect(resolved).toMatchObject({ actor: 'operator:colin', before: { operator: 'colin', reason: 'BOB confirmed the split fix; recheck', hold: 'UPSTREAM_MISMATCH' } })
    expect((await changeLeo('15.00', 'rt-after')).errors).toBeUndefined()
    // The job never re-sends it afterwards.
    t += 10 * RETRY_AFTER_MS
    await tick()
    expect(execCalls()).toHaveLength(MAX_MISMATCH_ATTEMPTS + 1)
  })

  it('BOB still answers with something else: the hold is kept, audited with what came back, exit 2', async () => {
    await holdP1()
    const r = await recover()
    expect(r).toMatchObject({ kind: 'RECHECKED', outcome: 'STILL_MISMATCHED', cycle: { status: 'DECIDED', operatorHold: 'UPSTREAM_MISMATCH' } })
    expect(exitCodeOf(r)).toBe(2)
    expect(await actions()).toEqual(expect.arrayContaining(['allowance.cycle_hold_recheck_mismatch', 'allowance.cycle_hold_kept']))
    expect(funding()).toHaveLength(1)
  })

  it('BOB unavailable: the hold is kept and nothing is assumed, exit 2', async () => {
    await holdP1()
    bob.failBefore = { re: /\/executions$/, count: 1, status: 503, code: 'UNAVAILABLE' }
    const r = await recover()
    expect(r).toMatchObject({ outcome: 'STILL_UNKNOWN', cycle: { status: 'DECIDED', operatorHold: 'UPSTREAM_MISMATCH', bobReason: 'UPSTREAM_UNAVAILABLE' } })
    expect(exitCodeOf(r)).toBe(2)
  })

  it('BOB refuses with a final code: FAILED with BOB’s reason, the hold cleared, no payment', async () => {
    await holdP1()
    bob.failBefore = { re: /\/executions$/, count: 1, status: 409, code: 'AUTHORITY_REVOKED' }
    const r = await recover()
    expect(r).toMatchObject({ outcome: 'RESOLVED_FAILED', cycle: { status: 'FAILED', bobReason: 'AUTHORITY_REVOKED', operatorHold: null } })
    expect(funding()).toHaveLength(1)
  })

  it('refuses a cycle that is not held, another bank’s cycle, an unknown cycle, and a cycle another sender has claimed', async () => {
    await setUpLeo()
    t = syd(P2, 0, 1)
    await tick() // P1 paid normally
    expect(await recover()).toMatchObject({ kind: 'REFUSED', message: expect.stringMatching(/is not held/) })
    expect(await recover({}, 'bank_manly')).toMatchObject({ kind: 'REFUSED', message: expect.stringMatching(/another bank/) })
    expect(await recover({ cycleKey: `${LEO}:2026-11-30` })).toMatchObject({ kind: 'REFUSED', message: expect.stringMatching(/no allowance cycle/) })
    // A held cycle whose claim is live (a sender mid-call) is left alone.
    await db.collection(CYCLES).updateOne({ cycleKey: KEY }, { $set: { status: 'DECIDED', operatorHold: 'UPSTREAM_MISMATCH', claimUntil: new Date(t + 60_000) } })
    const before = execCalls().length
    const busy = await recover()
    expect(busy).toMatchObject({ kind: 'RECHECKED', outcome: 'BUSY' })
    expect(exitCodeOf(busy)).toBe(2)
    expect(execCalls()).toHaveLength(before)
  })
})

describe('jobs liveness (container health check)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cs-hb-'))
  })
  afterAll(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it('fresh after a touch, stale after the allowed age, and missing is not fresh', () => {
    const f = join(dir, 'hb')
    expect(heartbeatFresh(60_000, f)).toBe(false)
    touchHeartbeat(f)
    expect(heartbeatFresh(60_000, f)).toBe(true)
    const old = new Date(Date.now() - 120_000)
    utimesSync(f, old, old)
    expect(heartbeatFresh(60_000, f)).toBe(false)
  })

  it('jobs-main touches the heartbeat after every tick, leader or not', () => {
    const main = readFileSync('src/jobs-main.ts', 'utf8')
    expect(main.indexOf('touchHeartbeat()')).toBeGreaterThan(main.indexOf('await runner.tick()'))
    expect(main.indexOf('touchHeartbeat()')).toBeLessThan(main.indexOf('JOB_TICK_INTERVAL_MS))'))
  })

  it('node dist/jobs-healthcheck.js exits 0 on a fresh heartbeat and 1 on a stale one', async () => {
    const tsx = resolve('node_modules/.bin/tsx')
    writeFileSync('/tmp/chore-scout-jobs.heartbeat', new Date().toISOString())
    expect((await run(tsx, [resolve('src/jobs-healthcheck.ts')], { PATH: process.env.PATH ?? '' })).status).toBe(0)
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync('/tmp/chore-scout-jobs.heartbeat', old, old)
    expect((await run(tsx, [resolve('src/jobs-healthcheck.ts')], { PATH: process.env.PATH ?? '' })).status).toBe(1)
    rmSync('/tmp/chore-scout-jobs.heartbeat', { force: true })
  })
})

describe('monitoring spec (infra/monitoring/jobs-monitoring.json)', () => {
  const spec = JSON.parse(readFileSync('infra/monitoring/jobs-monitoring.json', 'utf8')) as {
    logGroup: string
    filters: { metric: string; field: string; value: string }[]
    alarms: { name: string; metric: string; runningOnly?: boolean; treatMissingData: string }[]
  }

  it('has a filter for the heartbeat and every alert marker the code emits, on the jobs log group', () => {
    expect(spec.logGroup).toBe('/ecs/chore-scout-server')
    expect(spec.filters.map((f) => f.value).sort()).toEqual([ALLOWANCE_TICK_EVENT, ...Object.values(ALERT)].sort())
    expect(spec.filters.find((f) => f.value === ALLOWANCE_TICK_EVENT)?.field).toBe('event')
  })

  it('alarms on every marker except the informational recheck, and on a missing heartbeat only once jobs run', () => {
    const alarmed = new Set(spec.alarms.map((a) => a.metric))
    for (const f of spec.filters) if (f.value !== ALERT.HOLD_RECHECKED) expect(alarmed.has(f.metric), f.metric).toBe(true)
    const hb = spec.alarms.filter((a) => a.metric === 'AllowanceTick')
    expect(hb).toHaveLength(1)
    expect(hb[0]).toMatchObject({ runningOnly: true, treatMissingData: 'breaching' })
  })

  it('jobs-alarms.sh: a dry run prints the per-bank commands, calls no aws, and skips the heartbeat alarm unless asked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-alarms-'))
    const env = { PATH: `${resolve('test/fixtures/deploy-stubs')}:${process.env.PATH ?? ''}`, STUB_DIR: dir }
    const topic = 'arn:aws:sns:ap-southeast-2:932027117528:chore-scout-jobs-alarms'
    const r = await run('bash', [resolve('scripts/jobs-alarms.sh'), 'bank_manly', topic], env)
    expect(r.status).toBe(0)
    expect(existsSync(join(dir, 'calls.log'))).toBe(false)
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('DRY RUN: '))
    expect(lines.filter((l) => l.includes('put-metric-filter'))).toHaveLength(spec.filters.length)
    expect(lines.filter((l) => l.includes('put-metric-alarm'))).toHaveLength(spec.alarms.length - 1)
    expect(lines.every((l) => l.includes('bank_manly') && !l.includes('bank_bilgola'))).toBe(true)
    expect(r.stdout).toContain('skipped alarm no-heartbeat')
    const withHb = await run('bash', [resolve('scripts/jobs-alarms.sh'), 'bank_manly', topic, '--with-heartbeat'], env)
    expect(withHb.stdout.split('\n').filter((l) => l.includes('put-metric-alarm'))).toHaveLength(spec.alarms.length)
    for (const bad of [['bank_x', topic], ['bank_manly', 'not-an-arn'], ['bank_manly', topic, '--yes']]) {
      const b = await run('bash', [resolve('scripts/jobs-alarms.sh'), ...bad], env)
      expect(b.status, bad.join(' ')).not.toBe(0)
    }
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('answerMatches: BOB 204ceaa wire shapes for the Give leg (found in the isolated integration)', () => {
  const c = { childCustomerId: LEO, periodStart: P1, amountCents: 1000, splitCents: { spend: 500, save: 300, give: 200 } } as AllowanceCycleDoc
  const fundingLeg = { purpose: 'allowance_funding', origin: null, amountCents: 1000 }
  const saveLeg = { purpose: 'split', origin: 'automatic', amountCents: 300 }
  const e = (giveLeg: { purpose: string; origin: string | null; amountCents: number } | null, give: Execution['giveOutcome'], extra: Execution['legs'] = []): Execution => ({
    executionId: 'exe_1', authorityVersion: 1, childCustomerId: LEO, cycleRef: P1, instructionRef: `cyc_${LEO}:${P1}`, amountCents: 1000,
    legs: [fundingLeg, saveLeg, ...(giveLeg ? [giveLeg] : []), ...extra], giveOutcome: give,
  })
  const held = { status: 'held' as const, amountCents: 200, recipient: null }
  const donated = { status: 'donated' as const, amountCents: 200, recipient: { charityId: 'cust_c', revision: 3 } }

  it.each([
    ['held Give: leg give_unresolved (real BOB, no confirmed charity)', e({ purpose: 'give_unresolved', origin: 'automatic', amountCents: 200 }, held), true],
    ['donated Give: leg split', e({ purpose: 'split', origin: 'automatic', amountCents: 200 }, donated), true],
    ['held outcome but the leg says split', e({ purpose: 'split', origin: 'automatic', amountCents: 200 }, held), false],
    ['donated outcome but the leg says give_unresolved', e({ purpose: 'give_unresolved', origin: 'automatic', amountCents: 200 }, donated), false],
    ['no Give leg', e(null, held), false],
    ['no give_outcome', e({ purpose: 'give_unresolved', origin: 'automatic', amountCents: 200 }, null), false],
    ['a Give leg of another amount', e({ purpose: 'give_unresolved', origin: 'automatic', amountCents: 250 }, { ...held, amountCents: 250 }), false],
    ['a child-origin leg', e({ purpose: 'give_unresolved', origin: 'child', amountCents: 200 }, held), false],
    ['an extra leg', e({ purpose: 'give_unresolved', origin: 'automatic', amountCents: 200 }, held, [{ purpose: 'split', origin: 'automatic', amountCents: 1 }]), false],
  ])('%s -> %s', (_l, ex, want) => {
    expect(answerMatches(c, ex)).toBe(want)
  })
})
