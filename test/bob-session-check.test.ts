/** The BOB session-check adapter against contract bob-session/1 (Confluence 3224666113). */
import { describe, expect, it } from 'vitest'
import { BobSessionCheck, CALLER_HEADER_VALUE } from '../src/bob/session-check.js'
import { CsError } from '../src/errors.js'
import { SessionToken } from '../src/identity/principal.js'
import { FakeBob, json, playerRefFor, UNAUTHORIZED_BODY } from './fakes/bob.js'

const world = () =>
  new FakeBob()
    .addAdult('cust_T_SARAH')
    .addChild('cust_T_MIA')
    .addChild('cust_T_LEO', 'bank_bilgola', 'youth')
    .link('cust_T_SARAH', 'cust_T_MIA')
    .link('cust_T_SARAH', 'cust_T_LEO', 'pending')

const client = (bob: FakeBob, logs: unknown[] = []) =>
  new BobSessionCheck({ baseUrl: 'http://bob.test/', timeoutMs: 500, fetch: bob.fetch, log: { warn: (o, m) => logs.push([o, m]) } })

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'resolved'
  } catch (err) {
    return err instanceof CsError ? err.code : `other:${(err as Error).message}`
  }
}

describe('request (contract §2, §3)', () => {
  it('GETs /api/v1/auth/session with the person’s own bearer token and X-BOB-Caller', async () => {
    const bob = world()
    const tok = bob.signIn('cust_T_SARAH')
    await client(bob).check(new SessionToken(tok))
    expect(bob.sessionCalls).toEqual([{ authorization: `Bearer ${tok}`, caller: CALLER_HEADER_VALUE, url: 'http://bob.test/api/v1/auth/session' }])
  })

  it('sends no query string, cookie, teller or customer-token header', async () => {
    let seen: Headers | undefined
    let seenUrl = ''
    const bob = world()
    const tok = bob.signIn('cust_T_SARAH')
    const c = new BobSessionCheck({
      baseUrl: 'http://bob.test',
      timeoutMs: 500,
      fetch: async (u, init) => {
        seen = new Headers(init?.headers)
        seenUrl = String(u)
        return bob.fetch(u, init)
      },
    })
    await c.check(new SessionToken(tok))
    expect(new URL(seenUrl).search).toBe('')
    expect([...seen!.keys()].sort()).toEqual(['accept', 'authorization', 'x-bob-caller'])
  })
})

describe('200 mapping (contract §4.1)', () => {
  it('Guardian: roles, bank, children with status and player_ref; no guardians', async () => {
    const bob = world()
    const a = await client(bob).check(new SessionToken(bob.signIn('cust_T_SARAH')))
    expect(a.principal).toMatchObject({
      customerId: 'cust_T_SARAH',
      tenantId: 'bank_bilgola',
      roles: ['customer', 'guardian'],
      ageBand: null,
      playerRef: playerRefFor('cust_T_SARAH'),
      guardians: [],
    })
    expect(a.principal.children.map((c) => [c.customerId, c.status, c.playerRef])).toEqual([
      ['cust_T_MIA', 'active', playerRefFor('cust_T_MIA')],
      ['cust_T_LEO', 'pending', playerRefFor('cust_T_LEO')],
    ])
    expect(a.checkedAt).toBeInstanceOf(Date)
    expect(a.accessExpiresAt.getTime()).toBeGreaterThan(a.checkedAt.getTime())
  })

  it('Child: exactly ["child"], age band from BOB, guardians listed', async () => {
    const bob = world()
    const a = await client(bob).check(new SessionToken(bob.signIn('cust_T_LEO')))
    expect(a.principal).toMatchObject({ roles: ['child'], ageBand: 'YOUTH', children: [] })
    expect(a.principal.guardians.map((g) => g.customerId)).toEqual(['cust_T_SARAH'])
  })

  it('ignores unknown additional fields (additive within version 1)', async () => {
    const bob = world()
    bob.mutate = (d) => {
      d.extra = 1
      ;(d.child as Record<string, unknown>).teen_mode = false
    }
    expect(await codeOf(client(bob).check(new SessionToken(bob.signIn('cust_T_MIA'))))).toBe('resolved')
  })

  it('the mapped principal carries no token and no contact details', async () => {
    const bob = world()
    const tok = bob.signIn('cust_T_SARAH')
    const a = await client(bob).check(new SessionToken(tok))
    const s = JSON.stringify(a)
    expect(s).not.toContain(tok)
    expect(s).not.toMatch(/@|email|name|birth/i)
  })
})

