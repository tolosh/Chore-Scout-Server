/** CS-3949 resolvers: jobs, approvals, createJob, submitJob, decideJob, retryJobPayment. */
import { JobService, type ApprovalDoc, type DecisionResult, type JobDoc, type JobKind, type MoneyOperationDoc } from '../chores/service.js'
import { money, toCents, type MoneyInput } from '../money.js'
import type { RequestContext } from './context.js'
import type { ResolverMap } from './schema.js'

const service = (ctx: RequestContext) => new JobService(ctx.db, ctx.bob.family, ctx.now)

export const opToGraph = (o: MoneyOperationDoc | null) =>
  o && { idempotencyKey: o.idempotencyKey, kind: o.kind, status: o.status, bobOperationRef: o.bobOperationRef, amount: money(o.amountCents), reason: o.reason }

const jobToGraph = (j: JobDoc, payment: MoneyOperationDoc | null = null) => ({
  jobId: j.jobId,
  childCustomerId: j.childCustomerId,
  kind: j.kind,
  title: j.title,
  reward: j.rewardCents === null ? null : money(j.rewardCents),
  points: j.points,
  status: j.status,
  evidenceRef: j.evidenceRef,
  version: j.version,
  createdAt: j.createdAt.toISOString(),
  payment: opToGraph(payment),
})

const approvalToGraph = (a: ApprovalDoc) => ({
  approvalId: a.approvalId,
  kind: a.kind,
  status: a.status,
  childCustomerId: a.childCustomerId,
  subjectId: a.subjectId,
  createdAt: a.createdAt.toISOString(),
  version: a.version,
})

const decisionToGraph = (r: DecisionResult) => ({ job: jobToGraph(r.job, r.payment), approval: approvalToGraph(r.approval), payment: opToGraph(r.payment) })

async function withPayments(ctx: RequestContext, jobs: JobDoc[]) {
  const keys = jobs.map((j) => j.paymentKey).filter((k): k is string => k !== null)
  const ops = keys.length ? await ctx.db.collection<MoneyOperationDoc>('money_operations').find({ idempotencyKey: { $in: keys } }, { projection: { _id: 0 } }).toArray() : []
  const byKey = new Map(ops.map((o) => [o.idempotencyKey, o]))
  return jobs.map((j) => jobToGraph(j, j.paymentKey ? (byKey.get(j.paymentKey) ?? null) : null))
}

export const jobResolvers: ResolverMap = {
  Query: {
    jobs: async (_r, a: { childId?: string | null }, ctx: RequestContext) => withPayments(ctx, await service(ctx).list(ctx.actor, a.childId ?? null)),
    approvals: async (_r, _a, ctx: RequestContext) => (await service(ctx).pendingApprovals(ctx.actor)).map(approvalToGraph),
  },
  Mutation: {
    createJob: async (_r, a: { childId: string; kind: JobKind; title: string; reward?: MoneyInput | null; points?: number | null; idempotencyKey: string }, ctx: RequestContext) =>
      jobToGraph(
        await service(ctx).create(
          ctx.actor,
          { childId: a.childId, kind: a.kind, title: a.title, rewardCents: a.reward ? toCents(a.reward, 'reward') : null, points: a.points ?? null, idempotencyKey: a.idempotencyKey },
          ctx.correlationId,
        ),
      ),
    submitJob: async (_r, a: { jobId: string; evidenceRef?: string | null; expectedVersion: number; idempotencyKey: string }, ctx: RequestContext) =>
      jobToGraph(await service(ctx).submit(ctx.actor, a.jobId, a.evidenceRef ?? null, a.expectedVersion, a.idempotencyKey, ctx.correlationId)),
    decideJob: async (_r, a: { jobId: string; decision: 'APPROVE' | 'REJECT'; expectedVersion: number; idempotencyKey: string; fromAccountId?: string | null }, ctx: RequestContext) =>
      decisionToGraph(await service(ctx).decide(ctx.actor, { ...a, fromAccountId: a.fromAccountId ?? null }, ctx.correlationId)),
    retryJobPayment: async (_r, a: { jobId: string; expectedVersion: number; idempotencyKey: string }, ctx: RequestContext) =>
      decisionToGraph(await service(ctx).retryPayment(ctx.actor, a.jobId, a.expectedVersion, a.idempotencyKey, ctx.correlationId)),
  },
}
