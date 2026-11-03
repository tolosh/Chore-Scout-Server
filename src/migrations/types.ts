import type { Db } from 'mongodb'

export interface Migration {
  /** Stable, ordered id. Never renamed once merged. */
  id: string
  /** Must be idempotent: safe to re-run after a partial failure. */
  up(db: Db): Promise<void>
}