describe('errors fail closed (contract §5)', () => {
  it('401 (identical body for every cause) -> UNAUTHENTICATED', async () => {
    const bob = world()
    const tok = bob.signIn('cust_T_MIA')
    bob.endSession(tok)
    expect(await codeOf(client(bob).check(new SessionToken(tok)))).toBe('UNAUTHENTICATED')
    expect(await codeOf(client(bob).check(new SessionToken('bobat_guessed')))).toBe('UNAUTHENTICATED')
  })

  it('429 -> UNAUTHENTICATED (treat as not authenticated)', async () => {
    const bob = world()
    bob.override = { status: 429, body: { data: null, errors: [{ code: 'RATE_LIMITED' }] } }
    expect(await codeOf(client(bob).check(new SessionToken(bob.signIn('cust_T_MIA'))))).toBe('UNAUTHENTICATED')
  })

  it.each([400, 403, 404, 500, 502, 503])('%i -> UPSTREAM_UNAVAILABLE', async (status) => {
    const bob = world()
    bob.override = { status, body: { data: null, errors: [{ code: 'X' }] } }
    expect(await codeOf(client(bob).check(new SessionToken(bob.signIn('cust_T_MIA'))))).toBe('UPSTREAM_UNAVAILABLE')
  })

  it('network error and timeout -> UPSTREAM_UNAVAILABLE', async () => {
    const down = new BobSessionCheck({ baseUrl: 'http://bob.test', timeoutMs: 50, fetch: async () => Promise.reject(new TypeError('fetch failed')) })
    expect(await codeOf(down.check(new SessionToken('t')))).toBe('UPSTREAM_UNAVAILABLE')
    const slow = new BobSessionCheck({
      baseUrl: 'http://bob.test',
      timeoutMs: 50,
      fetch: (_u, init) =>
        new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason as Error))),
    })
    expect(await codeOf(slow.check(new SessionToken('t')))).toBe('UPSTREAM_UNAVAILABLE')
  })

  it('a 200 that is not JSON -> UPSTREAM_UNAVAILABLE', async () => {
    const c = new BobSessionCheck({ baseUrl: 'http://bob.test', timeoutMs: 50, fetch: async () => new Response('<html>', { status: 200 }) })
    expect(await codeOf(c.check(new SessionToken('t')))).toBe('UPSTREAM_UNAVAILABLE')
  })

  it('a 200 carrying the 401 body shape (data null) -> UPSTREAM_UNAVAILABLE', async () => {
    const c = new BobSessionCheck({ baseUrl: 'http://bob.test', timeoutMs: 50, fetch: async () => json(200, UNAUTHORIZED_BODY) })
    expect(await codeOf(c.check(new SessionToken('t')))).toBe('UPSTREAM_UNAVAILABLE')
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const violations: [string, string, (d: Record<string, any>) => void][] = [
    ['cust_T_MIA', 'another contract version', (d) => (d.contract = 'bob-session/2')],
    ['cust_T_MIA', 'an unknown bank', (d) => (d.person.bank_id = 'bank_other')],
    ['cust_T_MIA', 'an unknown role', (d) => (d.person.roles = ['child', 'teller'])],
    ['cust_T_MIA', 'a child with another role', (d) => (d.person.roles = ['child', 'customer'])],
    ['cust_T_MIA', 'a child without the child object', (d) => (d.child = null)],
    ['cust_T_MIA', 'a child listing children', (d) => (d.children = [{ customer_id: 'x', link_id: 'l', status: 'active', player_ref: playerRefFor('x') }])],
    ['cust_T_MIA', 'status other than active', (d) => (d.person.status = 'pending')],
    ['cust_T_MIA', 'a malformed player_ref', (d) => (d.person.player_ref = 'cust_T_MIA')],
    ['cust_T_MIA', 'a missing session', (d) => delete d.session],
    ['cust_T_SARAH', 'a child object on an adult', (d) => (d.child = { minor: true, age_band: 'child', limits: [] })],
    ['cust_T_SARAH', 'guardian role without children', (d) => (d.children = [])],
    ['cust_T_SARAH', 'children without guardian role', (d) => (d.person.roles = ['customer'])],
    ['cust_T_SARAH', 'a child link without player_ref', (d) => delete d.children[0].player_ref],
    ['cust_T_SARAH', 'a self link', (d) => (d.children[0].customer_id = 'cust_T_SARAH')],
    ['cust_T_SARAH', 'an adult listing guardians', (d) => (d.guardians = [{ customer_id: 'g', link_id: 'l', status: 'active' }])],
  ]
  it.each(violations)('%s with %s -> UPSTREAM_UNAVAILABLE, logged without the token', async (who, _what, mutate) => {
    const bob = world()
    bob.mutate = mutate
    const logs: unknown[] = []
    const tok = bob.signIn(who)
    expect(await codeOf(client(bob, logs).check(new SessionToken(tok)))).toBe('UPSTREAM_UNAVAILABLE')
    expect(logs.length).toBe(1)
    expect(JSON.stringify(logs)).not.toContain(tok)
  })
})
