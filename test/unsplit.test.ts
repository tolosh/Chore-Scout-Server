/**
 * CS-3953: the unsplit ledger and the child's allocation of job pay under the
 * child's own session (bob-family/1 §6.1, §6.2). Through POST /graphql.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from 'mongodb'
import { isChildJarMove } from '../src/bob/family.js'
import { SessionToken } from '../src/identity/principal.js'
import { runMigrations } from '../src/migrations/index.js'
import { readLedger } from '../src/unsplit/ledger.js'
import { splitKey, splitOpId } from '../src/unsplit/split.js'
import { FakeBob } from './fakes/bob.js'
import { buildTestApi, codeOf } from './helpers/api.js'
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

let bob: FakeBob
let t: number
let funding: string
let charity: string
beforeEach(async () => {
  db = mongo.db()
  await runMigrations(db, { holder: 'test' })
  t = Date.parse('2026-11-05T03:00:00Z')
  bob = new FakeBob()
  bob.clock = () => new Date(t)
  ;({ funding } = seedFamily(bob))
  charity = bob.addCharity('cust_T_CHARITY_PAWS', 'Paws Rescue')
})

const CREATE = `mutation($c: ID!, $r: CsMoneyInput, $key: ID!) { createJob(childId: $c, kind: EXTRA_EARNER, title: "Washed the car", reward: $r, idempotencyKey: $key) { jobId version } }`
const SUBMIT = `mutation($j: ID!, $v: Int!, $key: ID!) { submitJob(jobId: $j, expectedVersion: $v, idempotencyKey: $key) { jobId version } }`
const DECIDE = `mutation($j: ID!, $v: Int!, $key: ID!, $f: ID) { decideJob(jobId: $j, decision: APPROVE, expectedVersion: $v, idempotencyKey: $key, fromAccountId: $f) { job { status } } }`
const UNSPLIT = `query($c: ID!) { unsplit(childId: $c) { balance { amount } version entries { jobId amount { amount } } } }`
const SPLIT = `mutation($c: ID!, $legs: [CsSplitLegInput!]!, $v: Int!, $key: ID!) {
  splitUnsplit(childId: $c, legs: $legs, expectedVersion: $v, idempotencyKey: $key) {
    unsplit { balance { amount } version }
    operations { idempotencyKey kind status reason amount { amount } }
    giveOutcome { status amount { amount } donationRef }
  }
}`

type Api = ReturnType<typeof buildTestApi>
type SplitOut = { unsplit: { balance: { amount: string }; version: number }; operations: { idempotencyKey: string; status: string; reason: string | null }[]; giveOutcome: { status: string; amount: { amount: string } } | null }

let n = 0
/**
 * Synthetic idempotency keys for these tests (no secret). Routed through a
 * helper so no key literal sits next to a key-like name, which the secrets
 * scan (gitleaks generic-api-key) would otherwise flag (CS-3953 review R2).
 */
const K = (name: string) => name
async function payJob(api: Api, sarah: string, childTok: string, reward = '2.00', child = MIA) {
  const c = (await api.gql(sarah, CREATE, { c: child, r: { amount: reward, currency: 'AUD' }, key: `create-key-${++n}` })).body.data!.createJob as { jobId: string; version: number }
  const s = (await api.gql(childTok, SUBMIT, { j: c.jobId, v: c.version, key: `submit-key-${n}` })).body.data!.submitJob as { jobId: string; version: number }
  const d = await api.gql(sarah, DECIDE, { j: s.jobId, v: s.version, key: `decide-key-${n}`, f: funding })
  expect((d.body.data!.decideJob as { job: { status: string } }).job.status).toBe('PAID')
}

const legs = (spend: string, save: string, give: string) => [
  { jar: 'SPEND', amount: { amount: spend, currency: 'AUD' } },
  { jar: 'SAVE', amount: { amount: save, currency: 'AUD' } },
  { jar: 'GIVE', amount: { amount: give, currency: 'AUD' } },
]
const allocCalls = () => bob.calls.filter((c) => c.path === '/api/v1/children/me/allocations')
const allocLegs = () => bob.ledger.filter((l) => l.purpose === 'allocation')

