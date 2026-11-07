/**
 * Single-runner job host (CS-3941; required by the CS-3941 comment on revised SD-2).
 *
 * Each tick acquires or renews the "scheduler" lease; only the holder runs
 * jobs, and each run receives the lease's fencing token and a `stillLeader`
 * check to make before each external action. Jobs must be idempotent per their
 * own key (for the allowance job, the cycle key). The jobs process registers
 * its jobs in registry.ts (CS-3979: the allowance-cycle job).
 */
import type { Db } from 'mongodb'
import type { Logger } from 'pino'
import { LeaseLock } from '../lease.js'

export interface JobContext {
  db: Db
  fencingToken: number
  now: Date
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  /** True while this runner still holds the scheduler lease with `fencingToken`. */
  stillLeader: () => Promise<boolean>
}

export interface ScheduledJob {
  name: string
  run(ctx: JobContext): Promise<void>
}

export const SCHEDULER_LEASE = 'scheduler'

export interface TickResult {
  leader: boolean
  ran: string[]
  failed: string[]
}

export class JobRunner {
  private readonly lock: LeaseLock
  constructor(
    private readonly db: Db,
    private readonly holder: string,
    private readonly leaseTtlMs: number,
    private readonly jobs: readonly ScheduledJob[],
    private readonly log: Pick<Logger, 'info' | 'warn' | 'error'>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.lock = new LeaseLock(db, now)
  }

  async tick(): Promise<TickResult> {
    const lease = await this.lock.tryAcquire(SCHEDULER_LEASE, this.holder, this.leaseTtlMs)
    if (!lease) return { leader: false, ran: [], failed: [] }
    const ran: string[] = []
    const failed: string[] = []
    for (const job of this.jobs) {
      try {
        await job.run({ db: this.db, fencingToken: lease.token, now: this.now(), log: this.log, stillLeader: () => this.lock.holds(SCHEDULER_LEASE, this.holder, lease.token) })
        ran.push(job.name)
      } catch (err) {
        failed.push(job.name)
        this.log.error({ job: job.name, err: (err as Error).message }, 'job failed')
      }
    }
    return { leader: true, ran, failed }
  }

  async stop(): Promise<void> {
    await this.lock.release(SCHEDULER_LEASE, this.holder)
  }
}
