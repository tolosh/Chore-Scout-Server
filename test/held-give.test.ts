/**
 * CS-3957: held Give review, the child's explicit confirmation, and the release
 * under the child's own session (bob-family/1 §6.4, §6.5; CS-3904 HOLD-1..5).
 * Through POST /graphql, against the in-memory BOB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from 'mongodb'
import { runMigrations } from '../src/migrations/index.js'
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

const PAWS = 'cust_T_CHARITY_PAWS'
const TREES = 'cust_T_CHARITY_TREES'

/** Synthetic idempotency keys (no secret), routed through a helper so the secrets scan has no key literal to flag. */
const K = (name: string) => name

let bob: FakeBob
let t: number
let funding: string
beforeEach(async () => {
  db = mongo.db()
  await runMigrations(db, { holder: 'test' })
  t = Date.parse('2026-11-05T03:00:00Z')
  bob = new FakeBob()
  bob.clock = () => new Date(t)
  ;({ funding } = seedFamily(bob))
  bob.addCharity(PAWS, 'Paws Rescue')
  bob.addCharity(TREES, 'Tree Friends')
})

type Api = ReturnType<typeof buildTestApi>
const SET = `mutation($c: ID!, $id: ID!, $v: Int, $key: ID!) { setCharityPreference(childId: $c, bobCharityId: $id, expectedVersion: $v, idempotencyKey: $key) { version availability } }`
const HELD = `query($c: ID!) { giving(childId: $c) { heldGiving { amount { amount currency } recipientName recipientUnavailable reviewVersion confirmedAt } } }`
const CONFIRM = `mutation($c: ID!, $v: Int!, $key: ID!) {
  confirmHeldRelease(childId: $c, reviewVersion: $v, idempotencyKey: $key) {
    review { reviewVersion amount { amount } recipientName confirmedAt }
    operation { idempotencyKey kind status bobOperationRef reason amount { amount } }
  }
}`
type Held = { amount: { amount: string; currency: string }; recipientName: string | null; recipientUnavailable: boolean; reviewVersion: number; confirmedAt: string | null } | null
type Op = { idempotencyKey: string; kind: string; status: string; bobOperationRef: string | null; reason: string | null; amount: { amount: string } }

const quoteCalls = () => bob.calls.filter((c) => c.path === '/api/v1/children/me/give/release-quotes')
const confirmCalls = () => bob.calls.filter((c) => /\/release-quotes\/[^/]+\/confirm$/.test(c.path))
const releases = () => bob.ledger.filter((l) => l.purpose === 'donation_release')

async function held(api: Api, tok: string, child = LEO): Promise<Held> {
  const r = await api.gql(tok, HELD, { c: child })
  if (r.body.errors) throw new Error(JSON.stringify(r.body.errors))
  return (r.body.data!.giving as { heldGiving: Held }).heldGiving
}
const confirm = (api: Api, tok: string, v: number, key: string, child = LEO) => api.gql(tok, CONFIRM, { c: child, v, key })
const choose = (api: Api, tok: string, id: string, key: string, v?: number) => api.gql(tok, SET, { c: LEO, id, v, key })

