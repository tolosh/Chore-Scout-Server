/**
 * CS-3979: the scheduled allowance-cycle job, as the jobs process runs it: the
 * scheduler lease, the job registry, AllowanceCycleService and the allowance
 * credential, against the in-memory BOB (bob-family/1 §7.5 is contract only).
 * The clock here is a test clock passed to the runner and the service; the
 * jobs process itself has no clock setting (T8).
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from 'mongodb'
import { AllowanceCycleService, CYCLES, SEND_CLAIM_MS } from '../src/allowance/cycle.js'
import { BobAllowanceExecutor } from '../src/bob/allowance.js'
import { BobHttp } from '../src/bob/http.js'
import { AllowanceCycleJob, RETRY_AFTER_MS } from '../src/jobs/allowance-job.js'
import { buildJobs } from '../src/jobs/registry.js'
import { JobRunner } from '../src/jobs/runner.js'
import { runMigrations } from '../src/migrations/index.js'
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

const K = (name: string) => name
/** A Sydney wall-clock time as an instant (UTC+11 in November and December). */
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
  bob.addCharity('cust_T_CHARITY_PAWS', 'Paws Rescue')
  logs = []
})

const log = {
  info: (o: Record<string, unknown>, msg: string) => void logs.push({ level: 'info', msg, o }),
  warn: (o: Record<string, unknown>, msg: string) => void logs.push({ level: 'warn', msg, o }),
  error: (o: Record<string, unknown>, msg: string) => void logs.push({ level: 'error', msg, o }),
}
const clock = () => new Date(t)
const job = (cred = credential, tenant = TENANT) => new AllowanceCycleJob(db, tenant, new AllowanceCycleService(db, new BobAllowanceExecutor(new BobHttp({ baseUrl: BOB_URL, timeoutMs: 1_000, fetch: bob.fetch }), cred), clock))
const runner = (holder = 'jobs:a', j = job()) => new JobRunner(db, holder, 30_000, [j], log as never, clock)
const tick = (holder = 'jobs:a', j = job()) => runner(holder, j).tick()

const api = () => buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
const SET = `mutation($c: ID!, $m: CsAllowanceMode!, $lc: CsLinkedCondition, $key: ID!, $f: ID, $v: Int) {
  setAllowance(childId: $c, mode: $m, amount: { amount: "10.00", currency: "AUD" }, cadence: WEEKLY, startDate: "${START}", timezone: "Australia/Sydney", defaultSplit: { spendPercent: 50, savePercent: 30, givePercent: 20 }, linkedCondition: $lc, expectedVersion: $v, idempotencyKey: $key, fromAccountId: $f) { version }
}`
async function setUp(child: string, mode = 'FREE', key = `job-setup-${child}`, v: number | null = null) {
  const x = api()
  const r = await x.gql(bob.signIn(SARAH), SET, { c: child, m: mode, lc: mode === 'LINKED' ? 'WEEK_CHORES_DONE' : null, key: K(key), f: v ? null : fromAcct, v })
  if (r.body.errors) throw new Error(JSON.stringify(r.body.errors))
  await x.app.close()
}

const execCalls = () => bob.calls.filter((c) => /\/service\/standing-authorities\/[^/]+\/executions$/.test(c.path))
const funding = () => bob.ledger.filter((l) => l.purpose === 'allowance_funding')
const cycleDocs = () => db.collection(CYCLES).find({}, { projection: { _id: 0 } }).sort({ periodStart: 1 }).toArray()
const authorityOf = (child: string) => [...bob.authorities.values()].find((a) => a.child === child)!

