/**
 * Money at the GraphQL edge is CsMoney { amount: decimal string, currency }
 * (schema v1). BOB carries integer amount_cents (bob-family/1 §2.2). The
 * server converts exactly, with no rounding, and only AUD in S0.
 */
import { invalid } from './errors.js'

export const CURRENCY = 'AUD'
const AMOUNT_RE = /^(0|[1-9]\d{0,6})\.(\d{2})$/

export interface MoneyInput {
  amount: string
  currency: string
}

/** Exact cents from "12.30". Refuses anything that is not two decimals, AUD and above zero. */
export function toCents(m: MoneyInput, what = 'amount'): number {
  if (m.currency !== CURRENCY) throw invalid(`${what}: currency must be ${CURRENCY}`)
  const r = AMOUNT_RE.exec(m.amount)
  if (!r) throw invalid(`${what}: must be a decimal with two places, e.g. 2.00`)
  const cents = Number(r[1]) * 100 + Number(r[2])
  if (cents <= 0) throw invalid(`${what}: must be above zero`)
  return cents
}

export function money(cents: number): { amount: string; currency: string } {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('cents must be a non-negative integer')
  return { amount: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`, currency: CURRENCY }
}