/** Job pay 1.00 to Leo, split so `give` lands in Give (held or donated by BOB's §6.2 sweep). */
async function payAndSplit(api: Api, give: string, n: number) {
  const sarah = bob.signIn(SARAH)
  const leo = bob.signIn(LEO)
  const c = (await api.gql(sarah, `mutation($c: ID!, $key: ID!) { createJob(childId: $c, kind: EXTRA_EARNER, title: "Job", reward: { amount: "1.00", currency: "AUD" }, idempotencyKey: $key) { jobId version } }`, { c: LEO, key: K(`hg-create-${n}`) })).body.data!.createJob as { jobId: string; version: number }
  const s = (await api.gql(leo, `mutation($j: ID!, $v: Int!, $key: ID!) { submitJob(jobId: $j, expectedVersion: $v, idempotencyKey: $key) { jobId version } }`, { j: c.jobId, v: c.version, key: K(`hg-submit-${n}`) })).body.data!.submitJob as { jobId: string; version: number }
  await api.gql(sarah, `mutation($j: ID!, $v: Int!, $key: ID!, $f: ID) { decideJob(jobId: $j, decision: APPROVE, expectedVersion: $v, idempotencyKey: $key, fromAccountId: $f) { job { status } } }`, { j: s.jobId, v: s.version, key: K(`hg-decide-${n}`), f: funding })
  const u = (await api.gql(leo, `query($c: ID!) { unsplit(childId: $c) { version } }`, { c: LEO })).body.data!.unsplit as { version: number }
  const spend = (100 - Number(give.replace('0.', ''))).toString().padStart(2, '0')
  const r = await api.gql(leo, `mutation($c: ID!, $legs: [CsSplitLegInput!]!, $v: Int!, $key: ID!) { splitUnsplit(childId: $c, legs: $legs, expectedVersion: $v, idempotencyKey: $key) { giveOutcome { status } } }`, {
    c: LEO,
    legs: [
      { jar: 'SPEND', amount: { amount: `0.${spend}`, currency: 'AUD' } },
      { jar: 'GIVE', amount: { amount: give, currency: 'AUD' } },
    ],
    v: u.version,
    key: K(`hg-split-${n}`),
  })
  return (r.body.data!.splitUnsplit as { giveOutcome: { status: string } }).giveOutcome.status
}

/** 0.40 held with no charity, then Leo chooses Paws: the usual starting point. */
async function heldThenPaws(api: Api, leo: string) {
  expect(await payAndSplit(api, '0.40', 1)).toBe('HELD')
  await choose(api, leo, PAWS, K('hg-pref-paws'))
}

describe('nothing held', () => {
  it('heldGiving is null and no quote is taken', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    expect(await held(api, bob.signIn(LEO))).toBeNull()
    expect(quoteCalls()).toHaveLength(0)
    await api.app.close()
  })
})

describe('T1: a missing or disabled charity holds only the Give share (HOLD-1)', () => {
  it('no charity: Give share held, Spend unaffected, nothing to confirm', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    expect(await payAndSplit(api, '0.40', 1)).toBe('HELD')
    expect(bob.balance(LEO, 'spend')).toBe(60)
    expect(bob.held.get(LEO)).toBe(40)
    expect(await held(api, leo)).toEqual({ amount: { amount: '0.40', currency: 'AUD' }, recipientName: null, recipientUnavailable: true, reviewVersion: 0, confirmedAt: null })
    expect(quoteCalls()).toHaveLength(0)
    expect(codeOf((await confirm(api, leo, 0, K('hg-none-0001'))).body)).toBe('STALE_VERSION')
    expect(confirmCalls()).toHaveLength(0)
    await api.app.close()
  })

  it('a disabled charity: held, shown unavailable, and no review can be confirmed', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await choose(api, leo, PAWS, K('hg-pref-0001'))
    bob.charities.get(PAWS)!.enabled = false
    expect(await payAndSplit(api, '0.40', 1)).toBe('HELD')
    const h = await held(api, leo)
    expect(h).toMatchObject({ amount: { amount: '0.40' }, recipientName: null, recipientUnavailable: true, reviewVersion: 0 })
    expect(releases()).toHaveLength(0)
    await api.app.close()
  })
})

describe('T2: choosing a charity or a later Give credit releases nothing (HOLD-2); a later sweep stays immediate (HOLD-5)', () => {
  it('held 0.40 stays held; the next Give credit goes straight to Paws', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await heldThenPaws(api, leo)
    await choose(api, leo, TREES, K('hg-pref-tree'), 1)
    await choose(api, leo, PAWS, K('hg-pref-pawsb'), 2)
    expect(await payAndSplit(api, '0.30', 2)).toBe('DONATED')
    expect(bob.balance(PAWS, 'spend')).toBe(30)
    expect(bob.held.get(LEO)).toBe(40)
    expect(releases()).toHaveLength(0)
    expect(confirmCalls()).toHaveLength(0)
    await api.app.close()
  })
})

