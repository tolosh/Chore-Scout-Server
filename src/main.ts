/** API process entry point. */
import { hostname } from 'node:os'
import { buildApp } from './app.js'
import { bootConfig } from './boot.js'
import { connectMongo } from './db.js'
import { runMigrations } from './migrations/index.js'

const config = await bootConfig('api')
const client = await connectMongo(config)
const db = client.db(config.MONGODB_DB)
const app = buildApp({ gitSha: config.GIT_SHA, logLevel: config.LOG_LEVEL, db })
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
