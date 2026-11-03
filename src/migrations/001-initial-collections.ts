/**
 * Migration 001: collections and indexes for the server data model in spec
 * 3220570116 §5 (v7). Keys are exactly the spec's key fields.
 *
 * Not created here:
 * - tenant configuration: owned by CS-3909 (drafts, versions, publish, audit).
 * - goals: listed as a query in §6 but absent from the §5 data model; recorded
 *   as a gap on CS-3941 rather than invented here.
 *
 * Unique indexes only where the spec makes the key idempotent or one-per-child
 * (setupRef, cycleKey, idempotencyKey, per-child rules, one grant per capability).
 *
 * DocumentDB 5.0: plain single-field and compound ascending indexes only, no
 * collation, no partial or text indexes, no validators.
 */
import type { Migration } from './types.js'

interface IndexSpec {
  key: Record<string, 1>
  unique?: boolean
  name: string
}

export const COLLECTION_INDEXES: Record<string, IndexSpec[]> = {
  family_setups: [{ key: { setupRef: 1 }, unique: true, name: 'setupRef_unique' }],
  families: [
    { key: { familyId: 1 }, unique: true, name: 'familyId_unique' },
    { key: { tenantId: 1, guardianCustomerIds: 1 }, name: 'tenant_guardian' },
    { key: { tenantId: 1, childCustomerIds: 1 }, name: 'tenant_child' },
  ],
  allowance_rules: [{ key: { childCustomerId: 1 }, unique: true, name: 'childCustomerId_unique' }],
  allowance_cycles: [{ key: { cycleKey: 1 }, unique: true, name: 'cycleKey_unique' }],
  jobs: [
    { key: { jobId: 1 }, unique: true, name: 'jobId_unique' },
    { key: { childCustomerId: 1, status: 1 }, name: 'child_status' },
  ],
  approvals: [
    { key: { approvalId: 1 }, unique: true, name: 'approvalId_unique' },
    { key: { kind: 1, status: 1 }, name: 'kind_status' },
  ],
  money_operations: [{ key: { idempotencyKey: 1 }, unique: true, name: 'idempotencyKey_unique' }],
  purchase_operations: [
    { key: { idempotencyKey: 1 }, unique: true, name: 'idempotencyKey_unique' },
    { key: { childCustomerId: 1 }, name: 'childCustomerId' },
  ],
  demo_merchants: [{ key: { tenantId: 1, merchantId: 1 }, unique: true, name: 'tenant_merchant_unique' }],
  unsplit_ledger: [{ key: { childCustomerId: 1 }, unique: true, name: 'childCustomerId_unique' }],
  charity_preferences: [{ key: { childCustomerId: 1 }, unique: true, name: 'childCustomerId_unique' }],
  held_give_reviews: [{ key: { childCustomerId: 1, reviewVersion: 1 }, name: 'child_reviewVersion' }],
  boost_rules: [{ key: { childCustomerId: 1 }, unique: true, name: 'childCustomerId_unique' }],
  unlock_grants: [{ key: { childCustomerId: 1, capability: 1 }, unique: true, name: 'child_capability_unique' }],
  mission_events: [{ key: { anonymousPlayerId: 1, mission: 1, level: 1 }, name: 'player_mission_level' }],
  audit: [
    { key: { correlation: 1 }, name: 'correlation' },
    { key: { actor: 1 }, name: 'actor' },
  ],
  leases: [],
}

export const migration001: Migration = {
  id: '001-initial-collections',
  async up(db) {
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name))
    for (const [name, indexes] of Object.entries(COLLECTION_INDEXES)) {
      if (!existing.has(name)) await db.createCollection(name)
      for (const idx of indexes) {
        await db.collection(name).createIndex(idx.key, { name: idx.name, unique: idx.unique ?? false })
      }
    }
  },
}
