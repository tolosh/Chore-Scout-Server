/**
 * CS-3942: every request's session is checked with BOB, and the server acts
 * only as that person. T1-T6 from the ticket, through POST /graphql with the
 * real adapter (bob-session/1) and cache over a FakeBob.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from 'mongodb'
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
const MIA = 'cust_T_MIA'
const LEO = 'cust_T_LEO'
const OTHER = 'cust_T_OTHER_GUARDIAN'
const OTHER_KID = 'cust_T_OTHER_KID'
const MANLY = 'cust_T_MANLY_GUARDIAN'
const MANLY_KID = 'cust_T_MANLY_KID'

let bob: FakeBob
let t: number
beforeEach(async () => {
  db = mongo.db()
  t = Date.parse('2026-11-05T03:00:00Z')
  bob = new FakeBob()
  bob.clock = () => new Date(t)
  bob
    .addAdult(SARAH)
    .addChild(MIA)
    .addChild(LEO, 'bank_bilgola', 'youth')
    .link(SARAH, MIA)
    .link(SARAH, LEO, 'pending')
    .addAdult(OTHER)
    .addChild(OTHER_KID)
    .link(OTHER, OTHER_KID)
    .addAdult(MANLY, 'bank_manly')
    .addChild(MANLY_KID, 'bank_manly')
    .link(MANLY, MANLY_KID)
  await db.collection('families').insertMany([
    { familyId: 'fam_T_1', tenantId: 'bank_bilgola', guardianCustomerIds: [SARAH], childCustomerIds: [MIA, LEO] },
    { familyId: 'fam_T_2', tenantId: 'bank_bilgola', guardianCustomerIds: [OTHER], childCustomerIds: [OTHER_KID] },
    { familyId: 'fam_T_3', tenantId: 'bank_manly', guardianCustomerIds: [MANLY], childCustomerIds: [MANLY_KID] },
  ])
})

const api = () => buildTestApi({ db, bob, now: () => t })

const VIEWER = '{ viewer { customerId role tenantId ageBand linkedChildIds linkedGuardianIds linkedChildren { customerId status } anonymousPlayerId } }'
const FAMILY = '{ family { familyId tenantId guardianCustomerIds childCustomerIds } }'
const CHILD = 'query($id: ID!) { child(id: $id) { customerId familyId ageBand } }'

describe('authentication', () => {
  it('no Authorization header: 401 UNAUTHENTICATED, BOB not called', async () => {
    const { gql, app } = api()
    const r = await gql(null, VIEWER)
    expect(r.status).toBe(401)
    expect(codeOf(r.body)).toBe('UNAUTHENTICATED')
    expect(bob.sessionCalls).toHaveLength(0)
    await app.close()
  })

  it('a malformed header is refused without calling BOB', async () => {
    const { app } = api()
    for (const authorization of ['Basic abc', 'Bearer', 'Bearer a b', `Bearer ${'x'.repeat(600)}`]) {
      const res = await app.inject({ method: 'POST', url: '/graphql', headers: { authorization }, payload: { query: VIEWER } })
      expect(res.statusCode).toBe(401)
    }
    expect(bob.sessionCalls).toHaveLength(0)
    await app.close()
  })

  it('BOB refuses the token: 401 UNAUTHENTICATED, nothing executed', async () => {
    const { gql, app } = api()
    const r = await gql('bobat_guessed', VIEWER)
    expect(r.status).toBe(401)
    expect(r.body.data).toBeUndefined()
    await app.close()
  })

  it('BOB down: 503 UPSTREAM_UNAVAILABLE (fail closed)', async () => {
    const { gql, app } = api()
    const tok = bob.signIn(SARAH)
    bob.override = { status: 503, body: { data: null, errors: [{ code: 'UNAVAILABLE' }] } }
    const r = await gql(tok, VIEWER)
    expect(r.status).toBe(503)
    expect(codeOf(r.body)).toBe('UPSTREAM_UNAVAILABLE')
    await app.close()
  })

  it('the session is checked before introspection or validation (no schema leak to an unknown caller)', async () => {
    const { gql, app } = api()
    const r = await gql('bobat_guessed', '{ __schema { types { name } } }')
    expect(r.status).toBe(401)
    await app.close()
  })

  it('introspection is refused in production even for a valid session', async () => {
    const { gql, app } = api()
    const r = await gql(bob.signIn(SARAH), '{ __schema { types { name } } }')
    expect(r.status).toBe(400)
    await app.close()
  })

  it('the forwarded token is passed to BOB unchanged and never logged or echoed', async () => {
    const { gql, app } = api()
    const tok = bob.signIn(SARAH)
    const r = await gql(tok, VIEWER)
    expect(bob.sessionCalls[0]!.authorization).toBe(`Bearer ${tok}`)
    expect(JSON.stringify(r.body)).not.toContain(tok)
    await app.close()
  })
})

describe('T1: Sarah’s session gives a viewer with exactly Mia and Leo (AUTH-3)', () => {
  it('viewer and family come from BOB', async () => {
    const { gql, app } = api()
    const tok = bob.signIn(SARAH)
    const v = await gql(tok, VIEWER)
    expect(v.status).toBe(200)
    expect(v.body.data!.viewer).toMatchObject({
      customerId: SARAH,
      role: 'GUARDIAN',
      tenantId: 'bank_bilgola',
      ageBand: null,
      linkedChildIds: [MIA, LEO],
      linkedGuardianIds: [],
      linkedChildren: [
        { customerId: MIA, status: 'ACTIVE' },
        { customerId: LEO, status: 'PENDING' },
      ],
    })
    const f = await gql(tok, FAMILY)
    expect(f.body.data!.family).toEqual({ familyId: 'fam_T_1', tenantId: 'bank_bilgola', guardianCustomerIds: [SARAH], childCustomerIds: [MIA, LEO] })
    await app.close()
  })

  it('family scope is BOB’s list, not the server table: a child added only to the table is not shown', async () => {
    await db.collection('families').updateOne({ familyId: 'fam_T_1' }, { $push: { childCustomerIds: OTHER_KID } as never })
    const { gql, app } = api()
    const tok = bob.signIn(SARAH)
    const f = await gql(tok, FAMILY)
    expect((f.body.data!.family as { childCustomerIds: string[] }).childCustomerIds).toEqual([MIA, LEO])
    const c = await gql(tok, CHILD, { id: OTHER_KID })
    expect(codeOf(c.body)).toBe('FORBIDDEN')
    await app.close()
  })

  it('a child sees themselves and their guardians, not siblings', async () => {
    const { gql, app } = api()
    const tok = bob.signIn(MIA)
    const v = await gql(tok, VIEWER)
    expect(v.body.data!.viewer).toMatchObject({ customerId: MIA, role: 'CHILD', ageBand: 'CHILD', linkedChildIds: [], linkedGuardianIds: [SARAH] })
    const f = await gql(tok, FAMILY)
    expect(f.body.data!.family).toEqual({ familyId: 'fam_T_1', tenantId: 'bank_bilgola', guardianCustomerIds: [SARAH], childCustomerIds: [MIA] })
    const own = await gql(tok, CHILD, { id: MIA })
    expect(own.body.data!.child).toEqual({ customerId: MIA, familyId: 'fam_T_1', ageBand: 'CHILD' })
    await app.close()
  })

  it('an adult with no links yet is CUSTOMER with no family (before set-up)', async () => {
    bob.addAdult('cust_T_NEW')
    const { gql, app } = api()
    const tok = bob.signIn('cust_T_NEW')
    const v = await gql(tok, VIEWER)
    expect(v.body.data!.viewer).toMatchObject({ role: 'CUSTOMER', linkedChildIds: [] })
    expect((await gql(tok, FAMILY)).body.data!.family).toBeNull()
    await app.close()
  })
})

describe('T2: an unrelated Guardian gets an empty family and FORBIDDEN on Mia’s objects', () => {
  it('no family of Sarah’s, FORBIDDEN on Mia', async () => {
    bob.addAdult('cust_T_STRANGER')
    const { gql, app } = api()
    const tok = bob.signIn('cust_T_STRANGER')
    expect((await gql(tok, FAMILY)).body.data!.family).toBeNull()
    const c = await gql(tok, CHILD, { id: MIA })
    expect(codeOf(c.body)).toBe('FORBIDDEN')
    expect(c.body.data!.child).toBeNull()
    await app.close()
  })

  it('another family’s Guardian sees only their own family, and FORBIDDEN on Mia', async () => {
    const { gql, app } = api()
    const tok = bob.signIn(OTHER)
    expect((await gql(tok, FAMILY)).body.data!.family).toMatchObject({ familyId: 'fam_T_2', childCustomerIds: [OTHER_KID] })
    expect(codeOf((await gql(tok, CHILD, { id: MIA })).body)).toBe('FORBIDDEN')
    await app.close()
  })

  it('FORBIDDEN looks the same for an existing and a non-existent child', async () => {
    const { gql, app } = api()
    const tok = bob.signIn(OTHER)
    const a = await gql(tok, CHILD, { id: MIA })
    const b = await gql(tok, CHILD, { id: 'cust_T_NOBODY' })
    expect(a.body).toEqual(b.body)
    await app.close()
  })
})

describe('T3: Mia asking for Leo’s objects gets FORBIDDEN (AUTH-2)', () => {
  it('child(id: Leo) under Mia’s session', async () => {
    const { gql, app } = api()
    const r = await gql(bob.signIn(MIA), CHILD, { id: LEO })
    expect(codeOf(r.body)).toBe('FORBIDDEN')
    await app.close()
  })
})

describe('T4: revocation in BOB takes effect within the cache window (AUTH-3, AUTH-4)', () => {
  it('a revoked session is refused once the 30 s window has passed', async () => {
    const { gql, app } = api()
    const tok = bob.signIn(MIA)
    expect((await gql(tok, VIEWER)).status).toBe(200)
    bob.endSession(tok)
    t += 10_000
    expect((await gql(tok, VIEWER)).status).toBe(200) // within the documented window
    t += 20_000
    const r = await gql(tok, VIEWER)
    expect(r.status).toBe(401)
    expect(codeOf(r.body)).toBe('UNAUTHENTICATED')
    await app.close()
  })

  it('a revoked link removes the child from Sarah’s scope after the window', async () => {
    const { gql, app } = api()
    const tok = bob.signIn(SARAH)
    expect((await gql(tok, CHILD, { id: MIA })).body.data!.child).toMatchObject({ customerId: MIA })
    bob.revokeLink(SARAH, MIA)
    t += 30_000
    expect(codeOf((await gql(tok, CHILD, { id: MIA })).body)).toBe('FORBIDDEN')
    expect((await gql(tok, VIEWER)).body.data!.viewer).toMatchObject({ linkedChildIds: [LEO] })
    await app.close()
  })

  it('the child’s side: a revoked link removes the guardian from the child’s answer', async () => {
    const { gql, app } = api()
    const tok = bob.signIn(MIA)
    bob.revokeLink(SARAH, MIA)
    t += 30_000
    expect((await gql(tok, VIEWER)).body.data!.viewer).toMatchObject({ linkedGuardianIds: [] })
    await app.close()
  })
})

describe('T5: a Bank of Manly session sees zero Bank of Bilgola data (AUTH-1)', () => {
  it('Manly guardian: own Manly family only; FORBIDDEN on every Bilgola child', async () => {
    const { gql, app } = api()
    const tok = bob.signIn(MANLY)
    const v = await gql(tok, VIEWER)
    expect(v.body.data!.viewer).toMatchObject({ tenantId: 'bank_manly', linkedChildIds: [MANLY_KID] })
    expect((await gql(tok, FAMILY)).body.data!.family).toMatchObject({ familyId: 'fam_T_3', tenantId: 'bank_manly' })
    for (const id of [MIA, LEO, OTHER_KID]) expect(codeOf((await gql(tok, CHILD, { id })).body)).toBe('FORBIDDEN')
    await app.close()
  })

  it('a Bilgola family record naming a Manly guardian is never served to them (tenant filter)', async () => {
    await db.collection('families').deleteOne({ familyId: 'fam_T_3' })
    await db.collection('families').insertOne({ familyId: 'fam_T_X', tenantId: 'bank_bilgola', guardianCustomerIds: [MANLY], childCustomerIds: [MIA] })
    const { gql, app } = api()
    const tok = bob.signIn(MANLY)
    expect((await gql(tok, FAMILY)).body.data!.family).toBeNull()
    await app.close()
  })

  it('a Manly child cannot read their own child record from a Bilgola family', async () => {
    await db.collection('families').updateOne({ familyId: 'fam_T_3' }, { $set: { tenantId: 'bank_bilgola' } })
    const { gql, app } = api()
    const r = await gql(bob.signIn(MANLY_KID), CHILD, { id: MANLY_KID })
    expect(r.body.data!.child).toBeNull()
    await app.close()
  })
})

describe('T6: no customer-id literals in code or config; no names or emails stored', () => {
  const ROOT = new URL('..', import.meta.url).pathname
  const files = (dir: string): string[] =>
    readdirSync(join(ROOT, dir)).flatMap((n) => {
      const p = join(dir, n)
      return statSync(join(ROOT, p)).isDirectory() ? files(p) : [p]
    })
  const shipped = ['src', 'schema', 'infra', 'scripts'].flatMap(files).concat(['Dockerfile', '.env.example', 'package.json'])

  it('no BOB customer, account, link or player id literal in shipped code or config', () => {
    const hits = shipped.filter((f) => /\b(cust|acc|lnk|ply|ses)_[A-Za-z0-9]{3,}/.test(readFileSync(join(ROOT, f), 'utf8')))
    expect(hits).toEqual([])
  })

  it('no email address literal in shipped code or config', () => {
    const hits = shipped.filter((f) => /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(readFileSync(join(ROOT, f), 'utf8')))
    expect(hits).toEqual([])
  })

  it('serving a request stores nothing about the person', async () => {
    const before = await Promise.all((await db.listCollections().toArray()).map(async (c) => [c.name, await db.collection(c.name).countDocuments()]))
    const { gql, app } = api()
    await gql(bob.signIn(SARAH), VIEWER)
    await gql(bob.signIn(MIA), FAMILY)
    const after = await Promise.all((await db.listCollections().toArray()).map(async (c) => [c.name, await db.collection(c.name).countDocuments()]))
    expect(after).toEqual(before)
    await app.close()
  })
})

describe('unbuilt fields', () => {
  it('say so instead of returning an invented answer', async () => {
    const { gql, app } = api()
    const r = await gql(bob.signIn(SARAH), '{ demoMerchants { merchantId } }')
    expect(codeOf(r.body)).toBe('UPSTREAM_UNAVAILABLE')
    expect(r.body.errors![0]!.message).toMatch(/not built/)
    await app.close()
  })
})
