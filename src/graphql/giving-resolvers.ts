/** CS-3962 and CS-3957 resolvers: giving(childId), setCharityPreference, heldGiving and confirmHeldRelease. */
import { HeldGiveService, type HeldView, type ReleaseOperationDoc } from '../giving/held.js'
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

const heldToGraph = (v: HeldView | null) =>
  v && {
    childCustomerId: v.childCustomerId,
    amount: money(v.amountCents),
    recipientName: v.recipientName,
    recipientUnavailable: v.recipientUnavailable,
    reviewVersion: v.reviewVersion,
    confirmedAt: v.confirmedAt?.toISOString() ?? null,
  }

const releaseToGraph = (o: ReleaseOperationDoc) => ({ idempotencyKey: o.idempotencyKey, kind: o.kind, status: o.status, bobOperationRef: o.bobOperationRef, amount: money(o.amountCents), reason: o.reason })

export const givingResolvers: ResolverMap = {
  Query: {
    giving: async (_r, a: { childId: string }, ctx: RequestContext) => {
      const p = ctx.actor.principal
      assertChildAccess(p, a.childId)
      const pref = await readPreference(ctx.db, a.childId, p.tenantId)
      return { childCustomerId: a.childId, availability: availabilityOf(pref), preference: preferenceToGraph(pref), confirmingBobCharityId: pref?.pending?.bobCharityId ?? null }
    },
  },
  CsGiving: {
    /** CS-3957: BOB's held amount, live; the child also gets a reviewable quote (§6.5). Null when nothing is held. */
    heldGiving: async (g: { childCustomerId: string }, _a, ctx: RequestContext) => heldToGraph(await new HeldGiveService(ctx.db, ctx.bob.giving, ctx.now).review(ctx.actor, g.childCustomerId)),
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
    confirmHeldRelease: async (_r, a: { childId: string; reviewVersion: number; idempotencyKey: string }, ctx: RequestContext) => {
      const r = await new HeldGiveService(ctx.db, ctx.bob.giving, ctx.now).confirm(ctx.actor, a.childId, a.reviewVersion, a.idempotencyKey, ctx.correlationId)
      return { review: heldToGraph(r.review), operation: releaseToGraph(r.operation) }
    },
    setCharityPreference: async (_r, a: { childId: string; bobCharityId: string; expectedVersion?: number | null; idempotencyKey: string }, ctx: RequestContext) => {
      const d = await new CharityPreferenceService(ctx.db, ctx.bob.giving, ctx.now).set(ctx.actor, a.childId, a.bobCharityId, a.expectedVersion, a.idempotencyKey, ctx.correlationId)
      // A first choice still pending can't be shown as confirmed; the service throws in that case, so d is settled here.
      return preferenceToGraph(d)
    },
  },
}