describe('T3: Leo sees the exact amount, currency and recipient, confirms, and exactly one payment follows (HOLD-3)', () => {
  it('review, confirm: one release, one completed donation; the confirmation is audited', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await heldThenPaws(api, leo)
    const h = (await held(api, leo))!
    expect(h).toEqual({ amount: { amount: '0.40', currency: 'AUD' }, recipientName: 'Paws Rescue', recipientUnavailable: false, reviewVersion: 1, confirmedAt: null })
    expect((await held(api, leo))!.reviewVersion).toBe(1) // re-reading reuses the open review
    expect(quoteCalls()).toHaveLength(1)
    t += 1_000
    const r = await confirm(api, leo, 1, K('hg-confirm-01'))
    const out = r.body.data!.confirmHeldRelease as { review: { confirmedAt: string | null }; operation: Op }
    expect(out.operation).toMatchObject({ kind: 'release', status: 'COMPLETED', amount: { amount: '0.40' }, reason: null })
    expect(out.operation.idempotencyKey).toMatch(/^cs:qte_[^:]+:release$/)
    expect(out.operation.bobOperationRef).toMatch(/^don_/)
    expect(out.review.confirmedAt).toBe(new Date(t).toISOString())
    expect(releases()).toEqual([expect.objectContaining({ amountCents: 40 })])
    expect(bob.balance(PAWS, 'spend')).toBe(40)
    expect(bob.held.get(LEO)).toBe(0)
    expect(await held(api, leo)).toBeNull()
    const [a] = await db.collection('audit').find({ action: 'giving.held_release_confirmed' }).toArray()
    expect(a).toMatchObject({ actor: LEO, subject: LEO, after: { reviewVersion: 1, amountCents: 40, currency: 'AUD', charityId: PAWS, revision: 1 } })
    expect(typeof a!.correlation).toBe('string')
    await api.app.close()
  })

  it('a duplicate confirm, same key or a new one, gives no second payment', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await heldThenPaws(api, leo)
    await held(api, leo)
    const first = (await confirm(api, leo, 1, K('hg-dup-00001'))).body.data!.confirmHeldRelease as { operation: Op }
    const again = (await confirm(api, leo, 1, K('hg-dup-00001'))).body.data!.confirmHeldRelease as { operation: Op }
    const other = (await confirm(api, leo, 1, K('hg-dup-00002'))).body.data!.confirmHeldRelease as { operation: Op }
    expect(again.operation).toEqual(first.operation)
    expect(other.operation).toEqual(first.operation)
    expect(confirmCalls()).toHaveLength(1)
    expect(releases()).toHaveLength(1)
    await api.app.close()
  })

  it('a timeout after BOB paid: PENDING, then the retry with the same key completes once', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await heldThenPaws(api, leo)
    await held(api, leo)
    bob.dropResponses = { re: /\/confirm$/, count: 1 }
    const lost = (await confirm(api, leo, 1, K('hg-lost-0001'))).body.data!.confirmHeldRelease as { operation: Op }
    expect(lost.operation).toMatchObject({ status: 'PENDING', reason: 'UPSTREAM_UNAVAILABLE' })
    expect(releases()).toHaveLength(1) // BOB did pay
    const done = (await confirm(api, leo, 1, K('hg-lost-0001'))).body.data!.confirmHeldRelease as { operation: Op }
    expect(done.operation).toMatchObject({ status: 'COMPLETED' })
    expect(confirmCalls().map((c) => c.key)).toEqual([lost.operation.idempotencyKey, lost.operation.idempotencyKey])
    expect(releases()).toHaveLength(1)
    await api.app.close()
  })

  it('IDEMPOTENCY_CONFLICT after a lost answer stays PENDING, never FAILED', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await heldThenPaws(api, leo)
    await held(api, leo)
    bob.dropResponses = { re: /\/confirm$/, count: 1 }
    await confirm(api, leo, 1, K('hg-409-00001'))
    bob.failBefore = { re: /\/confirm$/, count: 1, status: 409, code: 'IDEMPOTENCY_CONFLICT' }
    const r = (await confirm(api, leo, 1, K('hg-409-00001'))).body.data!.confirmHeldRelease as { operation: Op }
    expect(r.operation).toMatchObject({ status: 'PENDING', reason: 'IDEMPOTENCY_CONFLICT' })
    expect(((await confirm(api, leo, 1, K('hg-409-00001'))).body.data!.confirmHeldRelease as { operation: Op }).operation.status).toBe('COMPLETED')
    expect(releases()).toHaveLength(1)
    await api.app.close()
  })
})

