/** CS-3953 resolvers: unsplit(childId), splitUnsplit. */
import { assertChildAccess } from '../identity/authz.js'
import { money } from '../money.js'
import { readLedger, type UnsplitLedgerDoc } from '../unsplit/ledger.js'
import { SplitService, type LegInput, type SplitOperationDoc } from '../unsplit/split.js'
import type { RequestContext } from './context.js'
import type { ResolverMap } from './schema.js'

const ledgerToGraph = (childCustomerId: string, l: UnsplitLedgerDoc | null) => ({
  childCustomerId,
  balance: money(l?.balanceCents ?? 0),
  entries: (l?.entries ?? []).map((e) => ({ entryId: e.entryId, jobId: e.jobId || null, amount: money(e.amountCents), createdAt: e.createdAt.toISOString() })),
  version: l?.version ?? 0,
})

const opToGraph = (o: SplitOperationDoc) => ({
  idempotencyKey: o.idempotencyKey,
  kind: o.kind,
  status: o.status,
  bobOperationRef: o.bobOperationRef,
  amount: money(o.amountCents),
  reason: o.reason,
})

export const unsplitResolvers: ResolverMap = {
  Query: {
    unsplit: async (_r, a: { childId: string }, ctx: RequestContext) => {
      assertChildAccess(ctx.actor.principal, a.childId)
      const l = await readLedger(ctx.db, a.childId)
      return ledgerToGraph(a.childId, l && l.tenantId === ctx.actor.principal.tenantId ? l : null)
    },
  },
  Mutation: {
    splitUnsplit: async (_r, a: { childId: string; legs: LegInput[]; expectedVersion: number; idempotencyKey: string }, ctx: RequestContext) => {
      const op = await new SplitService(ctx.db, ctx.bob.family, ctx.now).split(ctx.actor, a.childId, a.legs, a.expectedVersion, a.idempotencyKey, ctx.correlationId)
      const l = await readLedger(ctx.db, a.childId)
      return {
        unsplit: ledgerToGraph(a.childId, l),
        operations: [opToGraph(op)],
        giveOutcome: op.giveOutcome && { status: op.giveOutcome.status, amount: money(op.giveOutcome.amountCents), donationRef: op.giveOutcome.donationRef },
      }
    },
  },
}
