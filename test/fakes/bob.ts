/**
 * In-memory BOB for tests. It answers GET /api/v1/auth/session exactly as
 * contract bob-session/1 (Confluence 3224666113) describes, through a fake
 * fetch, so tests exercise the real adapter (src/bob/session-check.ts).
 * Customer ids here are synthetic test fixtures, never real BOB ids.
 */
import { createHash, randomBytes } from 'node:crypto'

type Bank = 'bank_bilgola' | 'bank_manly'

interface Person {
  customerId: string
  bank: Bank
  kind: 'adult' | 'child'
  ageBand?: 'child' | 'youth'
}

interface Link {
  guardian: string
  child: string
  linkId: string
  status: 'pending' | 'active'
  revoked: boolean
}

interface Session {
  customerId: string
  sessionId: string
  ended: boolean
  accessExpiresAt: Date
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function playerRefFor(customerId: string): string {
  const h = createHash('sha256').update(`test-player:${customerId}`).digest()
  let out = 'ply_'
  for (let i = 0; i < 26; i++) out += CROCKFORD[h[i]! % 32]
  return out
}

export const UNAUTHORIZED_BODY = { data: null, meta: { requestId: 'r' }, errors: [{ code: 'UNAUTHORIZED', message: 'Not signed in' }] }

export interface RouteCtx {
  person: Person | null
  token: string | null
  params: string[]
  body: Record<string, unknown>
  headers: Headers
}
export type RouteResult = { status: number; body: unknown }
type Handler = (ctx: RouteCtx) => RouteResult

export const ok = (status: number, data: unknown): RouteResult => ({ status, body: { data, meta: { requestId: 'r' }, errors: [] } })
export const err = (status: number, code: string, extra: Record<string, unknown> = {}): RouteResult => ({
  status,
  body: { data: null, meta: { requestId: 'r' }, errors: [{ code, message: code.toLowerCase(), ...extra }] },
})

let seq = 0
export const newId = (prefix: string) => `${prefix}_T${String(++seq).padStart(6, '0')}`

export class FakeBob {
  /** bob-family/1 routes: method, path pattern, whether Idempotency-Key is required, handler. */
  private readonly routes: { method: string; re: RegExp; idempotent: boolean; handler: Handler }[] = []
  /** §2.3 idempotency records keyed by principal, route and key. */
  private readonly idem = new Map<string, { bodyHash: string; result: RouteResult | 'in-progress' }>()
  /** Every bob-family/1 request seen (method, path, idempotency key, bearer). */
  readonly calls: { method: string; path: string; key: string | null; bearer: string | null; body: Record<string, unknown> }[] = []
  /**
   * Fault injection: for the next N matching requests, BOB processes the call
   * and commits, then the response is lost (a timeout or a crash between
   * BOB's success and the server's write, as seen by the server).
   */
  dropResponses: { re: RegExp; count: number } | null = null
  /** Force a status for the next N matching requests WITHOUT processing them (e.g. 503). */
  failBefore: { re: RegExp; count: number; status: number; code: string } | null = null
  readonly emails = new Map<string, Set<string>>()
  /** Every completed money movement BOB made (its ledger), for evidence in tests. */
  readonly ledger: { paymentId: string; purpose: string; origin?: string; from: string; to: string; amountCents: number; ref: string }[] = []
  readonly jobPayments = new Map<string, string>()
  readonly accounts = new Map<string, { owner: string; jar: 'spend' | 'save' | 'give' | 'funding'; balance: number }>()

  readonly people = new Map<string, Person>()
  readonly links: Link[] = []
  readonly sessions = new Map<string, Session>()
  /** Every session-check request seen: the headers BOB received. */
  readonly sessionCalls: { authorization: string | null; caller: string | null; url: string }[] = []
  /** Force the next session-check responses (status and body), e.g. 503. */
  override: { status: number; body: unknown } | null = null
  clock: () => Date = () => new Date()
  /** Mutates a 200 body before it is sent (contract-violation tests). */
  mutate: ((data: Record<string, unknown>) => void) | null = null

