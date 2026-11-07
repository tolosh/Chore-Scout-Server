/**
 * bob-family/1 §7: the Guardian's standing payment authority for allowances
 * (CS-3963, CS-3964; ID-14 as revised: "Sarah authorises, BOB executes, the
 * server decides"; SD-7: the exact amount, once per cycle).
 *
 * - §7.1 create and §7.2 change run under the Guardian's OWN session.
 * - §7.5 execute runs under the server's allowance credential, the only service
 *   credential (identity model 6, 11.10). It is passed in by the jobs process
 *   from the secrets store and is never logged or stored.
 */
import { z } from 'zod'
import type { SessionToken } from '../identity/principal.js'
import { parsed, type Outcome } from './family.js'
import type { BobHttp } from './http.js'

const id = z.string().min(1).max(200)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const cents = z.number().int().nonnegative()

export interface SplitCents {
  spend: number
  save: number
  give: number
}
export interface AuthorityCycle {
  period: 'weekly'
  startDate: string
  timezone: string
}

const authority = z.object({
  authority_id: id,
  version: z.number().int().positive(),
  status: z.enum(['active', 'revoked']),
  guardian_customer_id: id,
  child_customer_id: id,
  from_account_id: id,
  amount_cents: z.number().int().positive(),
  currency: z.literal('AUD'),
  split_cents: z.object({ spend: cents, save: cents, give: cents }),
  cycle: z.object({ period: z.literal('weekly'), start_date: date, timezone: z.string().min(1) }),
  purposes: z.array(z.string()),
})

export interface Authority {
  authorityId: string
  version: number
  status: 'active' | 'revoked'
  guardianCustomerId: string
  childCustomerId: string
  fromAccountId: string
  amountCents: number
  splitCents: SplitCents
  cycle: AuthorityCycle
  purposes: string[]
}

const toAuthority = (d: z.infer<typeof authority>): Authority => ({
  authorityId: d.authority_id,
  version: d.version,
  status: d.status,
  guardianCustomerId: d.guardian_customer_id,
  childCustomerId: d.child_customer_id,
  fromAccountId: d.from_account_id,
  amountCents: d.amount_cents,
  splitCents: d.split_cents,
  cycle: { period: d.cycle.period, startDate: d.cycle.start_date, timezone: d.cycle.timezone },
  purposes: d.purposes,
})

export const authorityCreateKey = (childId: string) => `cs:${childId}:authority:create`
export const authorityChangeKey = (authorityId: string, expectedVersion: number) => `cs:${authorityId}:v${expectedVersion}`

/** §7.1, §7.2 under the Guardian's own session. */
export class BobAuthorityClient {
  constructor(private readonly http: BobHttp) {}

  async create(
    session: SessionToken,
    childId: string,
    input: { fromAccountId: string; amountCents: number; splitCents: SplitCents; cycle: AuthorityCycle },
  ): Promise<Outcome<Authority>> {
    const o = await this.http.send({
      method: 'POST',
      path: `/api/v1/children/${encodeURIComponent(childId)}/standing-authorities`,
      auth: { session },
      idempotencyKey: authorityCreateKey(childId),
      body: {
        from_account_id: input.fromAccountId,
        amount_cents: input.amountCents,
        currency: 'AUD',
        split_cents: input.splitCents,
        cycle: { period: input.cycle.period, start_date: input.cycle.startDate, timezone: input.cycle.timezone },
      },
    })
    return parsed(o, authority, toAuthority)
  }

  async change(
    session: SessionToken,
    authorityId: string,
    expectedVersion: number,
    input: { amountCents: number; splitCents: SplitCents; fromAccountId: string },
  ): Promise<Outcome<Authority>> {
    const o = await this.http.send({
      method: 'PATCH',
      path: `/api/v1/standing-authorities/${encodeURIComponent(authorityId)}`,
      auth: { session },
      idempotencyKey: authorityChangeKey(authorityId, expectedVersion),
      body: { expected_version: expectedVersion, amount_cents: input.amountCents, split_cents: input.splitCents, from_account_id: input.fromAccountId },
    })
    return parsed(o, authority, toAuthority)
  }
}

// ---------------------------------------------------------------- §7.5 execution under the allowance credential

const leg = z.object({ leg_id: id, purpose: z.string(), origin: z.string().optional(), amount_cents: z.number().int().positive() })
const execution = z.object({
  execution_id: id,
  status: z.literal('completed'),
  authority_id: id,
  authority_version: z.number().int().positive(),
  child_customer_id: id,
  cycle_ref: date,
  instruction_ref: id,
  amount_cents: z.number().int().positive(),
  legs: z.array(leg).min(1),
  give_outcome: z
    .object({
      status: z.enum(['donated', 'held', 'none']),
      donation_id: id.optional(),
      amount_cents: cents.optional(),
      recipient: z.object({ charity_id: id, revision: z.number().int().nonnegative() }).optional(),
    })
    .optional(),
})

export interface Execution {
  executionId: string
  authorityVersion: number
  childCustomerId: string
  cycleRef: string
  instructionRef: string
  amountCents: number
  legs: { purpose: string; origin: string | null; amountCents: number }[]
  giveOutcome: { status: 'donated' | 'held' | 'none'; amountCents: number; recipient: { charityId: string; revision: number } | null } | null
}

export const allowanceKey = (cycleKey: string) => `cs:${cycleKey}:allowance`
export const instructionRef = (childId: string, cycleRef: string) => `cyc_${childId}:${cycleRef}`

export class BobAllowanceExecutor {
  /** `credential` comes from the secrets store in the jobs process only (config.ts); it is sent to route 7.5 and nowhere else. */
  constructor(
    private readonly http: BobHttp,
    private readonly credential: string,
  ) {}

  async execute(authorityId: string, cycleKey: string, input: { childCustomerId: string; cycleRef: string; amountCents: number }): Promise<Outcome<Execution>> {
    const o = await this.http.send({
      method: 'POST',
      path: `/api/v1/service/standing-authorities/${encodeURIComponent(authorityId)}/executions`,
      auth: { serviceCredential: this.credential },
      idempotencyKey: allowanceKey(cycleKey),
      body: { child_customer_id: input.childCustomerId, cycle_ref: input.cycleRef, amount_cents: input.amountCents, instruction_ref: instructionRef(input.childCustomerId, input.cycleRef) },
    })
    return parsed(o, execution, (d) => ({
      executionId: d.execution_id,
      authorityVersion: d.authority_version,
      childCustomerId: d.child_customer_id,
      cycleRef: d.cycle_ref,
      instructionRef: d.instruction_ref,
      amountCents: d.amount_cents,
      legs: d.legs.map((l) => ({ purpose: l.purpose, origin: l.origin ?? null, amountCents: l.amount_cents })),
      giveOutcome: d.give_outcome
        ? {
            status: d.give_outcome.status,
            amountCents: d.give_outcome.amount_cents ?? 0,
            recipient: d.give_outcome.recipient ? { charityId: d.give_outcome.recipient.charity_id, revision: d.give_outcome.recipient.revision } : null,
          }
        : null,
    }))
  }
}
