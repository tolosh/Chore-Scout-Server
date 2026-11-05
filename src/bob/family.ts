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
  amountCents: number
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
    return parsed(o, jobPayment, (d) => ({ paymentId: d.payment_id, jobRef: d.job_ref, childCustomerId: d.child_customer_id, amountCents: d.amount_cents }))
  }
}
