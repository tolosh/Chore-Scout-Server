/**
 * HTTP app (CS-3941 scaffold): health and readiness only.
 *
 * Correlation ids: an inbound x-correlation-id is accepted if well formed,
 * otherwise one is generated. It is the Fastify request id, so every request
 * log line carries it as "correlationId", and it is echoed on the response.
 *
 * POST /graphql (CS-3942) is registered when `graphql` deps are given: every
 * request's forwarded session is checked with BOB first (src/graphql/route.ts).
 */
import { randomUUID } from 'node:crypto'
import Fastify, { LogController, type FastifyInstance } from 'fastify'
import type { Db } from 'mongodb'
import { registerGraphql, type GraphqlRouteDeps } from './graphql/route.js'
import { CORRELATION_HEADER, loggerOptions } from './logger.js'

const CORRELATION_RE = /^[A-Za-z0-9._:-]{1,128}$/

export interface AppDeps {
  gitSha: string
  logLevel: string
  db: Db
  /** Readiness ping timeout. */
  pingTimeoutMs?: number
  /** Log destination override (tests). Defaults to stdout. */
  logStream?: NodeJS.WritableStream
  /** The GraphQL API (CS-3942). Omitted, only /health and /ready are served. */
  graphql?: GraphqlRouteDeps
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logStream
      ? { ...loggerOptions(deps.logLevel, deps.gitSha), stream: deps.logStream }
      : loggerOptions(deps.logLevel, deps.gitSha),
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'correlationId' }),
    genReqId: (req) => {
      const inbound = req.headers[CORRELATION_HEADER]
      return typeof inbound === 'string' && CORRELATION_RE.test(inbound) ? inbound : randomUUID()
    },
  })

  app.addHook('onRequest', async (req, reply) => {
    reply.header(CORRELATION_HEADER, req.id)
  })

  /** Liveness. Reports the commit SHA the image was built from. No dependency checks. */
  app.get('/health', async () => ({ status: 'ok', service: 'chore-scout-server', sha: deps.gitSha }))

  /** Readiness: database reachable. */
  app.get('/ready', async (req, reply) => {
    const timeout = deps.pingTimeoutMs ?? 2_000
    try {
      await Promise.race([
        deps.db.command({ ping: 1 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), timeout).unref()),
      ])
      return { status: 'ready', sha: deps.gitSha, db: 'up' }
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'readiness: database unavailable')
      return reply.code(503).send({ status: 'unavailable', sha: deps.gitSha, db: 'down' })
    }
  })

  if (deps.graphql) registerGraphql(app, deps.graphql)

  return app
}