async function unsplitOf(api: Api, tok: string, child = MIA) {
  return (await api.gql(tok, UNSPLIT, { c: child })).body.data!.unsplit as { balance: { amount: string }; version: number }
}

describe('T1: $2.00 split 1.00/0.60/0.40 gives exact legs and unsplit goes to 0', () => {
  it('one atomic BOB call under Mia’s session; Spend share stays put; Give donated to her recipient', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const mia = bob.signIn(MIA)
    bob.recipients.set(MIA, { charityId: charity, revision: 1 })
    await payJob(api, sarah, mia)
    const before = await unsplitOf(api, mia)
    expect(before.balance.amount).toBe('2.00')
    const r = await api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '0.60', '0.40'), v: before.version, key: K('split-key-0001') })
    const out = r.body.data!.splitUnsplit as SplitOut
    expect(out.unsplit.balance.amount).toBe('0.00')
    expect(out.operations[0]).toMatchObject({ kind: 'split', status: 'COMPLETED', idempotencyKey: splitKey(splitOpId(MIA, K('split-key-0001'))) })
    expect(out.giveOutcome).toMatchObject({ status: 'DONATED', amount: { amount: '0.40' } })
    expect(allocCalls().map((c) => [c.bearer, c.key, c.body])).toEqual([
      [mia, splitKey(splitOpId(MIA, K('split-key-0001'))), { allocation_ref: splitOpId(MIA, K('split-key-0001')), from_jar: 'spend', legs: [{ to_jar: 'save', amount_cents: 60 }, { to_jar: 'give', amount_cents: 40 }] }],
    ])
    expect(bob.balance(MIA, 'spend')).toBe(100)
    expect(bob.balance(MIA, 'save')).toBe(60)
    expect(bob.balance(MIA, 'give')).toBe(0)
    expect(bob.balance(charity, 'spend')).toBe(40)
    await api.app.close()
  })

  it('all to Spend: no BOB call, unsplit 0', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    const out = (await api.gql(mia, SPLIT, { c: MIA, legs: [{ jar: 'SPEND', amount: { amount: '2.00', currency: 'AUD' } }], v, key: K('split-spend-01') })).body.data!.splitUnsplit as SplitOut
    expect(out.unsplit.balance.amount).toBe('0.00')
    expect(out.giveOutcome!.status).toBe('NONE')
    expect(allocCalls()).toHaveLength(0)
    await api.app.close()
  })
})

describe('T2: a replay produces no new legs', () => {
  it('same key twice: one BOB allocation, identical answer', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    const vars = { c: MIA, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-replay-1') }
    const a = await api.gql(mia, SPLIT, vars)
    const b = await api.gql(mia, SPLIT, vars)
    expect(b.body).toEqual(a.body)
    expect(allocCalls()).toHaveLength(1)
    expect(allocLegs()).toHaveLength(2)
    await api.app.close()
  })

  it('the same money cannot be split twice under a new key', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    await api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-once-001') })
    expect(codeOf((await api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-twice-01') })).body)).toBe('STALE_VERSION')
    const v2 = (await unsplitOf(api, mia)).version
    expect(codeOf((await api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '0.60', '0.40'), v: v2, key: K('split-twice-02') })).body)).toBe('INVALID')
    expect(allocLegs()).toHaveLength(2)
    await api.app.close()
  })

  it('concurrent splits of the same balance with different keys: one allocation', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    const rs = await Promise.all(['split-conc-a1', 'split-conc-b1', 'split-conc-c1'].map((key) => api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '0.60', '0.40'), v, key })))
    expect(rs.filter((r) => codeOf(r.body) === undefined)).toHaveLength(1)
    expect(allocLegs()).toHaveLength(2)
    expect((await readLedger(db, MIA))!.balanceCents).toBe(0)
    await api.app.close()
  })

  it('a lost BOB answer: PENDING, then the retry re-sends the same key and completes once', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    bob.dropResponses = { re: /allocations$/, count: 1 }
    const vars = { c: MIA, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-lost-001') }
    const a = (await api.gql(mia, SPLIT, vars)).body.data!.splitUnsplit as SplitOut
    expect(a.operations[0]).toMatchObject({ status: 'PENDING', reason: 'UPSTREAM_UNAVAILABLE' })
    expect(a.unsplit.balance.amount).toBe('0.00') // debited once, held against this operation
    const b = (await api.gql(mia, SPLIT, vars)).body.data!.splitUnsplit as SplitOut
    expect(b.operations[0]!.status).toBe('COMPLETED')
    expect(allocCalls().map((c) => c.key)).toEqual([a.operations[0]!.idempotencyKey, a.operations[0]!.idempotencyKey])
    expect(allocLegs()).toHaveLength(2)
    await api.app.close()
  })

  it('a key reused with a different split is INVALID', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    await api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-reuse-01') })
    expect(codeOf((await api.gql(mia, SPLIT, { c: MIA, legs: legs('2.00', '0.00', '0.00'), v, key: K('split-reuse-01') })).body)).toBe('INVALID')
    await api.app.close()
  })
})

