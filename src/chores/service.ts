/**
 * Jobs and Guardian approvals (CS-3949; spec §5, §7; identity model §6).
 *
 * States: TODO -> WAITING (child submits) -> SENT_BACK (Guardian sends back;
 * the child can resubmit) or, on approval:
 *   - a job with a reward: APPROVED_PAYMENT_PENDING -> PAID or PAYMENT_FAILED;
 *   - a good deed, or a chore with no reward: DONE, with zero BOB calls.
 *
 * Job pay (bob-family/1 §5):
 * - One money operation per job (opId `job-<jobId>`, key `cs:<opId>:job`),
 *   written BEFORE BOB is called. Concurrent or replayed approvals converge
 *   on it, and BOB allows one payment per (child, job_ref) whatever the key.
 * - BOB is called under the approving Guardian's own session.
 * - PAID is set only after BOB reports completion (201, or its replay, or
 *   JOB_ALREADY_PAID with the original payment id). The amount is then
 *   credited to the child's unsplit ledger, exactly once.
 * - An unknown outcome (timeout, 5xx, in progress) leaves the operation
 *   PENDING for the Guardian. retryJobPayment, under a live Guardian session,
 *   re-sends exactly the original key, amount and source account. Nothing
 *   retries in the background.
 * - A BOB refusal (FORBIDDEN, INSUFFICIENT_FUNDS, VALIDATION_ERROR) is FAILED
 *   with BOB's code, and the job is PAYMENT_FAILED. No money moved.
 */
import { createHash } from 'node:crypto'
import { MongoServerError, type Collection, type Db } from 'mongodb'
import { audit } from '../audit.js'
import type { BobFamilyClient } from '../bob/family.js'
import { forbidden, invalid, notAllowedInState, stale, unauthenticated } from '../errors.js'
import { assertChildSelf, assertGuardianOf, visibleChildIds } from '../identity/authz.js'
import type { Actor } from '../identity/principal.js'
import { creditFromJobPayment } from '../unsplit/ledger.js'

export type JobKind = 'HOME_JOB' | 'EXTRA_EARNER' | 'GOOD_DEED' | 'NEIGHBOURHOOD'
export type JobStatus = 'TODO' | 'WAITING' | 'SENT_BACK' | 'APPROVED_PAYMENT_PENDING' | 'PAID' | 'PAYMENT_FAILED' | 'DONE'

export interface JobDoc {
  jobId: string
  tenantId: string
  childCustomerId: string
  createdBy: string
  kind: JobKind
  title: string
  rewardCents: number | null
  points: number | null
  status: JobStatus
  evidenceRef: string | null
  version: number
  createdAt: Date
  submittedAt: Date | null
  decidedAt: Date | null
  decidedBy: string | null
  approvalId: string | null
  paymentKey: string | null
  /** Idempotency: the client key of each applied mutation, mapped to the version it produced. */
  appliedKeys: Record<string, number>
}

export interface ApprovalDoc {
  approvalId: string
  tenantId: string
  kind: 'JOB'
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  childCustomerId: string
  subjectId: string
  createdAt: Date
  version: number
}

export interface MoneyOperationDoc {
  idempotencyKey: string
  opId: string
  kind: 'job'
  tenantId: string
  jobId: string
  childCustomerId: string
  actorCustomerId: string
  fromAccountId: string
  amountCents: number
  status: 'PENDING' | 'COMPLETED' | 'FAILED'
  bobOperationRef: string | null
  reason: string | null
  attempts: number
  createdAt: Date
  updatedAt: Date
}

export const jobOpId = (jobId: string) => `job-${jobId}`
export const jobPaymentKey = (jobId: string) => `cs:${jobOpId(jobId)}:job`
/**
 * Refusals that guarantee nothing moved under this key. IDEMPOTENCY_CONFLICT is
 * NOT one: §2.3 says only the conflicting call did nothing, and the original
 * call under the key may have paid. It stays PENDING (CS-3949 review R2).
 */
