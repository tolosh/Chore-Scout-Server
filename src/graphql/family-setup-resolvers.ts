/** CS-3948 resolvers: startFamilySetup, familySetup(setupRef). */
import { FamilySetupService, isResumable, type FamilySetupDoc, type SetupChildInput } from '../family-setup/service.js'
import type { RequestContext } from './context.js'
import type { ResolverMap } from './schema.js'

const service = (ctx: RequestContext) => new FamilySetupService(ctx.db, ctx.bob.family, ctx.now)

export const toGraph = (d: FamilySetupDoc) => ({
  setupRef: d.setupRef,
  state: d.state,
  resumable: isResumable(d),
  familyId: d.familyId ?? null,
  slots: d.slots.map((s) => ({ slot: s.slot, state: s.state, childCustomerId: s.childCustomerId ?? null, reason: s.reason ?? null })),
})

export const familySetupResolvers: ResolverMap = {
  Query: {
    familySetup: async (_r, args: { setupRef: string }, ctx: RequestContext) => {
      const d = await service(ctx).get(ctx.actor, args.setupRef)
      return d ? toGraph(d) : null
    },
  },
  Mutation: {
    startFamilySetup: async (_r, args: { setupRef: string; children: SetupChildInput[] }, ctx: RequestContext) =>
      toGraph(await service(ctx).start(ctx.actor, args.setupRef, args.children, ctx.correlationId)),
  },
}
