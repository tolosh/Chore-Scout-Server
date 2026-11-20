/**
 * The scheduled allowance-cycle job (CS-3979; revised SD-2, ID-14, SD-7; D55;
 * bob-family/1 §7.5).
 *
 * Runs in the jobs process only, as the scheduler lease holder, on the real
 * clock. Each tick:
 * - finds the most recent product week whose cut-off has passed (D55: weeks run
 *   Monday 00:00 to Monday 00:00 Australia/Sydney, so the cut-off is the next
 *   Monday 00:00 Sydney);
 * - for each allowance rule of the credential's bank, runs every cycle from the
 *   rule's first effective period up to that week that has no final record yet,
 *   through AllowanceCycleService (decideCycle, then at most one BOB execution
 *   with key `cs:<cycleKey>:allowance` for exactly the rule's amount).
 *
 * Guarantees:
 * - Nothing is decided early: a week is a candidate only once its cut-off has
 *   passed on the real clock, and decideCycle re-checks it (NOT_DUE).
 * - Nothing is backdated or backfilled: candidates start at the rule's start
 *   date and its `effectiveFrom`, which only moves forward; decideCycle refuses
 *   anything earlier. A cycle missed during an outage is a genuine cycle under
 *   the current rule, so it is caught up once, at its own amount, as its own
 *   payment (never combined), and logged as late so the outage is visible.
 * - One BOB execution per (child, cycle): the decision is recorded once per
 *   cycleKey (unique index), a sender claims the cycle before its BOB call, and
 *   a retry re-sends the original key only. The lease's `stillLeader` check runs
 *   before each cycle, so a runner that lost the lease stops.
 * - A PAY cycle still DECIDED is always settled under the rule it was decided
 *   on: setAllowance refuses a pay change until BOB has answered (review 40015).
 *   A 201 that keeps not matching is held for an operator after
 *   MAX_MISMATCH_ATTEMPTS, logged at error level, and never re-sent.
 * - Interruption is safe: a crash after the decision leaves the cycle DECIDED,
 *   and the next tick re-sends the same key once the retry interval has passed.
 *   BOB refusals are recorded FAILED with BOB's code and are not job errors.
 * DocumentDB: reads plus the service's insertOne and conditional single-document
 * updates; no upserts, no transactions, no new indexes (cycles are read by
 * cycleKey on its unique index; the rules of one bank are a small scan).
 */
import type { Db } from 'mongodb'
import { AllowanceCycleService, CYCLES, type AllowanceCycleDoc } from '../allowance/cycle.js'
import { addDays, cycleKeyOf, weekStartOf } from '../allowance/decide.js'
import { RULES, type AllowanceRuleDoc } from '../allowance/rule.js'
import type { JobContext, ScheduledJob } from './runner.js'

export const ALLOWANCE_JOB = 'allowance-cycles'
/** A PAY cycle whose BOB outcome is unknown is re-sent, with the same key, no sooner than this after its last attempt. */
export const RETRY_AFTER_MS = 60_000

export interface AllowanceTickSummary {
  lastEndedWeek: string
  considered: number
  decided: number
  executed: number
  failed: number
  pending: number
  held: number
  late: number
  stoppedNotLeader: boolean
}

export class AllowanceCycleJob implements ScheduledJob {
  readonly name = ALLOWANCE_JOB
  /** The latest tick's summary, for logs and tests. */
  last: AllowanceTickSummary | null = null

  constructor(
    private readonly db: Db,
    /** The bank the allowance credential belongs to; other banks' children are never run with it. */
    private readonly tenantId: string,
    private readonly cycles: AllowanceCycleService,
  ) {}