const FINAL_PAY_REFUSALS = new Set(['FORBIDDEN', 'INSUFFICIENT_FUNDS', 'VALIDATION_ERROR'])
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/
const MAX_POINTS = 10_000

export interface CreateJobInput {
  childId: string
  kind: JobKind
  title: string
  rewardCents: number | null
  points: number | null
  idempotencyKey: string
}

export interface DecisionResult {
  job: JobDoc
  approval: ApprovalDoc
  payment: MoneyOperationDoc | null
}

export class JobService {
  private readonly jobs: Collection<JobDoc>
  private readonly approvals: Collection<ApprovalDoc>
  private readonly ops: Collection<MoneyOperationDoc>

  constructor(
    private readonly db: Db,
    private readonly bob: BobFamilyClient,
    private readonly now: () => Date,
  ) {
    this.jobs = db.collection<JobDoc>('jobs')
    this.approvals = db.collection<ApprovalDoc>('approvals')
    this.ops = db.collection<MoneyOperationDoc>('money_operations')
  }

  private key(k: string): void {
    if (!KEY_RE.test(k)) throw invalid('idempotencyKey must be 8-128 characters of A-Z, a-z, 0-9, . _ : -')
  }

  /** Load a job the actor may see; FORBIDDEN (same answer) if it isn't theirs or doesn't exist. */
  private async visibleJob(actor: Actor, jobId: string): Promise<JobDoc> {
    const job = await this.jobs.findOne({ jobId }, { projection: { _id: 0 } })
    const p = actor.principal
    if (!job || job.tenantId !== p.tenantId || !visibleChildIds(p).includes(job.childCustomerId)) throw forbidden()
    return job
  }

  async list(actor: Actor, childId: string | null): Promise<JobDoc[]> {
    const visible = visibleChildIds(actor.principal)
    if (childId !== null && !visible.includes(childId)) throw forbidden()
    const ids = childId === null ? visible : [childId]
    return this.jobs.find({ tenantId: actor.principal.tenantId, childCustomerId: { $in: ids } }, { projection: { _id: 0 }, sort: { createdAt: 1 } }).toArray()
  }

  /** The Guardian's pending approvals, for their linked children only. A child has none. */
  async pendingApprovals(actor: Actor): Promise<ApprovalDoc[]> {
    const p = actor.principal
    const ids = p.children.map((c) => c.customerId)
    if (ids.length === 0 || p.roles.includes('child')) return []
    return this.approvals.find({ tenantId: p.tenantId, childCustomerId: { $in: ids }, status: 'PENDING' }, { projection: { _id: 0 }, sort: { createdAt: 1 } }).toArray()
  }

  async create(actor: Actor, input: CreateJobInput, correlation: string): Promise<JobDoc> {
    const p = actor.principal
    assertGuardianOf(p, input.childId)
    this.key(input.idempotencyKey)
    const title = input.title.trim()
    if (title.length < 1 || title.length > 80) throw invalid('title must be 1-80 characters')
    if (input.kind === 'GOOD_DEED') {
      if (input.rewardCents !== null) throw invalid('a good deed carries points only, no reward')
      if (input.points === null) throw invalid('a good deed needs points')
    } else if (input.kind !== 'HOME_JOB' && input.rewardCents === null) {
      throw invalid(`${input.kind} needs a reward`)
    }
    if (input.points !== null && (!Number.isInteger(input.points) || input.points < 1 || input.points > MAX_POINTS)) throw invalid('points must be 1-10000')
    // Idempotent create: the job id is derived from the Guardian's key, so a replay finds the same job.
    const jobId = `job-${hash(`${p.tenantId}:${p.customerId}:${input.idempotencyKey}`)}`
    const now = this.now()
    const doc: JobDoc = {
      jobId,
      tenantId: p.tenantId,
      childCustomerId: input.childId,
      createdBy: p.customerId,
      kind: input.kind,
      title,
      rewardCents: input.rewardCents,
      points: input.points,
      status: 'TODO',
      evidenceRef: null,
      version: 1,
      createdAt: now,
      submittedAt: null,
      decidedAt: null,
      decidedBy: null,
      approvalId: null,
      paymentKey: null,
      appliedKeys: { [input.idempotencyKey]: 1 },
    }
    try {
      await this.jobs.insertOne({ ...doc })
    } catch (err) {
      if (!(err instanceof MongoServerError && err.code === 11000)) throw err
      const existing = (await this.jobs.findOne({ jobId }, { projection: { _id: 0 } }))!
      if (existing.childCustomerId !== input.childId || existing.title !== title || existing.rewardCents !== input.rewardCents || existing.kind !== input.kind) {
        throw invalid('idempotencyKey reused with a different job')
      }
      return existing
    }
    await audit(this.db, { actor: p.customerId, tenantId: p.tenantId, action: 'job.created', subject: jobId, after: { childCustomerId: input.childId, kind: input.kind, rewardCents: input.rewardCents }, correlation }, now)
    return doc
  }

