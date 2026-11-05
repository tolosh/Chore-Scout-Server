/**
 * Allowance set-up (CS-3963; revised SD-2, ID-14, SD-7; bob-family/1 §7.1, §7.2).
 *
 * - Guardian only, for a linked child; a child session gets FORBIDDEN.
 * - Versioned (expectedVersion), idempotent per idempotencyKey, and audited
 *   (actor, before, after, correlation).
 * - First set-up records Sarah's standing authority in BOB under HER session
 *   (§7.1). A change to the amount, split or source account updates it (§7.2).
 *   BOB is called first: if BOB refuses, the rule is not saved (SD-7), so the
 *   rule's amount always equals BOB's authorised amount.
 * - A mode or amount change applies from the period in which it is made
 *   (`effectiveFrom`); undecided earlier periods are never paid (no backfill).
 * - The cycle (cadence, startDate, timezone) can't change in S0: BOB's cycle is
 *   fixed on the authority (§7.2), so it needs a revoke and a new authority.
 * DocumentDB: no upserts and no transactions; insertOne (E11000 = stale) and
 * conditional single-document updates.
 */
import { createHash } from 'node:crypto'
import { MongoServerError, type Collection, type Db } from 'mongodb'
import { audit } from '../audit.js'
import type { BobAuthorityClient, SplitCents } from '../bob/allowance.js'
import { forbidden, invalid, notAllowedInState, stale, unauthenticated, upstreamUnavailable } from '../errors.js'
import { assertGuardianOf } from '../identity/authz.js'
import type { Actor } from '../identity/principal.js'
import { toCents, type MoneyInput } from '../money.js'
import { isDate, isTimezone, localDate, periodContaining, type AllowanceMode } from './decide.js'

export const RULES = 'allowance_rules'
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/
const KEEP_KEYS = 20

export interface SplitPercent {
  spendPercent: number
  savePercent: number
  givePercent: number
}

export interface AllowanceRuleDoc {
  childCustomerId: string
  tenantId: string
  guardianCustomerId: string
  mode: AllowanceMode
  amountCents: number
  cadence: 'WEEKLY'
  startDate: string
  timezone: string
  split: SplitPercent
  splitCents: SplitCents
  linkedCondition: 'WEEK_CHORES_DONE' | null
  fromAccountId: string
  authorityId: string
  authorityVersion: number
  /** The first period this version decides; earlier undecided periods are never paid. */
  effectiveFrom: string
  version: number
  /** The latest applied client keys, with a hash of the request, for idempotent replays. */
  applied: { key: string; hash: string; version: number }[]
  createdAt: Date
  updatedAt: Date
}

export interface SetAllowanceInput {
  childId: string
  mode: AllowanceMode
  amount: MoneyInput
  cadence: string
  startDate: string
  timezone: string
  defaultSplit: SplitPercent
  linkedCondition?: 'WEEK_CHORES_DONE' | null
  fromAccountId?: string | null
  expectedVersion?: number | null
  idempotencyKey: string
}

/**
 * Whole cents per jar, adding up exactly to the amount (§7.1). Save and Give
 * are rounded down; Spend takes the remainder. Deterministic for a given rule.
 */
export function splitCentsOf(amountCents: number, s: SplitPercent): SplitCents {
  const save = Math.floor((amountCents * s.savePercent) / 100)
  const give = Math.floor((amountCents * s.givePercent) / 100)
  return { spend: amountCents - save - give, save, give }
}

const pct = (n: number) => Number.isInteger(n) && n >= 0 && n <= 100

export class AllowanceRuleService {
  private readonly rules: Collection<AllowanceRuleDoc>

  constructor(
    private readonly db: Db,
    private readonly bob: BobAuthorityClient,
    private readonly now: () => Date,
  ) {
    this.rules = db.collection<AllowanceRuleDoc>(RULES)
  }