describe('T3: a split that doesn’t match the unsplit amount gets INVALID', () => {
  it.each([
    ['totalling 2.01', legs('1.00', '0.61', '0.40')],
    ['totalling 1.99', legs('1.00', '0.59', '0.40')],
    ['three-decimal cents', legs('1.000', '0.60', '0.40')],
    ['a repeated jar', [...legs('1.00', '0.60', '0.40'), { jar: 'SAVE', amount: { amount: '0.00', currency: 'AUD' } }]],
    ['another currency', [{ jar: 'SPEND', amount: { amount: '2.00', currency: 'NZD' } }]],
  ])('%s', async (_n, l) => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    expect(codeOf((await api.gql(mia, SPLIT, { c: MIA, legs: l, v, key: K('split-bad-0001') })).body)).toBe('INVALID')
    expect(allocCalls()).toHaveLength(0)
    expect((await unsplitOf(api, mia)).balance.amount).toBe('2.00')
    await api.app.close()
  })
})

describe('T4 (ledger side): only job pay credits the unsplit ledger', () => {
  it('BOB money that is not job pay (e.g. any other credit to Spend) never appears as unsplit', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    bob.accounts.get(bob.accountOf(MIA, 'spend')!)!.balance += 1000 // money arriving outside job pay
    expect((await unsplitOf(api, mia)).balance.amount).toBe('0.00')
    await payJob(api, bob.signIn(SARAH), mia, '1.50')
    const u = (await api.gql(mia, UNSPLIT, { c: MIA })).body.data!.unsplit as { balance: { amount: string }; entries: { jobId: string }[] }
    expect(u.balance.amount).toBe('1.50')
    expect(u.entries).toHaveLength(1)
    expect(u.entries[0]!.jobId).toMatch(/^job-/)
    await api.app.close()
  })
})

describe('T5: the child Save carries child origin, distinct from the automatic split', () => {
  it('every allocation leg is purpose allocation, origin child', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    await api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-origin-1') })
    expect(allocLegs().map((l) => [l.purpose, l.origin])).toEqual([
      ['allocation', 'child'],
      ['allocation', 'child'],
    ])
    await api.app.close()
  })
})

describe('T6: with no charity selected, the Give share is held (HOLD-1)', () => {
  it('Save unaffected, gifted total unchanged, Give held', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    const out = (await api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-held-001') })).body.data!.splitUnsplit as SplitOut
    expect(out.giveOutcome).toMatchObject({ status: 'HELD', amount: { amount: '0.40' } })
    expect(bob.balance(MIA, 'save')).toBe(60)
    expect(bob.balance(MIA, 'give')).toBe(40)
    expect(bob.held.get(MIA)).toBe(40)
    expect(bob.ledger.filter((l) => l.purpose === 'donation')).toHaveLength(0)
    await api.app.close()
  })

  it('a zero Give creates no Give leg and no donation', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    bob.recipients.set(MIA, { charityId: charity, revision: 1 })
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    const out = (await api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '1.00', '0.00'), v, key: K('split-zero-001') })).body.data!.splitUnsplit as SplitOut
    expect(out.giveOutcome!.status).toBe('NONE')
    expect(allocCalls()[0]!.body.legs).toEqual([{ to_jar: 'save', amount_cents: 100 }])
    expect(bob.ledger.filter((l) => l.purpose === 'donation')).toHaveLength(0)
    await api.app.close()
  })
})

