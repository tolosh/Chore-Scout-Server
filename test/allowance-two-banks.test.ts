/**
 * CS-3979, review 40503 item 1: one scheduler lease per bank.
 *
 * Bank of Bilgola's and Bank of Manly's allowance runners share one database
 * (the API's rule records) but each holds only its own bank's credential and
 * its own bank's lease, `scheduler:allowance:<tenantId>`. These tests run both
 * banks' runners against the in-memory BOB and show: both pay concurrently, a
 * renewing leader in one bank never starves the other, failover is per bank,
 * and neither runner touches the other bank's children, credential or lease.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from 'mongodb'
import { AllowanceCycleService, CYCLES } from '../src/allowance/cycle.js'
import { BobAllowanceExecutor } from '../src/bob/allowance.js'
import { BobHttp } from '../src/bob/http.js'
import { AllowanceCycleJob } from '../src/jobs/allowance-job.js'
import { JobRunner, SCHEDULER_LEASE_PREFIX, schedulerLeaseFor } from '../src/jobs/runner.js'
import { LEASES_COLLECTION, LeaseLock } from '../src/lease.js'
import { runMigrations } from '../src/migrations/index.js'
import { FakeBob } from './fakes/bob.js'
import { BOB_URL, buildTestApi } from './helpers/api.js'
import { LEO, SARAH, seedFamily } from './helpers/family.js'
import { startMongo, type TestMongo } from './helpers/mongo.js'

let mongo: TestMongo
let db: Db
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})

/** A Sydney wall-clock time as an instant (UTC+11 in November). */
const syd = (d: string, hh = 12, mm = 0, ss = 0) => Date.parse(`${d}T00:00:00Z`) + (hh - 11) * 3_600_000 + mm * 60_000 + ss * 1_000
const START = '2026-11-09'
const P1 = START
const P2 = '2026-11-16'
const BILGOLA = 'bank_bilgola'
const MANLY = 'bank_manly'
const M_GUARDIAN = 'cust_T_MANLY_GUARDIAN'
const M_KID = 'cust_T_MANLY_KID'
const TTL = 30_000

let bob: FakeBob
let t: number
const cred: Record<string, string> = {}
const funding: Record<string, string> = {}
const logs: { level: string; msg: string; o: Record<string, unknown> }[] = []
const log = {
  info: (o: Record<string, unknown>, msg: string) => void logs.push({ level: 'info', msg, o }),
  warn: (o: Record<string, unknown>, msg: string) => void logs.push({ level: 'warn', msg, o }),
  error: (o: Record<string, unknown>, msg: string) => void logs.push({ level: 'error', msg, o }),
}
const clock = () => new Date(t)

beforeEach(async () => {
  db = mongo.db()
  await runMigrations(db, { holder: 'test' })
  t = syd('2026-11-05')
  bob = new FakeBob()
  bob.clock = () => new Date(t)
  funding[BILGOLA] = seedFamily(bob).funding
  bob.addAdult(M_GUARDIAN, MANLY).addChild(M_KID, MANLY).link(M_GUARDIAN, M_KID)
  funding[MANLY] = bob.openAccount(M_GUARDIAN, 'funding', 10_000)
  for (const jar of ['spend', 'save', 'give'] as const) bob.openAccount(M_KID, jar)
  cred[BILGOLA] = bob.issueAllowanceCredential(BILGOLA)
  cred[MANLY] = bob.issueAllowanceCredential(MANLY)
  logs.length = 0
})

const job = (tenant: string) => new AllowanceCycleJob(db, tenant, new AllowanceCycleService(db, new BobAllowanceExecutor(new BobHttp({ baseUrl: BOB_URL, timeoutMs: 1_000, fetch: bob.fetch }), cred[tenant]!), clock))
/** A bank's jobs process as jobs-main builds it: its credential, its job, its bank's lease. */
const runnerFor = (tenant: string, holder: string) => new JobRunner(db, schedulerLeaseFor(tenant), holder, TTL, [job(tenant)], log as never, clock)

const SET = `mutation($c: ID!, $key: ID!, $f: ID) {
  setAllowance(childId: $c, mode: FREE, amount: { amount: "10.00", currency: "AUD" }, cadence: WEEKLY, startDate: "${START}", timezone: "Australia/Sydney", defaultSplit: { spendPercent: 50, savePercent: 30, givePercent: 20 }, idempotencyKey: $key, fromAccountId: $f) { version }
}`
async function setUp(guardian: string, child: string, tenant: string) {
  const x = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
  const r = await x.gql(bob.signIn(guardian), SET, { c: child, key: `two-banks-${child}`, f: funding[tenant] })
  await x.app.close()
  if (r.body.errors) throw new Error(JSON.stringify(r.body.errors))
}

const execCalls = () => bob.calls.filter((c) => /\/service\/standing-authorities\/[^/]+\/executions$/.test(c.path))
const paidChildren = () => execCalls().map((c) => [c.body.child_customer_id, c.bearer === cred[BILGOLA] ? BILGOLA : c.bearer === cred[MANLY] ? MANLY : 'other'])
const fundingLegs = () => bob.ledger.filter((l) => l.purpose === 'allowance_funding')
const cycle = (child: string, p: string) => db.collection(CYCLES).findOne({ cycleKey: `${child}:${p}` }, { projection: { _id: 0 } })
const leaseDocs = () => db.collection(LEASES_COLLECTION).find({ _id: { $regex: `^${SCHEDULER_LEASE_PREFIX}` } as never }, { projection: { holder: 1, token: 1 } }).sort({ _id: 1 }).toArray()

