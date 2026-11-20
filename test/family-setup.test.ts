/**
 * CS-3948: family set-up orchestration under Sarah's session, with one set-up
 * reference and safe resume. Through POST /graphql, the real bob-family/1
 * client, and an in-memory BOB serving §4.1.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from 'mongodb'
import { REGISTERED_JOBS } from '../src/jobs/registry.js'
import { runMigrations } from '../src/migrations/index.js'
import { slotKey } from '../src/family-setup/service.js'
import { FakeBob } from './fakes/bob.js'
import { buildTestApi, codeOf } from './helpers/api.js'
import { startMongo, type TestMongo } from './helpers/mongo.js'

let mongo: TestMongo
let db: Db
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})

const SARAH = 'cust_T_SARAH'
let bob: FakeBob
let t: number
beforeEach(async () => {
  db = mongo.db()
  await runMigrations(db, { holder: 'test' }) // the unique indexes the orchestration relies on
  t = Date.parse('2026-11-05T03:00:00Z')
  bob = new FakeBob()
  bob.clock = () => new Date(t)
  bob.addAdult(SARAH).addAdult('cust_T_STRANGER').addAdult('cust_T_MANLY', 'bank_manly').addChild('cust_T_KID')
})

const START = `mutation($ref: ID!, $children: [CsSetupChildInput!]!) {
  startFamilySetup(setupRef: $ref, children: $children) { setupRef state resumable familyId slots { slot state childCustomerId reason } }
}`
const GET = `query($ref: ID!) { familySetup(setupRef: $ref) { setupRef state resumable familyId slots { slot state childCustomerId reason } } }`
const FAMILY = '{ family { familyId childCustomerIds } viewer { linkedChildren { customerId status } } }'

const MIA = { firstName: 'Mia', dateOfBirth: '2017-03-02', email: 'mia.test@example.test' }
const LEO = { firstName: 'Leo', dateOfBirth: '2012-08-20', email: 'leo.test@example.test' }
const REF = 'setup-ref-0001'

type Setup = { setupRef: string; state: string; resumable: boolean; familyId: string | null; slots: { slot: number; state: string; childCustomerId: string | null; reason: string | null }[] }
const setupOf = (b: { data?: Record<string, unknown> | null }) => b.data!.startFamilySetup as Setup
const bobChildrenOf = (g: string) => bob.links.filter((l) => l.guardian === g).map((l) => l.child)
const createCalls = () => bob.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/children')

describe('happy path', () => {
  it('creates each child in BOB under Sarah’s session, then the family record: COMPLETE', async () => {
    const { gql, app } = buildTestApi({ db, bob, now: () => t })
    const tok = bob.signIn(SARAH)
    const r = await gql(tok, START, { ref: REF, children: [MIA, LEO] })
    expect(r.status).toBe(200)
    const s = setupOf(r.body)
    expect(s).toMatchObject({ state: 'COMPLETE', resumable: false })
    expect(s.slots.map((x) => x.state)).toEqual(['CREATED', 'CREATED'])
    const kids = bobChildrenOf(SARAH)
    expect(s.slots.map((x) => x.childCustomerId)).toEqual(kids)
    // Every BOB call carried Sarah's own token and the per-slot key.
    expect(createCalls().map((c) => [c.bearer, c.key])).toEqual([
      [tok, slotKey(REF, 1)],
      [tok, slotKey(REF, 2)],
    ])
    expect(createCalls()[0]!.body).toEqual({ first_name: 'Mia', date_of_birth: '2017-03-02', email: 'mia.test@example.test', guardian_confirms_authority: true })
    // The family pointer exists; BOB's links (pending until first sign-in) are what the viewer sees.
    t += 31_000
    const f = await gql(tok, FAMILY)
    expect(f.body.data!.family).toEqual({ familyId: s.familyId, childCustomerIds: kids })
    expect((f.body.data!.viewer as { linkedChildren: { status: string }[] }).linkedChildren.map((c) => c.status)).toEqual(['PENDING', 'PENDING'])
    await app.close()
  })

  it('records the set-up before calling BOB', async () => {
    const { gql, app } = buildTestApi({ db, bob, now: () => t })
    bob.failBefore = { re: /^\/api\/v1\/children$/, count: 10, status: 503, code: 'UNAVAILABLE' }
    const r = await gql(bob.signIn(SARAH), START, { ref: REF, children: [MIA] })
    expect(setupOf(r.body)).toMatchObject({ state: 'PARTIAL', resumable: true, slots: [{ state: 'PENDING', reason: 'UPSTREAM_UNAVAILABLE' }] })
    expect(await db.collection('family_setups').countDocuments({ setupRef: REF })).toBe(1)
    expect(await db.collection('families').countDocuments()).toBe(0)
    await app.close()
  })
})

describe('T1: the same setupRef twice gives one BOB customer per slot and one family', () => {
  it('a second submission makes no new BOB customer and no second family', async () => {
    const { gql, app } = buildTestApi({ db, bob, now: () => t })
    const tok = bob.signIn(SARAH)
    const a = setupOf((await gql(tok, START, { ref: REF, children: [MIA, LEO] })).body)
    const b = setupOf((await gql(tok, START, { ref: REF, children: [MIA, LEO] })).body)
    expect(b).toEqual(a)
    expect(bobChildrenOf(SARAH)).toHaveLength(2)
    expect(createCalls()).toHaveLength(2) // COMPLETE: the retry does not call BOB at all
    expect(await db.collection('families').countDocuments()).toBe(1)
    expect(await db.collection('family_setups').countDocuments()).toBe(1)
    await app.close()
  })

  it('concurrent submissions of the same setupRef still give one customer per slot', async () => {
    const { gql, app } = buildTestApi({ db, bob, now: () => t })
    const tok = bob.signIn(SARAH)
    await Promise.all([gql(tok, START, { ref: REF, children: [MIA, LEO] }), gql(tok, START, { ref: REF, children: [MIA, LEO] })])
    const done = setupOf((await gql(tok, START, { ref: REF, children: [MIA, LEO] })).body)
    expect(done.state).toBe('COMPLETE')
    expect(bobChildrenOf(SARAH)).toHaveLength(2)
    expect(await db.collection('families').countDocuments()).toBe(1)
    await app.close()
  })
})

describe('T2: a crash after BOB succeeds, then a resume with the same reference', () => {
  it('no duplicate child, and the set-up completes', async () => {
    const { gql, app } = buildTestApi({ db, bob, now: () => t })
    const tok = bob.signIn(SARAH)
    // BOB commits slot 1, but the server never sees the answer.
    bob.dropResponses = { re: /^\/api\/v1\/children$/, count: 1 }
    const first = setupOf((await gql(tok, START, { ref: REF, children: [MIA, LEO] })).body)
    expect(first).toMatchObject({ state: 'PARTIAL', resumable: true })
    expect(first.slots.map((s) => s.state)).toEqual(['PENDING', 'CREATED'])
    expect(bobChildrenOf(SARAH)).toHaveLength(2) // BOB did create Mia
    const resumed = setupOf((await gql(tok, START, { ref: REF, children: [MIA, LEO] })).body)
    expect(resumed.state).toBe('COMPLETE')
    expect(bobChildrenOf(SARAH)).toHaveLength(2) // and not again
    expect(resumed.slots[0]!.childCustomerId).toBe(bobChildrenOf(SARAH)[0])
    expect(createCalls().map((c) => c.key)).toEqual([slotKey(REF, 1), slotKey(REF, 2), slotKey(REF, 1)])
    await app.close()
  })
})

describe('T3: one slot rejected (email already used in the tenant)', () => {
  it('the other slot completes, PARTIAL, reason visible; the same email in another bank is allowed', async () => {
    bob.emails.set('bank_bilgola', new Set([LEO.email]))
    bob.emails.set('bank_manly', new Set([MIA.email]))
    const { gql, app } = buildTestApi({ db, bob, now: () => t })
    const tok = bob.signIn(SARAH)
    const s = setupOf((await gql(tok, START, { ref: REF, children: [MIA, LEO] })).body)
    expect(s).toMatchObject({ state: 'PARTIAL', resumable: false })
    expect(s.slots.map((x) => [x.state, x.reason])).toEqual([
      ['CREATED', null],
      ['REFUSED', 'EMAIL_IN_USE'],
    ])
    // Settled: the family pointer holds the created child.
    expect(await db.collection('families').findOne({}, { projection: { _id: 0, childCustomerIds: 1 } })).toEqual({ childCustomerIds: [s.slots[0]!.childCustomerId] })
    // A retry does not re-create Mia; BOB replays the refusal for Leo's key.
    const again = setupOf((await gql(tok, START, { ref: REF, children: [MIA, LEO] })).body)
    expect(again.slots.map((x) => x.state)).toEqual(['CREATED', 'REFUSED'])
    expect(bobChildrenOf(SARAH)).toHaveLength(1)
    await app.close()
  })

  it('a child outside 6-17 is refused by BOB (AGE_OUT_OF_RANGE)', async () => {
    const { gql, app } = buildTestApi({ db, bob, now: () => t })
    const s = setupOf((await gql(bob.signIn(SARAH), START, { ref: REF, children: [{ ...MIA, dateOfBirth: '2024-01-01' }] })).body)
    expect(s.slots[0]).toMatchObject({ state: 'REFUSED', reason: 'AGE_OUT_OF_RANGE' })
    await app.close()
  })

  it('a later set-up adds to the same family', async () => {
    const { gql, app } = buildTestApi({ db, bob, now: () => t })
    const tok = bob.signIn(SARAH)
    const a = setupOf((await gql(tok, START, { ref: REF, children: [MIA] })).body)
    const b = setupOf((await gql(tok, START, { ref: 'setup-ref-0002', children: [LEO] })).body)
    expect(b.familyId).toBe(a.familyId)
    expect(await db.collection('families').countDocuments()).toBe(1)
    expect((await db.collection('families').findOne())!.childCustomerIds).toHaveLength(2)
    await app.close()
  })
})

describe('T4: a child, an unrelated Guardian or a Bank of Manly session cannot start or resume it', () => {
  it('a child session cannot start a set-up', async () => {
    const { gql, app } = buildTestApi({ db, bob, now: () => t })
    const r = await gql(bob.signIn('cust_T_KID'), START, { ref: REF, children: [MIA] })
    expect(codeOf(r.body)).toBe('FORBIDDEN')
    expect(createCalls()).toHaveLength(0)
    expect(await db.collection('family_setups').countDocuments()).toBe(0)
    await app.close()
  })

  it.each(['cust_T_STRANGER', 'cust_T_MANLY', 'cust_T_KID'])('%s cannot resume or read Sarah’s set-up', async (who) => {
    const { gql, app } = buildTestApi({ db, bob, now: () => t })
    bob.failBefore = { re: /^\/api\/v1\/children$/, count: 1, status: 503, code: 'UNAVAILABLE' }
    await gql(bob.signIn(SARAH), START, { ref: REF, children: [MIA] })
    const callsBefore = createCalls().length
    const tok = bob.signIn(who)
    expect(codeOf((await gql(tok, START, { ref: REF, children: [MIA] })).body)).toBe('FORBIDDEN')
    expect(codeOf((await gql(tok, GET, { ref: REF })).body)).toBe('FORBIDDEN')
    expect(createCalls().length).toBe(callsBefore)
    await app.close()
  })
})

describe('T5: an expired Sarah session gives UNAUTHENTICATED on resume; a fresh sign-in resumes', () => {
  it('expired, then fresh', async () => {
    const { gql, app } = buildTestApi({ db, bob, now: () => t })
    const old = bob.signIn(SARAH)
    bob.failBefore = { re: /^\/api\/v1\/children$/, count: 1, status: 503, code: 'UNAVAILABLE' }
    expect(setupOf((await gql(old, START, { ref: REF, children: [MIA] })).body).resumable).toBe(true)
    bob.endSession(old)
    t += 31_000
    const r = await gql(old, START, { ref: REF, children: [MIA] })
    expect(r.status).toBe(401)
    expect(codeOf(r.body)).toBe('UNAUTHENTICATED')
    const fresh = bob.signIn(SARAH)
    expect(setupOf((await gql(fresh, START, { ref: REF, children: [MIA] })).body).state).toBe('COMPLETE')
    await app.close()
  })

  it('BOB refusing the session mid-call (inside the cache window) gives UNAUTHENTICATED and drops the cache entry', async () => {
    const { gql, app, cache } = buildTestApi({ db, bob, now: () => t })
    const tok = bob.signIn(SARAH)
    await gql(tok, '{ viewer { customerId } }')
    expect(cache.size).toBe(1)
    bob.endSession(tok) // the cached answer is still fresh, but BOB checks live
    const r = await gql(tok, START, { ref: REF, children: [MIA] })
    expect(codeOf(r.body)).toBe('UNAUTHENTICATED')
    expect(cache.size).toBe(0)
    expect(bobChildrenOf(SARAH)).toHaveLength(0)
    await app.close()
  })
})

describe('T6: no server-issued credentials, no pairing codes, no contact details kept, no background completion', () => {
  it('the server stores no name, email or date of birth, and issues nothing', async () => {
    const { gql, app } = buildTestApi({ db, bob, now: () => t })
    const r = await gql(bob.signIn(SARAH), START, { ref: REF, children: [MIA, LEO] })
    expect(JSON.stringify(r.body)).not.toMatch(/token|code|pin|password/i)
    for (const c of await db.listCollections().toArray()) {
      const dump = JSON.stringify(await db.collection(c.name).find().toArray())
      for (const v of [MIA.firstName, MIA.email, MIA.dateOfBirth, LEO.firstName, LEO.email, LEO.dateOfBirth]) expect(dump, c.name).not.toContain(v)
    }
    await app.close()
  })

  it('no scheduled job exists that could complete a set-up without Sarah', () => {
    // The only scheduled job is the allowance cycle (CS-3979); it creates no family set-up.
    expect([...REGISTERED_JOBS]).toEqual(['allowance-cycles'])
  })
})

describe('input validation', () => {
  it.each([
    ['short ref', 'abc', [MIA]],
    ['no children', REF, []],
    ['bad email', REF, [{ ...MIA, email: 'nope' }]],
    ['bad date', REF, [{ ...MIA, dateOfBirth: '03/02/2017' }]],
  ])('%s gives INVALID with no BOB call', async (_n, ref, children) => {
    const { gql, app } = buildTestApi({ db, bob, now: () => t })
    expect(codeOf((await gql(bob.signIn(SARAH), START, { ref, children })).body)).toBe('INVALID')
    expect(createCalls()).toHaveLength(0)
    await app.close()
  })

  it('a retry with a different number of children gives INVALID', async () => {
    const { gql, app } = buildTestApi({ db, bob, now: () => t })
    const tok = bob.signIn(SARAH)
    bob.failBefore = { re: /^\/api\/v1\/children$/, count: 1, status: 503, code: 'UNAVAILABLE' }
    await gql(tok, START, { ref: REF, children: [MIA] })
    expect(codeOf((await gql(tok, START, { ref: REF, children: [MIA, LEO] })).body)).toBe('INVALID')
    await app.close()
  })

  it('a retry with a changed child: BOB refuses (IDEMPOTENCY_CONFLICT), the slot stays resumable, never a second child', async () => {
    const { gql, app } = buildTestApi({ db, bob, now: () => t })
    const tok = bob.signIn(SARAH)
    bob.dropResponses = { re: /^\/api\/v1\/children$/, count: 1 }
    await gql(tok, START, { ref: REF, children: [MIA] })
    const s = setupOf((await gql(tok, START, { ref: REF, children: [{ ...MIA, firstName: 'Mya' }] })).body)
    expect(s).toMatchObject({ state: 'PARTIAL', resumable: true, slots: [{ state: 'PENDING', reason: 'IDEMPOTENCY_CONFLICT' }] })
    expect(bobChildrenOf(SARAH)).toHaveLength(1)
    const fixed = setupOf((await gql(tok, START, { ref: REF, children: [MIA] })).body)
    expect(fixed.state).toBe('COMPLETE')
    expect(fixed.slots[0]!.childCustomerId).toBe(bobChildrenOf(SARAH)[0])
    await app.close()
  })
})
