/** CS-3962 resolvers: giving(childId), setCharityPreference. Held-Give review and release follow in CS-3957. */
import { CsError } from '../errors.js'
import { assertChildAccess } from '../identity/authz.js'
import { money } from '../money.js'
import { availabilityOf, CharityPreferenceService, readPreference, type CharityPreferenceDoc } from '../giving/preference.js'
import type { SplitOperationDoc } from '../unsplit/split.js'
import type { RequestContext } from './context.js'
import type { ResolverMap } from './schema.js'

export const preferenceToGraph = (d: CharityPreferenceDoc | null) =>
  d && d.bobCharityId
    ? { childCustomerId: d.childCustomerId, bobCharityId: d.bobCharityId, version: d.version, revision: d.revision, confirmedAt: d.confirmedAt?.toISOString() ?? null, availability: availabilityOf(d) }
    : null

export const givingResolvers: ResolverMap = {
  Query: {
    giving: async (_r, a: { childId: string }, ctx: RequestContext) => {
      const p = ctx.actor.principal
      assertChildAccess(p, a.childId)
      const pref = await readPreference(ctx.db, a.childId, p.tenantId)
      return { childCustomerId: a.childId, availability: availabilityOf(pref), preference: preferenceToGraph(pref) }
    },
  },
  CsGiving: {
    /** Not built in this PR (CS-3957). A null here would wrongly read as "nothing held", so the field refuses instead. */
    heldGiving: () => {
      throw new CsError('UPSTREAM_UNAVAILABLE', 'CsGiving.heldGiving is not built in this release')
    },
    /** Immediate donations the server saw BOB complete (split Give legs); BOB's ledger is the record. */
    donations: async (g: { childCustomerId: string }, _a, ctx: RequestContext) => {
      const ops = await ctx.db
        .collection<SplitOperationDoc>('money_operations')
        .find({ childCustomerId: g.childCustomerId, tenantId: ctx.actor.principal.tenantId, kind: 'split', 'giveOutcome.status': 'DONATED' }, { projection: { _id: 0 } })
        .sort({ updatedAt: -1 })
        .limit(50)
        .toArray()
      return ops.map((o) => ({ bobOperationRef: o.giveOutcome!.donationRef, amount: money(o.giveOutcome!.amountCents), recipientName: null, at: o.updatedAt.toISOString() }))
    },
  },
  Mutation: {
    setCharityPreference: async (_r, a: { childId: string; bobCharityId: string; expectedVersion?: number | null; idempotencyKey: string }, ctx: RequestContext) => {
      const d = await new CharityPreferenceService(ctx.db, ctx.bob.giving, ctx.now).set(ctx.actor, a.childId, a.bobCharityId, a.expectedVersion, a.idempotencyKey, ctx.correlationId)
      // A first choice still pending can't be shown as confirmed; the service throws in that case, so d is settled here.
      return preferenceToGraph(d)
    },
  },
}