  addAdult(customerId: string, bank: Bank = 'bank_bilgola'): this {
    this.people.set(customerId, { customerId, bank, kind: 'adult' })
    return this
  }

  addChild(customerId: string, bank: Bank = 'bank_bilgola', ageBand: 'child' | 'youth' = 'child'): this {
    this.people.set(customerId, { customerId, bank, kind: 'child', ageBand })
    return this
  }

  link(guardian: string, child: string, status: 'pending' | 'active' = 'active'): this {
    this.links.push({ guardian, child, linkId: `lnk_${guardian}_${child}`, status, revoked: false })
    return this
  }

  revokeLink(guardian: string, child: string): void {
    for (const l of this.links) if (l.guardian === guardian && l.child === child) l.revoked = true
  }

  signIn(customerId: string): string {
    if (!this.people.has(customerId)) throw new Error(`unknown ${customerId}`)
    const token = `bobat_${randomBytes(32).toString('base64url')}`
    this.sessions.set(token, {
      customerId,
      sessionId: `ses_${randomBytes(8).toString('hex')}`,
      ended: false,
      accessExpiresAt: new Date(this.clock().getTime() + 15 * 60_000),
    })
    return token
  }

  endSession(token: string): void {
    const s = this.sessions.get(token)
    if (s) s.ended = true
  }

  /** The person a live token belongs to, or null (BOB's own live check on its routes). */
  personFor(token: string | undefined): Person | null {
    if (!token) return null
    const s = this.sessions.get(token)
    if (!s || s.ended || s.accessExpiresAt <= this.clock()) return null
    return this.people.get(s.customerId) ?? null
  }

  activeLink(guardian: string, child: string): Link | undefined {
    return this.links.find((l) => l.guardian === guardian && l.child === child && !l.revoked)
  }

  sessionData(token: string): Record<string, unknown> | null {
    const s = this.sessions.get(token)
    const p = this.personFor(token)
    if (!s || !p) return null
    const live = this.links.filter((l) => !l.revoked)
    const children = p.kind === 'adult' ? live.filter((l) => l.guardian === p.customerId) : []
    const guardians = p.kind === 'child' ? live.filter((l) => l.child === p.customerId) : []
    const now = this.clock()
    return {
      contract: 'bob-session/1',
      checked_at: now.toISOString(),
      session: {
        session_id: s.sessionId,
        issued_at: now.toISOString(),
        access_expires_at: s.accessExpiresAt.toISOString(),
        idle_expires_at: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      },
      person: {
        customer_id: p.customerId,
        bank_id: p.bank,
        roles: p.kind === 'child' ? ['child'] : children.length > 0 ? ['customer', 'guardian'] : ['customer'],
        status: 'active',
        player_ref: playerRefFor(p.customerId),
      },
      child:
        p.kind === 'child'
          ? { minor: true, age_band: p.ageBand, limits: ['no_external_payments', 'no_new_payees', 'purchases_from_spend_only', 'no_withdrawal_from_give'] }
          : null,
      guardians: guardians.map((l) => ({ customer_id: l.guardian, link_id: l.linkId, status: 'active' })),
      children: children.map((l) => ({ customer_id: l.child, link_id: l.linkId, status: l.status, player_ref: playerRefFor(l.child) })),
    }
  }

  route(method: string, re: RegExp, idempotent: boolean, handler: Handler): this {
    this.routes.push({ method, re, idempotent, handler })
    return this
  }

  /** Accounts held by a customer, by jar. */
  accountOf(owner: string, jar: 'spend' | 'save' | 'give' | 'funding'): string | undefined {
    for (const [id, a] of this.accounts) if (a.owner === owner && a.jar === jar) return id
    return undefined
  }

  openAccount(owner: string, jar: 'spend' | 'save' | 'give' | 'funding', balance = 0): string {
    const id = newId('acc')
    this.accounts.set(id, { owner, jar, balance })
    return id
  }

  balance(owner: string, jar: 'spend' | 'save' | 'give' | 'funding'): number {
    const id = this.accountOf(owner, jar)
    return id ? this.accounts.get(id)!.balance : 0
  }

