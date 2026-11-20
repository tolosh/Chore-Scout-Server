/**
 * Lease lock (CS-3941): single-runner guarantee for the job process (spec §9,
 * CS-3979) and for migrations.
 *
 * DocumentDB note (BOB finding): concurrent upserts on a unique _id can raise
 * E11000 on DocumentDB. This lock therefore never upserts. Acquire is:
 *   1. a conditional findOneAndUpdate (no upsert) that takes over an expired
 *      lease or renews our own; then, if no document matched,
 *   2. insertOne, where E11000 simply means another holder won the race.
 * Each successful acquire increments a fencing token.
 */
import { MongoServerError, type Collection, type Db } from 'mongodb'

export interface LeaseDoc {
  _id: string
  holder: string
  expiresAt: Date
  token: number
  acquiredAt: Date
}

export interface Lease {
  name: string
  holder: string
  token: number
  expiresAt: Date
}

export const LEASES_COLLECTION = 'leases'

export class LeaseLock {
  private readonly coll: Collection<LeaseDoc>
  constructor(
    db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.coll = db.collection<LeaseDoc>(LEASES_COLLECTION)
  }

  /** Try to acquire or renew. Returns the lease, or null if another holder has a live lease. */
  async tryAcquire(name: string, holder: string, ttlMs: number): Promise<Lease | null> {
    const now = this.now()
    const expiresAt = new Date(now.getTime() + ttlMs)
    const taken = await this.coll.findOneAndUpdate(
      { _id: name, $or: [{ expiresAt: { $lte: now } }, { holder }] },
      { $set: { holder, expiresAt, acquiredAt: now }, $inc: { token: 1 } },
      { returnDocument: 'after', upsert: false },
    )
    if (taken) return { name, holder, token: taken.token, expiresAt: taken.expiresAt }
    try {
      await this.coll.insertOne({ _id: name, holder, expiresAt, token: 1, acquiredAt: now })
      return { name, holder, token: 1, expiresAt }
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) return null
      throw err
    }
  }

  /** True while `holder` still holds the live lease with this fencing token (a stale leader stops before acting). */
  async holds(name: string, holder: string, token: number): Promise<boolean> {
    const d = await this.coll.findOne({ _id: name, holder, token, expiresAt: { $gt: this.now() } }, { projection: { _id: 1 } })
    return d !== null
  }

  /** Release only if we still hold it. Returns true if released. */
  async release(name: string, holder: string): Promise<boolean> {
    const res = await this.coll.updateOne(
      { _id: name, holder },
      { $set: { expiresAt: new Date(0) } },
      { upsert: false },
    )
    return res.modifiedCount === 1
  }
}
