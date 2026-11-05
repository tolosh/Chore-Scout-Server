/**
 * BOB family routes client, contract bob-family/1 (Confluence 3224731649).
 * Every method here runs under the acting person's own session (§2.1).
 * Section numbers are the page's (§4-§7), not its route-index labels.
 */
import { z } from 'zod'
import type { SessionToken } from '../identity/principal.js'
import type { BobHttp, BobOutcome } from './http.js'

const id = z.string().min(1).max(200)

// ---------------------------------------------------------------- §4.1 create a linked child

export interface CreateLinkedChildInput {
  firstName: string
  dateOfBirth: string
  email: string
}

const createdChild = z.object({
  child: z.object({ customer_id: id, bank_id: id, status: z.enum(['pending', 'active']) }),
  accounts: z.object({
    spend: z.object({ account_id: id }),
    save: z.object({ account_id: id }),
    give: z.object({ account_id: id }),
  }),
  link: z.object({ link_id: id, guardian_customer_id: id, child_customer_id: id }),
})

export interface CreatedChild {
  childCustomerId: string
  bankId: string
  linkId: string
  guardianCustomerId: string
  accounts: { spend: string; save: string; give: string }
}

/** A typed outcome: the parsed body for ok; a 2xx outside the documented shape is unknown. */
export type Outcome<T> = { kind: 'ok'; value: T; replay: boolean } | Extract<BobOutcome, { kind: 'refused' }> | Extract<BobOutcome, { kind: 'unknown' }>

export function parsed<S extends z.ZodTypeAny, T>(o: BobOutcome, schema: S, map: (d: z.infer<S>) => T): Outcome<T> {
  if (o.kind !== 'ok') return o
  const r = schema.safeParse(o.data)
  if (!r.success) return { kind: 'unknown', detail: 'response outside bob-family/1' }
  return { kind: 'ok', value: map(r.data), replay: o.replay }
}

// ---------------------------------------------------------------- §5 job payment

const jobPayment = z.object({
  payment_id: id,
  status: z.literal('completed'),
  purpose: z.literal('job'),
  job_ref: id,
  child_customer_id: id,
  from_account_id: id,
  amount_cents: z.number().int().positive(),
  currency: z.literal('AUD'),
})

export interface JobPaymentInput {
  childCustomerId: string
  jobRef: string
  fromAccountId: string
  amountCents: number
  description: string
}

export interface JobPayment {
  paymentId: string
  jobRef: string
  childCustomerId: string
  fromAccountId: string
  amountCents: number
}

// ---------------------------------------------------------------- §6.1 child allocation

export type BobJar = 'spend' | 'save' | 'give'

/**
 * A child's own jar moves (bob-family/1 §6.1 as amended by D52, CS-3943 comment
 * 39909): Spend→Save, Spend→Give, Save→Spend and Save→Give. Nothing leaves Give
 * (ID-4). Every move into Give goes through this allocations route, so BOB's
 * §6.2 sweep applies (D51): it donates only to the child's confirmed recipient,
 * otherwise it holds the money.
 */
export const CHILD_JAR_MOVES: readonly (readonly [BobJar, BobJar])[] = [
  ['spend', 'save'],
  ['spend', 'give'],
  ['save', 'spend'],
  ['save', 'give'],
]
export const isChildJarMove = (from: BobJar, to: BobJar) => CHILD_JAR_MOVES.some(([f, t]) => f === from && t === to)

const allocation = z.object({
  allocation_ref: id,
  status: z.literal('completed'),
  legs: z.array(
    z.object({
      leg_id: id,
      from_jar: z.enum(['spend', 'save', 'give']),
      to_jar: z.enum(['spend', 'save', 'give']),
      amount_cents: z.number().int().positive(),
      purpose: z.literal('allocation'),
      origin: z.literal('child'),
    }),
  ),
  give_outcome: z.object({
    status: z.enum(['donated', 'held', 'none']),
    donation_id: id.optional(),
    amount_cents: z.number().int().nonnegative().optional(),
    recipient: z.object({ charity_id: id, revision: z.number().int().nonnegative() }).optional(),
  }),
})

export interface AllocationInput {
  allocationRef: string
  fromJar: BobJar
  legs: { toJar: BobJar; amountCents: number }[]
}

export interface Allocation {
  allocationRef: string
  legs: { legId: string; toJar: BobJar; amountCents: number }[]
  giveOutcome: { status: 'donated' | 'held' | 'none'; donationId: string | null; amountCents: number; recipient: { charityId: string; revision: number } | null }
}

export class BobFamilyClient {
  constructor(private readonly http: BobHttp) {}

