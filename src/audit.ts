/**
 * Audit trail (spec §5 `audit`): actor, action, before/after, correlation.
 * Customer numbers and object ids only. Never contact details, tokens or card numbers.
 */
import type { Db } from 'mongodb'

export interface AuditEntry {
  actor: string
  tenantId: string
  action: string
  subject: string
  before?: unknown
  after?: unknown
  correlation: string
}

export async function audit(db: Db, e: AuditEntry, now: Date): Promise<void> {
  await db.collection('audit').insertOne({ ...e, at: now })
}