  private async serveFamilyRoute(method: string, url: URL, init: RequestInit | undefined, headers: Headers): Promise<Response | null> {
    const r = this.routes.find((x) => x.method === method && x.re.test(url.pathname))
    if (!r) return null
    const params = r.re.exec(url.pathname)!.slice(1)
    const bearer = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1] ?? null
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>
    const key = headers.get('idempotency-key')
    this.calls.push({ method, path: url.pathname, key, bearer, body })
    if (this.failBefore && this.failBefore.re.test(url.pathname) && this.failBefore.count > 0) {
      this.failBefore.count--
      const e = err(this.failBefore.status, this.failBefore.code)
      return json(e.status, e.body)
    }
    const person = this.personFor(bearer ?? undefined)
    const ctx: RouteCtx = { person, token: bearer, params, body, headers }
    let result: RouteResult
    let replay = false
    if (r.idempotent) {
      if (!key) {
        const e = err(400, 'IDEMPOTENCY_KEY_REQUIRED')
        return json(e.status, e.body)
      }
      const scope = `${person?.customerId ?? bearer ?? 'anon'}|${method} ${r.re.source}|${key}`
      const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
      const prior = this.idem.get(scope)
      if (prior && prior.bodyHash !== bodyHash) result = err(409, 'IDEMPOTENCY_CONFLICT')
      else if (prior && prior.result === 'in-progress') result = err(409, 'IDEMPOTENCY_IN_PROGRESS')
      else if (prior) {
        result = prior.result as RouteResult
        replay = true
      } else {
        this.idem.set(scope, { bodyHash, result: 'in-progress' })
        result = r.handler(ctx)
        // Unauthenticated calls are not bound to a key (no principal to scope them to).
        if (result.status === 401) this.idem.delete(scope)
        else this.idem.set(scope, { bodyHash, result })
      }
    } else {
      result = r.handler(ctx)
    }
    if (this.dropResponses && this.dropResponses.re.test(url.pathname) && this.dropResponses.count > 0) {
      this.dropResponses.count--
      throw new TypeError('fetch failed (response lost after BOB committed)')
    }
    const status = replay && result.status === 201 ? 200 : result.status
    const res = json(status, result.body)
    if (replay) res.headers.set('x-idempotency-replay', 'true')
    return res
  }

  /** A fetch that serves BOB's session route and the registered bob-family/1 routes. */
  fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const headers = new Headers(init?.headers)
    const method = init?.method ?? 'GET'
    const served = await this.serveFamilyRoute(method, url, init, headers)
    if (served) return served
    if (url.pathname === '/api/v1/auth/session' && (init?.method ?? 'GET') === 'GET') {
      const authorization = headers.get('authorization')
      this.sessionCalls.push({ authorization, caller: headers.get('x-bob-caller'), url: url.toString() })
      if (this.override) return json(this.override.status, this.override.body)
      const m = /^Bearer (.+)$/.exec(authorization ?? '')
      const data = m?.[1] ? this.sessionData(m[1]) : null
      if (!data) return json(401, UNAUTHORIZED_BODY)
      this.mutate?.(data)
      return json(200, { data, meta: { requestId: 'r' }, errors: [] })
    }
    return json(404, { data: null, errors: [{ code: 'NOT_FOUND', message: 'no route' }] })
  }

  constructor() {
    installFamilyRoutes(this)
  }
}

/** Years between a YYYY-MM-DD date of birth and today. */
function ageOn(dob: string, today: Date): number {
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number]
  let age = today.getUTCFullYear() - y
  if (today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d)) age--
  return age
}

/** Move money between two accounts, as BOB's protected transfer would (one step, balance checked). */
export function move(bob: FakeBob, from: string, to: string, amountCents: number, purpose: string, ref: string, origin?: string): string {
  const a = bob.accounts.get(from)!
  const b = bob.accounts.get(to)!
  if (a.balance < amountCents) throw new Error('insufficient')
  a.balance -= amountCents
  b.balance += amountCents
  const paymentId = newId('pay')
  bob.ledger.push({ paymentId, purpose, origin, from, to, amountCents, ref })
  return paymentId
}