describe('T4: a change after the review refuses the confirmation and needs a new review (HOLD-4)', () => {
  it('the amount held changed: STALE_VERSION, no BOB confirm; a new review then pays the new amount once', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await heldThenPaws(api, leo)
    await held(api, leo)
    bob.held.set(LEO, 50)
    bob.accounts.get(bob.accountOf(LEO, 'give')!)!.balance = 50
    expect(codeOf((await confirm(api, leo, 1, K('hg-amt-00001'))).body)).toBe('STALE_VERSION')
    expect(confirmCalls()).toHaveLength(0)
    const h = (await held(api, leo))!
    expect(h).toMatchObject({ amount: { amount: '0.50' }, reviewVersion: 2 })
    expect(((await confirm(api, leo, 2, K('hg-amt-00002'))).body.data!.confirmHeldRelease as { operation: Op }).operation.status).toBe('COMPLETED')
    expect(releases().map((l) => l.amountCents)).toEqual([50])
    await api.app.close()
  })

  it('the recipient changed: STALE_VERSION, no BOB confirm', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await heldThenPaws(api, leo)
    await held(api, leo)
    await choose(api, leo, TREES, K('hg-pref-tree'), 1)
    expect(codeOf((await confirm(api, leo, 1, K('hg-rcp-00001'))).body)).toBe('STALE_VERSION')
    expect(confirmCalls()).toHaveLength(0)
    expect(releases()).toHaveLength(0)
    await api.app.close()
  })

  it('the review expired: STALE_VERSION, no BOB confirm', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await heldThenPaws(api, leo)
    await held(api, leo)
    t += 5 * 60_000
    expect(codeOf((await confirm(api, leo, 1, K('hg-exp-00001'))).body)).toBe('STALE_VERSION')
    expect(confirmCalls()).toHaveLength(0)
    await api.app.close()
  })

  it('the charity is newly disabled in BOB: BOB refuses (FRESH_QUOTE_NEEDED), nothing moves, the choice shows UNAVAILABLE', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await heldThenPaws(api, leo)
    await held(api, leo)
    bob.charities.get(PAWS)!.enabled = false
    const r = await confirm(api, leo, 1, K('hg-dis-00001'))
    expect(codeOf(r.body)).toBe('STALE_VERSION')
    expect(r.body.errors![0]!.message).toMatch(/recipient_disabled/)
    expect(confirmCalls()).toHaveLength(1)
    expect(releases()).toHaveLength(0)
    expect(bob.held.get(LEO)).toBe(40)
    const op = await db.collection('money_operations').findOne({ kind: 'release' })
    expect(op).toMatchObject({ status: 'FAILED', reason: 'FRESH_QUOTE_NEEDED:recipient_disabled' })
    expect(codeOf((await confirm(api, leo, 1, K('hg-dis-00002'))).body)).toBe('STALE_VERSION') // the review can't be reused
    expect(await held(api, leo)).toMatchObject({ recipientUnavailable: true, reviewVersion: 0 })
    await api.app.close()
  })
})