describe('T1: Leo Free; the cut-off passes on the clock: one BOB payment and auto-split, recorded with its cycle key', () => {
  it('nothing before Monday 00:00 Sydney; one execution at the cut-off; later ticks send nothing', async () => {
    await setUp(LEO)
    t = syd('2026-11-15', 23, 59) // Sunday 23:59 Sydney: the week has not ended
    expect(await tick()).toEqual({ leader: true, ran: ['allowance-cycles'], failed: [] })
    expect(execCalls()).toHaveLength(0)
    expect(await cycleDocs()).toHaveLength(0)
    t = syd(P2, 0) // Monday 00:00 Sydney
    await tick()
    expect(execCalls().map((c) => [c.key, c.body.amount_cents, c.body.cycle_ref, c.bearer])).toEqual([[`cs:${LEO}:${P1}:allowance`, 1000, P1, credential]])
    expect(funding().map((l) => l.amountCents)).toEqual([1000])
    expect(bob.ledger.filter((l) => l.purpose === 'split').map((l) => [l.amountCents, l.origin])).toEqual([
      [300, 'automatic'],
      [200, 'automatic'],
    ])
    expect(await cycleDocs()).toMatchObject([{ cycleKey: `${LEO}:${P1}`, decision: 'PAY', status: 'EXECUTED', amountCents: 1000 }])
    for (const m of [1, 30, 24 * 60]) {
      t = syd(P2, 0) + m * 60_000
      await tick()
    }
    expect(execCalls()).toHaveLength(1)
    expect(logs.some((l) => l.msg === 'allowance cycle executed' && l.o.cycleKey === `${LEO}:${P1}`)).toBe(true)
  })
})

describe('T2: two job instances at once: one payment', () => {
  it('two runners tick concurrently: one leader, one execution', async () => {
    await setUp(LEO)
    t = syd(P2, 0, 5)
    const [a, b] = await Promise.all([tick('jobs:a'), tick('jobs:b')])
    expect([a.leader, b.leader].filter(Boolean)).toHaveLength(1)
    expect(execCalls()).toHaveLength(1)
    expect(funding()).toHaveLength(1)
  })

  it('even two jobs running without the lease (a lost lease mid-run) send one instruction: the cycle is claimed before the BOB call', async () => {
    await setUp(LEO)
    t = syd(P2, 0, 5)
    const ctx = { db, fencingToken: 1, now: new Date(t), log: log as never, stillLeader: async () => true }
    await Promise.all([job().run(ctx), job().run(ctx), job().run(ctx)])
    expect(execCalls()).toHaveLength(1)
    expect(funding()).toHaveLength(1)
  })

  it('a runner that has lost the lease stops before the next cycle and sends nothing', async () => {
    await setUp(LEO)
    t = syd(P2, 0, 5)
    const j = job()
    await j.run({ db, fencingToken: 7, now: new Date(t), log: log as never, stillLeader: async () => false })
    expect(execCalls()).toHaveLength(0)
    expect(await cycleDocs()).toHaveLength(0)
    expect(j.last).toMatchObject({ stoppedNotLeader: true, considered: 0 })
  })
})

describe('T3, T10: down across due times, then restarted', () => {
  it('two missed cycles are caught up as two separate payments of the set amount; nothing before the start date', async () => {
    await setUp(LEO)
    t = syd('2026-11-30', 9) // the job was down across the P2 and P3 cut-offs (the P1 one too)
    const j = job()
    await tick('jobs:a', j)
    expect(execCalls().map((c) => [c.body.cycle_ref, c.body.amount_cents])).toEqual([
      [P1, 1000],
      [P2, 1000],
      [P3, 1000],
    ])
    expect(funding().map((l) => l.amountCents)).toEqual([1000, 1000, 1000])
    expect((await cycleDocs()).map((c) => c.periodStart)).toEqual([P1, P2, P3])
    expect((await cycleDocs()).some((c) => c.periodStart < START)).toBe(false)
    // Each missed week is logged as late (an alert on the missed runs); the latest week is on time.
    expect(logs.filter((l) => l.msg.startsWith('allowance cycle decided late')).map((l) => l.o.periodStart)).toEqual([P1, P2])
    expect(j.last).toMatchObject({ lastEndedWeek: P3, decided: 3, executed: 3, late: 2 })
    await tick('jobs:a', j)
    expect(execCalls()).toHaveLength(3)
  })

  it('a change made while the job was down applies from its own period: the earlier missed weeks are not backfilled', async () => {
    await setUp(LEO, 'EARNED')
    t = syd('2026-11-25')
    await setUp(LEO, 'FREE', 'job-mode-change', 1)
    t = syd('2026-11-30', 9)
    await tick()
    expect(execCalls().map((c) => c.body.cycle_ref)).toEqual([P3])
    expect((await cycleDocs()).map((c) => c.periodStart)).toEqual([P3])
  })
})