  async submit(actor: Actor, jobId: string, evidenceRef: string | null, expectedVersion: number, idempotencyKey: string, correlation: string): Promise<JobDoc> {
    this.key(idempotencyKey)
    const job = await this.visibleJob(actor, jobId)
    assertChildSelf(actor.principal, job.childCustomerId)
    if (job.appliedKeys[idempotencyKey] !== undefined) return job // replay
    if (evidenceRef !== null && evidenceRef.length > 200) throw invalid('evidenceRef too long')
    if (job.version !== expectedVersion) throw stale()
    if (job.status !== 'TODO' && job.status !== 'SENT_BACK') throw notAllowedInState(`cannot submit a job in ${job.status}`)
    const now = this.now()
    const approvalId = `apr-${jobId}-v${job.version + 1}`
    const r = await this.jobs.findOneAndUpdate(
      { jobId, version: expectedVersion, status: { $in: ['TODO', 'SENT_BACK'] } },
      { $set: { status: 'WAITING', evidenceRef, submittedAt: now, approvalId, [`appliedKeys.${idempotencyKey}`]: job.version + 1 }, $inc: { version: 1 } },
      { returnDocument: 'after', projection: { _id: 0 } },
    )
    if (!r) return this.afterLostRace(actor, jobId, idempotencyKey)
    await this.approvals.insertOne({ approvalId, tenantId: job.tenantId, kind: 'JOB', status: 'PENDING', childCustomerId: job.childCustomerId, subjectId: jobId, createdAt: now, version: 1 })
    await audit(this.db, { actor: actor.principal.customerId, tenantId: job.tenantId, action: 'job.submitted', subject: jobId, correlation }, now)
    return r
  }

  private async afterLostRace(actor: Actor, jobId: string, idempotencyKey: string): Promise<JobDoc> {
    const now = await this.visibleJob(actor, jobId)
    if (now.appliedKeys[idempotencyKey] !== undefined) return now
    throw stale()
  }

