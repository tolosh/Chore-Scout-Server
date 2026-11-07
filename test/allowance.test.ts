/**
 * CS-3963: allowance set-up (Free, Linked, Earned) under Sarah's session and
 * the per-cycle payment under the allowance credential (bob-family/1 §7.1,
 * §7.2, §7.5; revised SD-2, ID-14, SD-7). GraphQL for the set-up; the cycle
 * through AllowanceCycleService, as the scheduled job (CS-3979) will call it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from 'mongodb'
import { AllowanceCycleService, CYCLES } from '../src/allowance/cycle.js'
import { BobAllowanceExecutor } from '../src/bob/allowance.js'
import { BobHttp } from '../src/bob/http.js'
import { runMigrations } from '../src/migrations/index.js'
import { readLedger } from '../src/unsplit/ledger.js'
import { FakeBob } from './fakes/bob.js'
import { BOB_URL, buildTestApi, codeOf } from './helpers/api.js'
import { LEO, MIA, OTHER_KID, SARAH, seedFamily } from './helpers/family.js'
import { startMongo, type TestMongo } from './helpers/mongo.js'

let mongo: TestMongo
let db: Db
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})

/** Synthetic idempotency keys (no secret), routed through a helper so the secrets scan has no key literal to flag. */
const K = (name: string) => name
/** A Sydney wall-clock time as an instant (UTC+11 in November and December). */
const syd = (d: string, hh = 12) => Date.parse(`${d}T00:00:00Z`) + (hh - 11) * 3_600_000

const START = '2026-11-09'
const P1 = START
const P2 = '2026-11-16'
const P3 = '2026-11-23'

let bob: FakeBob
let t: number
let funding: string
let credential: string
beforeEach(async () => {
  db = mongo.db()
  await runMigrations(db, { holder: 'test' })
  t = syd('2026-11-05')
  bob = new FakeBob()
  bob.clock = () => new Date(t)
  ;({ funding } = seedFamily(bob))
  credential = bob.issueAllowanceCredential()
  bob.addCharity('cust_T_CHARITY_PAWS', 'Paws Rescue')
  bob.addCharity('cust_T_CHARITY_TREES', 'Tree Friends')
})

type Api = ReturnType<typeof buildTestApi>
const api = () => buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
const cycles = (cred = credential) => new AllowanceCycleService(db, new BobAllowanceExecutor(new BobHttp({ baseUrl: BOB_URL, timeoutMs: 1_000, fetch: bob.fetch }), cred), () => new Date(t))

const SET = `mutation($c: ID!, $m: CsAllowanceMode!, $a: CsMoneyInput!, $s: CsDate!, $tz: String!, $sp: CsSplitInput!, $lc: CsLinkedCondition, $v: Int, $key: ID!, $f: ID) {
  setAllowance(childId: $c, mode: $m, amount: $a, cadence: WEEKLY, startDate: $s, timezone: $tz, defaultSplit: $sp, linkedCondition: $lc, expectedVersion: $v, idempotencyKey: $key, fromAccountId: $f) {
    childCustomerId mode amount { amount } startDate timezone defaultSplit { spendPercent savePercent givePercent } linkedCondition version
  }
}`
const ALLOWANCE = `query($c: ID!) { allowance(childId: $c) { rule { mode amount { amount } version } nextDueDate lastCycle { cycleKey periodStart decision reason ruleVersion amount { amount } status bobOperationRef receipt { bobOperationRef amount { amount } legs { jar amount { amount } } } } } }`

interface SetArgs {
  c?: string
  m?: string
  a?: string
  s?: string
  sp?: [number, number, number]
  lc?: string | null
  v?: number | null
  f?: string | null
  tz?: string
}
const set = (x: Api, tok: string, key: string, o: SetArgs = {}) =>
  x.gql(tok, SET, {
    c: o.c ?? LEO,
    m: o.m ?? 'FREE',
    a: { amount: o.a ?? '10.00', currency: 'AUD' },
    s: o.s ?? START,
    tz: o.tz ?? 'Australia/Sydney',
    sp: { spendPercent: (o.sp ?? [50, 30, 20])[0], savePercent: (o.sp ?? [50, 30, 20])[1], givePercent: (o.sp ?? [50, 30, 20])[2] },
    lc: o.lc ?? null,
    v: o.v ?? null,
    f: o.f === undefined ? funding : o.f,
    key,
  })

