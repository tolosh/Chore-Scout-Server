/** Job process entry point: one process per environment; the lease guarantees a single runner. Real clock only. */
import { hostname } from 'node:os'
import { bootConfig } from './boot.js'
import { connectMongo } from './db.js'
import { buildJobs } from './jobs/registry.js'
import { JobRunner } from './jobs/runner.js'
import { createLogger } from './logger.js'

const config = await bootConfig('jobs')
const log = createLogger(config.LOG_LEVEL, config.GIT_SHA)
const client = await connectMongo(config)
const db = client.db(config.MONGODB_DB)
const jobs = buildJobs(db, config)
const runner = new JobRunner(db, `jobs:${hostname()}:${process.pid}`, config.JOB_LEASE_TTL_MS, jobs, log)
log.info({ jobs: jobs.map((j) => j.name), tenant: config.ALLOWANCE_TENANT_ID }, 'job process started')

let stopping = false
const loop = async () => {
  while (!stopping) {
    try {
      await runner.tick()
    } catch (err) {
      log.error({ err: (err as Error).message }, 'scheduler tick failed')
    }
    await new Promise((r) => setTimeout(r, config.JOB_TICK_INTERVAL_MS))
  }
}
const shutdown = async () => {
  stopping = true
  await runner.stop().catch(() => undefined)
  await client.close()
  process.exit(0)
}
process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())
await loop()
