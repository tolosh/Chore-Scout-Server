/**
 * Per-request context. `actor` is set only after BOB's session check has
 * accepted the forwarded session; resolvers never see an unauthenticated
 * request.
 */
import type { Db } from 'mongodb'
import type { FastifyBaseLogger } from 'fastify'
import type { Actor, SessionToken } from '../identity/principal.js'

/** Outbound BOB ports. Later tickets add theirs; each takes the actor's own session. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface BobPorts {}

export interface Services {
  db: Db
  bob: BobPorts
  /** Drop the cached session answer at once on any 401 from any BOB route (bob-session/1 §6 rule 4). */
  sessions: { invalidate(session: SessionToken): void }
  now: () => Date
}

export interface RequestContext extends Services {
  actor: Actor
  log: FastifyBaseLogger
  correlationId: string
}
