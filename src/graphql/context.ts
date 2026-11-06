/**
 * Per-request context. `actor` is set only after BOB's session check has
 * accepted the forwarded session; resolvers never see an unauthenticated
 * request.
 */
import type { Db } from 'mongodb'
import type { FastifyBaseLogger } from 'fastify'
import type { BobFamilyClient } from '../bob/family.js'
import type { Actor, SessionToken } from '../identity/principal.js'

/** Outbound BOB clients (contract bob-family/1). Each person-route call takes the actor's own session. */
export interface BobPorts {
  family: BobFamilyClient
}

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
