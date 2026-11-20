/**
 * The jobs the jobs process runs (CS-3979). This is the only place the
 * allowance credential is turned into a BOB client: the API process never
 * builds one, and config.ts refuses the credential outside the jobs process.
 *
 * Real clock only (CS-3979 T8): every job here uses the system clock. There is
 * no clock parameter and no configuration that could move it.
 */
import type { Db } from 'mongodb'
import { AllowanceCycleService } from '../allowance/cycle.js'
import { BobAllowanceExecutor } from '../bob/allowance.js'
import { BobHttp } from '../bob/http.js'
import type { JobsConfig } from '../config.js'
import { AllowanceCycleJob, ALLOWANCE_JOB } from './allowance-job.js'
import type { ScheduledJob } from './runner.js'

/** The names of the registered jobs, in run order. */
export const REGISTERED_JOBS = [ALLOWANCE_JOB] as const

const realClock = () => new Date()

export function buildJobs(db: Db, config: Pick<JobsConfig, 'BOB_API_URL' | 'BOB_CALL_TIMEOUT_MS' | 'BOB_ALLOWANCE_CREDENTIAL' | 'ALLOWANCE_TENANT_ID'>, fetch?: typeof globalThis.fetch): ScheduledJob[] {
  if (!config.BOB_API_URL) throw new Error('BOB_API_URL is required in the jobs process')
  const http = new BobHttp({ baseUrl: config.BOB_API_URL, timeoutMs: config.BOB_CALL_TIMEOUT_MS, fetch })
  const executor = new BobAllowanceExecutor(http, config.BOB_ALLOWANCE_CREDENTIAL)
  return [new AllowanceCycleJob(db, config.ALLOWANCE_TENANT_ID, new AllowanceCycleService(db, executor, realClock))]
}
