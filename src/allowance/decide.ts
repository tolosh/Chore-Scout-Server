/**
 * The per-cycle allowance decision (CS-3963; revised SD-2, ID-14, SD-7).
 *
 * `decideCycle` is pure and deterministic: the same rule, period, clock and
 * chore state always give the same answer. The scheduled job (CS-3979) calls it
 * through AllowanceCycleService; it is unit-tested on its own.
 *
 * - A cycle is the week [periodStart, periodStart + 7) in the rule's timezone.
 *   Its cut-off is the start of periodStart + 7. It is decided only once the
 *   cut-off has passed, so no cycle is decided early (no accelerated cycles).
 *   The BOB `cycle_ref` is periodStart, which is then a past period start.
 * - periodStart must be the rule's startDate plus a whole number of weeks, and
 *   on or after the rule's `effectiveFrom`: no backdated cycle, and no backfill
 *   after a change (a change applies from the period in which it was made).
 * - FREE pays. EARNED never pays. LINKED (WEEK_CHORES_DONE) pays only if the
 *   week had at least one assigned chore (HOME_JOB created in the week) and
 *   every one was approved before the cut-off; otherwise it skips with a reason.
 */
export type AllowanceMode = 'FREE' | 'LINKED' | 'EARNED'

export interface DecisionRule {
  mode: AllowanceMode
  amountCents: number
  startDate: string
  timezone: string
  linkedCondition: 'WEEK_CHORES_DONE' | null
  effectiveFrom: string
  version: number
}

export interface ChoreState {
  kind: string
  status: string
  createdAt: Date
  decidedAt: Date | null
}

export type CycleDecision =
  | { kind: 'NOT_DUE'; cutOff: string }
  | { kind: 'INVALID_PERIOD'; reason: string }
  | { kind: 'DECIDED'; decision: 'PAY' | 'SKIP'; reason: string | null; amountCents: number | null; ruleVersion: number }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const APPROVED = new Set(['DONE', 'PAID', 'APPROVED_PAYMENT_PENDING', 'PAYMENT_FAILED'])

/** The calendar date of an instant in an IANA timezone, as YYYY-MM-DD. */
export function localDate(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function isDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false
  const t = Date.parse(`${d}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d
}

export function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** The start of the weekly period that contains `day`, or startDate when `day` is before it. */
export function periodContaining(startDate: string, day: string): string {
  const n = daysBetween(startDate, day)
  return n <= 0 ? startDate : addDays(startDate, Math.floor(n / 7) * 7)
}

export const cycleKeyOf = (childId: string, periodStart: string) => `${childId}:${periodStart}`

export function decideCycle(rule: DecisionRule | null, periodStart: string, now: Date, chores: readonly ChoreState[]): CycleDecision {
  if (!rule) return { kind: 'INVALID_PERIOD', reason: 'NO_ALLOWANCE' }
  if (!isDate(periodStart)) return { kind: 'INVALID_PERIOD', reason: 'NOT_A_DATE' }
  const offset = daysBetween(rule.startDate, periodStart)
  if (offset < 0 || offset % 7 !== 0) return { kind: 'INVALID_PERIOD', reason: 'NOT_A_PERIOD_START' }
  if (periodStart < rule.effectiveFrom) return { kind: 'INVALID_PERIOD', reason: 'BEFORE_RULE_EFFECTIVE' }
  const cutOff = addDays(periodStart, 7)
  if (localDate(now, rule.timezone) < cutOff) return { kind: 'NOT_DUE', cutOff }

  const decided = (decision: 'PAY' | 'SKIP', reason: string | null): CycleDecision => ({
    kind: 'DECIDED',
    decision,
    reason,
    amountCents: decision === 'PAY' ? rule.amountCents : null,
    ruleVersion: rule.version,
  })
  if (rule.mode === 'FREE') return decided('PAY', null)
  if (rule.mode === 'EARNED') return decided('SKIP', 'EARNED_MODE')

  // LINKED, WEEK_CHORES_DONE: the week's assigned chores, all approved before the cut-off.
  const week = chores.filter((c) => c.kind === 'HOME_JOB' && localDate(c.createdAt, rule.timezone) >= periodStart && localDate(c.createdAt, rule.timezone) < cutOff)
  if (week.length === 0) return decided('SKIP', 'NO_CHORES_ASSIGNED')
  const open = week.filter((c) => !(APPROVED.has(c.status) && c.decidedAt && localDate(c.decidedAt, rule.timezone) < cutOff)).length
  return open === 0 ? decided('PAY', null) : decided('SKIP', `CHORES_NOT_DONE:${open}/${week.length}`)
}
