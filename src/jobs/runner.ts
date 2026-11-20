/**
 * Single-runner job host (CS-3941; required by the CS-3941 comment on revised SD-2).
 *
 * Each tick acquires or renews the runner's lease; only the holder runs jobs,
 * and each run receives the lease's fencing token and a `stillLeader` check to
 * make before each external action. Jobs must be idempotent per their own key
 * (for the allowance job, the cycle key). The jobs process registers its jobs in
 * registry.ts (CS-3979: the allowance-cycle job).
 *
 * One lease per bank (review 40503 item 1). A jobs process holds one bank's
 * allowance credential and runs only that bank's children, so it takes that
 * bank's lease, `scheduler:allowance:<tenantId>`. Bank of Bilgola's and Bank of
 * Manly's runners share the database (the API's rule records live there) but
 * never compete: one bank's renewing leader can't starve the other. Failover is
 * per bank: a second runner for the same bank takes over when the leader's lease
 * expires. No process ever holds two banks' credentials.
 */
import type { Db } from 'mongodb'
import type { Logger } from 'pino'
import { LeaseLock } from '../lease.js'
import { ALERT } from './alerts.js'

export interface JobContext {
  db: Db
  fencingToken: number
  now: Date
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  /** True while this runner still holds its bank's scheduler lease with `fencingToken`. */
  stillLeader: () => Promise<boolean>
}

export interface ScheduledJob {
  name: string
  run(ctx: JobContext): Promise<void>
}

export const SCHEDULER_LEASE_PREFIX = 'scheduler:allowance:'

/** The lease a bank's allowance runner holds. Refuses an empty or malformed bank id rather than share a lease. */
export function schedulerLeaseFor(tenantId: string): string {
  if (!/^[a-z0-9_]{1,64}$/.test(tenantId)) throw new Error('a scheduler lease needs a bank id (lower-case letters, digits and underscores)')
  return SCHEDULER_LEASE_PREFIX + tenantId
}

export interface TickResult {
  leader: boolean
  ran: string[]
  failed: string[]
}

export class JobRunner {
  private readonly lock: LeaseLock
  constructor(
    private readonly db: Db,
    /** From schedulerLeaseFor(tenantId): one lease per bank. */
    private readonly leaseName: string,
    private readonly holder: string,
    private readonly leaseTtlMs: number,
    private readonly jobs: readonly ScheduledJob[],
    private readonly log: Pick<Logger, 'info' | 'warn' | 'error'>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.lock = new LeaseLock(db, now)
  }

  async tick(): Promise<TickResult> {
    const lease = await this.lock.tryAcquire(this.leaseName, this.holder, this.leaseTtlMs)
    if (!lease) return { leader: false, ran: [], failed: [] }
    const ran: string[] = []
    const failed: string[] = []
    for (const job of this.jobs) {
      try {
        await job.run({ db: this.db, fencingToken: lease.token, now: this.now(), log: this.log, stillLeader: () => this.lock.holds(this.leaseName, this.holder, lease.token) })
        ran.push(job.name)
      } catch (err) {
        failed.push(job.name)
        this.log.error({ job: job.name, lease: this.leaseName, err: (err as Error).message, alert: ALERT.JOB_FAILED }, 'job failed')
      }
    }
    return { leader: true, ran, failed }
  }

  async stop(): Promise<void> {
    await this.lock.release(this.leaseName, this.holder)
  }
}
