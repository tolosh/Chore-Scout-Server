import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COLLECTION_INDEXES } from '../src/migrations/001-initial-collections.js'
import { MIGRATIONS, MIGRATIONS_COLLECTION, runMigrations } from '../src/migrations/index.js'
import { startMongo, type TestMongo } from './helpers/mongo.js'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})

// Spec 3220570116 §5 collections, except tenant configuration (CS-3909).
const SPEC_COLLECTIONS = [
  'family_setups', 'families', 'allowance_rules', 'allowance_cycles', 'jobs', 'approvals', 'money_operations',
  'purchase_operations', 'demo_merchants', 'unsplit_ledger', 'charity_preferences', 'held_give_reviews',
  'boost_rules', 'unlock_grants', 'mission_events', 'audit',
]

describe('migrations', () => {
  it('creates every §5 collection with its indexes', async () => {
    const db = mongo.db()
    expect(await runMigrations(db, { holder: 't' })).toEqual(MIGRATIONS.map((m) => m.id))
    const names = (await db.listCollections().toArray()).map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining([...SPEC_COLLECTIONS, 'leases', MIGRATIONS_COLLECTION]))
    for (const [coll, specs] of Object.entries(COLLECTION_INDEXES)) {
      const idx = await db.collection(coll).indexes()
      for (const s of specs) {
        const found = idx.find((i) => i.name === s.name)
        expect(found, `${coll}.${s.name}`).toBeDefined()
        expect(found?.key).toEqual(s.key)
        expect(Boolean(found?.unique)).toBe(Boolean(s.unique))
      }
    }
  })

  it('is idempotent on re-run', async () => {
    const db = mongo.db()
    await runMigrations(db, { holder: 't' })
    expect(await runMigrations(db, { holder: 't' })).toEqual([])
    expect(await db.collection(MIGRATIONS_COLLECTION).countDocuments()).toBe(MIGRATIONS.length)
  })

  it('concurrent boots apply each migration exactly once', async () => {
    const db = mongo.db()
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => runMigrations(db, { holder: `boot${i}`, pollMs: 20 })))
    expect(results.flat()).toEqual(MIGRATIONS.map((m) => m.id))
    expect(await db.collection(MIGRATIONS_COLLECTION).countDocuments()).toBe(MIGRATIONS.length)
  })

  it('unique keys enforce idempotency (allowance cycle key, operation idempotency key)', async () => {
    const db = mongo.db()
    await runMigrations(db, { holder: 't' })
    await db.collection('allowance_cycles').insertOne({ cycleKey: 'child1:2026-11-09' })
    await expect(db.collection('allowance_cycles').insertOne({ cycleKey: 'child1:2026-11-09' })).rejects.toMatchObject({ code: 11000 })
    await db.collection('money_operations').insertOne({ idempotencyKey: 'cs:op1:job' })
    await expect(db.collection('money_operations').insertOne({ idempotencyKey: 'cs:op1:job' })).rejects.toMatchObject({ code: 11000 })
  })

  it('rejects duplicate migration ids', async () => {
    const m = { id: 'dup', up: async () => undefined }
    await expect(runMigrations(mongo.db(), { holder: 't', migrations: [m, m] })).rejects.toThrow(/duplicate/)
  })
})
