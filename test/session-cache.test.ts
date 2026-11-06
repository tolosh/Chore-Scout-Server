/** Session-check cache rules (contract bob-session/1 §6). */
import { describe, expect, it } from 'vitest'
import { CsError } from '../src/errors.js'
import { SessionToken, type Principal } from '../src/identity/principal.js'
import { CachedSessionCheck, MAX_SESSION_CACHE_MS, tokenHash, type SessionAnswer, type SessionCheck } from '../src/identity/session-check.js'

const principal = { customerId: 'c1', tenantId: 'bank_bilgola', roles: ['customer'], ageBand: null, playerRef: 'p', children: [], guardians: [], sessionId: 's' } as Principal

class Inner implements SessionCheck {
  calls = 0
  fail: CsError | null = null
  answer: (now: number) => SessionAnswer = (now) => ({ principal, checkedAt: new Date(now), accessExpiresAt: new Date(now + 15 * 60_000) })
  constructor(private readonly clock: () => number) {}
  async check(): Promise<SessionAnswer> {
    this.calls++
    if (this.fail) throw this.fail
    return this.answer(this.clock())
  }
}

function setup(ttlMs?: number) {
  let t = 1_000_000
  const now = () => t
  const inner = new Inner(now)
  const cache = new CachedSessionCheck(inner, { ttlMs, now })
  return { inner, cache, advance: (ms: number) => (t += ms), now }
}

const tok = new SessionToken('bobat_abc')

describe('session cache', () => {
  it('reuses a 200 for up to 30 s from checked_at, then asks BOB again', async () => {
    const { inner, cache, advance } = setup()
    await cache.check(tok)
    advance(29_999)
    await cache.check(tok)
    expect(inner.calls).toBe(1)
    advance(1)
    await cache.check(tok)
    expect(inner.calls).toBe(2)
  })

  it('a configured TTL above 30 s is clamped to 30 s', async () => {
    const { inner, cache, advance } = setup(120_000)
    await cache.check(tok)
    advance(MAX_SESSION_CACHE_MS)
    await cache.check(tok)
    expect(inner.calls).toBe(2)
  })

  it('never past access_expires_at', async () => {
    const { inner, cache, advance } = setup()
    inner.answer = (n) => ({ principal, checkedAt: new Date(n), accessExpiresAt: new Date(n + 5_000) })
    await cache.check(tok)
    advance(5_000)
    await cache.check(tok)
    expect(inner.calls).toBe(2)
  })

  it('the window starts at checked_at: an answer checked 25 s ago lasts only 5 s more', async () => {
    const { inner, cache, advance } = setup()
    inner.answer = (n) => ({ principal, checkedAt: new Date(n - 25_000), accessExpiresAt: new Date(n + 900_000) })
    await cache.check(tok)
    advance(5_000)
    await cache.check(tok)
    expect(inner.calls).toBe(2)
  })

  it('a BOB clock ahead of ours cannot lengthen the window past 30 s of our clock', async () => {
    const { inner, cache, advance } = setup()
    inner.answer = (n) => ({ principal, checkedAt: new Date(n + 3_600_000), accessExpiresAt: new Date(n + 7_200_000) })
    await cache.check(tok)
    advance(30_000)
    await cache.check(tok)
    expect(inner.calls).toBe(2)
  })

  it.each(['UNAUTHENTICATED', 'UPSTREAM_UNAVAILABLE'] as const)('never caches a failure (%s)', async (code) => {
    const { inner, cache } = setup()
    inner.fail = new CsError(code, 'x')
    await expect(cache.check(tok)).rejects.toThrow()
    await expect(cache.check(tok)).rejects.toThrow()
    expect(inner.calls).toBe(2)
    expect(cache.size).toBe(0)
  })

  it('a failure after a cached success evicts it, with no fallback to the stale answer', async () => {
    const { inner, cache, advance } = setup()
    await cache.check(tok)
    advance(30_000)
    inner.fail = new CsError('UPSTREAM_UNAVAILABLE', 'down')
    await expect(cache.check(tok)).rejects.toThrow()
    expect(cache.size).toBe(0)
  })

  it('invalidate() drops the entry at once (401 from any BOB route)', async () => {
    const { inner, cache } = setup()
    await cache.check(tok)
    cache.invalidate(tok)
    await cache.check(tok)
    expect(inner.calls).toBe(2)
  })

  it('TTL 0 disables caching', async () => {
    const { inner, cache } = setup(0)
    await cache.check(tok)
    await cache.check(tok)
    expect(inner.calls).toBe(2)
  })

  it('is keyed by the SHA-256 of the token, and one token never gets another’s answer', async () => {
    const { inner, cache } = setup()
    expect(tokenHash(tok)).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenHash(tok)).not.toContain('bobat_abc')
    await cache.check(tok)
    await cache.check(new SessionToken('bobat_other'))
    expect(inner.calls).toBe(2)
  })

  it('the session token redacts itself when serialised', () => {
    expect(String(tok)).toBe('[session]')
    expect(JSON.stringify({ tok })).toBe('{"tok":"[session]"}')
  })
})