  /**
   * §4.1 POST /api/v1/children under the Guardian's session. The
   * Idempotency-Key is the set-up reference for this child slot. Contact
   * details pass through to BOB and are not kept by the server.
   */
  async createLinkedChild(session: SessionToken, idempotencyKey: string, input: CreateLinkedChildInput): Promise<Outcome<CreatedChild>> {
    const o = await this.http.send({
      method: 'POST',
      path: '/api/v1/children',
      auth: { session },
      idempotencyKey,
      body: { first_name: input.firstName, date_of_birth: input.dateOfBirth, email: input.email, guardian_confirms_authority: true },
    })
    return parsed(o, createdChild, (d) => ({
      childCustomerId: d.child.customer_id,
      bankId: d.child.bank_id,
      linkId: d.link.link_id,
      guardianCustomerId: d.link.guardian_customer_id,
      accounts: { spend: d.accounts.spend.account_id, save: d.accounts.save.account_id, give: d.accounts.give.account_id },
    }))
  }

  /**
   * §5 POST /api/v1/children/{child_id}/job-payments under the APPROVING
   * GUARDIAN'S own session (never a service credential, §9.1). Key
   * `cs:<opId>:job`. A 201 (or its replay) means BOB committed; the money
   * arrives unsplit in the child's Spend.
   */
  async payJob(session: SessionToken, idempotencyKey: string, input: JobPaymentInput): Promise<Outcome<JobPayment>> {
    const o = await this.http.send({
      method: 'POST',
      path: `/api/v1/children/${encodeURIComponent(input.childCustomerId)}/job-payments`,
      auth: { session },
      idempotencyKey,
      body: { job_ref: input.jobRef, from_account_id: input.fromAccountId, amount_cents: input.amountCents, currency: 'AUD', description: input.description },
    })
    return parsed(o, jobPayment, (d) => ({ paymentId: d.payment_id, jobRef: d.job_ref, childCustomerId: d.child_customer_id, fromAccountId: d.from_account_id, amountCents: d.amount_cents }))
  }

  /**
   * §6.1 POST /api/v1/children/me/allocations under the CHILD'S own session.
   * Jars, not account ids (`me` is the presenting child). All legs execute
   * atomically; BOB stamps purpose `allocation` and origin `child`, and runs
   * the Give sweep or hold (§6.2) in the same transaction. Key `cs:<splitOpId>:split`.
   */
  async allocate(session: SessionToken, idempotencyKey: string, input: AllocationInput): Promise<Outcome<Allocation>> {
    // Fail closed before BOB on a move outside the child's set (D52); nothing is sent.
    if (input.legs.length === 0 || input.legs.some((l) => !isChildJarMove(input.fromJar, l.toJar))) {
      throw new Error(`not a child jar move: ${input.fromJar} -> ${input.legs.map((l) => l.toJar).join(',') || '(none)'}`)
    }
    const o = await this.http.send({
      method: 'POST',
      path: '/api/v1/children/me/allocations',
      auth: { session },
      idempotencyKey,
      body: { allocation_ref: input.allocationRef, from_jar: input.fromJar, legs: input.legs.map((l) => ({ to_jar: l.toJar, amount_cents: l.amountCents })) },
    })
    return parsed(o, allocation, (d) => ({
      allocationRef: d.allocation_ref,
      legs: d.legs.map((l) => ({ legId: l.leg_id, toJar: l.to_jar, amountCents: l.amount_cents })),
      giveOutcome: {
        status: d.give_outcome.status,
        donationId: d.give_outcome.donation_id ?? null,
        amountCents: d.give_outcome.amount_cents ?? 0,
        recipient: d.give_outcome.recipient ? { charityId: d.give_outcome.recipient.charity_id, revision: d.give_outcome.recipient.revision } : null,
      },
    }))
  }
}

// ---------------------------------------------------------------- §6.3 the child's Give recipient

const giveRecipient = z.object({
  charity_id: id,
  revision: z.number().int().nonnegative(),
  confirmed_at: z.string().min(1),
  eligible: z.boolean(),
})

export interface GiveRecipient {
  charityId: string
  revision: number
  confirmedAt: Date
  eligible: boolean
}

export class BobGivingClient {
  constructor(private readonly http: BobHttp) {}

  /**
   * §6.3 PUT /api/v1/children/me/give-recipient under the CHILD'S own session.
   * The child's own confirmation of where future Give credits go (D51). Naturally
   * idempotent; no key. Moves no money and never releases held Give (HOLD-2).
   */
  async setGiveRecipient(session: SessionToken, charityId: string): Promise<Outcome<GiveRecipient>> {
    const o = await this.http.send({ method: 'PUT', path: '/api/v1/children/me/give-recipient', auth: { session }, body: { charity_id: charityId } })
    const out = parsed(o, giveRecipient, (d) => ({ charityId: d.charity_id, revision: d.revision, confirmedAt: new Date(d.confirmed_at), eligible: d.eligible }))
    // A recipient other than the one asked for is outside the contract: unknown, fail closed.
    if (out.kind === 'ok' && (out.value.charityId !== charityId || Number.isNaN(out.value.confirmedAt.getTime()))) return { kind: 'unknown', detail: 'response outside bob-family/1' }
    return out
  }
}
