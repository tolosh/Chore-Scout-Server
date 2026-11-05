/**
 * BOB session-check client (CS-3942), implemented to contract bob-session/1
 * (Confluence 3224666113, "BOB session-check contract (CS-3943)").
 *
 *   GET {BOB_API_URL}/api/v1/auth/session
 *   Authorization: Bearer <the person's own access token, forwarded unchanged>
 *   X-BOB-Caller: chorescout-server   (audit only; carries no authority, §3)
 *
 * Outcomes (§5):
 * - 200 with a body that meets the contract -> the answer.
 * - 401 (any body)                         -> UNAUTHENTICATED; the caller drops any cache entry.
 * - 429                                    -> UNAUTHENTICATED: "treat the person as not
 *                                             authenticated until a 200 arrives".
 * - 400, 5xx, any other status, a timeout, a network error, or a 200 that breaks
 *   the contract (wrong contract string, unknown role or bank, a child with other
 *   roles, a status other than active, a missing field) -> UPSTREAM_UNAVAILABLE.
 *   Fail closed; never a fallback.
 *
 * Unknown additional fields are ignored (§ header: additive optional fields may
 * appear within version 1). No token is logged: log lines carry session_id and
 * customer_id only (§6 rule 6).
 */
import { z } from 'zod'
import { CsError } from '../errors.js'
import type { AgeBand, BobRole, LinkedPerson, Principal, SessionToken } from '../identity/principal.js'
import type { SessionAnswer, SessionCheck } from '../identity/session-check.js'

export const SESSION_CONTRACT = 'bob-session/1'
export const SESSION_PATH = '/api/v1/auth/session'
export const CALLER_HEADER_VALUE = 'chorescout-server'
/** Version 1 bank ids (contract §4.1, ID-15). Anything else fails closed. */
export const KNOWN_BANKS = ['bank_bilgola', 'bank_manly'] as const
/** ply_ + 26 Crockford base32 characters (contract §4.1). */
export const PLAYER_REF_RE = /^ply_[0-9A-HJKMNP-TV-Z]{26}$/

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'ISO 8601 timestamp')
const id = z.string().min(1).max(200)

const link = z.object({
  customer_id: id,
  link_id: id,
  status: z.enum(['pending', 'active']),
  player_ref: z.string().regex(PLAYER_REF_RE).optional(),
})

const body = z.object({
  data: z.object({
    contract: z.literal(SESSION_CONTRACT),
    checked_at: iso,
    session: z.object({
      session_id: id,
      issued_at: iso,
      access_expires_at: iso,
      idle_expires_at: iso,
    }),
    person: z.object({
      customer_id: id,
      bank_id: z.enum(KNOWN_BANKS),
      roles: z.array(z.enum(['customer', 'guardian', 'child'])).min(1),
      status: z.literal('active'),
      player_ref: z.string().regex(PLAYER_REF_RE),
    }),
    child: z
      .object({
        minor: z.literal(true),
        age_band: z.enum(['child', 'youth']),
        limits: z.array(z.string()),
      })
      .nullable(),
    guardians: z.array(link),
    children: z.array(link),
  }),
})

type Body = z.infer<typeof body>['data']

export interface SessionLog {
  warn(obj: object, msg: string): void
}

export interface BobSessionCheckOptions {
  baseUrl: string
  timeoutMs: number
  fetch?: typeof globalThis.fetch
  log?: SessionLog
}

const upstream = (msg: string) => new CsError('UPSTREAM_UNAVAILABLE', msg)

/** Contract rules beyond field types (§4.1). Returns a problem, or null. */
export function contractProblem(d: Body): string | null {
  const roles = d.person.roles
  if (new Set(roles).size !== roles.length) return 'duplicate roles'
  const child = roles.includes('child')
  if (child && roles.length !== 1) return 'child role appears with another role'
  if (child && d.child === null) return 'child session without child object'
  if (!child && d.child !== null) return 'child object on an adult session'
  if (!child && !roles.includes('customer')) return 'adult session without customer role'
  if (child && d.children.length > 0) return 'child session lists children'
  if (!child && d.guardians.length > 0) return 'adult session lists guardians'
  if (roles.includes('guardian') !== d.children.length > 0) return 'guardian role does not match children list'
  if (d.guardians.some((g) => g.status !== 'active')) return 'guardian link not active'
  if (d.children.some((c) => c.player_ref === undefined)) return 'child link without player_ref'
  const ids = [d.person.customer_id, ...d.children.map((c) => c.customer_id), ...d.guardians.map((g) => g.customer_id)]
  if (new Set(ids).size !== ids.length) return 'duplicate or self link'
  return null
}

const toLinked = (l: z.infer<typeof link>): LinkedPerson =>
  Object.freeze({ customerId: l.customer_id, linkId: l.link_id, status: l.status, playerRef: l.player_ref ?? null })

export function toAnswer(d: Body): SessionAnswer {
  const principal: Principal = Object.freeze({
    customerId: d.person.customer_id,
    tenantId: d.person.bank_id,
    roles: Object.freeze([...d.person.roles] as BobRole[]),
    ageBand: d.child ? (d.child.age_band.toUpperCase() as AgeBand) : null,
    playerRef: d.person.player_ref,
    children: Object.freeze(d.children.map(toLinked)),
    guardians: Object.freeze(d.guardians.map(toLinked)),
    sessionId: d.session.session_id,
  })
  return { principal, checkedAt: new Date(d.checked_at), accessExpiresAt: new Date(d.session.access_expires_at) }
}

export class BobSessionCheck implements SessionCheck {
  private readonly url: string
  private readonly fetchFn: typeof globalThis.fetch

  constructor(private readonly opts: BobSessionCheckOptions) {
    this.url = new URL(SESSION_PATH, opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`).toString()
    this.fetchFn = opts.fetch ?? globalThis.fetch
  }

  async check(session: SessionToken): Promise<SessionAnswer> {
    let res: Response
    try {
      res = await this.fetchFn(this.url, {
        method: 'GET',
        headers: { authorization: `Bearer ${session.reveal()}`, 'x-bob-caller': CALLER_HEADER_VALUE, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      })
    } catch (err) {
      this.opts.log?.warn({ err: (err as Error).name }, 'session check: BOB unreachable')
      throw upstream('session check unavailable')
    }
    if (res.status === 401 || res.status === 429) {
      await res.body?.cancel()
      throw new CsError('UNAUTHENTICATED', 'session not valid')
    }
    if (res.status !== 200) {
      await res.body?.cancel()
      this.opts.log?.warn({ status: res.status }, 'session check: BOB error')
      throw upstream('session check unavailable')
    }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw upstream('session check: malformed response')
    }
    const parsed = body.safeParse(json)
    if (!parsed.success) {
      this.opts.log?.warn({ issues: parsed.error.issues.map((i) => i.path.join('.')) }, 'session check: response outside bob-session/1')
      throw upstream('session check: response outside contract')
    }
    const problem = contractProblem(parsed.data.data)
    if (problem) {
      this.opts.log?.warn({ problem, sessionId: parsed.data.data.session.session_id }, 'session check: response outside bob-session/1')
      throw upstream('session check: response outside contract')
    }
    return toAnswer(parsed.data.data)
  }
}