  async decide(
    actor: Actor,
    args: { jobId: string; decision: 'APPROVE' | 'REJECT'; expectedVersion: number; idempotencyKey: string; fromAccountId: string | null },
    correlation: string,
  ): Promise<DecisionResult> {
    this.key(args.idempotencyKey)
    const p = actor.principal
    const job = await this.visibleJob(actor, args.jobId)
    assertGuardianOf(p, job.childCustomerId) // a child can never approve
    if (job.appliedKeys[args.idempotencyKey] !== undefined) return this.settle(actor, job, correlation) // replay: finish any payment
    if (job.version !== args.expectedVersion) throw stale()
    if (job.status !== 'WAITING') throw notAllowedInState(`cannot decide a job in ${job.status}`)
    const pays = args.decision === 'APPROVE' && job.rewardCents !== null
    if (pays && (args.fromAccountId === null || args.fromAccountId.length < 1 || args.fromAccountId.length > 200)) {
      throw invalid('fromAccountId (the Guardian’s own account) is required to approve a paid job')
    }
    const now = this.now()

    // The money operation is recorded before the job moves and before BOB is called.
    if (pays) await this.recordPayment(actor, job, args.fromAccountId!, now)

    const status: JobStatus = args.decision === 'REJECT' ? 'SENT_BACK' : pays ? 'APPROVED_PAYMENT_PENDING' : 'DONE'
    const r = await this.jobs.findOneAndUpdate(
      { jobId: job.jobId, version: args.expectedVersion, status: 'WAITING' },
      {
        $set: { status, decidedAt: now, decidedBy: p.customerId, paymentKey: pays ? jobPaymentKey(job.jobId) : null, [`appliedKeys.${args.idempotencyKey}`]: job.version + 1 },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', projection: { _id: 0 } },
    )
    if (!r) {
      const latest = await this.afterLostRace(actor, job.jobId, args.idempotencyKey)
      return this.settle(actor, latest, correlation)
    }
    await this.approvals.updateOne({ approvalId: job.approvalId!, status: 'PENDING' }, { $set: { status: args.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' }, $inc: { version: 1 } })
    await audit(this.db, { actor: p.customerId, tenantId: job.tenantId, action: `job.${args.decision === 'APPROVE' ? 'approved' : 'sent_back'}`, subject: job.jobId, after: { status }, correlation }, now)
    return this.settle(actor, r, correlation)
  }

  /** Retry a payment whose outcome is unknown, under the Guardian's live session, with the original key. */
  async retryPayment(actor: Actor, jobId: string, expectedVersion: number, idempotencyKey: string, correlation: string): Promise<DecisionResult> {
    this.key(idempotencyKey)
    const job = await this.visibleJob(actor, jobId)
    assertGuardianOf(actor.principal, job.childCustomerId)
    if (job.version !== expectedVersion) throw stale()
    if (job.status !== 'APPROVED_PAYMENT_PENDING') throw notAllowedInState(`no payment pending for a job in ${job.status}`)
    // §5, §9.1: only the approving Guardian's own session pays (CS-3949 review R1).
    const op = job.paymentKey ? await this.ops.findOne({ idempotencyKey: job.paymentKey }, { projection: { _id: 0, actorCustomerId: 1 } }) : null
    if (op && op.actorCustomerId !== actor.principal.customerId) throw forbidden('only the Guardian who approved this job can retry its payment')
    return this.settle(actor, job, correlation)
  }

  private async recordPayment(actor: Actor, job: JobDoc, fromAccountId: string, now: Date): Promise<void> {
    const op: MoneyOperationDoc = {
      idempotencyKey: jobPaymentKey(job.jobId),
      opId: jobOpId(job.jobId),
      kind: 'job',
      tenantId: job.tenantId,
      jobId: job.jobId,
      childCustomerId: job.childCustomerId,
      actorCustomerId: actor.principal.customerId,
      fromAccountId,
      amountCents: job.rewardCents!,
      status: 'PENDING',
      bobOperationRef: null,
      reason: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }
    try {
      await this.ops.insertOne({ ...op })
    } catch (err) {
      if (!(err instanceof MongoServerError && err.code === 11000)) throw err
      // A concurrent approval already recorded the one payment for this job. It
      // may go ahead only if it is the same Guardian paying from the same
      // account; otherwise it lost the race (CS-3949 review R1).
      const stored = await this.ops.findOne({ idempotencyKey: op.idempotencyKey }, { projection: { _id: 0, actorCustomerId: 1, fromAccountId: 1 } })
      if (!stored || stored.actorCustomerId !== op.actorCustomerId || stored.fromAccountId !== fromAccountId) throw stale()
    }
  }

  /**
   * Drive a job's payment to its outcome. Idempotent: safe on every replay.
   * Calls BOB only while the operation is PENDING, and only with the stored
   * key, amount and source account.
   */
  private async settle(actor: Actor, job: JobDoc, correlation: string): Promise<DecisionResult> {
    let op = job.paymentKey ? await this.ops.findOne({ idempotencyKey: job.paymentKey }, { projection: { _id: 0 } }) : null
    // BOB is called only under the session of the Guardian who recorded the payment (§5, §9.1;
    // CS-3949 review R1). Anyone else sees the current state and nothing is sent.
    if (op && op.status === 'PENDING' && job.status === 'APPROVED_PAYMENT_PENDING' && op.actorCustomerId === actor.principal.customerId) {
      const out = await this.bob.payJob(actor.session, op.idempotencyKey, {
        childCustomerId: op.childCustomerId,
        jobRef: op.jobId,
        fromAccountId: op.fromAccountId,
        amountCents: op.amountCents,
        description: job.title,
      })
      const now = this.now()
      if (out.kind === 'ok' || (out.kind === 'refused' && out.code === 'JOB_ALREADY_PAID')) {
        const ref = out.kind === 'ok' ? out.value.paymentId : String(out.error.payment_id ?? '')
        if (
          out.kind === 'ok' &&
          (out.value.amountCents !== op.amountCents || out.value.childCustomerId !== op.childCustomerId || out.value.jobRef !== op.jobId || out.value.fromAccountId !== op.fromAccountId)
        ) {
          // Outside the contract: never mark PAID on an answer that doesn't match what we asked for.
          await this.ops.updateOne({ idempotencyKey: op.idempotencyKey, status: 'PENDING' }, { $set: { reason: 'UPSTREAM_MISMATCH', updatedAt: now }, $inc: { attempts: 1 } })
        } else {
          await this.ops.updateOne({ idempotencyKey: op.idempotencyKey, status: 'PENDING' }, { $set: { status: 'COMPLETED', bobOperationRef: ref || null, reason: null, updatedAt: now }, $inc: { attempts: 1 } })
        }
      } else if (out.kind === 'refused' && out.code === 'UNAUTHORIZED') {
        await this.ops.updateOne({ idempotencyKey: op.idempotencyKey, status: 'PENDING' }, { $set: { reason: 'UNAUTHORIZED', updatedAt: now }, $inc: { attempts: 1 } })
        throw unauthenticated()
      } else if (out.kind === 'refused' && FINAL_PAY_REFUSALS.has(out.code)) {
        await this.ops.updateOne({ idempotencyKey: op.idempotencyKey, status: 'PENDING' }, { $set: { status: 'FAILED', reason: out.code, updatedAt: now }, $inc: { attempts: 1 } })
      } else {
        await this.ops.updateOne(
          { idempotencyKey: op.idempotencyKey, status: 'PENDING' },
          { $set: { reason: out.kind === 'refused' ? out.code : 'UPSTREAM_UNAVAILABLE', updatedAt: now }, $inc: { attempts: 1 } },
        )
      }
      op = await this.ops.findOne({ idempotencyKey: op.idempotencyKey }, { projection: { _id: 0 } })
    }
    let current = job
    if (op && op.status !== 'PENDING' && job.status === 'APPROVED_PAYMENT_PENDING') {
      const now = this.now()
      if (op.status === 'COMPLETED') {
        await creditFromJobPayment(this.db, { ...op, kind: 'job', status: 'COMPLETED' }, now)
      }
      const next: JobStatus = op.status === 'COMPLETED' ? 'PAID' : 'PAYMENT_FAILED'
      await this.jobs.updateOne({ jobId: job.jobId, status: 'APPROVED_PAYMENT_PENDING' }, { $set: { status: next }, $inc: { version: 1 } })
      await audit(this.db, { actor: actor.principal.customerId, tenantId: job.tenantId, action: `job.${next.toLowerCase()}`, subject: job.jobId, after: { bobOperationRef: op.bobOperationRef, reason: op.reason }, correlation }, now)
      current = (await this.jobs.findOne({ jobId: job.jobId }, { projection: { _id: 0 } }))!
    } else if (op && op.status === 'COMPLETED' && job.status === 'PAID') {
      await creditFromJobPayment(this.db, { ...op, kind: 'job', status: 'COMPLETED' }, this.now()) // idempotent repair
    }
    const approval = (await this.approvals.findOne({ approvalId: current.approvalId! }, { projection: { _id: 0 } }))!
    return { job: current, approval, payment: op }
  }
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24)