  async run(ctx: JobContext): Promise<void> {
    const now = ctx.now
    // The week that contains `now` hasn't ended; the one before it is the latest whose cut-off has passed.
    const lastEndedWeek = addDays(weekStartOf(now), -7)
    const sum: AllowanceTickSummary = { lastEndedWeek, considered: 0, decided: 0, executed: 0, failed: 0, pending: 0, held: 0, late: 0, stoppedNotLeader: false }
    const errors: string[] = []
    const rules = await this.db
      .collection<AllowanceRuleDoc>(RULES)
      .find({ tenantId: this.tenantId }, { projection: { _id: 0, childCustomerId: 1, startDate: 1, effectiveFrom: 1 } })
      .sort({ childCustomerId: 1 })
      .toArray()

    outer: for (const rule of rules) {
      const from = rule.effectiveFrom > rule.startDate ? rule.effectiveFrom : rule.startDate
      if (from > lastEndedWeek) continue
      const periods: string[] = []
      for (let p = from; p <= lastEndedWeek; p = addDays(p, 7)) periods.push(p)
      // Looked up by cycleKey, on its existing unique index.
      const known = new Map(
        (
          await this.db
            .collection<AllowanceCycleDoc>(CYCLES)
            .find({ cycleKey: { $in: periods.map((p) => cycleKeyOf(rule.childCustomerId, p)) } }, { projection: { _id: 0, periodStart: 1, decision: 1, status: 1, updatedAt: 1, operatorHold: 1 } })
            .toArray()
        ).map((c) => [c.periodStart, c]),
      )
      for (const p of periods) {
        const seen = known.get(p)
        // Final records (SKIP, EXECUTED, FAILED) are never re-run. A PAY still DECIDED is retried with its original key.
        if (seen && !(seen.decision === 'PAY' && seen.status === 'DECIDED')) continue
        // Held for an operator (repeated mismatch): never re-sent automatically; alerted when the hold was set.
        if (seen?.operatorHold) continue
        if (seen && now.getTime() - seen.updatedAt.getTime() < RETRY_AFTER_MS) continue
        if (!(await ctx.stillLeader())) {
          sum.stoppedNotLeader = true
          ctx.log.warn({ job: this.name }, 'scheduler lease lost; stopping before the next cycle')
          break outer
        }
        sum.considered++
        const cycleKey = cycleKeyOf(rule.childCustomerId, p)
        const correlation = `job:${this.name}:${ctx.fencingToken}:${cycleKey}`
        try {
          const r = await this.cycles.run(rule.childCustomerId, p, correlation)
          if (r.outcome !== 'RECORDED') {
            ctx.log.warn({ job: this.name, cycleKey, outcome: r.outcome, detail: r.detail }, 'allowance cycle not decided')
            continue
          }
          const c = r.cycle
          if (!seen) {
            sum.decided++
            // A week before the latest ended one is a catch-up: a run was missed (outage). Visible as a warning.
            if (p < lastEndedWeek) {
              sum.late++
              ctx.log.warn({ job: this.name, cycleKey, periodStart: p, lastEndedWeek }, 'allowance cycle decided late (missed run caught up)')
            }
          }
          const fields = { job: this.name, cycleKey, decision: c.decision, reason: c.reason, status: c.status, bobReason: c.bobReason, operatorHold: c.operatorHold ?? null, amountCents: c.amountCents, bobOperationRef: c.bobOperationRef, correlation }
          if (c.status === 'EXECUTED') {
            sum.executed++
            ctx.log.info(fields, 'allowance cycle executed')
          } else if (c.status === 'FAILED') {
            // An expected BOB refusal (revoked, amount not authorised, ...): recorded, not retried, not a job error.
            sum.failed++
            ctx.log.info(fields, 'allowance cycle refused by BOB; recorded FAILED')
          } else if (c.operatorHold) {
            sum.held++
            ctx.log.error(fields, 'allowance cycle held for an operator: BOB answered with something other than what was asked; not re-sent')
          } else if (c.decision === 'PAY') {
            sum.pending++
            ctx.log.warn(fields, 'allowance payment outcome unknown; will re-send the same key')
          } else {
            ctx.log.info(fields, 'allowance cycle skipped')
          }
        } catch (err) {
          errors.push(`${cycleKey}: ${(err as Error).message}`)
          ctx.log.error({ job: this.name, cycleKey, err: (err as Error).message }, 'allowance cycle errored; will retry next tick')
        }
      }
    }
    this.last = sum
    ctx.log.info({ job: this.name, ...sum }, 'allowance tick complete')
    if (errors.length > 0) throw new Error(`${errors.length} allowance cycle(s) errored`)
  }
}
