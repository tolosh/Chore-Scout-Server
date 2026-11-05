/**
 * The unsplit ledger (spec §5 `unsplit_ledger`; D08; strategy point 3).
 *
 * Credited ONLY by completed job pay: the single entry point is
 * creditFromJobPayment, which takes a COMPLETED job money operation. (The one
 * other increase, restoreFailedSplit, undoes this ledger's own debit when BOB
 * refused a split and moved nothing: no new money.) The
 * allowance never appears here (it auto-splits in BOB and is shown as a
 * receipt). Each credit's entryId is the job payment's idempotency key, so a
 * replay can never credit twice.
 *
 * DocumentDB: no upserts. A missing ledger is created by insertOne; E11000
 * means a concurrent creator won, and the credit is retried as an update.
 */
import { MongoServerError, type Db } from 'mongodb'

export interface UnsplitEntry {
  entryId: string
  jobId: string
  amountCents: number
  createdAt: Date
}

export interface UnsplitLedgerDoc {
  childCustomerId: string
  tenantId: string
  balanceCents: number
  entries: UnsplitEntry[]
  /** Split operations already debited (CS-3953): idempotency for allocation. */
  debits: { opKey: string; amountCents: number; at: Date }[]
  version: number
}

export interface CompletedJobPayment {
  idempotencyKey: string
  kind: 'job'
  status: 'COMPLETED'
  jobId: string
  childCustomerId: string
  tenantId: string
  amountCents: number
}

export const LEDGER = 'unsplit_ledger'

export async function creditFromJobPayment(db: Db, op: CompletedJobPayment, now: Date): Promise<void> {
  if (op.kind !== 'job' || op.status !== 'COMPLETED') throw new Error('only completed job pay credits the unsplit ledger')
  const ledger = db.collection<UnsplitLedgerDoc>(LEDGER)
  const entry: UnsplitEntry = { entryId: op.idempotencyKey, jobId: op.jobId, amountCents: op.amountCents, createdAt: now }
  for (let i = 0; i < 3; i++) {
    const r = await ledger.updateOne(
      { childCustomerId: op.childCustomerId, 'entries.entryId': { $ne: entry.entryId } },
      { $push: { entries: entry }, $inc: { balanceCents: op.amountCents, version: 1 } },
    )
    if (r.matchedCount === 1) return
    const exists = await ledger.findOne({ childCustomerId: op.childCustomerId }, { projection: { _id: 1 } })
    if (exists) return // already credited for this payment
    try {
      await ledger.insertOne({ childCustomerId: op.childCustomerId, tenantId: op.tenantId, balanceCents: op.amountCents, entries: [entry], debits: [], version: 1 })
      return
    } catch (err) {
      if (!(err instanceof MongoServerError && err.code === 11000)) throw err
    }
  }
  throw new Error('unsplit ledger credit did not converge')
}

export async function readLedger(db: Db, childCustomerId: string): Promise<UnsplitLedgerDoc | null> {
  return db.collection<UnsplitLedgerDoc>(LEDGER).findOne({ childCustomerId }, { projection: { _id: 0 } })
}

/** Outcome of an attempted split debit. */
export type DebitResult = 'debited' | 'already' | 'stale' | 'amount_mismatch' | 'missing'

/**
 * Debit the whole unsplit balance for one split operation (CS-3953). Atomic and
 * conditional on the expected version AND the expected balance, and keyed by
 * the split's key, so the same money can never be allocated twice.
 */
export async function debitForSplit(db: Db, childCustomerId: string, opKey: string, amountCents: number, expectedVersion: number, now: Date): Promise<DebitResult> {
  const ledger = db.collection<UnsplitLedgerDoc>(LEDGER)
  const r = await ledger.updateOne(
    { childCustomerId, version: expectedVersion, balanceCents: amountCents, 'debits.opKey': { $ne: opKey } },
    { $inc: { balanceCents: -amountCents, version: 1 }, $push: { debits: { opKey, amountCents, at: now } } },
  )
  if (r.matchedCount === 1) return 'debited'
  const doc = await ledger.findOne({ childCustomerId }, { projection: { _id: 0 } })
  if (!doc) return 'missing'
  if (doc.debits.some((d) => d.opKey === opKey)) return 'already'
  if (doc.version !== expectedVersion) return 'stale'
  return 'amount_mismatch'
}

/** BOB refused the split and moved nothing: give the unsplit money back, once. */
export async function restoreFailedSplit(db: Db, childCustomerId: string, opKey: string, amountCents: number, now: Date): Promise<void> {
  const entry: UnsplitEntry = { entryId: `restore:${opKey}`, jobId: '', amountCents, createdAt: now }
  await db.collection<UnsplitLedgerDoc>(LEDGER).updateOne(
    { childCustomerId, 'debits.opKey': opKey, 'entries.entryId': { $ne: entry.entryId } },
    { $push: { entries: entry }, $inc: { balanceCents: amountCents, version: 1 } },
  )
}