  async set(actor: Actor, i: SetAllowanceInput, correlation: string): Promise<AllowanceRuleDoc> {
    const p = actor.principal
    assertGuardianOf(p, i.childId)
    if (!KEY_RE.test(i.idempotencyKey)) throw invalid('idempotencyKey must be 8-128 characters of A-Z, a-z, 0-9, . _ : -')
    const amountCents = toCents(i.amount)
    if (i.cadence !== 'WEEKLY') throw invalid('cadence must be WEEKLY in S0')
    if (!isDate(i.startDate)) throw invalid('startDate must be a date, YYYY-MM-DD')
    if (!isTimezone(i.timezone)) throw invalid('timezone must be an IANA timezone')
    const s = i.defaultSplit
    if (![s.spendPercent, s.savePercent, s.givePercent].every(pct) || s.spendPercent + s.savePercent + s.givePercent !== 100) throw invalid('defaultSplit must be whole percentages adding up to 100')
    const linkedCondition = i.linkedCondition ?? null
    if ((i.mode === 'LINKED') !== (linkedCondition !== null)) throw invalid('linkedCondition is required for LINKED and only for LINKED')
    const splitCents = splitCentsOf(amountCents, s)
    const hash = createHash('sha256')
      .update(JSON.stringify([i.mode, amountCents, i.cadence, i.startDate, i.timezone, s, linkedCondition, i.fromAccountId ?? null]))
      .digest('hex')

    const doc = await this.rules.findOne({ childCustomerId: i.childId }, { projection: { _id: 0 } })
    if (doc && doc.tenantId !== p.tenantId) throw forbidden()
    const seen = doc?.applied.find((a) => a.key === i.idempotencyKey)
    if (doc && seen) {
      if (seen.hash !== hash) throw invalid('idempotencyKey reused with a different request')
      return doc
    }
    const now = this.now()
    const today = localDate(now, i.timezone)
    return doc ? this.change(actor, doc, i, { amountCents, splitCents, linkedCondition, hash, today }, correlation) : this.create(actor, i, { amountCents, splitCents, linkedCondition, hash, today }, correlation)
  }

