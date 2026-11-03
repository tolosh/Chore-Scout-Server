/** One-shot migration entry point (for a pre-deploy task, once hosting is decided). */
import { hostname } from 'node:os'
import { bootConfig } from './boot.js'
import { connectMongo } from './db.js'
import { createLogger } from './logger.js'
import { runMigrations } from './migrations/index.js'

const config = await bootConfig('migrate')
const log = createLogger(config.LOG_LEVEL, config.GIT_SHA)
const client = await connectMongo(config)
try {
  const applied = await runMigrations(client.db(config.MONGODB_DB), { holder: `migrate:${hostname()}:${process.pid}`, logger: log })
  log.info({ applied }, 'migrations complete')
} finally {
  await client.close()
}
