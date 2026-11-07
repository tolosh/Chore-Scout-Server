/** CS-3963: the per-cycle decision in isolation. Pure and deterministic; no database, no BOB. */
import { describe, expect, it } from 'vitest'
import { addDays, decideCycle, isDate, isTimezone, isWeekStart, localDate, periodContaining, weekStartOf, type ChoreState, type DecisionRule } from '../src/allowance/decide.js'
import { splitCentsOf } from '../src/allowance/rule.js'

const TZ = 'Australia/Sydney'
const rule = (over: Partial<DecisionRule> = {}): DecisionRule => ({ mode: 'FREE', amountCents: 1000, startDate: '2026-11-09', timezone: TZ, linkedCondition: null, effectiveFrom: '2026-11-09', version: 3, ...over })
/** A Sydney wall-clock time as an instant (UTC+11 in November). */
const syd = (d: string, hh = 12) => new Date(Date.parse(`${d}T00:00:00Z`) + (hh - 11) * 3_600_000)
const chore = (created: string, status: string, decided: string | null): ChoreState => ({ kind: 'HOME_JOB', status, createdAt: syd(created), decidedAt: decided ? syd(decided) : null })
const linked = rule({ mode: 'LINKED', linkedCondition: 'WEEK_CHORES_DONE' })

describe('timing: decided only after the cut-off, only on a period start', () => {
  it('before the cut-off is NOT_DUE (no accelerated cycle); from the cut-off it is decided', () => {
    expect(decideCycle(rule(), '2026-11-09', syd('2026-11-15', 23), [])).toEqual({ kind: 'NOT_DUE', cutOff: '2026-11-16' })
    expect(decideCycle(rule(), '2026-11-09', syd('2026-11-16', 0), [])).toMatchObject({ kind: 'DECIDED', decision: 'PAY' })
  })

  it('the cut-off is in the rule’s timezone, not UTC', () => {
    // 2026-11-15T13:30Z is already 2026-11-16 00:30 in Sydney.
    expect(decideCycle(rule(), '2026-11-09', new Date('2026-11-15T13:30:00Z'), [])).toMatchObject({ kind: 'DECIDED' })
    expect(decideCycle(rule(), '2026-11-09', new Date('2026-11-15T12:30:00Z'), [])).toMatchObject({ kind: 'NOT_DUE' })
  })

  it('a date that is not a period start, before startDate, before the rule took effect, or not a date is refused', () => {
    const now = syd('2026-12-31')
    expect(decideCycle(rule(), '2026-11-10', now, [])).toEqual({ kind: 'INVALID_PERIOD', reason: 'NOT_A_PERIOD_START' })
    expect(decideCycle(rule(), '2026-11-02', now, [])).toEqual({ kind: 'INVALID_PERIOD', reason: 'NOT_A_PERIOD_START' })
    expect(decideCycle(rule({ effectiveFrom: '2026-11-23' }), '2026-11-16', now, [])).toEqual({ kind: 'INVALID_PERIOD', reason: 'BEFORE_RULE_EFFECTIVE' })
    expect(decideCycle(rule(), '2026-13-01', now, [])).toEqual({ kind: 'INVALID_PERIOD', reason: 'NOT_A_DATE' })
    expect(decideCycle(null, '2026-11-09', now, [])).toEqual({ kind: 'INVALID_PERIOD', reason: 'NO_ALLOWANCE' })
  })
})

describe('modes', () => {
  const now = syd('2026-11-16')
  it('FREE pays exactly the rule amount, with the rule version', () => {
    expect(decideCycle(rule(), '2026-11-09', now, [])).toEqual({ kind: 'DECIDED', decision: 'PAY', reason: null, amountCents: 1000, ruleVersion: 3 })
  })
  it('EARNED never pays', () => {
    expect(decideCycle(rule({ mode: 'EARNED' }), '2026-11-09', now, [])).toEqual({ kind: 'DECIDED', decision: 'SKIP', reason: 'EARNED_MODE', amountCents: null, ruleVersion: 3 })
  })
  it('LINKED pays when every chore assigned in the week was approved before the cut-off', () => {
    const c = [chore('2026-11-09', 'DONE', '2026-11-10'), chore('2026-11-12', 'PAID', '2026-11-15')]
    expect(decideCycle(linked, '2026-11-09', now, c)).toMatchObject({ decision: 'PAY', amountCents: 1000 })
  })
  it('LINKED skips with a reason when a chore is open, sent back, or approved only after the cut-off', () => {
    expect(decideCycle(linked, '2026-11-09', now, [chore('2026-11-09', 'DONE', '2026-11-10'), chore('2026-11-11', 'WAITING', null)])).toMatchObject({ decision: 'SKIP', reason: 'CHORES_NOT_DONE:1/2' })
    expect(decideCycle(linked, '2026-11-09', now, [chore('2026-11-11', 'SENT_BACK', '2026-11-12')])).toMatchObject({ decision: 'SKIP', reason: 'CHORES_NOT_DONE:1/1' })
    expect(decideCycle(linked, '2026-11-09', syd('2026-11-20'), [chore('2026-11-11', 'DONE', '2026-11-17')])).toMatchObject({ decision: 'SKIP', reason: 'CHORES_NOT_DONE:1/1' })
  })
  it('D56: LINKED with no chore assigned in the week pays (nothing was missed)', () => {
    expect(decideCycle(linked, '2026-11-09', now, [])).toEqual({ kind: 'DECIDED', decision: 'PAY', reason: 'NO_CHORES_ASSIGNED', amountCents: 1000, ruleVersion: 3 })
    // Chores in other weeks, and kinds other than HOME_JOB, are not this week's assigned chores.
    expect(decideCycle(linked, '2026-11-09', now, [chore('2026-11-02', 'WAITING', null), chore('2026-11-16', 'TODO', null)])).toMatchObject({ decision: 'PAY', reason: 'NO_CHORES_ASSIGNED', amountCents: 1000 })
    expect(decideCycle(linked, '2026-11-09', now, [{ ...chore('2026-11-10', 'TODO', null), kind: 'EXTRA_EARNER' }])).toMatchObject({ decision: 'PAY', reason: 'NO_CHORES_ASSIGNED' })
    // Still never early.
    expect(decideCycle(linked, '2026-11-09', syd('2026-11-15', 23), [])).toMatchObject({ kind: 'NOT_DUE' })
  })
  it('is deterministic: the same inputs give the same answer', () => {
    const c = [chore('2026-11-10', 'DONE', '2026-11-11')]
    expect(decideCycle(linked, '2026-11-09', now, c)).toEqual(decideCycle(linked, '2026-11-09', now, c))
  })
})

