/** CS-3963 resolvers: allowance(childId) and setAllowance. The cycle itself runs in the jobs process (CS-3979). */
import { addDays, cycleKeyOf, localDate, periodContaining } from '../allowance/decide.js'
import { CYCLES, type AllowanceCycleDoc } from '../allowance/cycle.js'
import { AllowanceRuleService, RULES, type AllowanceRuleDoc, type SetAllowanceInput } from '../allowance/rule.js'
import { assertChildAccess } from '../identity/authz.js'
import { money } from '../money.js'
import type { RequestContext } from './context.js'
import type { ResolverMap } from './schema.js'

const ruleToGraph = (r: AllowanceRuleDoc) => ({
  childCustomerId: r.childCustomerId,
  mode: r.mode,
  amount: money(r.amountCents),
  cadence: r.cadence,
  startDate: r.startDate,
  timezone: r.timezone,
  defaultSplit: r.split,
  linkedCondition: r.linkedCondition,
  version: r.version,
})

const cycleToGraph = (c: AllowanceCycleDoc) => ({
  cycleKey: c.cycleKey,
  periodStart: c.periodStart,
  decision: c.decision,
  reason: c.reason ?? c.bobReason,
  ruleVersion: c.ruleVersion,
  amount: c.amountCents === null ? null : money(c.amountCents),
  bobOperationRef: c.bobOperationRef,
  status: c.status,
  // The receipt is the auto-split BOB executed (origin automatic); nothing is shown as unsplit.
  receipt:
    c.status === 'EXECUTED' && c.bobOperationRef && c.splitCents && c.amountCents !== null
      ? {
          bobOperationRef: c.bobOperationRef,
          amount: money(c.amountCents),
          legs: [
            { jar: 'SPEND', amount: money(c.splitCents.spend) },
            { jar: 'SAVE', amount: money(c.splitCents.save) },
            { jar: 'GIVE', amount: money(c.splitCents.give) },
          ],
        }
      : null,
})

export const allowanceResolvers: ResolverMap = {
  Query: {
    allowance: async (_r, a: { childId: string }, ctx: RequestContext) => {
      const p = ctx.actor.principal
      assertChildAccess(p, a.childId)
      const rule = await ctx.db.collection<AllowanceRuleDoc>(RULES).findOne({ childCustomerId: a.childId, tenantId: p.tenantId }, { projection: { _id: 0 } })
      if (!rule) return { rule: null, nextDueDate: null, lastCycle: null }
      const today = localDate(ctx.now(), rule.timezone)
      const current = periodContaining(rule.startDate, today)
      // Cycle keys are deterministic, so the recent cycles are found on the unique cycleKey index.
      const keys = Array.from({ length: 8 }, (_, n) => addDays(current, -7 * n))
        .filter((d) => d >= rule.startDate)
        .map((d) => cycleKeyOf(a.childId, d))
      const recent = await ctx.db.collection<AllowanceCycleDoc>(CYCLES).find({ cycleKey: { $in: keys }, tenantId: p.tenantId }, { projection: { _id: 0 } }).toArray()
      recent.sort((x, y) => (x.periodStart < y.periodStart ? 1 : -1))
      return { rule: ruleToGraph(rule), nextDueDate: addDays(current, 7), lastCycle: recent[0] ? cycleToGraph(recent[0]) : null }
    },
  },
  Mutation: {
    setAllowance: async (_r, a: Omit<SetAllowanceInput, 'childId'> & { childId: string }, ctx: RequestContext) => {
      const r = await new AllowanceRuleService(ctx.db, ctx.bob.authority, ctx.now).set(ctx.actor, a, ctx.correlationId)
      return ruleToGraph(r)
    },
  },
}
