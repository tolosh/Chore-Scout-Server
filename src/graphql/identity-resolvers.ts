/**
 * CS-3942 resolvers: viewer, family, child(id).
 *
 * Family scope is BOB's answer only. The families collection (written by the
 * set-up orchestration, CS-3948) supplies the familyId pointer; it never adds
 * a child or a guardian to what BOB says (spec §5: "a pointer only; BOB's
 * links are authoritative").
 */
import { assertChildAccess, assertSameTenant } from '../identity/authz.js'
import { isChild, isGuardian, type Principal } from '../identity/principal.js'
import type { RequestContext } from './context.js'
import type { ResolverMap } from './schema.js'

export interface FamilyDoc {
  familyId: string
  tenantId: string
  guardianCustomerIds: string[]
  childCustomerIds: string[]
}

export const viewerRole = (p: Principal): 'CHILD' | 'GUARDIAN' | 'CUSTOMER' =>
  isChild(p) ? 'CHILD' : isGuardian(p) ? 'GUARDIAN' : 'CUSTOMER'

/** The family record this person belongs to, in their own bank only. */
export async function familyRecordFor(ctx: RequestContext): Promise<FamilyDoc | null> {
  const p = ctx.actor.principal
  const field = isChild(p) ? 'childCustomerIds' : 'guardianCustomerIds'
  const doc = await ctx.db
    .collection<FamilyDoc>('families')
    .findOne({ tenantId: p.tenantId, [field]: p.customerId }, { projection: { _id: 0 } })
  return doc
}

export const identityResolvers: ResolverMap = {
  Query: {
    viewer: (_root, _args, ctx: RequestContext) => {
      const p = ctx.actor.principal
      return {
        customerId: p.customerId,
        role: viewerRole(p),
        tenantId: p.tenantId,
        ageBand: p.ageBand,
        linkedChildIds: p.children.map((c) => c.customerId),
        linkedGuardianIds: p.guardians.map((g) => g.customerId),
        linkedChildren: p.children.map((c) => ({ customerId: c.customerId, status: c.status === 'active' ? 'ACTIVE' : 'PENDING' })),
        anonymousPlayerId: p.playerRef,
      }
    },

    family: async (_root, _args, ctx: RequestContext) => {
      const p = ctx.actor.principal
      const doc = await familyRecordFor(ctx)
      if (!doc) return null
      assertSameTenant(p, doc.tenantId)
      return isChild(p)
        ? { familyId: doc.familyId, tenantId: p.tenantId, guardianCustomerIds: p.guardians.map((g) => g.customerId), childCustomerIds: [p.customerId] }
        : { familyId: doc.familyId, tenantId: p.tenantId, guardianCustomerIds: [p.customerId], childCustomerIds: p.children.map((c) => c.customerId) }
    },

    child: async (_root, args: { id: string }, ctx: RequestContext) => {
      const p = ctx.actor.principal
      assertChildAccess(p, args.id)
      const doc = await ctx.db
        .collection<FamilyDoc>('families')
        .findOne({ tenantId: p.tenantId, childCustomerIds: args.id }, { projection: { _id: 0 } })
      if (!doc) return null
      return { customerId: args.id, familyId: doc.familyId, ageBand: isChild(p) ? p.ageBand : null }
    },
  },
}