  private async create(
    actor: Actor,
    i: SetAllowanceInput,
    v: { amountCents: number; splitCents: SplitCents; linkedCondition: 'WEEK_CHORES_DONE' | null; hash: string; today: string },
    correlation: string,
  ): Promise<AllowanceRuleDoc> {
    const p = actor.principal
    if (i.expectedVersion !== undefined && i.expectedVersion !== null && i.expectedVersion !== 0) throw stale()
    if (!i.fromAccountId) throw invalid('fromAccountId (your own funding account) is required on first set-up')
    if (i.startDate < v.today) throw invalid('startDate must not be in the past (no backdated cycles)')

    const out = await this.bob.create(actor.session, i.childId, {
      fromAccountId: i.fromAccountId,
      amountCents: v.amountCents,
      splitCents: v.splitCents,
      cycle: { period: 'weekly', startDate: i.startDate, timezone: i.timezone },
    })
    if (out.kind !== 'ok') this.refusal(out)
    const a = out.value
    if (a.childCustomerId !== i.childId || a.amountCents !== v.amountCents || a.fromAccountId !== i.fromAccountId || !a.purposes.includes('allowance')) {
      throw upstreamUnavailable('the bank recorded an authority that does not match the request; nothing was saved')
    }
    const now = this.now()
    const doc: AllowanceRuleDoc = {
      childCustomerId: i.childId,
      tenantId: p.tenantId,
      guardianCustomerId: p.customerId,
      mode: i.mode,
      amountCents: v.amountCents,
      cadence: 'WEEKLY',
      startDate: i.startDate,
      timezone: i.timezone,
      split: { ...i.defaultSplit },
      splitCents: v.splitCents,
      linkedCondition: v.linkedCondition,
      fromAccountId: i.fromAccountId,
      authorityId: a.authorityId,
      authorityVersion: a.version,
      effectiveFrom: i.startDate,
      version: 1,
      applied: [{ key: i.idempotencyKey, hash: v.hash, version: 1 }],
      createdAt: now,
      updatedAt: now,
    }
    try {
      await this.rules.insertOne({ ...doc })
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) throw stale()
      throw err
    }
    await audit(this.db, { actor: p.customerId, tenantId: p.tenantId, action: 'allowance.rule_created', subject: i.childId, before: null, after: this.summary(doc), correlation }, now)
    return doc
  }

  private async change(
    actor: Actor,
    doc: AllowanceRuleDoc,
    i: SetAllowanceInput,
    v: { amountCents: number; splitCents: SplitCents; linkedCondition: 'WEEK_CHORES_DONE' | null; hash: string; today: string },
    correlation: string,
  ): Promise<AllowanceRuleDoc> {
    const p = actor.principal
    if (i.expectedVersion !== doc.version) throw stale()
    if (i.cadence !== doc.cadence || i.startDate !== doc.startDate || i.timezone !== doc.timezone) {
      throw notAllowedInState('the cycle (cadence, startDate, timezone) cannot change; revoke the allowance and set it up again')
    }
    const fromAccountId = i.fromAccountId ?? doc.fromAccountId
    const sameSplit = v.splitCents.spend === doc.splitCents.spend && v.splitCents.save === doc.splitCents.save && v.splitCents.give === doc.splitCents.give
    let authorityVersion = doc.authorityVersion
    if (v.amountCents !== doc.amountCents || !sameSplit || fromAccountId !== doc.fromAccountId) {
      // SD-7: BOB first. If BOB refuses, nothing here is saved.
      const out = await this.bob.change(actor.session, doc.authorityId, doc.authorityVersion, { amountCents: v.amountCents, splitCents: v.splitCents, fromAccountId })
      if (out.kind !== 'ok') this.refusal(out)
      if (out.value.authorityId !== doc.authorityId || out.value.amountCents !== v.amountCents || out.value.fromAccountId !== fromAccountId) {
        throw upstreamUnavailable('the bank changed the authority to something other than the request; nothing was saved')
      }
      authorityVersion = out.value.version
    }
    const now = this.now()
    const changesPay = i.mode !== doc.mode || v.amountCents !== doc.amountCents || v.linkedCondition !== doc.linkedCondition
    const effectiveFrom = changesPay ? periodContaining(doc.startDate, v.today) : doc.effectiveFrom
    const set = {
      mode: i.mode,
      amountCents: v.amountCents,
      split: { ...i.defaultSplit },
      splitCents: v.splitCents,
      linkedCondition: v.linkedCondition,
      fromAccountId,
      authorityVersion,
      effectiveFrom: effectiveFrom > doc.effectiveFrom ? effectiveFrom : doc.effectiveFrom,
      applied: [...doc.applied, { key: i.idempotencyKey, hash: v.hash, version: doc.version + 1 }].slice(-KEEP_KEYS),
      updatedAt: now,
    }
    const r = await this.rules.updateOne({ childCustomerId: doc.childCustomerId, version: doc.version }, { $set: set, $inc: { version: 1 } })
    if (r.matchedCount !== 1) throw stale()
    const after: AllowanceRuleDoc = { ...doc, ...set, version: doc.version + 1 }
    await audit(this.db, { actor: p.customerId, tenantId: doc.tenantId, action: 'allowance.rule_changed', subject: doc.childCustomerId, before: this.summary(doc), after: this.summary(after), correlation }, now)
    return after
  }

  private summary(d: AllowanceRuleDoc) {
    return { mode: d.mode, amountCents: d.amountCents, splitCents: d.splitCents, linkedCondition: d.linkedCondition, authorityId: d.authorityId, authorityVersion: d.authorityVersion, effectiveFrom: d.effectiveFrom, version: d.version }
  }

  private refusal(out: { kind: 'refused'; code: string; reason?: string } | { kind: 'unknown'; detail: string }): never {
    if (out.kind === 'unknown') throw upstreamUnavailable('the bank did not confirm the authority; nothing was saved. Retry the same request.')
    switch (out.code) {
      case 'UNAUTHORIZED':
        throw unauthenticated()
      case 'FORBIDDEN':
        throw forbidden('the bank refused the authority (link, bank or source account); nothing was saved')
      case 'VALIDATION_ERROR':
        throw invalid('the bank refused the authority as invalid; nothing was saved')
      case 'STALE_VERSION':
        throw stale('the bank has a newer authority; nothing was saved')
      case 'IDEMPOTENCY_CONFLICT':
        // Another, different change was sent for the same authority version (or set-up) first.
        throw stale('a different change to this allowance was sent first; nothing was saved')
      case 'AUTHORITY_EXISTS':
      case 'AUTHORITY_REVOKED':
        throw notAllowedInState(`the bank refused it (${out.code}); nothing was saved`)
      default:
        throw upstreamUnavailable(`the bank refused it (${out.code}); nothing was saved. Retry the same request.`)
    }
  }
}