describe('the lease name', () => {
  it('is one per bank, and an empty or malformed bank id is refused rather than shared', () => {
    expect(schedulerLeaseFor(BILGOLA)).toBe('scheduler:allowance:bank_bilgola')
    expect(schedulerLeaseFor(MANLY)).toBe('scheduler:allowance:bank_manly')
    for (const bad of ['', 'bank_x:y', 'Bank_Manly', 'bank manly', 'x'.repeat(65)]) expect(() => schedulerLeaseFor(bad), JSON.stringify(bad)).toThrow(/bank id/)
  })
})

describe('review 40503 item 1: Bilgola and Manly runners on one database', () => {
  beforeEach(async () => {
    await setUp(SARAH, LEO, BILGOLA)
    await setUp(M_GUARDIAN, M_KID, MANLY)
  })

  it('both banks’ runners tick at once: each is its own bank’s leader, and each child is paid once under its own bank’s credential', async () => {
    t = syd(P2, 0, 0, 5)
    const [b, m] = await Promise.all([runnerFor(BILGOLA, 'jobs:bilgola:1').tick(), runnerFor(MANLY, 'jobs:manly:1').tick()])
    expect([b.leader, m.leader]).toEqual([true, true])
    expect(paidChildren().sort()).toEqual([
      [LEO, BILGOLA],
      [M_KID, MANLY],
    ])
    expect(fundingLegs().map((l) => l.amountCents)).toEqual([1000, 1000])
    expect(await cycle(LEO, P1)).toMatchObject({ tenantId: BILGOLA, status: 'EXECUTED' })
    expect(await cycle(M_KID, P1)).toMatchObject({ tenantId: MANLY, status: 'EXECUTED' })
  })

  it('a Bilgola leader renewing its lease every tick never starves Manly: Manly leads every tick and pays at its cut-off', async () => {
    const bilgola = runnerFor(BILGOLA, 'jobs:bilgola:1')
    const manly = runnerFor(MANLY, 'jobs:manly:1')
    t = syd(P1, 9) // mid-week: nothing due yet
    const leaders: [boolean, boolean][] = []
    for (let i = 0; i < 8; i++) {
      // Bilgola always ticks first and renews before Manly asks: the case a shared lease starved.
      const b = await bilgola.tick()
      const m = await manly.tick()
      leaders.push([b.leader, m.leader])
      t = i === 3 ? syd(P2, 0, 0, 1) : t + 10_000 // the cut-off passes half way through
    }
    expect(leaders.every(([b, m]) => b && m)).toBe(true)
    expect(paidChildren().sort()).toEqual([
      [LEO, BILGOLA],
      [M_KID, MANLY],
    ])
  })

  it('failover is per bank: a crashed Manly leader is replaced when its lease expires; Bilgola is unaffected; the old leader stays out', async () => {
    const m1 = runnerFor(MANLY, 'jobs:manly:1')
    const m2 = runnerFor(MANLY, 'jobs:manly:2')
    const b1 = runnerFor(BILGOLA, 'jobs:bilgola:1')
    t = syd('2026-11-15', 23, 59, 50) // Sunday: m1 takes Manly's lease, then crashes (stops ticking, never releases)
    expect((await m1.tick()).leader).toBe(true)
    // m1's own stillLeader check, with the fencing token it was given.
    const m1StillLeader = () => new LeaseLock(db, clock).holds(schedulerLeaseFor(MANLY), 'jobs:manly:1', 1)
    expect(await m1StillLeader()).toBe(true)

    t = syd(P2, 0, 0, 5) // the cut-off has passed; m1's lease is still live
    expect((await m2.tick()).leader).toBe(false)
    expect((await b1.tick()).leader).toBe(true) // Bilgola's own lease: not blocked by Manly's
    expect(paidChildren()).toEqual([[LEO, BILGOLA]])

    t = syd(P2, 0, 0, 21) // m1's lease (taken at 23:59:50, 30 s) has expired
    expect((await m2.tick()).leader).toBe(true)
    expect(paidChildren().sort()).toEqual([
      [LEO, BILGOLA],
      [M_KID, MANLY],
    ])
    expect(await m1StillLeader()).toBe(false)

    t = syd(P2, 0, 0, 30) // m1 comes back: m2 renewed at 00:00:21, so m1 is not the leader and sends nothing
    expect((await m1.tick()).leader).toBe(false)
    expect(execCalls()).toHaveLength(2)
    expect(fundingLegs()).toHaveLength(2)
  })

  it('isolation: each runner holds only its bank’s lease, and the other bank’s lease, children and records are untouched', async () => {
    t = syd(P2, 0, 0, 5)
    await runnerFor(MANLY, 'jobs:manly:1').tick()
    expect(paidChildren()).toEqual([[M_KID, MANLY]])
    expect(await cycle(LEO, P1)).toBeNull()
    expect((await leaseDocs()).map((d) => [d._id, d.holder])).toEqual([[schedulerLeaseFor(MANLY), 'jobs:manly:1']])

    await runnerFor(BILGOLA, 'jobs:bilgola:1').tick()
    const leases = await leaseDocs()
    expect(leases.map((d) => [d._id, d.holder, d.token])).toEqual([
      [schedulerLeaseFor(BILGOLA), 'jobs:bilgola:1', 1],
      [schedulerLeaseFor(MANLY), 'jobs:manly:1', 1],
    ])
    expect(paidChildren()).toEqual([
      [M_KID, MANLY],
      [LEO, BILGOLA],
    ])
    // No lease named plain "scheduler" (the shared lease this replaces) is ever taken.
    expect(await db.collection(LEASES_COLLECTION).countDocuments({ _id: 'scheduler' as never })).toBe(0)
  })
})