describe('T4: Mia Linked with chores not done: SKIP and zero BOB calls', () => {
  it('an open chore at the cut-off skips; the skip is final', async () => {
    await setUp(MIA, 'LINKED')
    t = syd('2026-11-11')
    const x = api()
    await x.gql(bob.signIn(SARAH), `mutation($c: ID!, $key: ID!) { createJob(childId: $c, kind: HOME_JOB, title: "Make the bed", idempotencyKey: $key) { jobId } }`, { c: MIA, key: K('job-mia-chore') })
    await x.app.close()
    t = syd(P2, 0, 1)
    await tick()
    t = syd(P2, 2)
    await tick()
    expect(await cycleDocs()).toMatchObject([{ cycleKey: `${MIA}:${P1}`, decision: 'SKIP', reason: 'CHORES_NOT_DONE:1/1' }])
    expect(execCalls()).toHaveLength(0)
  })

  it('D56: no chore assigned in the week pays once', async () => {
    await setUp(MIA, 'LINKED')
    t = syd(P2, 0, 1)
    await tick()
    expect(await cycleDocs()).toMatchObject([{ decision: 'PAY', reason: 'NO_CHORES_ASSIGNED', status: 'EXECUTED' }])
    expect(execCalls()).toHaveLength(1)
  })
})

describe('T5: Sarah revokes her standing authority', () => {
  it('the next due cycle is refused by BOB and recorded FAILED; no payment; not retried; not a job error', async () => {
    await setUp(LEO)
    bob.revokeAuthority(authorityOf(LEO).authorityId)
    t = syd(P2, 0, 1)
    expect(await tick()).toMatchObject({ ran: ['allowance-cycles'], failed: [] })
    expect(await cycleDocs()).toMatchObject([{ status: 'FAILED', bobReason: 'AUTHORITY_REVOKED' }])
    expect(funding()).toHaveLength(0)
    t += 2 * RETRY_AFTER_MS
    await tick()
    expect(execCalls()).toHaveLength(1)
    expect(logs.filter((l) => l.level === 'error')).toHaveLength(0)
  })
})