describe('T7: Mia splitting Leo’s unsplit gets FORBIDDEN (AUTH-2)', () => {
  it('sibling and Guardian are both refused; only the child splits', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const leo = bob.signIn(LEO)
    await payJob(api, sarah, leo, '2.00', LEO)
    const v = (await unsplitOf(api, leo, LEO)).version
    expect(codeOf((await api.gql(bob.signIn(MIA), SPLIT, { c: LEO, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-sib-0001') })).body)).toBe('FORBIDDEN')
    expect(codeOf((await api.gql(sarah, SPLIT, { c: LEO, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-grd-0001') })).body)).toBe('FORBIDDEN')
    expect(codeOf((await api.gql(bob.signIn(MIA), UNSPLIT, { c: LEO })).body)).toBe('FORBIDDEN')
    expect((await unsplitOf(api, sarah, LEO)).balance.amount).toBe('2.00') // the Guardian may see it
    expect(allocCalls()).toHaveLength(0)
    await api.app.close()
  })
})

describe('crash between recording the split and debiting the ledger', () => {
  it('the replay debits first, then calls BOB once; the money is never allocated without a debit', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    const opId = splitOpId(MIA, K('split-crash-01'))
    const now = new Date(t)
    await db.collection('money_operations').insertOne({
      idempotencyKey: splitKey(opId), opId, kind: 'split', tenantId: 'bank_bilgola', childCustomerId: MIA, actorCustomerId: MIA, clientKey: K('split-crash-01'),
      shares: { SPEND: 100, SAVE: 60, GIVE: 40 }, amountCents: 200, expectedVersion: v, status: 'PENDING', bobOperationRef: null, giveOutcome: null, reason: null, createdAt: now, updatedAt: now,
    })
    const out = (await api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-crash-01') })).body.data!.splitUnsplit as SplitOut
    expect(out.operations[0]!.status).toBe('COMPLETED')
    expect(out.unsplit.balance.amount).toBe('0.00')
    expect(allocCalls()).toHaveLength(1)
    await api.app.close()
  })

  it('if the balance moved on meanwhile, the stranded split fails and nothing moves', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    const opId = splitOpId(MIA, K('split-crash-02'))
    const now = new Date(t)
    await db.collection('money_operations').insertOne({
      idempotencyKey: splitKey(opId), opId, kind: 'split', tenantId: 'bank_bilgola', childCustomerId: MIA, actorCustomerId: MIA, clientKey: K('split-crash-02'),
      shares: { SPEND: 100, SAVE: 60, GIVE: 40 }, amountCents: 200, expectedVersion: 99, status: 'PENDING', bobOperationRef: null, giveOutcome: null, reason: null, createdAt: now, updatedAt: now,
    })
    const out = (await api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '0.60', '0.40'), v: 99, key: K('split-crash-02') })).body.data!.splitUnsplit as SplitOut
    expect(out.operations[0]).toMatchObject({ status: 'FAILED', reason: 'STALE_VERSION' })
    expect(allocCalls()).toHaveLength(0)
    expect(out.unsplit.balance.amount).toBe('2.00')
    await api.app.close()
  })
})

describe('BOB refusals restore the unsplit balance; nothing moved', () => {
  it('INSUFFICIENT_FUNDS (Spend already spent): FAILED, unsplit back to 2.00, one restore only', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    bob.accounts.get(bob.accountOf(MIA, 'spend')!)!.balance = 50 // the job pay was spent before splitting
    const v = (await unsplitOf(api, mia)).version
    const vars = { c: MIA, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-poor-001') }
    const out = (await api.gql(mia, SPLIT, vars)).body.data!.splitUnsplit as SplitOut
    expect(out.operations[0]).toMatchObject({ status: 'FAILED', reason: 'INSUFFICIENT_FUNDS' })
    expect(out.unsplit.balance.amount).toBe('2.00')
    await api.gql(mia, SPLIT, vars) // replay
    expect((await readLedger(db, MIA))!.balanceCents).toBe(200)
    expect(allocLegs()).toHaveLength(0)
    await api.app.close()
  })
})

describe('split-to-progress latency (target 1 s or less, where exercised)', () => {
  it('measured in process against the in-memory BOB', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    const t0 = performance.now()
    await api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-lat-0001') })
    const ms = performance.now() - t0
    console.log(`split-to-progress: ${ms.toFixed(1)} ms (in-memory BOB; not a deployed measurement)`)
    expect(ms).toBeLessThan(1_000)
    await api.app.close()
  })
})

describe('review R1: IDEMPOTENCY_CONFLICT never restores the unsplit balance (bob-family/1 §2.3)', () => {
  it('BOB commits, the answer is lost, the retry gets an injected 409: PENDING, balance held, and a new key cannot split the same money again', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    const vars = { c: MIA, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-r1-a') }
    bob.dropResponses = { re: /allocations$/, count: 1 }
    await api.gql(mia, SPLIT, vars)
    bob.failBefore = { re: /allocations$/, count: 1, status: 409, code: 'IDEMPOTENCY_CONFLICT' }
    const r = (await api.gql(mia, SPLIT, vars)).body.data!.splitUnsplit as SplitOut
    expect(r.operations[0]).toMatchObject({ status: 'PENDING', reason: 'IDEMPOTENCY_CONFLICT' })
    expect(r.unsplit.balance.amount).toBe('0.00')
    // The reviewer's probe: a second split under a new key.
    const v2 = (await unsplitOf(api, mia)).version
    expect(codeOf((await api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '0.60', '0.40'), v: v2, key: K('split-r1-b') })).body)).toBe('INVALID')
    expect(bob.balance(MIA, 'save')).toBe(60)
    expect(allocLegs()).toHaveLength(2)
    // Reconcile: the same request again replays BOB's original answer and completes once.
    const done = (await api.gql(mia, SPLIT, vars)).body.data!.splitUnsplit as SplitOut
    expect(done.operations[0]!.status).toBe('COMPLETED')
    expect((await readLedger(db, MIA))!.balanceCents).toBe(0)
    expect(allocLegs()).toHaveLength(2)
    await api.app.close()
  })

  it('IDEMPOTENCY_IN_PROGRESS also stays PENDING with the balance held', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    bob.failBefore = { re: /allocations$/, count: 1, status: 409, code: 'IDEMPOTENCY_IN_PROGRESS' }
    const r = (await api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-r1-c') })).body.data!.splitUnsplit as SplitOut
    expect(r.operations[0]).toMatchObject({ status: 'PENDING', reason: 'IDEMPOTENCY_IN_PROGRESS' })
    expect(r.unsplit.balance.amount).toBe('0.00')
    await api.app.close()
  })
})

describe('review optional 1 and 2: the Give outcome must match the Give share; the recipient is kept', () => {
  it.each([
    ['a Give share answered as none', (d: Record<string, unknown>) => ((d.give_outcome as Record<string, unknown>).status = 'none')],
    ['a Give amount that differs from the share', (d: Record<string, unknown>) => ((d.give_outcome as Record<string, unknown>).amount_cents = 39)],
  ])('%s stays PENDING (UPSTREAM_MISMATCH) and is never COMPLETED', async (_n, mutate) => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    bob.mutateFamily = (d) => {
      if ('allocation_ref' in d) mutate(d)
    }
    const r = (await api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-o1-a') })).body.data!.splitUnsplit as SplitOut
    expect(r.operations[0]).toMatchObject({ status: 'PENDING', reason: 'UPSTREAM_MISMATCH' })
    expect(r.giveOutcome).toBeNull()
    await api.app.close()
  })

  it('a donated Give keeps BOB’s recipient and revision on the operation', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    bob.recipients.set(MIA, { charityId: charity, revision: 1 })
    await payJob(api, bob.signIn(SARAH), mia)
    const v = (await unsplitOf(api, mia)).version
    await api.gql(mia, SPLIT, { c: MIA, legs: legs('1.00', '0.60', '0.40'), v, key: K('split-o2-a') })
    const op = (await db.collection('money_operations').findOne({ idempotencyKey: splitKey(splitOpId(MIA, K('split-o2-a'))) }))!
    expect(op.giveOutcome).toMatchObject({ status: 'DONATED', amountCents: 40, recipient: { charityId: charity, revision: 1 } })
    await api.app.close()
  })
})

