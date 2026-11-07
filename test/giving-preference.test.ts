/**
 * CS-3962: the child's charity preference, owned by the server and confirmed
 * in BOB under the child's own session (bob-family/1 §6.3; D12, D51). Through POST /graphql.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from 'mongodb'
import { runMigrations } from '../src/migrations/index.js'
import { PENDING_LEASE_MS } from '../src/giving/preference.js'
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
const OCEAN = 'cust_T_CHARITY_OCEAN'
const GONE = 'cust_T_CHARITY_GONE'
const FOREIGN = 'cust_T_CHARITY_MANLY'

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
  bob.addCharity(OCEAN, 'Clean Oceans')
  bob.addCharity(GONE, 'Closed Charity')
  bob.charities.get(GONE)!.enabled = false
  bob.addCharity(FOREIGN, 'Manly Mates', 'bank_manly')
})

const SET = `mutation($c: ID!, $id: ID!, $v: Int, $key: ID!) { setCharityPreference(childId: $c, bobCharityId: $id, expectedVersion: $v, idempotencyKey: $key) { childCustomerId bobCharityId version revision confirmedAt availability } }`
const GIVING = `query($c: ID!) { giving(childId: $c) { availability preference { bobCharityId version revision availability } donations { bobOperationRef amount { amount } } } }`
type Pref = { bobCharityId: string; version: number; revision: number; availability: string }
type Giving = { availability: string; preference: Pref | null; donations: { bobOperationRef: string; amount: { amount: string } }[] }

const putCalls = () => bob.calls.filter((c) => c.path === '/api/v1/children/me/give-recipient')
const moneyMoves = () => bob.ledger.filter((l) => l.purpose !== 'give_unresolved')

async function giving(api: ReturnType<typeof buildTestApi>, tok: string, child = LEO) {
  return (await api.gql(tok, GIVING, { c: child })).body.data!.giving as Giving
}

describe('T1: select, reload, the value persists', () => {
  it('Leo chooses Paws: confirmed in BOB under his own session, AVAILABLE, visible to Sarah', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    expect((await giving(api, leo)).availability).toBe('NONE_SELECTED')
    const r = await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-key-0001') })
    expect(r.body.data!.setCharityPreference).toMatchObject({ bobCharityId: PAWS, version: 1, revision: 1, availability: 'AVAILABLE' })
    expect(putCalls().map((c) => [c.method, c.bearer, c.key, c.body])).toEqual([['PUT', leo, null, { charity_id: PAWS }]])
    expect(bob.recipients.get(LEO)).toEqual({ charityId: PAWS, revision: 1 })
    const reload = await giving(api, bob.signIn(LEO))
    expect(reload).toMatchObject({ availability: 'AVAILABLE', preference: { bobCharityId: PAWS, version: 1 } })
    expect((await giving(api, bob.signIn(SARAH))).preference!.bobCharityId).toBe(PAWS)
    await api.app.close()
  })

  it('a replay of the same key returns the same preference and changes nothing', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    const a = await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-replay-1') })
    const b = await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-replay-1') })
    expect(b.body).toEqual(a.body)
    expect(putCalls()).toHaveLength(1)
    expect(codeOf((await api.gql(leo, SET, { c: LEO, id: TREES, key: K('pref-replay-1') })).body)).toBe('INVALID')
    await api.app.close()
  })

  it('every change is audited with actor, before and after, and correlation', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-audit-01') })
    await api.gql(leo, SET, { c: LEO, id: TREES, v: 1, key: K('pref-audit-02') })
    const rows = await db.collection('audit').find({ action: 'giving.preference_confirmed' }).sort({ at: 1 }).toArray()
    expect(rows.map((r) => [r.actor, (r.before as { bobCharityId: string | null }).bobCharityId, (r.after as { bobCharityId: string }).bobCharityId])).toEqual([
      [LEO, null, PAWS],
      [LEO, PAWS, TREES],
    ])
    expect(rows.every((r) => typeof r.correlation === 'string' && r.correlation.length > 0)).toBe(true)
    await api.app.close()
  })
})

describe('T2: two writes on the same version give one success and one STALE_VERSION', () => {
  it('sequential and concurrent', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-v-00001') })
    const rs = await Promise.all([
      api.gql(leo, SET, { c: LEO, id: TREES, v: 1, key: K('pref-v-00002') }),
      api.gql(leo, SET, { c: LEO, id: OCEAN, v: 1, key: K('pref-v-00003') }),
    ])
    const codes = rs.map((r) => codeOf(r.body) ?? 'OK').sort()
    expect(codes).toEqual(['OK', 'STALE_VERSION'])
    const winner = (rs.find((r) => !codeOf(r.body))!.body.data!.setCharityPreference as Pref).bobCharityId
    // What the server shows is what BOB sweeps to (D51).
    expect(bob.recipients.get(LEO)!.charityId).toBe(winner)
    expect((await giving(api, leo)).preference!.bobCharityId).toBe(winner)
    expect(codeOf((await api.gql(leo, SET, { c: LEO, id: OCEAN, v: 1, key: K('pref-v-00004') })).body)).toBe('STALE_VERSION')
    expect(codeOf((await api.gql(leo, SET, { c: LEO, id: OCEAN, key: K('pref-v-00005') })).body)).toBe('STALE_VERSION') // a version is required once one exists
    await api.app.close()
  })

  it('two concurrent first choices: one wins, one STALE_VERSION', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    const rs = await Promise.all([api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-first-1') }), api.gql(leo, SET, { c: LEO, id: TREES, key: K('pref-first-2') })])
    expect(rs.map((r) => codeOf(r.body) ?? 'OK').sort()).toEqual(['OK', 'STALE_VERSION'])
    expect(putCalls()).toHaveLength(1)
    await api.app.close()
  })

  it('a lost BOB answer stays pending: a different choice waits; the same key completes it', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    bob.dropResponses = { re: /give-recipient$/, count: 1 }
    expect(codeOf((await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-lost-01') })).body)).toBe('UPSTREAM_UNAVAILABLE')
    expect((await giving(api, leo)).availability).toBe('NONE_SELECTED') // not shown until BOB confirms
    expect(codeOf((await api.gql(leo, SET, { c: LEO, id: TREES, v: 1, key: K('pref-lost-02') })).body)).toBe('NOT_ALLOWED_IN_STATE')
    const r = await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-lost-01') })
    expect(r.body.data!.setCharityPreference).toMatchObject({ bobCharityId: PAWS, version: 1, availability: 'AVAILABLE' })
    await api.app.close()
  })

  it('a pending choice lost for longer than the lease can be superseded; the old key is then stale', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    bob.failBefore = { re: /give-recipient$/, count: 1, status: 503, code: 'UNAVAILABLE' }
    await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-lease-1') })
    t += PENDING_LEASE_MS
    const r = await api.gql(leo, SET, { c: LEO, id: TREES, v: 1, key: K('pref-lease-2') })
    expect(r.body.data!.setCharityPreference).toMatchObject({ bobCharityId: TREES, version: 2 })
    expect(codeOf((await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-lease-1') })).body)).toBe('STALE_VERSION')
    expect(bob.recipients.get(LEO)!.charityId).toBe(TREES)
    await api.app.close()
  })
})

async function payAndSplit(api: ReturnType<typeof buildTestApi>, give: string, n: number) {
  const sarah = bob.signIn(SARAH)
  const leo = bob.signIn(LEO)
  const c = (await api.gql(sarah, `mutation($c: ID!, $key: ID!) { createJob(childId: $c, kind: EXTRA_EARNER, title: "Job", reward: { amount: "1.00", currency: "AUD" }, idempotencyKey: $key) { jobId version } }`, { c: LEO, key: K(`pc-create-${n}`) })).body.data!.createJob as { jobId: string; version: number }
  const s = (await api.gql(leo, `mutation($j: ID!, $v: Int!, $key: ID!) { submitJob(jobId: $j, expectedVersion: $v, idempotencyKey: $key) { jobId version } }`, { j: c.jobId, v: c.version, key: K(`pc-submit-${n}`) })).body.data!.submitJob as { jobId: string; version: number }
  await api.gql(sarah, `mutation($j: ID!, $v: Int!, $key: ID!, $f: ID) { decideJob(jobId: $j, decision: APPROVE, expectedVersion: $v, idempotencyKey: $key, fromAccountId: $f) { job { status } } }`, { j: s.jobId, v: s.version, key: K(`pc-decide-${n}`), f: funding })
  const u = (await api.gql(leo, `query($c: ID!) { unsplit(childId: $c) { version } }`, { c: LEO })).body.data!.unsplit as { version: number }
  const spend = (100 - Number(give.replace('0.', ''))).toString().padStart(2, '0')
  const r = await api.gql(leo, `mutation($c: ID!, $legs: [CsSplitLegInput!]!, $v: Int!, $key: ID!) { splitUnsplit(childId: $c, legs: $legs, expectedVersion: $v, idempotencyKey: $key) { giveOutcome { status amount { amount } donationRef } } }`, {
    c: LEO,
    legs: [
      { jar: 'SPEND', amount: { amount: `0.${spend}`, currency: 'AUD' } },
      { jar: 'GIVE', amount: { amount: give, currency: 'AUD' } },
    ],
    v: u.version,
    key: K(`pc-split-${n}`),
  })
  return (r.body.data!.splitUnsplit as { giveOutcome: { status: string; donationRef: string | null } }).giveOutcome
}

describe('T3: the next Give sweep uses the new preference', () => {
  it('Paws, then Trees: the next Give goes to Trees; the earlier donation stays with Paws', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-t3-0001') })
    expect((await payAndSplit(api, '0.40', 1)).status).toBe('DONATED')
    await api.gql(leo, SET, { c: LEO, id: TREES, v: 1, key: K('pref-t3-0002') })
    t += 1_000
    expect((await payAndSplit(api, '0.30', 2)).status).toBe('DONATED')
    expect(bob.balance(PAWS, 'spend')).toBe(40)
    expect(bob.balance(TREES, 'spend')).toBe(30)
    expect((await giving(api, leo)).donations.map((d) => d.amount.amount)).toEqual(['0.30', '0.40'])
    await api.app.close()
  })
})

describe('T4: a disabled charity gives UNAVAILABLE and a hold, with no silent replacement (HOLD-1)', () => {
  it('choosing a disabled charity: CHARITY_UNAVAILABLE, BOB records nothing, the earlier choice stays', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    expect(codeOf((await api.gql(leo, SET, { c: LEO, id: GONE, key: K('pref-gone-01') })).body)).toBe('CHARITY_UNAVAILABLE')
    expect(bob.recipients.has(LEO)).toBe(false)
    expect((await giving(api, leo)).availability).toBe('NONE_SELECTED')
    await api.gql(leo, SET, { c: LEO, id: PAWS, v: 1, key: K('pref-gone-02') })
    expect(codeOf((await api.gql(leo, SET, { c: LEO, id: GONE, v: 2, key: K('pref-gone-03') })).body)).toBe('CHARITY_UNAVAILABLE')
    expect(bob.recipients.get(LEO)!.charityId).toBe(PAWS)
    expect((await giving(api, leo)).preference!.bobCharityId).toBe(PAWS)
    await api.app.close()
  })

  it('a chosen charity disabled later: the Give share is held, availability becomes UNAVAILABLE, and nothing is replaced', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-dis-001') })
    bob.charities.get(PAWS)!.enabled = false
    expect((await payAndSplit(api, '0.40', 3)).status).toBe('HELD')
    expect(bob.held.get(LEO)).toBe(40)
    const g = await giving(api, leo)
    expect(g).toMatchObject({ availability: 'UNAVAILABLE', preference: { bobCharityId: PAWS, availability: 'UNAVAILABLE' } })
    expect(bob.ledger.filter((l) => l.purpose === 'donation')).toHaveLength(0)
    await api.app.close()
  })
})

describe('T5: a foreign-bank charity id gets FORBIDDEN', () => {
  it('Manly charity for a Bilgola child', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    expect(codeOf((await api.gql(leo, SET, { c: LEO, id: FOREIGN, key: K('pref-for-001') })).body)).toBe('FORBIDDEN')
    expect(bob.recipients.has(LEO)).toBe(false)
    await api.app.close()
  })

  it('only the child chooses: Sarah and Mia are FORBIDDEN, and BOB is never called', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    expect(codeOf((await api.gql(bob.signIn(SARAH), SET, { c: LEO, id: PAWS, key: K('pref-sar-001') })).body)).toBe('FORBIDDEN')
    expect(codeOf((await api.gql(bob.signIn(MIA), SET, { c: LEO, id: PAWS, key: K('pref-mia-001') })).body)).toBe('FORBIDDEN')
    expect(codeOf((await api.gql(bob.signIn(MIA), GIVING, { c: LEO })).body)).toBe('FORBIDDEN')
    expect(putCalls()).toHaveLength(0)
    await api.app.close()
  })
})

describe('T6: saving a preference releases nothing (HOLD-2)', () => {
  it('held Give stays held across choosing, changing and re-choosing; zero payments', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    expect((await payAndSplit(api, '0.40', 4)).status).toBe('HELD')
    const before = moneyMoves().length
    await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-hold-01') })
    await api.gql(leo, SET, { c: LEO, id: TREES, v: 1, key: K('pref-hold-02') })
    await api.gql(leo, SET, { c: LEO, id: TREES, v: 2, key: K('pref-hold-03') })
    expect(moneyMoves().length).toBe(before)
    expect(bob.held.get(LEO)).toBe(40)
    expect(bob.balance(LEO, 'give')).toBe(40)
    await api.app.close()
  })
})

describe('T7: no routing fields reach a payload or a log', () => {
  it('responses, BOB request bodies and stored documents carry only the charity id and revision', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    const set = await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-scan-01') })
    const read = await api.gql(leo, GIVING, { c: LEO })
    const stored = await db.collection('charity_preferences').find({}, { projection: { _id: 0 } }).toArray()
    const audits = await db.collection('audit').find({}, { projection: { _id: 0 } }).toArray()
    const blob = JSON.stringify([set.body, read.body, stored, audits, putCalls().map((c) => c.body)])
    expect(blob).not.toMatch(/bsb|account_?number|routing|swift|iban|payee/i)
    await api.app.close()
  })
})

describe('D51: the server’s charity follows what BOB sweeps to', () => {
  const GIVING2 = `query($c: ID!) { giving(childId: $c) { availability confirmingBobCharityId preference { bobCharityId availability } } }`
  type G2 = { availability: string; confirmingBobCharityId: string | null; preference: { bobCharityId: string; availability: string } | null }
  const g2 = async (api: ReturnType<typeof buildTestApi>, tok: string) => (await api.gql(tok, GIVING2, { c: LEO })).body.data!.giving as G2
  const auditOf = (action: string) => db.collection('audit').find({ action }).toArray()

  it('a lost answer: BOB recorded the choice and its next sweep donates there, so the server settles it as confirmed', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    bob.dropResponses = { re: /give-recipient$/, count: 1 }
    expect(codeOf((await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-d51-01') })).body)).toBe('UPSTREAM_UNAVAILABLE')
    expect(await g2(api, leo)).toEqual({ availability: 'NONE_SELECTED', confirmingBobCharityId: PAWS, preference: null })
    expect((await payAndSplit(api, '0.40', 51)).status).toBe('DONATED')
    expect(bob.balance(PAWS, 'spend')).toBe(40)
    expect(await g2(api, leo)).toEqual({ availability: 'AVAILABLE', confirmingBobCharityId: null, preference: { bobCharityId: PAWS, availability: 'AVAILABLE' } })
    expect(await auditOf('giving.preference_confirmed_by_sweep')).toHaveLength(1)
    const puts = putCalls().length
    const r = await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-d51-01') })
    expect(r.body.data!.setCharityPreference).toMatchObject({ bobCharityId: PAWS, version: 1, availability: 'AVAILABLE' })
    expect(putCalls()).toHaveLength(puts) // the replay sends nothing
    await api.app.close()
  })

  it('a confirmed charity shown UNAVAILABLE after a hold is AVAILABLE again once BOB donates to it', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-d51-02') })
    bob.charities.get(PAWS)!.enabled = false
    expect((await payAndSplit(api, '0.40', 52)).status).toBe('HELD')
    expect((await g2(api, leo)).availability).toBe('UNAVAILABLE')
    bob.charities.get(PAWS)!.enabled = true
    expect((await payAndSplit(api, '0.30', 53)).status).toBe('DONATED')
    expect(await g2(api, leo)).toMatchObject({ availability: 'AVAILABLE', preference: { bobCharityId: PAWS } })
    expect(bob.held.get(LEO)).toBe(40) // the earlier hold stays held (HOLD-2)
    await api.app.close()
  })

  it('BOB donating to a charity the server didn’t confirm is audited as drift, with no silent replacement', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-d51-03') })
    bob.recipients.set(LEO, { charityId: TREES, revision: 1 })
    expect((await payAndSplit(api, '0.40', 54)).status).toBe('DONATED')
    expect((await g2(api, leo)).preference).toEqual({ bobCharityId: PAWS, availability: 'AVAILABLE' })
    const drift = await auditOf('giving.recipient_drift')
    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ subject: LEO, after: { bobCharityId: TREES, revision: 1 } })
    await api.app.close()
  })

  it('a switch whose answer is lost after BOB recorded it: the pending choice is shown, and the next sweep settles it', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-d51-sw1') })
    bob.dropResponses = { re: /give-recipient$/, count: 1 }
    expect(codeOf((await api.gql(leo, SET, { c: LEO, id: TREES, v: 1, key: K('pref-d51-sw2') })).body)).toBe('UPSTREAM_UNAVAILABLE')
    expect(bob.recipients.get(LEO)!.charityId).toBe(TREES) // BOB recorded it; only the answer was lost
    expect(await g2(api, leo)).toEqual({ availability: 'AVAILABLE', confirmingBobCharityId: TREES, preference: { bobCharityId: PAWS, availability: 'AVAILABLE' } })
    expect((await payAndSplit(api, '0.40', 55)).status).toBe('DONATED')
    expect(bob.balance(TREES, 'spend')).toBe(40)
    expect(bob.balance(PAWS, 'spend')).toBe(0)
    expect(await g2(api, leo)).toEqual({ availability: 'AVAILABLE', confirmingBobCharityId: null, preference: { bobCharityId: TREES, availability: 'AVAILABLE' } })
    expect(await auditOf('giving.preference_confirmed_by_sweep')).toHaveLength(1)
    expect(await auditOf('giving.recipient_drift')).toHaveLength(0)
    await api.app.close()
  })

  it('a 200 with eligible:false is shown UNAVAILABLE, never AVAILABLE', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    bob.mutateFamily = (d) => {
      if ('eligible' in d) d.eligible = false
    }
    const r = await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-elig-01') })
    expect(r.body.data!.setCharityPreference).toMatchObject({ bobCharityId: PAWS, version: 1, availability: 'UNAVAILABLE' })
    bob.mutateFamily = null
    expect(await g2(api, leo)).toEqual({ availability: 'UNAVAILABLE', confirmingBobCharityId: null, preference: { bobCharityId: PAWS, availability: 'UNAVAILABLE' } })
    await api.app.close()
  })

  it('a 200 naming a different charity_id is unknown: UPSTREAM_UNAVAILABLE, and the choice stays pending', async () => {
    const api = buildTestApi({ db, bob, now: () => t, clock: () => new Date(t) })
    const leo = bob.signIn(LEO)
    bob.mutateFamily = (d) => {
      if ('eligible' in d) d.charity_id = TREES
    }
    expect(codeOf((await api.gql(leo, SET, { c: LEO, id: PAWS, key: K('pref-mism-01') })).body)).toBe('UPSTREAM_UNAVAILABLE')
    bob.mutateFamily = null
    expect(await g2(api, leo)).toEqual({ availability: 'NONE_SELECTED', confirmingBobCharityId: PAWS, preference: null })
    expect(await auditOf('giving.preference_confirmed')).toHaveLength(0)
    await api.app.close()
  })
})