describe('T6: the credential can only execute a recorded allowance authority', () => {
  it('refused by BOB for another child, for another bank, and on any person or transfer route', async () => {
    await setUp(LEO)
    await setUp(MIA)
    t = syd(P2, 0, 1)
    const http = new BobHttp({ baseUrl: BOB_URL, timeoutMs: 1_000, fetch: bob.fetch })
    const exec = new BobAllowanceExecutor(http, credential)
    const leoAuth = authorityOf(LEO).authorityId
    expect(await exec.execute(leoAuth, `${MIA}:${P1}`, { childCustomerId: MIA, cycleRef: P1, amountCents: 1000 })).toMatchObject({ kind: 'refused', code: 'CHILD_NOT_COVERED' })
    const manly = new BobAllowanceExecutor(http, bob.issueAllowanceCredential('bank_manly'))
    expect(await manly.execute(leoAuth, `${LEO}:${P1}`, { childCustomerId: LEO, cycleRef: P1, amountCents: 1000 })).toMatchObject({ kind: 'refused', code: 'NOT_FOUND' })
    for (const [method, path, body] of [
      ['GET', '/api/v1/auth/session', undefined],
      ['PUT', '/api/v1/children/me/give-recipient', { charity_id: 'cust_T_CHARITY_PAWS' }],
      ['POST', `/api/v1/children/${LEO}/job-payments`, { amount_cents: 100 }], // a non-allowance transfer
      ['POST', `/api/v1/children/${LEO}/standing-authorities`, { amount_cents: 100 }], // creating its own authority
      ['PATCH', `/api/v1/standing-authorities/${encodeURIComponent(leoAuth)}`, { amount_cents: 5000 }], // raising one
      ['POST', '/api/v1/children/me/allocations', { legs: [] }],
    ] as const) {
      const r = await http.send({ method, path, auth: { serviceCredential: credential }, body, idempotencyKey: method === 'GET' ? undefined : K('cs:probe:1') })
      expect(r, `${method} ${path}`).toMatchObject({ kind: 'refused', status: 401 })
    }
    expect(bob.ledger.filter((l) => l.purpose !== 'give_unresolved')).toHaveLength(0)
  })

  it('a job configured for another bank never runs this bank’s children', async () => {
    await setUp(LEO)
    t = syd(P2, 0, 1)
    await tick('jobs:a', job(bob.issueAllowanceCredential('bank_manly'), 'bank_manly'))
    expect(execCalls()).toHaveLength(0)
    expect(await cycleDocs()).toHaveLength(0)
  })
})

describe('T7: single initiator', () => {
  it('with no job tick there is no allowance payment, however long after the cut-off', async () => {
    await setUp(LEO)
    t = syd('2026-12-31')
    expect(funding()).toHaveLength(0)
    expect(execCalls()).toHaveLength(0)
  })
})

describe('T8: real clock only', () => {
  it('the jobs process and its registry take no clock: the runner and every job use the system time', () => {
    const main = readFileSync(new URL('../src/jobs-main.ts', import.meta.url), 'utf8')
    const registry = readFileSync(new URL('../src/jobs/registry.ts', import.meta.url), 'utf8')
    // JobRunner(db, holder, ttl, jobs, log) with no sixth (clock) argument.
    expect(main).toMatch(/new JobRunner\(db, [^,]+, config\.JOB_LEASE_TTL_MS, jobs, log\)/)
    expect(registry).toMatch(/const realClock = \(\) => new Date\(\)/)
    expect(registry).not.toMatch(/process\.env/)
    const jobs = buildJobs(db, { BOB_API_URL: BOB_URL, BOB_CALL_TIMEOUT_MS: 1_000, BOB_ALLOWANCE_CREDENTIAL: credential, ALLOWANCE_TENANT_ID: TENANT }, bob.fetch)
    expect(jobs.map((j) => j.name)).toEqual(['allowance-cycles'])
  })

  it('the registered job pays on the real clock: a week that has not ended on the system clock is not paid', async () => {
    // A rule whose first week is the current real week: its cut-off is in the future on the real clock.
    const now = new Date()
    const thisWeek = (await import('../src/allowance/decide.js')).weekStartOf(now)
    await db.collection('allowance_rules').insertOne({ childCustomerId: LEO, tenantId: TENANT, startDate: thisWeek, effectiveFrom: thisWeek, timezone: 'Australia/Sydney', mode: 'FREE', amountCents: 1000, splitCents: { spend: 1000, save: 0, give: 0 }, authorityId: 'auth_x', version: 1 })
    const [j] = buildJobs(db, { BOB_API_URL: BOB_URL, BOB_CALL_TIMEOUT_MS: 1_000, BOB_ALLOWANCE_CREDENTIAL: credential, ALLOWANCE_TENANT_ID: TENANT }, bob.fetch)
    await new JobRunner(db, 'jobs:real', 30_000, [j!], log as never).tick()
    expect(execCalls()).toHaveLength(0)
    expect(await cycleDocs()).toHaveLength(0)
  })
})

