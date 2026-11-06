/**
 * BOB HTTP conventions for contract bob-family/1 (Confluence 3224731649 §2).
 *
 * - Person routes carry the person's own session as `Authorization: Bearer`
 *   (§2.1). The allowance credential is used only on route 7.5 (CS-3963/3979).
 * - Writes carry `Idempotency-Key` (§2.3). A replay is flagged by
 *   `x-idempotency-replay: true` and is treated exactly like the first answer (§8).
 * - Envelope `{ data, meta, errors: [{ code, message, reason? }] }`; callers
 *   match on code and reason only, never on message (§2.4).
 *
 * Outcomes:
 * - ok:      2xx with a data object;
 * - refused: a 4xx with an error code (BOB decided; nothing moved);
 * - unknown: network error, timeout, 429, 5xx, or a body outside the envelope.
 *            For money calls the outcome is unknown: retry only with the SAME key.
 * A 401 on any route drops the person's cached session answer (bob-session/1 §6 rule 4).
 */
import type { SessionToken } from '../identity/principal.js'

export type BobOutcome<T = Record<string, unknown>> =
  | { kind: 'ok'; status: number; data: T; replay: boolean }
  | { kind: 'refused'; status: number; code: string; reason?: string; error: Record<string, unknown> }
  | { kind: 'unknown'; detail: string }

export interface BobHttpOptions {
  baseUrl: string
  timeoutMs: number
  fetch?: typeof globalThis.fetch
  /** Called on any 401 for a person session (drop the cached session answer). */
  onUnauthorized?: (session: SessionToken) => void
}

export interface BobRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH'
  path: string
  /** The person's own session, or the allowance credential's raw value (route 7.5 only). */
  auth: { session: SessionToken } | { serviceCredential: string }
  idempotencyKey?: string
  body?: unknown
}

export const IDEMPOTENCY_KEY_MAX = 200

export class BobHttp {
  private readonly base: string
  private readonly fetchFn: typeof globalThis.fetch

  constructor(private readonly opts: BobHttpOptions) {
    this.base = opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`
    this.fetchFn = opts.fetch ?? globalThis.fetch
  }

  async send<T = Record<string, unknown>>(req: BobRequest): Promise<BobOutcome<T>> {
    if (req.idempotencyKey !== undefined && (req.idempotencyKey.length < 1 || req.idempotencyKey.length > IDEMPOTENCY_KEY_MAX)) {
      throw new Error('idempotency key must be 1-200 characters (bob-family/1 §2.3)')
    }
    const bearer = 'session' in req.auth ? req.auth.session.reveal() : req.auth.serviceCredential
    const headers: Record<string, string> = {
      authorization: `Bearer ${bearer}`,
      'x-bob-caller': 'chorescout-server',
      accept: 'application/json',
    }
    if (req.idempotencyKey !== undefined) headers['idempotency-key'] = req.idempotencyKey
    if (req.body !== undefined) headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await this.fetchFn(new URL(req.path.replace(/^\//, ''), this.base).toString(), {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      })
    } catch (err) {
      return { kind: 'unknown', detail: `network: ${(err as Error).name}` }
    }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      json = undefined
    }
    if (res.status === 401 && 'session' in req.auth) this.opts.onUnauthorized?.(req.auth.session)
    if (res.status === 429 || res.status >= 500) return { kind: 'unknown', detail: `status ${res.status}` }
    const env = json as { data?: unknown; errors?: unknown } | undefined
    if (res.status >= 200 && res.status < 300) {
      if (!env || typeof env.data !== 'object' || env.data === null) return { kind: 'unknown', detail: 'response outside envelope' }
      return { kind: 'ok', status: res.status, data: env.data as T, replay: res.headers.get('x-idempotency-replay') === 'true' }
    }
    const first = Array.isArray(env?.errors) ? (env.errors[0] as Record<string, unknown> | undefined) : undefined
    if (res.status >= 400 && res.status < 500 && first && typeof first.code === 'string') {
      return {
        kind: 'refused',
        status: res.status,
        code: first.code,
        reason: typeof first.reason === 'string' ? first.reason : undefined,
        error: first,
      }
    }
    return { kind: 'unknown', detail: `status ${res.status} outside envelope` }
  }
}
