/** CS-3963: the per-cycle decision in isolation. Pure and deterministic; no database, no BOB. */
import { describe, expect, it } from 'vitest'
import { addDays, decideCycle, isDate, isTimezone, localDate, periodContaining, type ChoreState, type DecisionRule } from '../src/allowance/decide.js'
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
  it('LINKED with no chore assigned in the week skips (the condition is never assumed met)', () => {
    expect(decideCycle(linked, '2026-11-09', now, [chore('2026-11-02', 'DONE', '2026-11-03'), chore('2026-11-16', 'DONE', '2026-11-16')])).toMatchObject({ decision: 'SKIP', reason: 'NO_CHORES_ASSIGNED' })
    expect(decideCycle(linked, '2026-11-09', now, [{ ...chore('2026-11-10', 'TODO', null), kind: 'EXTRA_EARNER' }])).toMatchObject({ decision: 'SKIP', reason: 'NO_CHORES_ASSIGNED' })
  })
  it('is deterministic: the same inputs give the same answer', () => {
    const c = [chore('2026-11-10', 'DONE', '2026-11-11')]
    expect(decideCycle(linked, '2026-11-09', now, c)).toEqual(decideCycle(linked, '2026-11-09', now, c))
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
