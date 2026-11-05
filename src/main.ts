/** API process entry point. */
import { hostname } from 'node:os'
import { buildApp } from './app.js'
import { BobSessionCheck } from './bob/session-check.js'
import { bootConfig } from './boot.js'
import { connectMongo } from './db.js'
import { RESOLVERS } from './graphql/resolvers.js'
import { buildExecutableSchema } from './graphql/schema.js'
import type { SessionToken } from './identity/principal.js'
import { CachedSessionCheck, UnconfiguredSessionCheck, type SessionCheck } from './identity/session-check.js'
import { createLogger } from './logger.js'
import { runMigrations } from './migrations/index.js'

const config = await bootConfig('api')
const client = await connectMongo(config)
const db = client.db(config.MONGODB_DB)
const bootLog = createLogger(config.LOG_LEVEL, config.GIT_SHA)

// CS-3942: every request is checked with BOB (contract bob-session/1). Without
// BOB_API_URL the API starts but refuses every request (fail closed).
let sessionCheck: SessionCheck
let invalidate: (s: SessionToken) => void = () => {}
if (config.BOB_API_URL) {
  const cached = new CachedSessionCheck(
    new BobSessionCheck({ baseUrl: config.BOB_API_URL, timeoutMs: config.SESSION_CHECK_TIMEOUT_MS, log: bootLog }),
    { ttlMs: config.SESSION_CACHE_TTL_MS },
  )
  sessionCheck = cached
  invalidate = (s) => cached.invalidate(s)
} else {
  bootLog.warn('BOB_API_URL not set: every GraphQL request will be refused (UPSTREAM_UNAVAILABLE)')
  sessionCheck = new UnconfiguredSessionCheck()
}

const app = buildApp({
  gitSha: config.GIT_SHA,
  logLevel: config.LOG_LEVEL,
  db,
  graphql: {
    schema: buildExecutableSchema(RESOLVERS),
    sessionCheck,
    services: { db, bob: {}, sessions: { invalidate }, now: () => new Date() },
    production: config.NODE_ENV === 'production',
  },
})
await runMigrations(db, { holder: `api:${hostname()}:${process.pid}`, logger: app.log })

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down')
  await app.close()
  await client.close()
  process.exit(0)
}
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

await app.listen({ port: config.PORT, host: config.HOST })
