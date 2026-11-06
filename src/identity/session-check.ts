/**
 * Session check port and its cache (CS-3942).
 *
 * Every request's forwarded session is checked with BOB (spec §3.3). The
 * answer may be cached in process memory only (contract bob-session/1 §6):
 * - keyed by the SHA-256 hash of the access token, never the raw token;
 * - only a successful answer, never a 401, 429 or 5xx;
 * - for at most 30 seconds from BOB's checked_at, and never past the token's
 *   access_expires_at. The window is also capped at 30 seconds of this
 *   server's own clock, so a skewed BOB clock cannot lengthen it;
 * - dropped at once on any 401 from any BOB route (invalidate()).
 */
import { createHash } from 'node:crypto'
import { CsError } from '../errors.js'
import type { Principal, SessionToken } from './principal.js'

export interface SessionAnswer {
  principal: Principal
  /** BOB's clock when it answered (start of the cache window). */
  checkedAt: Date
  /** When the presented access token stops working. */
  accessExpiresAt: Date
}

/**
 * Asks BOB who this session is. Resolves with BOB's answer, or rejects with a
 * CsError: UNAUTHENTICATED (BOB said no) or UPSTREAM_UNAVAILABLE (BOB failed or
 * answered outside the contract; fail closed).
 */
export interface SessionCheck {
  check(session: SessionToken): Promise<SessionAnswer>
}

/** The contract's ceiling on a cached answer (bob-session/1 §6 rule 2). */
export const MAX_SESSION_CACHE_MS = 30_000

export const tokenHash = (session: SessionToken): string =>
  createHash('sha256').update(session.reveal(), 'utf8').digest('hex')

interface Entry {
  answer: SessionAnswer
  expiresAt: number
}

export class CachedSessionCheck implements SessionCheck {
  private readonly entries = new Map<string, Entry>()
  private readonly ttlMs: number

  constructor(
    private readonly inner: SessionCheck,
    opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {
    this.ttlMs = Math.min(opts.ttlMs ?? MAX_SESSION_CACHE_MS, MAX_SESSION_CACHE_MS)
    this.maxEntries = opts.maxEntries ?? 10_000
    this.now = opts.now ?? Date.now
  }
  private readonly maxEntries: number
  private readonly now: () => number

  async check(session: SessionToken): Promise<SessionAnswer> {
    const key = tokenHash(session)
    const hit = this.entries.get(key)
    const now = this.now()
    if (hit && hit.expiresAt > now) return hit.answer
    if (hit) this.entries.delete(key)
    let answer: SessionAnswer
    try {
      answer = await this.inner.check(session)
    } catch (err) {
      this.entries.delete(key) // never cache, and never fall back to, a failed answer
      throw err
    }
    if (this.ttlMs > 0) {
      const expiresAt = Math.min(
        answer.checkedAt.getTime() + this.ttlMs,
        answer.accessExpiresAt.getTime(),
        now + this.ttlMs,
      )
      if (expiresAt > now) {
        if (this.entries.size >= this.maxEntries) {
          const oldest = this.entries.keys().next()
          if (!oldest.done) this.entries.delete(oldest.value)
        }
        this.entries.set(key, { answer, expiresAt })
      }
    }
    return answer
  }

  /** Drop the cached answer for this token (on any 401 from any BOB route, §6 rule 4). */
  invalidate(session: SessionToken): void {
    this.entries.delete(tokenHash(session))
  }

  get size(): number {
    return this.entries.size
  }
}

/** Used when no BOB API URL is configured: every request is refused (fail closed). */
export class UnconfiguredSessionCheck implements SessionCheck {
  async check(): Promise<SessionAnswer> {
    throw new CsError('UPSTREAM_UNAVAILABLE', 'session check not configured')
  }
}