describe('T9, T11: the exact amount, once per cycle (SD-7)', () => {
  it('T9: an amount different from the authority is refused by BOB, recorded FAILED with its reason, and not retried', async () => {
    await setUp(LEO)
    authorityOf(LEO).amountCents = 999
    t = syd(P2, 0, 1)
    await tick()
    expect(await cycleDocs()).toMatchObject([{ status: 'FAILED', bobReason: 'AMOUNT_NOT_AUTHORISED', amountCents: 1000 }])
    t += 2 * RETRY_AFTER_MS
    await tick()
    expect(execCalls()).toHaveLength(1)
    expect(funding()).toHaveLength(0)
  })

  it('T11: a second invocation for a paid cycle is refused by BOB (CYCLE_ALREADY_PAID), with no second payment', async () => {
    await setUp(LEO)
    t = syd(P2, 0, 1)
    await tick()
    await db.collection(CYCLES).deleteMany({}) // the server lost its record; a rotated credential is a new key scope
    t += 60_000
    await tick('jobs:a', job(bob.issueAllowanceCredential()))
    expect(await cycleDocs()).toMatchObject([{ status: 'EXECUTED', bobReason: 'CYCLE_ALREADY_PAID' }])
    expect(execCalls()).toHaveLength(2)
    expect(funding()).toHaveLength(1)
  })
})

describe('interruption and retry', () => {
  it('a lost answer stays DECIDED; it is re-sent with the same key only after the retry interval, and pays once', async () => {
    await setUp(LEO)
    t = syd(P2, 0, 1)
    bob.dropResponses = { re: /\/executions$/, count: 1 }
    await tick()
    expect(await cycleDocs()).toMatchObject([{ status: 'DECIDED', bobReason: 'UPSTREAM_UNAVAILABLE' }])
    expect(logs.some((l) => l.level === 'warn' && l.msg.startsWith('allowance payment outcome unknown'))).toBe(true)
    t += RETRY_AFTER_MS / 2
    await tick()
    expect(execCalls()).toHaveLength(1)
    t += RETRY_AFTER_MS
    await tick()
    expect(await cycleDocs()).toMatchObject([{ status: 'EXECUTED' }])
    expect(execCalls().map((c) => c.key)).toEqual([`cs:${LEO}:${P1}:allowance`, `cs:${LEO}:${P1}:allowance`])
    expect(funding()).toHaveLength(1)
  })

  it('a sender that crashed mid-call: its claim blocks a second send until it lapses, then the same key is re-sent once', async () => {
    await setUp(LEO)
    t = syd(P2, 0, 1)
    bob.dropResponses = { re: /\/executions$/, count: 1 }
    await tick()
    // Simulate the crash: the claim is still held as if the call were in flight.
    await db.collection(CYCLES).updateOne({ cycleKey: `${LEO}:${P1}` }, { $set: { claimUntil: new Date(t + SEND_CLAIM_MS + RETRY_AFTER_MS), updatedAt: new Date(t - RETRY_AFTER_MS) } })
    t += RETRY_AFTER_MS
    await tick()
    expect(execCalls()).toHaveLength(1)
    t += SEND_CLAIM_MS + RETRY_AFTER_MS
    await tick()
    expect(execCalls()).toHaveLength(2)
    expect(await cycleDocs()).toMatchObject([{ status: 'EXECUTED', claimUntil: null }])
    expect(funding()).toHaveLength(1)
  })

  it('a crash between the decision and the BOB call: the next tick sends the original key once', async () => {
    await setUp(LEO)
    t = syd(P2, 0, 1)
    bob.failBefore = { re: /\/executions$/, count: 1, status: 503, code: 'UNAVAILABLE' }
    await tick()
    expect(funding()).toHaveLength(0)
    t += RETRY_AFTER_MS
    await tick()
    expect(funding()).toHaveLength(1)
    expect(new Set(execCalls().map((c) => c.key))).toEqual(new Set([`cs:${LEO}:${P1}:allowance`]))
  })
})
