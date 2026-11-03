/**
 * Migration runner (CS-3941).
 *
 * - Runs under the "migrations" lease so concurrent boots apply each migration once.
 * - Applied ids are recorded in schema_migrations by insertOne with _id = id
 *   (no upsert; see lease.ts for the DocumentDB E11000 note).
 * - Migrations are idempotent, so a crash between up() and the record is safe.
 */
import { MongoServerError, type Db } from 'mongodb'
import type { Logger } from 'pino'
import { LeaseLock } from '../lease.js'
import { migration001 } from './001-initial-collections.js'
import type { Migration } from './types.js'

export const MIGRATIONS: readonly Migration[] = [migration001]
export const MIGRATIONS_COLLECTION = 'schema_migrations'

export class MigrationLockBusy extends Error {
  constructor() {
    super('another process holds the migrations lease')
    this.name = 'MigrationLockBusy'
  }
}

export interface MigrateOptions {
  holder: string
  migrations?: readonly Migration[]
  leaseTtlMs?: number
  waitMs?: number
  pollMs?: number
  logger?: Pick<Logger, 'info'>
}

export async function runMigrations(db: Db, opts: MigrateOptions): Promise<string[]> {
  const migrations = opts.migrations ?? MIGRATIONS
  const ids = migrations.map((m) => m.id)
  if (new Set(ids).size !== ids.length) throw new Error('duplicate migration id')

  const lock = new LeaseLock(db)
  const ttl = opts.leaseTtlMs ?? 120_000
  const deadline = Date.now() + (opts.waitMs ?? 60_000)
  let lease = await lock.tryAcquire('migrations', opts.holder, ttl)
  while (!lease) {
    if (Date.now() > deadline) throw new MigrationLockBusy()
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 250))
    lease = await lock.tryAcquire('migrations', opts.holder, ttl)
  }

  const applied: string[] = []
  try {
    const records = db.collection<{ _id: string; appliedAt: Date }>(MIGRATIONS_COLLECTION)
    const done = new Set((await records.find({}, { projection: { _id: 1 } }).toArray()).map((r) => r._id))
    for (const m of migrations) {
      if (done.has(m.id)) continue
      await m.up(db)
      try {
        await records.insertOne({ _id: m.id, appliedAt: new Date() })
      } catch (err) {
        if (!(err instanceof MongoServerError && err.code === 11000)) throw err
      }
      applied.push(m.id)
      opts.logger?.info({ migration: m.id }, 'migration applied')
    }
  } finally {
    await lock.release('migrations', opts.holder)
  }
  return applied
}