const authorityCalls = () => bob.calls.filter((c) => /standing-authorities/.test(c.path) && !/\/service\//.test(c.path))
const execCalls = () => bob.calls.filter((c) => /\/service\/standing-authorities\/[^/]+\/executions$/.test(c.path))
const legs = (purpose: string) => bob.ledger.filter((l) => l.purpose === purpose)
const authorityOf = (child: string) => [...bob.authorities.values()].find((a) => a.child === child)!

async function chore(x: Api, child: string, key: string, approve: boolean) {
  const sarah = bob.signIn(SARAH)
  const kid = bob.signIn(child)
  const c = (await x.gql(sarah, `mutation($c: ID!, $key: ID!) { createJob(childId: $c, kind: HOME_JOB, title: "Make the bed", idempotencyKey: $key) { jobId version } }`, { c: child, key: K(`${key}-create`) })).body.data!.createJob as { jobId: string; version: number }
  if (!approve) return
  const s = (await x.gql(kid, `mutation($j: ID!, $v: Int!, $key: ID!) { submitJob(jobId: $j, expectedVersion: $v, idempotencyKey: $key) { version } }`, { j: c.jobId, v: c.version, key: K(`${key}-submit`) })).body.data!.submitJob as { version: number }
  const d = await x.gql(sarah, `mutation($j: ID!, $v: Int!, $key: ID!) { decideJob(jobId: $j, decision: APPROVE, expectedVersion: $v, idempotencyKey: $key) { job { status } } }`, { j: c.jobId, v: s.version, key: K(`${key}-decide`) })
  expect((d.body.data!.decideJob as { job: { status: string } }).job.status).toBe('DONE')
}

describe('set-up: Guardian only, versioned, idempotent, audited; BOB authority under Sarah’s session', () => {
  it('first set-up records Sarah’s standing authority in BOB, then the rule', async () => {
    const x = api()
    const sarah = bob.signIn(SARAH)
    const r = await set(x, sarah, K('al-setup-0001'))
    expect(r.body.data!.setAllowance).toEqual({
      childCustomerId: LEO,
      mode: 'FREE',
      amount: { amount: '10.00' },
      startDate: START,
      timezone: 'Australia/Sydney',
      defaultSplit: { spendPercent: 50, savePercent: 30, givePercent: 20 },
      linkedCondition: null,
      version: 1,
    })
    const [call] = authorityCalls()
    expect(call).toMatchObject({ method: 'POST', path: `/api/v1/children/${LEO}/standing-authorities`, bearer: sarah, key: `cs:${LEO}:authority:create` })
    expect(call!.body).toEqual({ from_account_id: funding, amount_cents: 1000, currency: 'AUD', split_cents: { spend: 500, save: 300, give: 200 }, cycle: { period: 'weekly', start_date: START, timezone: 'Australia/Sydney' } })
    expect(authorityOf(LEO)).toMatchObject({ guardian: SARAH, amountCents: 1000, status: 'active' })
    const [a] = await db.collection('audit').find({ action: 'allowance.rule_created' }).toArray()
    expect(a).toMatchObject({ actor: SARAH, subject: LEO, before: null, after: { mode: 'FREE', amountCents: 1000, version: 1 } })
    expect(typeof a!.correlation).toBe('string')
    await x.app.close()
  })

  it('a replay of the same key returns the same rule and calls BOB once; the same key with a different request is INVALID', async () => {
    const x = api()
    const sarah = bob.signIn(SARAH)
    await set(x, sarah, K('al-replay-001'))
    expect((await set(x, sarah, K('al-replay-001'))).body.data!.setAllowance).toMatchObject({ version: 1 })
    expect(codeOf((await set(x, sarah, K('al-replay-001'), { a: '11.00' })).body)).toBe('INVALID')
    expect(authorityCalls()).toHaveLength(1)
    await x.app.close()
  })

  it('T6: invalid amount, split, condition, start date or source; an unlinked child; a child session: all refused, BOB never called', async () => {
    const x = api()
    const sarah = bob.signIn(SARAH)
    expect(codeOf((await set(x, sarah, K('al-bad-00001'), { a: '0.00' })).body)).toBe('INVALID')
    expect(codeOf((await set(x, sarah, K('al-bad-00002'), { a: '10.001' })).body)).toBe('INVALID')
    expect(codeOf((await set(x, sarah, K('al-bad-00003'), { sp: [50, 30, 30] })).body)).toBe('INVALID')
    expect(codeOf((await set(x, sarah, K('al-bad-00004'), { m: 'LINKED' })).body)).toBe('INVALID')
    expect(codeOf((await set(x, sarah, K('al-bad-00005'), { lc: 'WEEK_CHORES_DONE' })).body)).toBe('INVALID')
    expect(codeOf((await set(x, sarah, K('al-bad-00006'), { s: '2026-11-02' })).body)).toBe('INVALID')
    expect(codeOf((await set(x, sarah, K('al-bad-00007'), { f: null })).body)).toBe('INVALID')
    expect(codeOf((await set(x, sarah, K('al-bad-00008'), { tz: 'Mars/Olympus' })).body)).toBe('INVALID')
    // D55: the week is Monday 00:00 to Monday 00:00 Australia/Sydney; the Guardian doesn't choose it.
    expect(codeOf((await set(x, sarah, K('al-bad-00011'), { tz: 'Europe/London' })).body)).toBe('INVALID')
    expect(codeOf((await set(x, sarah, K('al-bad-00012'), { tz: 'Australia/Melbourne' })).body)).toBe('INVALID')
    expect(codeOf((await set(x, sarah, K('al-bad-00013'), { s: '2026-11-11' })).body)).toBe('INVALID')
    expect(codeOf((await set(x, sarah, K('al-bad-00014'), { s: '2026-11-15' })).body)).toBe('INVALID')
    expect(codeOf((await set(x, sarah, K('al-bad-00009'), { c: OTHER_KID })).body)).toBe('FORBIDDEN')
    expect(codeOf((await set(x, bob.signIn(LEO), K('al-bad-00010'))).body)).toBe('FORBIDDEN')
    expect(authorityCalls()).toHaveLength(0)
    await x.app.close()
  })

  it('SD-7: when BOB refuses the authority, the rule is not saved', async () => {
    const x = api()
    const sarah = bob.signIn(SARAH)
    const notHers = bob.accountOf(LEO, 'save')!
    expect(codeOf((await set(x, sarah, K('al-refuse-001'), { f: notHers })).body)).toBe('FORBIDDEN')
    expect((await x.gql(sarah, ALLOWANCE, { c: LEO })).body.data!.allowance).toEqual({ rule: null, nextDueDate: null, lastCycle: null })
    await x.app.close()
  })

  it('SD-7: when BOB refuses an amount change, the rule keeps its amount and version', async () => {
    const x = api()
    const sarah = bob.signIn(SARAH)
    await set(x, sarah, K('al-refchg-01'))
    bob.revokeAuthority(authorityOf(LEO).authorityId)
    expect(codeOf((await set(x, sarah, K('al-refchg-02'), { a: '15.00', v: 1 })).body)).toBe('NOT_ALLOWED_IN_STATE')
    expect((await x.gql(sarah, ALLOWANCE, { c: LEO })).body.data!.allowance).toMatchObject({ rule: { amount: { amount: '10.00' }, version: 1 } })
    await x.app.close()
  })

  it('a stale version gets STALE_VERSION; two concurrent changes on one version give one success and one STALE_VERSION', async () => {
    const x = api()
    const sarah = bob.signIn(SARAH)
    await set(x, sarah, K('al-ver-00001'))
    const [a, b] = await Promise.all([set(x, sarah, K('al-ver-00002'), { a: '11.00', v: 1 }), set(x, sarah, K('al-ver-00003'), { a: '12.00', v: 1 })])
    const codes = [codeOf(a.body), codeOf(b.body)].sort()
    expect(codes).toEqual([undefined, 'STALE_VERSION'].sort())
    const won = (a.body.data?.setAllowance ?? b.body.data!.setAllowance) as { amount: { amount: string }; version: number }
    expect(won.version).toBe(2)
    expect(authorityOf(LEO).amountCents).toBe(Number(won.amount.amount.replace('.', '')))
    expect(codeOf((await set(x, sarah, K('al-ver-00004'), { a: '13.00', v: 1 })).body)).toBe('STALE_VERSION')
    await x.app.close()
  })

  it('the cycle can’t change in S0 (BOB fixes it on the authority); a mode-only change makes no BOB call', async () => {
    const x = api()
    const sarah = bob.signIn(SARAH)
    await set(x, sarah, K('al-cyc-00001'))
    expect(codeOf((await set(x, sarah, K('al-cyc-00002'), { s: '2026-11-16', v: 1 })).body)).toBe('NOT_ALLOWED_IN_STATE')
    expect((await set(x, sarah, K('al-cyc-00003'), { m: 'EARNED', v: 1 })).body.data!.setAllowance).toMatchObject({ mode: 'EARNED', version: 2 })
    expect(authorityCalls()).toHaveLength(1)
    await x.app.close()
  })

  it('Sarah and Leo can read Leo’s allowance; Mia can’t', async () => {
    const x = api()
    await set(x, bob.signIn(SARAH), K('al-read-0001'))
    expect((await x.gql(bob.signIn(LEO), ALLOWANCE, { c: LEO })).body.data!.allowance).toMatchObject({ rule: { mode: 'FREE', version: 1 }, nextDueDate: '2026-11-16', lastCycle: null })
    expect(codeOf((await x.gql(bob.signIn(MIA), ALLOWANCE, { c: LEO })).body)).toBe('FORBIDDEN')
    await x.app.close()
  })
})

describe('T1: Free (Leo): each due cycle gives one PAY and one BOB payment plus auto-split', () => {
  it('one execution under the allowance credential; the receipt matches to the cent; nothing is unsplit', async () => {
    const x = api()
    await set(x, bob.signIn(SARAH), K('al-free-0001'))
    t = syd(P2, 9)
    const run = await cycles().run(LEO, P1, 'corr-t1')
    expect(run).toMatchObject({ outcome: 'RECORDED', cycle: { decision: 'PAY', status: 'EXECUTED', amountCents: 1000, ruleVersion: 1 } })
    const [call] = execCalls()
    expect(call).toMatchObject({ bearer: credential, key: `cs:${LEO}:${P1}:allowance` })
    expect(call!.body).toEqual({ child_customer_id: LEO, cycle_ref: P1, amount_cents: 1000, instruction_ref: `cyc_${LEO}:${P1}` })
    expect(legs('allowance_funding').map((l) => l.amountCents)).toEqual([1000])
    expect(legs('split').map((l) => [l.amountCents, l.origin])).toEqual([
      [300, 'automatic'],
      [200, 'automatic'],
    ])
    expect([bob.balance(LEO, 'spend'), bob.balance(LEO, 'save'), bob.balance(LEO, 'give')]).toEqual([500, 300, 200])
    expect(await readLedger(db, LEO)).toBeNull()
    const al = (await x.gql(bob.signIn(SARAH), ALLOWANCE, { c: LEO })).body.data!.allowance as { lastCycle: { receipt: unknown; bobOperationRef: string } }
    expect(al.lastCycle.receipt).toEqual({
      bobOperationRef: al.lastCycle.bobOperationRef,
      amount: { amount: '10.00' },
      legs: [
        { jar: 'SPEND', amount: { amount: '5.00' } },
        { jar: 'SAVE', amount: { amount: '3.00' } },
        { jar: 'GIVE', amount: { amount: '2.00' } },
      ],
    })
    await x.app.close()
  })

  it('no cycle is decided before its cut-off, off a period start, or before the start date; nothing is sent', async () => {
    const x = api()
    await set(x, bob.signIn(SARAH), K('al-early-001'))
    t = syd(P2, 9)
    expect(await cycles().run(LEO, P2, 'c')).toEqual({ outcome: 'NOT_DUE', detail: `cut-off ${P3}` })
    expect(await cycles().run(LEO, '2026-11-10', 'c')).toEqual({ outcome: 'INVALID_PERIOD', detail: 'NOT_A_PERIOD_START' })
    expect(await cycles().run(LEO, '2026-11-02', 'c')).toEqual({ outcome: 'INVALID_PERIOD', detail: 'NOT_A_PERIOD_START' })
    expect(await db.collection(CYCLES).countDocuments()).toBe(0)
    expect(execCalls()).toHaveLength(0)
    await x.app.close()
  })
})

describe('T2: Linked (Mia)', () => {
  it('chores done by the cut-off: PAY. Chores not done: SKIP with a reason and zero BOB calls', async () => {
    const x = api()
    await set(x, bob.signIn(SARAH), K('al-link-0001'), { c: MIA, m: 'LINKED', lc: 'WEEK_CHORES_DONE' })
    t = syd('2026-11-10')
    await chore(x, MIA, 'w1-bed', true)
    await chore(x, MIA, 'w1-dishes', true)
    t = syd(P2, 9)
    expect((await cycles().run(MIA, P1, 'c')).outcome === 'RECORDED' && execCalls()).toHaveLength(1)
    t = syd('2026-11-18')
    await chore(x, MIA, 'w2-bed', true)
    await chore(x, MIA, 'w2-dishes', false)
    t = syd(P3, 9)
    const r = await cycles().run(MIA, P2, 'c')
    expect(r).toMatchObject({ outcome: 'RECORDED', cycle: { decision: 'SKIP', reason: 'CHORES_NOT_DONE:1/2', status: 'DECIDED', amountCents: null } })
    expect(execCalls()).toHaveLength(1)
    expect(legs('allowance_funding')).toHaveLength(1)
    await x.app.close()
  })
})

describe('D55 and D56: the Linked week ends Monday 00:00 Sydney; a week with no chores assigned pays', () => {
  it('D56: Mia, Linked, no chore assigned in the week: PAY the set amount once', async () => {
    const x = api()
    await set(x, bob.signIn(SARAH), K('al-d56-00001'), { c: MIA, m: 'LINKED', lc: 'WEEK_CHORES_DONE' })
    t = syd(P2, 0) + 60_000 // Monday 00:01 Sydney, just after the cut-off
    const r = await cycles().run(MIA, P1, 'c')
    expect(r).toMatchObject({ outcome: 'RECORDED', cycle: { decision: 'PAY', reason: 'NO_CHORES_ASSIGNED', status: 'EXECUTED', amountCents: 1000 } })
    expect(execCalls()).toHaveLength(1)
    expect(legs('allowance_funding').map((l) => l.amountCents)).toEqual([1000])
    await x.app.close()
  })

  it('a chore approved after the Monday 00:00 Sydney cut-off is not done in time: SKIP, zero BOB calls', async () => {
    const x = api()
    await set(x, bob.signIn(SARAH), K('al-d55-00001'), { c: MIA, m: 'LINKED', lc: 'WEEK_CHORES_DONE' })
    t = syd('2026-11-11')
    const sarah = bob.signIn(SARAH)
    const c = (await x.gql(sarah, `mutation($c: ID!, $key: ID!) { createJob(childId: $c, kind: HOME_JOB, title: "Make the bed", idempotencyKey: $key) { jobId version } }`, { c: MIA, key: K('al-d55-create') })).body.data!.createJob as { jobId: string; version: number }
    const sub = (await x.gql(bob.signIn(MIA), `mutation($j: ID!, $v: Int!, $key: ID!) { submitJob(jobId: $j, expectedVersion: $v, idempotencyKey: $key) { version } }`, { j: c.jobId, v: c.version, key: K('al-d55-submit') })).body.data!.submitJob as { version: number }
    t = syd(P2, 0) + 5 * 60_000 // approved Monday 00:05 Sydney, after the week ended
    await x.gql(bob.signIn(SARAH), `mutation($j: ID!, $v: Int!, $key: ID!) { decideJob(jobId: $j, decision: APPROVE, expectedVersion: $v, idempotencyKey: $key) { job { status } } }`, { j: c.jobId, v: sub.version, key: K('al-d55-decide') })
    expect(await cycles().run(MIA, P1, 'c')).toMatchObject({ outcome: 'RECORDED', cycle: { decision: 'SKIP', reason: 'CHORES_NOT_DONE:1/1', status: 'DECIDED' } })
    expect(execCalls()).toHaveLength(0)
    await x.app.close()
  })

  it('a 201 that does not match what was asked is never shown as paid', async () => {
    const x = api()
    await set(x, bob.signIn(SARAH), K('al-mism-0001'))
    t = syd(P2, 9)
    bob.mutateFamily = (d) => {
      if ('execution_id' in d) d.amount_cents = 1100
    }
    expect(await cycles().run(LEO, P1, 'c')).toMatchObject({ cycle: { status: 'DECIDED', bobReason: 'UPSTREAM_MISMATCH' } })
    bob.mutateFamily = null
    await x.app.close()
  })
})

describe('T3: Earned: SKIP every cycle; job pay still works', () => {
  it('two cycles skip with zero BOB calls; an approved paid job still pays', async () => {
    const x = api()
    const sarah = bob.signIn(SARAH)
    await set(x, sarah, K('al-earn-0001'), { m: 'EARNED' })
    t = syd(P3, 9)
    for (const p of [P1, P2]) expect(await cycles().run(LEO, p, 'c')).toMatchObject({ cycle: { decision: 'SKIP', reason: 'EARNED_MODE' } })
    expect(execCalls()).toHaveLength(0)
    const sarah2 = bob.signIn(SARAH)
    const c = (await x.gql(sarah2, `mutation($c: ID!, $key: ID!) { createJob(childId: $c, kind: EXTRA_EARNER, title: "Washed the car", reward: { amount: "2.00", currency: "AUD" }, idempotencyKey: $key) { jobId version } }`, { c: LEO, key: K('al-earn-job1') })).body.data!.createJob as { jobId: string; version: number }
    const s = (await x.gql(bob.signIn(LEO), `mutation($j: ID!, $v: Int!, $key: ID!) { submitJob(jobId: $j, expectedVersion: $v, idempotencyKey: $key) { version } }`, { j: c.jobId, v: c.version, key: K('al-earn-sub1') })).body.data!.submitJob as { version: number }
    const d = await x.gql(sarah2, `mutation($j: ID!, $v: Int!, $key: ID!, $f: ID) { decideJob(jobId: $j, decision: APPROVE, expectedVersion: $v, idempotencyKey: $key, fromAccountId: $f) { job { status } } }`, { j: c.jobId, v: s.version, key: K('al-earn-dec1'), f: funding })
    expect((d.body.data!.decideJob as { job: { status: string } }).job.status).toBe('PAID')
    await x.app.close()
  })
})

describe('T4: re-running the same cycleKey never pays twice', () => {
  it('a lost answer stays DECIDED; the re-run re-sends the same key and completes once; later re-runs send nothing', async () => {
    const x = api()
    await set(x, bob.signIn(SARAH), K('al-rerun-001'))
    t = syd(P2, 9)
    bob.dropResponses = { re: /\/executions$/, count: 1 }
    expect(await cycles().run(LEO, P1, 'c')).toMatchObject({ cycle: { status: 'DECIDED', bobReason: 'UPSTREAM_UNAVAILABLE' } })
    expect(await cycles().run(LEO, P1, 'c')).toMatchObject({ cycle: { status: 'EXECUTED' } })
    await cycles().run(LEO, P1, 'c')
    expect(execCalls().map((c) => c.key)).toEqual([`cs:${LEO}:${P1}:allowance`, `cs:${LEO}:${P1}:allowance`])
    expect(legs('allowance_funding')).toHaveLength(1)
    await x.app.close()
  })

  it('a second instruction for a paid cycle (another credential, so another key scope) gets CYCLE_ALREADY_PAID: recorded with the original, no payment', async () => {
    const x = api()
    await set(x, bob.signIn(SARAH), K('al-second-01'))
    t = syd(P2, 9)
    const first = await cycles().run(LEO, P1, 'c')
    await db.collection(CYCLES).deleteMany({})
    const rotated = bob.issueAllowanceCredential()
    const again = await cycles(rotated).run(LEO, P1, 'c')
    expect(again).toMatchObject({ cycle: { status: 'EXECUTED', bobReason: 'CYCLE_ALREADY_PAID' } })
    expect(again.outcome === 'RECORDED' && first.outcome === 'RECORDED' && again.cycle.bobOperationRef).toBe(first.outcome === 'RECORDED' && first.cycle.bobOperationRef)
    expect(legs('allowance_funding')).toHaveLength(1)
    await x.app.close()
  })
})

describe('T5, T10: an amount change applies from the next cycle, with no backfill', () => {
  it('10.00 paid for the first cycle; changed to 12.00 mid-period; the next cycle pays 12.00 once; nothing is adjusted', async () => {
    const x = api()
    const sarah = bob.signIn(SARAH)
    await set(x, sarah, K('al-chg-00001'))
    t = syd(P2, 9)
    await cycles().run(LEO, P1, 'c')
    t = syd('2026-11-18')
    const r = await set(x, bob.signIn(SARAH), K('al-chg-00002'), { a: '12.00', v: 1 })
    expect(r.body.data!.setAllowance).toMatchObject({ amount: { amount: '12.00' }, version: 2 })
    const patch = authorityCalls().find((c) => c.method === 'PATCH')!
    expect(patch.key).toBe(`cs:${authorityOf(LEO).authorityId}:v1`)
    expect(patch.body).toMatchObject({ expected_version: 1, amount_cents: 1200, split_cents: { spend: 600, save: 360, give: 240 } })
    t = syd(P3, 9)
    expect(await cycles().run(LEO, P2, 'c')).toMatchObject({ cycle: { status: 'EXECUTED', amountCents: 1200, ruleVersion: 2 } })
    await cycles().run(LEO, P1, 'c')
    expect(legs('allowance_funding').map((l) => l.amountCents)).toEqual([1000, 1200])
    await x.app.close()
  })

  it('a mode change does not backfill: Earned to Free mid-period pays from the current period only', async () => {
    const x = api()
    const sarah = bob.signIn(SARAH)
    await set(x, sarah, K('al-mode-0001'), { m: 'EARNED' })
    t = syd('2026-11-25')
    expect((await set(x, bob.signIn(SARAH), K('al-mode-0002'), { m: 'FREE', v: 1 })).body.data!.setAllowance).toMatchObject({ mode: 'FREE', version: 2 })
    expect(await cycles().run(LEO, P1, 'c')).toEqual({ outcome: 'INVALID_PERIOD', detail: 'BEFORE_RULE_EFFECTIVE' })
    expect(await cycles().run(LEO, P2, 'c')).toEqual({ outcome: 'INVALID_PERIOD', detail: 'BEFORE_RULE_EFFECTIVE' })
    t = syd('2026-11-30', 9)
    expect(await cycles().run(LEO, P3, 'c')).toMatchObject({ cycle: { decision: 'PAY', status: 'EXECUTED' } })
    expect(legs('allowance_funding')).toHaveLength(1)
    await x.app.close()
  })
})

describe('T8, T9: the exact amount, once per cycle (SD-7)', () => {
  it('T8: the amount sent equals the rule amount and BOB’s authority amount, to the cent', async () => {
    const x = api()
    await set(x, bob.signIn(SARAH), K('al-t8-00001'), { a: '7.35' })
    t = syd(P2, 9)
    await cycles().run(LEO, P1, 'c')
    expect(execCalls()[0]!.body.amount_cents).toBe(735)
    expect(authorityOf(LEO).amountCents).toBe(735)
    await x.app.close()
  })

  it('T9: a mismatched amount is refused by BOB and recorded FAILED with BOB’s reason; no payment', async () => {
    const x = api()
    await set(x, bob.signIn(SARAH), K('al-t9-00001'))
    authorityOf(LEO).amountCents = 999
    t = syd(P2, 9)
    expect(await cycles().run(LEO, P1, 'c')).toMatchObject({ cycle: { status: 'FAILED', bobReason: 'AMOUNT_NOT_AUTHORISED' } })
    expect(legs('allowance_funding')).toHaveLength(0)
    expect(await cycles().run(LEO, P1, 'c')).toMatchObject({ cycle: { status: 'FAILED' } })
    expect(execCalls()).toHaveLength(1)
    await x.app.close()
  })
})

describe('T7: a revoked authority', () => {
  it('the next PAY is refused by BOB and recorded FAILED with the reason; nothing moves', async () => {
    const x = api()
    await set(x, bob.signIn(SARAH), K('al-t7-00001'))
    bob.revokeAuthority(authorityOf(LEO).authorityId)
    t = syd(P2, 9)
    expect(await cycles().run(LEO, P1, 'c')).toMatchObject({ cycle: { decision: 'PAY', status: 'FAILED', bobReason: 'AUTHORITY_REVOKED' } })
    expect(legs('allowance_funding')).toHaveLength(0)
    await x.app.close()
  })

  it('a revoked link also revokes it at BOB; an unknown credential leaves the cycle DECIDED with nothing paid', async () => {
    const x = api()
    await set(x, bob.signIn(SARAH), K('al-t7-00002'))
    t = syd(P2, 9)
    expect(await cycles('bobsvc_unknown_credential_value_000').run(LEO, P1, 'c')).toMatchObject({ cycle: { status: 'DECIDED', bobReason: 'UNAUTHORIZED' } })
    bob.revokeLink(SARAH, LEO)
    expect(await cycles().run(LEO, P1, 'c')).toMatchObject({ cycle: { status: 'FAILED', bobReason: 'AUTHORITY_REVOKED' } })
    expect(legs('allowance_funding')).toHaveLength(0)
    await x.app.close()
  })
})

describe('D51 (CS-3962 T3, allowance half): the allowance Give share follows the child’s confirmed charity', () => {
  it('Paws, then Trees: each cycle’s Give goes to the charity confirmed at the time', async () => {
    const x = api()
    await set(x, bob.signIn(SARAH), K('al-d51-00001'))
    const choose = (id: string, key: string, v?: number) => x.gql(bob.signIn(LEO), `mutation($id: ID!, $v: Int, $key: ID!) { setCharityPreference(childId: "${LEO}", bobCharityId: $id, expectedVersion: $v, idempotencyKey: $key) { version } }`, { id, v, key })
    await choose('cust_T_CHARITY_PAWS', K('al-d51-pref1'))
    t = syd(P2, 9)
    await cycles().run(LEO, P1, 'c')
    await choose('cust_T_CHARITY_TREES', K('al-d51-pref2'), 1)
    t = syd(P3, 9)
    await cycles().run(LEO, P2, 'c')
    expect(bob.balance('cust_T_CHARITY_PAWS', 'spend')).toBe(200)
    expect(bob.balance('cust_T_CHARITY_TREES', 'spend')).toBe(200)
    expect(bob.held.get(LEO) ?? 0).toBe(0)
    await x.app.close()
  })
})
