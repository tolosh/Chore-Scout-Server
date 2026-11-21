/**
 * Migration 002 (CS-3979, review 40045 A4): one index on allowance_cycles so the
 * Guardian's "is a payment still settling?" check reads only unsettled PAY cycles
 * of that child, instead of a cycleKey list that grew by one key a week.
 *
 * Additive only: a new, non-unique index. Code from before this migration ignores
 * it, so a rollback to an earlier image still reads the migrated database.
 * DocumentDB 5.0 supports compound indexes; createIndex is idempotent by name.
 */
import type { Migration } from './types.js'

export const CYCLE_CHILD_STATUS_INDEX = { key: { childCustomerId: 1, decision: 1, status: 1 } as const, name: 'child_decision_status' }

export const migration002: Migration = {
  id: '002-cycle-child-status',
  async up(db) {
    await db.collection('allowance_cycles').createIndex(CYCLE_CHILD_STATUS_INDEX.key, { name: CYCLE_CHILD_STATUS_INDEX.name })
  },
}