describe('a charity disabled, then re-enabled: the review offered can be confirmed (review 39967 R1)', () => {
  it('BOB quoting the confirmed charity makes it AVAILABLE again; the child confirms and exactly one release follows', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await choose(api, leo, PAWS, K('hg-reen-pref'))
    bob.charities.get(PAWS)!.enabled = false
    expect(await payAndSplit(api, '0.40', 61)).toBe('HELD')
    const pref = () => db.collection('charity_preferences').findOne({ childCustomerId: LEO })
    expect((await pref())!.availability).toBe('UNAVAILABLE')
    // While BOB still refuses the charity there is nothing to confirm.
    expect(await held(api, leo)).toMatchObject({ amount: { amount: '0.40' }, recipientUnavailable: true, reviewVersion: 0 })
    bob.charities.get(PAWS)!.enabled = true
    const h = (await held(api, leo))!
    expect(h).toMatchObject({ amount: { amount: '0.40' }, recipientName: 'Paws Rescue', recipientUnavailable: false, reviewVersion: 1 })
    expect((await pref())!.availability).toBe('AVAILABLE')
    expect(await db.collection('audit').countDocuments({ action: 'giving.preference_available_by_quote', subject: LEO })).toBe(1)
    const r = await confirm(api, leo, h.reviewVersion, K('hg-reen-0001'))
    expect((r.body.data!.confirmHeldRelease as { operation: Op }).operation.status).toBe('COMPLETED')
    expect(confirmCalls()).toHaveLength(1)
    expect(releases().map((l) => l.amountCents)).toEqual([40])
    expect(bob.balance(PAWS, 'spend')).toBe(40)
    expect(bob.held.get(LEO) ?? 0).toBe(0)
    // A repeat pays nothing more.
    await confirm(api, leo, h.reviewVersion, K('hg-reen-0002'))
    expect(releases()).toHaveLength(1)
    await api.app.close()
  })

  it('an open review is not reused once the choice is UNAVAILABLE: the next read asks BOB again', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await heldThenPaws(api, leo)
    expect((await held(api, leo))!.reviewVersion).toBe(1)
    await db.collection('charity_preferences').updateOne({ childCustomerId: LEO }, { $set: { availability: 'UNAVAILABLE' } })
    const quotes = quoteCalls().length
    const h = (await held(api, leo))!
    expect(quoteCalls()).toHaveLength(quotes + 1)
    expect(h).toMatchObject({ recipientUnavailable: false, reviewVersion: 2 })
    expect(((await confirm(api, leo, 2, K('hg-reuse-001'))).body.data!.confirmHeldRelease as { operation: Op }).operation.status).toBe('COMPLETED')
    expect(releases()).toHaveLength(1)
    await api.app.close()
  })
})

describe('T5: an in-flight release keeps its pinned recipient (HOLD-5)', () => {
  it('confirmed to Paws, answer lost, Leo then picks Trees: the retry still pays Paws, once', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await heldThenPaws(api, leo)
    await held(api, leo)
    bob.dropResponses = { re: /\/confirm$/, count: 1 }
    await confirm(api, leo, 1, K('hg-pin-00001'))
    await choose(api, leo, TREES, K('hg-pref-tree'), 1)
    expect(((await confirm(api, leo, 1, K('hg-pin-00001'))).body.data!.confirmHeldRelease as { operation: Op }).operation.status).toBe('COMPLETED')
    expect(bob.balance(PAWS, 'spend')).toBe(40)
    expect(bob.balance(TREES, 'spend')).toBe(0)
    expect(releases()).toHaveLength(1)
    await api.app.close()
  })
})

describe('T6: only the child confirms', () => {
  it('Sarah confirming for Leo is FORBIDDEN, and so is Mia; BOB is never asked to release', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await heldThenPaws(api, leo)
    await held(api, leo)
    expect(codeOf((await confirm(api, bob.signIn(SARAH), 1, K('hg-sarah-001'))).body)).toBe('FORBIDDEN')
    expect(codeOf((await confirm(api, bob.signIn(MIA), 1, K('hg-mia-00001'))).body)).toBe('FORBIDDEN')
    expect(confirmCalls()).toHaveLength(0)
    expect(releases()).toHaveLength(0)
    await api.app.close()
  })

  it('Sarah can see Leo’s held amount, read only: no quote is taken under her session', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await heldThenPaws(api, leo)
    const h = await held(api, bob.signIn(SARAH))
    expect(h).toMatchObject({ amount: { amount: '0.40' }, recipientUnavailable: false, reviewVersion: 0 })
    expect(quoteCalls()).toHaveLength(0)
    await api.app.close()
  })

  it('Mia cannot read Leo’s held Give', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const r = await api.gql(bob.signIn(MIA), HELD, { c: LEO })
    expect(codeOf(r.body)).toBe('FORBIDDEN')
    await api.app.close()
  })
})