/** bob-family/1 §4.1 and §5. Later tickets' routes are installed alongside. */
export function installFamilyRoutes(bob: FakeBob): void {
  bob.route('POST', /^\/api\/v1\/children\/([^/]+)\/job-payments$/, true, (c) => {
    if (!c.person) return err(401, 'UNAUTHORIZED')
    const childId = decodeURIComponent(c.params[0]!)
    const child = bob.people.get(childId)
    if (c.person.kind !== 'adult' || !child || child.bank !== c.person.bank || !bob.activeLink(c.person.customerId, childId)) return err(403, 'FORBIDDEN')
    const b = c.body
    const from = bob.accounts.get(String(b.from_account_id))
    if (!from || from.owner !== c.person.customerId) return err(403, 'FORBIDDEN')
    if (!Number.isInteger(b.amount_cents) || (b.amount_cents as number) <= 0 || b.currency !== 'AUD' || typeof b.job_ref !== 'string') return err(400, 'VALIDATION_ERROR')
    const prior = bob.jobPayments.get(`${childId}|${b.job_ref}`)
    if (prior) return err(409, 'JOB_ALREADY_PAID', { payment_id: prior })
    const amount = b.amount_cents as number
    if (from.balance < amount) return err(422, 'INSUFFICIENT_FUNDS')
    const spend = bob.accountOf(childId, 'spend')!
    const paymentId = move(bob, String(b.from_account_id), spend, amount, 'job', String(b.job_ref))
    bob.jobPayments.set(`${childId}|${b.job_ref}`, paymentId)
    return ok(201, {
      payment_id: paymentId,
      status: 'completed',
      purpose: 'job',
      job_ref: b.job_ref,
      child_customer_id: childId,
      from_account_id: b.from_account_id,
      to_account_id: spend,
      amount_cents: amount,
      currency: 'AUD',
      completed_at: bob.clock().toISOString(),
    })
  })

  bob.route('POST', /^\/api\/v1\/children$/, true, (c) => {
    if (!c.person) return err(401, 'UNAUTHORIZED')
    if (c.person.kind !== 'adult') return err(403, 'FORBIDDEN')
    const b = c.body
    const allowed = ['first_name', 'date_of_birth', 'email', 'guardian_confirms_authority']
    if (Object.keys(b).some((k) => !allowed.includes(k))) return err(400, 'VALIDATION_ERROR')
    if (typeof b.first_name !== 'string' || !b.first_name || typeof b.email !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date_of_birth)) || b.guardian_confirms_authority !== true) {
      return err(400, 'VALIDATION_ERROR')
    }
    const bank = c.person.bank
    const emails = bob.emails.get(bank) ?? new Set<string>()
    bob.emails.set(bank, emails)
    const email = b.email.toLowerCase()
    if (emails.has(email)) return err(409, 'EMAIL_IN_USE')
    const age = ageOn(String(b.date_of_birth), bob.clock())
    if (age < 6 || age > 17) return err(422, 'AGE_OUT_OF_RANGE')
    const childId = newId('cust')
    emails.add(email)
    bob.addChild(childId, bank, age >= 13 ? 'youth' : 'child')
    bob.link(c.person.customerId, childId, 'pending')
    const spend = bob.openAccount(childId, 'spend')
    const save = bob.openAccount(childId, 'save')
    const give = bob.openAccount(childId, 'give')
    return ok(201, {
      child: { customer_id: childId, bank_id: bank, status: 'pending', age_band: age >= 13 ? 'youth' : 'child', player_ref: playerRefFor(childId) },
      accounts: { spend: { account_id: spend, jar: 'spend' }, save: { account_id: save, jar: 'save' }, give: { account_id: give, jar: 'give' } },
      link: {
        link_id: `lnk_${c.person.customerId}_${childId}`,
        guardian_customer_id: c.person.customerId,
        child_customer_id: childId,
        status: 'active',
        created_at: bob.clock().toISOString(),
        authority: { action: 'create_linked_child', recorded_against_session_id: 'ses_x', guardian_confirmed: true },
      },
      welcome_email: 'sent',
    })
  })
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
