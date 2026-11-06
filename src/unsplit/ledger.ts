/**
 * The unsplit ledger (spec §5 `unsplit_ledger`; D08; strategy point 3).
 *
 * Credited ONLY by completed job pay: the single entry point is
 * creditFromJobPayment, which takes a COMPLETED job money operation. The
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
