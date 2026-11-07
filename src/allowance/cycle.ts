/**
 * Running one allowance cycle (CS-3963; SD-7; bob-family/1 §7.5). The
 * scheduled job that calls this for each due cycle is CS-3979.
 *
 * - The decision (decide.ts) is recorded once per cycleKey = child:periodStart
 *   (unique index; insertOne, E11000 = already decided). A recorded decision is
 *   never changed, so re-running a cycle never pays twice and never re-decides.
 * - SKIP makes no BOB call. PAY makes exactly one BOB instruction, key
 *   `cs:<cycleKey>:allowance`, for exactly the rule's amount (SD-7), under the
 *   server's allowance credential. BOB pays and auto-splits (origin automatic);
 *   nothing is credited to the unsplit ledger.
 * - EXECUTED only on BOB's 201 (or a replay) that matches, or CYCLE_ALREADY_PAID.
 *   BOB's refusals (revoked, amount not authorised, child not covered, invalid
 *   cycle, insufficient funds, not found, forbidden) are FAILED with BOB's code.
 *   An unknown outcome or an idempotency 409 stays DECIDED; re-running the cycle
 *   re-sends the same key.
 * - One sender at a time: a PAY cycle is claimed (SEND_CLAIM_MS) with a
 *   conditional update before its BOB call, so concurrent runs never send twice.
 * - The Give share's sweep or hold (§6.2) keeps the child's charity choice in
 *   step with BOB (D51), as for a child allocation.
 */
import { MongoServerError, type Collection, type Db } from 'mongodb'
import { audit } from '../audit.js'
import type { BobAllowanceExecutor, SplitCents } from '../bob/allowance.js'
import type { JobDoc } from '../chores/service.js'
import { markUnavailable, reconcileWithSweep } from '../giving/preference.js'
import { cycleKeyOf, decideCycle, type CycleDecision } from './decide.js'
import { RULES, type AllowanceRuleDoc } from './rule.js'

export const CYCLES = 'allowance_cycles'
/**
 * A sender claims a DECIDED PAY cycle before its one BOB call, so two runners
 * never have the same instruction in flight (review 39969, RV11-2). Longer than
 * the longest BOB call (BOB_CALL_TIMEOUT_MS max 30 s); a claim left by a crashed
 * sender lapses, and the retry re-sends the same key.
 */
export const SEND_CLAIM_MS = 60_000
const FAILED_CODES = new Set(['AUTHORITY_REVOKED', 'AMOUNT_NOT_AUTHORISED', 'CHILD_NOT_COVERED', 'INVALID_CYCLE', 'INSUFFICIENT_FUNDS', 'NOT_FOUND', 'FORBIDDEN'])

export interface AllowanceCycleDoc {
  cycleKey: string
  childCustomerId: string
  tenantId: string
  periodStart: string
  decision: 'PAY' | 'SKIP'
  reason: string | null
  ruleVersion: number
  amountCents: number | null
  splitCents: SplitCents | null
  authorityId: string
  status: 'DECIDED' | 'EXECUTED' | 'FAILED'
  /** Why a PAY is still DECIDED (e.g. UPSTREAM_UNAVAILABLE) or why it FAILED (BOB's code). */
  bobReason: string | null
  bobOperationRef: string | null
  attempts: number
  /** While set and in the future, one sender has the BOB call in flight. */
  claimUntil?: Date | null
  decidedAt: Date
  updatedAt: Date
}

export type CycleRun = { outcome: 'NOT_DUE' | 'INVALID_PERIOD'; detail: string } | { outcome: 'RECORDED'; cycle: AllowanceCycleDoc }

export class AllowanceCycleService {
  private readonly cycles: Collection<AllowanceCycleDoc>

  constructor(
    private readonly db: Db,
    private readonly bob: BobAllowanceExecutor,
    private readonly now: () => Date,
  ) {
    this.cycles = db.collection<AllowanceCycleDoc>(CYCLES)
  }

  async run(childId: string, periodStart: string, correlation: string): Promise<CycleRun> {
    const cycleKey = cycleKeyOf(childId, periodStart)
    let cycle: AllowanceCycleDoc | null = await this.cycles.findOne({ cycleKey }, { projection: { _id: 0 } })
    if (!cycle) {
      const rule = await this.db.collection<AllowanceRuleDoc>(RULES).findOne({ childCustomerId: childId }, { projection: { _id: 0 } })
      const chores =
        rule?.mode === 'LINKED'
          ? await this.db
              .collection<JobDoc>('jobs')
              .find({ childCustomerId: childId, tenantId: rule.tenantId, kind: 'HOME_JOB' }, { projection: { _id: 0, kind: 1, status: 1, createdAt: 1, decidedAt: 1 } })
              .toArray()
          : []
      const d: CycleDecision = decideCycle(rule, periodStart, this.now(), chores)
      if (d.kind === 'NOT_DUE') return { outcome: 'NOT_DUE', detail: `cut-off ${d.cutOff}` }
      if (d.kind === 'INVALID_PERIOD') return { outcome: 'INVALID_PERIOD', detail: d.reason }
      const now = this.now()
      const doc: AllowanceCycleDoc = {
        cycleKey,
        childCustomerId: childId,
        tenantId: rule!.tenantId,
        periodStart,
        decision: d.decision,
        reason: d.reason,
        ruleVersion: d.ruleVersion,
        amountCents: d.amountCents,
        splitCents: d.decision === 'PAY' ? rule!.splitCents : null,
        authorityId: rule!.authorityId,
        status: 'DECIDED',
        bobReason: null,
        bobOperationRef: null,
        attempts: 0,
        decidedAt: now,
        updatedAt: now,
      }
      try {
        await this.cycles.insertOne({ ...doc })
        await audit(this.db, { actor: 'allowance-cycle', tenantId: doc.tenantId, action: 'allowance.cycle_decided', subject: cycleKey, after: { decision: doc.decision, reason: doc.reason, ruleVersion: doc.ruleVersion, amountCents: doc.amountCents }, correlation }, now)
      } catch (err) {
        if (!(err instanceof MongoServerError && err.code === 11000)) throw err
      }
      cycle = (await this.cycles.findOne({ cycleKey }, { projection: { _id: 0 } }))!
    }
    if (cycle.decision === 'PAY' && cycle.status === 'DECIDED') cycle = await this.execute(cycle, correlation)
    return { outcome: 'RECORDED', cycle }
  }

