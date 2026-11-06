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

export class FakeBob {
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

  /** A fetch that serves BOB's session route. Other paths 404 (later tickets add theirs). */
  fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const headers = new Headers(init?.headers)
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
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
