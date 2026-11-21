/**
 * One-off operator recovery task (CS-3979, review 40045 A3). See src/jobs/recover.ts.
 *
 * Run it as a one-off ECS task of the bank's jobs task definition with a
 * command override (runbook "Hold recovery"); it uses that bank's credential
 * and configuration and prints one JSON result line. Real clock only.
 */
import { randomUUID } from 'node:crypto'
import { bootConfig } from './boot.js'
import { AllowanceCycleService } from './allowance/cycle.js'
import { BobAllowanceExecutor } from './bob/allowance.js'
import { BobHttp } from './bob/http.js'
import { connectMongo } from './db.js'
import { ALERT } from './jobs/alerts.js'
import { exitCodeOf, parseRecoverArgs, recoverCycle } from './jobs/recover.js'
import { createLogger } from './logger.js'

const args = parseRecoverArgs(process.argv.slice(2))
if (typeof args === 'string') {
  process.stderr.write(JSON.stringify({ level: 'fatal', msg: 'jobs-recover: bad arguments', problem: args }) + '\n')
  process.exit(64) // EX_USAGE
}
const config = await bootConfig('jobs')
const log = createLogger(config.LOG_LEVEL, config.GIT_SHA)
const client = await connectMongo(config)
let code = 1
try {
  const db = client.db(config.MONGODB_DB)
  const http = new BobHttp({ baseUrl: config.BOB_API_URL!, timeoutMs: config.BOB_CALL_TIMEOUT_MS })
  const cycles = new AllowanceCycleService(db, new BobAllowanceExecutor(http, config.BOB_ALLOWANCE_CREDENTIAL), () => new Date())
  const correlation = `recover:${randomUUID()}`
  const result = await recoverCycle(db, config.ALLOWANCE_TENANT_ID, cycles, args, correlation)
  code = exitCodeOf(result)
  log.info({ tenantId: config.ALLOWANCE_TENANT_ID, cycleKey: args.cycleKey, operator: args.operator, recheck: args.recheck, correlation, result, alert: result.kind === 'RECHECKED' ? ALERT.HOLD_RECHECKED : undefined }, 'jobs-recover result')
} finally {
  await client.close()
}
process.exit(code)