describe('D52: Save→Give is a child allocation choice, through §6.1 so the D51 sweep applies', () => {
  const fund = (cents: number) => {
    bob.accounts.get(bob.accountOf(MIA, 'save')!)!.balance = cents
  }

  it('the move set is Spend→Save, Spend→Give, Save→Spend and Save→Give; nothing leaves Give', () => {
    expect(isChildJarMove('save', 'give')).toBe(true)
    expect(isChildJarMove('spend', 'save') && isChildJarMove('spend', 'give') && isChildJarMove('save', 'spend')).toBe(true)
    expect(isChildJarMove('give', 'save') || isChildJarMove('give', 'spend') || isChildJarMove('spend', 'spend')).toBe(false)
  })

  it('Save→Give with a confirmed recipient donates exactly that credit under the child’s session', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    bob.recipients.set(MIA, { charityId: charity, revision: 1 })
    fund(100)
    const out = await api.ports.family.allocate(new SessionToken(bob.signIn(MIA)), K('cs:d52-a:split'), { allocationRef: 'spl_d52a', fromJar: 'save', legs: [{ toJar: 'give', amountCents: 40 }] })
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') throw new Error('unreachable')
    expect(out.value.giveOutcome).toMatchObject({ status: 'donated', amountCents: 40, recipient: { charityId: charity, revision: 1 } })
    expect(allocCalls()).toHaveLength(1)
    expect(allocCalls()[0]!.body).toMatchObject({ from_jar: 'save', legs: [{ to_jar: 'give', amount_cents: 40 }] })
    expect(allocLegs()).toEqual([expect.objectContaining({ purpose: 'allocation', origin: 'child', amountCents: 40 })])
    expect(bob.ledger.filter((l) => l.purpose === 'donation').map((l) => l.amountCents)).toEqual([40])
    expect(bob.balance(MIA, 'save')).toBe(60)
    await api.app.close()
  })

  it('Save→Give with no confirmed recipient is held (HOLD-1); nothing is donated', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    fund(100)
    const out = await api.ports.family.allocate(new SessionToken(bob.signIn(MIA)), K('cs:d52-b:split'), { allocationRef: 'spl_d52b', fromJar: 'save', legs: [{ toJar: 'give', amountCents: 40 }] })
    expect(out.kind === 'ok' && out.value.giveOutcome.status).toBe('held')
    expect(bob.held.get(MIA)).toBe(40)
    expect(bob.balance(MIA, 'give')).toBe(40)
    expect(bob.ledger.filter((l) => l.purpose === 'donation')).toHaveLength(0)
    await api.app.close()
  })

  it('a move out of Give, or to the same jar, is refused before BOB: no call is sent', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const s = new SessionToken(bob.signIn(MIA))
    await expect(api.ports.family.allocate(s, K('cs:d52-c:split'), { allocationRef: 'spl_d52c', fromJar: 'give', legs: [{ toJar: 'save', amountCents: 1 }] })).rejects.toThrow(/not a child jar move/)
    await expect(api.ports.family.allocate(s, K('cs:d52-d:split'), { allocationRef: 'spl_d52d', fromJar: 'save', legs: [{ toJar: 'save', amountCents: 1 }] })).rejects.toThrow(/not a child jar move/)
    expect(allocCalls()).toHaveLength(0)
    await api.app.close()
  })
})
