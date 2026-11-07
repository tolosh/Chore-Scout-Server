/**
 * Per-request context. `actor` is set only after BOB's session check has
 * accepted the forwarded session; resolvers never see an unauthenticated
 * request.
 */
import type { Db } from 'mongodb'
import type { FastifyBaseLogger } from 'fastify'
import { BobFamilyClient, BobGivingClient } from '../bob/family.js'
import type { BobHttp } from '../bob/http.js'
import type { Actor, SessionToken } from '../identity/principal.js'

/** Outbound BOB clients (contract bob-family/1). Each person-route call takes the actor's own session. */
export interface BobPorts {
  family: BobFamilyClient
  /** §6.3-§6.5: the child's Give recipient, held Give and its release. */
  giving: BobGivingClient
}

/** Every person-route client over one BOB HTTP adapter. */
export const bobPorts = (http: BobHttp): BobPorts => ({ family: new BobFamilyClient(http), giving: new BobGivingClient(http) })

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