describe('D55: one product week, Monday 00:00 to Monday 00:00 Australia/Sydney', () => {
  it('a rule on another timezone or start day is never decided', () => {
    const now = syd('2026-12-31')
    expect(decideCycle(rule({ timezone: 'Europe/London' }), '2026-11-09', now, [])).toEqual({ kind: 'INVALID_PERIOD', reason: 'NOT_PRODUCT_WEEK' })
    expect(decideCycle(rule({ startDate: '2026-11-11', effectiveFrom: '2026-11-11' }), '2026-11-18', now, [])).toEqual({ kind: 'INVALID_PERIOD', reason: 'NOT_PRODUCT_WEEK' })
  })

  it('the Linked cut-off is the end of the week: Monday 00:00 Sydney, across the October DST change', () => {
    // Sydney moves to UTC+11 on 2026-10-04. The week of 2026-09-28 ends 2026-10-05 00:00 AEDT = 2026-10-04T13:00Z.
    const r = rule({ mode: 'LINKED', linkedCondition: 'WEEK_CHORES_DONE', startDate: '2026-09-28', effectiveFrom: '2026-09-28' })
    const c = [{ kind: 'HOME_JOB', status: 'DONE', createdAt: new Date('2026-09-29T00:00:00Z'), decidedAt: new Date('2026-10-04T12:59:00Z') }]
    expect(decideCycle(r, '2026-09-28', new Date('2026-10-04T12:59:59Z'), c)).toMatchObject({ kind: 'NOT_DUE', cutOff: '2026-10-05' })
    expect(decideCycle(r, '2026-09-28', new Date('2026-10-04T13:00:00Z'), c)).toMatchObject({ decision: 'PAY' })
    const late = [{ ...c[0]!, decidedAt: new Date('2026-10-04T13:00:00Z') }]
    expect(decideCycle(r, '2026-09-28', new Date('2026-10-04T13:00:00Z'), late)).toMatchObject({ decision: 'SKIP', reason: 'CHORES_NOT_DONE:1/1' })
  })

  it('week starts', () => {
    expect(isWeekStart('2026-11-09')).toBe(true)
    expect(isWeekStart('2026-11-11')).toBe(false)
    expect(isWeekStart('2026-11-08')).toBe(false)
    expect(weekStartOf(new Date('2026-11-08T12:59:59Z'))).toBe('2026-11-02') // Sunday 23:59:59 Sydney
    expect(weekStartOf(new Date('2026-11-08T13:00:00Z'))).toBe('2026-11-09') // Monday 00:00 Sydney
    expect(weekStartOf(new Date('2026-11-15T12:00:00Z'))).toBe('2026-11-09')
  })
})

describe('helpers', () => {
  it('dates, timezones and periods', () => {
    expect(isDate('2026-02-29')).toBe(false)
    expect(isDate('2028-02-29')).toBe(true)
    expect(isTimezone('Australia/Sydney')).toBe(true)
    expect(isTimezone('Mars/Olympus')).toBe(false)
    expect(localDate(new Date('2026-11-08T14:00:00Z'), TZ)).toBe('2026-11-09')
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04')
    expect(periodContaining('2026-11-09', '2026-11-22')).toBe('2026-11-16')
    expect(periodContaining('2026-11-09', '2026-11-01')).toBe('2026-11-09')
  })
  it('split cents add up exactly to the amount', () => {
    expect(splitCentsOf(1000, { spendPercent: 50, savePercent: 30, givePercent: 20 })).toEqual({ spend: 500, save: 300, give: 200 })
    expect(splitCentsOf(101, { spendPercent: 34, savePercent: 33, givePercent: 33 })).toEqual({ spend: 35, save: 33, give: 33 })
    expect(splitCentsOf(1000, { spendPercent: 100, savePercent: 0, givePercent: 0 })).toEqual({ spend: 1000, save: 0, give: 0 })
  })
})