  private async execute(c: AllowanceCycleDoc, correlation: string): Promise<AllowanceCycleDoc> {
    const at = this.now()
    const claim = await this.cycles.updateOne(
      { cycleKey: c.cycleKey, status: 'DECIDED', decision: 'PAY', $or: [{ claimUntil: null }, { claimUntil: { $lte: at } }] },
      { $set: { claimUntil: new Date(at.getTime() + SEND_CLAIM_MS) } },
    )
    // Another sender has this cycle's instruction in flight: send nothing; its outcome is recorded by that sender.
    if (claim.modifiedCount !== 1) return (await this.cycles.findOne({ cycleKey: c.cycleKey }, { projection: { _id: 0 } }))!
    const out = await this.bob.execute(c.authorityId, c.cycleKey, { childCustomerId: c.childCustomerId, cycleRef: c.periodStart, amountCents: c.amountCents! })
    const now = this.now()
    const decided = { cycleKey: c.cycleKey, status: 'DECIDED' as const }
    let final = false
    if (out.kind === 'ok') {
      const e = out.value
      const split = c.splitCents!
      const funding = e.legs.filter((l) => l.purpose === 'allowance_funding')
      const splits = e.legs.filter((l) => l.purpose === 'split')
      const want = [split.save, split.give].filter((n) => n > 0).sort((a, b) => a - b)
      const got = splits.map((l) => l.amountCents).sort((a, b) => a - b)
      const giveOk = split.give === 0 || (e.giveOutcome !== null && e.giveOutcome.status !== 'none' && e.giveOutcome.amountCents === split.give)
      const matches =
        e.childCustomerId === c.childCustomerId &&
        e.cycleRef === c.periodStart &&
        e.amountCents === c.amountCents &&
        funding.length === 1 &&
        funding[0]!.amountCents === c.amountCents &&
        splits.every((l) => l.origin === 'automatic') &&
        JSON.stringify(got) === JSON.stringify(want) &&
        giveOk
      if (!matches) {
        // Outside the contract: never shown as paid on an answer that doesn't match what was asked.
        await this.cycles.updateOne(decided, { $set: { bobReason: 'UPSTREAM_MISMATCH', claimUntil: null, updatedAt: now }, $inc: { attempts: 1 } })
      } else {
        final = (await this.cycles.updateOne(decided, { $set: { status: 'EXECUTED', bobOperationRef: e.executionId, bobReason: null, claimUntil: null, updatedAt: now }, $inc: { attempts: 1 } })).modifiedCount === 1
        if (final && e.giveOutcome?.status === 'held') await markUnavailable(this.db, c.childCustomerId, now)
        if (final && e.giveOutcome?.status === 'donated' && e.giveOutcome.recipient) await reconcileWithSweep(this.db, c.childCustomerId, c.tenantId, e.giveOutcome.recipient, now, correlation)
      }
    } else if (out.kind === 'refused' && out.code === 'CYCLE_ALREADY_PAID') {
      // §8: already done, here is the original. No second payment.
      final = (await this.cycles.updateOne(decided, { $set: { status: 'EXECUTED', bobOperationRef: String(out.error.execution_id ?? ''), bobReason: 'CYCLE_ALREADY_PAID', claimUntil: null, updatedAt: now }, $inc: { attempts: 1 } })).modifiedCount === 1
    } else if (out.kind === 'refused' && FAILED_CODES.has(out.code)) {
      final = (await this.cycles.updateOne(decided, { $set: { status: 'FAILED', bobReason: out.code, claimUntil: null, updatedAt: now }, $inc: { attempts: 1 } })).modifiedCount === 1
    } else {
      // Unknown, 401 (credential), 429 or an idempotency 409: the payment may have happened. Stay DECIDED; the same key is re-sent.
      await this.cycles.updateOne(decided, { $set: { bobReason: out.kind === 'refused' ? out.code : 'UPSTREAM_UNAVAILABLE', claimUntil: null, updatedAt: now }, $inc: { attempts: 1 } })
    }
    const done = (await this.cycles.findOne({ cycleKey: c.cycleKey }, { projection: { _id: 0 } }))!
    if (final) {
      await audit(this.db, { actor: 'allowance-cycle', tenantId: done.tenantId, action: `allowance.cycle_${done.status.toLowerCase()}`, subject: done.cycleKey, after: { bobOperationRef: done.bobOperationRef, bobReason: done.bobReason, amountCents: done.amountCents }, correlation }, now)
    }
    return done
  }
}
