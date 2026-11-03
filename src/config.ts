/**
 * Configuration (CS-3941).
 *
 * Rules:
 * - Values come from the process environment, or from the secrets store when
 *   CS_SECRETS_ID is set (see secrets.ts). Nothing secret has a default in code.
 * - Start-up fails closed: a missing or malformed required value throws
 *   ConfigError and the entry points exit non-zero.
 * - The server must never hold a BOB teller credential or a blanket BOB service
 *   credential (identity model §6, §11.10; spec §9). The only BOB credential slot
 *   is BOB_ALLOWANCE_CREDENTIAL, used by the job process for the scheduled
 *   allowance job (CS-3979, spec §3.7). Any other BOB_* or *TELLER* key present
 *   in the environment or secrets refuses start-up.
 */
import { z } from 'zod'

export type Role = 'api' | 'jobs' | 'migrate'

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`)
    this.name = 'ConfigError'
  }
}

/** Keys that hold secrets. They may come from the secrets store and are redacted in logs. */
export const SECRET_KEYS = ['MONGODB_URI', 'BOB_ALLOWANCE_CREDENTIAL'] as const

/** The single permitted BOB credential slot (scoped standing-authority credential). */
export const ALLOWED_BOB_KEYS = new Set<string>(['BOB_ALLOWANCE_CREDENTIAL'])

const intFrom = (name: string, def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def
      if (!/^\d+$/.test(v)) {
        ctx.addIssue({ code: 'custom', message: `${name} must be an integer` })
        return z.NEVER
      }
      const n = Number(v)
      if (n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `${name} must be between ${min} and ${max}` })
        return z.NEVER
      }
      return n
    })

const base = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Baked into the image at build time (Dockerfile ARG GIT_SHA). Required: /health reports it.
  GIT_SHA: z.string().regex(/^[0-9a-f]{7,40}$/, 'GIT_SHA must be a 7-40 character lowercase hex commit SHA'),
  PORT: intFrom('PORT', 3000, 1, 65535),
  HOST: z.string().min(1).default('0.0.0.0'),

  // Database. The URI carries credentials on DocumentDB, so it is a secret with no default.
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'MONGODB_URI must be a mongodb:// URI'),
  MONGODB_DB: z.string().regex(/^[A-Za-z0-9_-]{1,63}$/, 'MONGODB_DB must be a plain database name'),
  // Path to the RDS CA bundle when connecting to DocumentDB over TLS. Optional locally.
  MONGODB_TLS_CA_FILE: z.string().min(1).optional(),

  // Explicit connection-pool settings (CS-3941 expected outcome). Defaults are stated here, not left to the driver.
  MONGO_MAX_POOL_SIZE: intFrom('MONGO_MAX_POOL_SIZE', 10, 1, 500),
  MONGO_MIN_POOL_SIZE: intFrom('MONGO_MIN_POOL_SIZE', 0, 0, 500),
  MONGO_MAX_IDLE_TIME_MS: intFrom('MONGO_MAX_IDLE_TIME_MS', 60_000, 0, 3_600_000),
  MONGO_WAIT_QUEUE_TIMEOUT_MS: intFrom('MONGO_WAIT_QUEUE_TIMEOUT_MS', 5_000, 1, 120_000),
  MONGO_SERVER_SELECTION_TIMEOUT_MS: intFrom('MONGO_SERVER_SELECTION_TIMEOUT_MS', 5_000, 1, 120_000),
  MONGO_CONNECT_TIMEOUT_MS: intFrom('MONGO_CONNECT_TIMEOUT_MS', 5_000, 1, 120_000),
  MONGO_SOCKET_TIMEOUT_MS: intFrom('MONGO_SOCKET_TIMEOUT_MS', 30_000, 0, 600_000),
})

const jobsExtra = z.object({
  // Secrets-store slot for the one scoped BOB credential (CS-3941 comment, spec §3.7).
  // It can only invoke Guardian standing authorities for allowance payments; BOB limits it.
  BOB_ALLOWANCE_CREDENTIAL: z.string().min(16, 'BOB_ALLOWANCE_CREDENTIAL must be set (from the secrets store)'),
  JOB_LEASE_TTL_MS: intFrom('JOB_LEASE_TTL_MS', 30_000, 1_000, 600_000),
  JOB_TICK_INTERVAL_MS: intFrom('JOB_TICK_INTERVAL_MS', 10_000, 100, 600_000),
})

export type BaseConfig = z.infer<typeof base>
export type JobsConfig = BaseConfig & z.infer<typeof jobsExtra>
export type Config<R extends Role = Role> = R extends 'jobs' ? JobsConfig : BaseConfig

/** Refuse BOB teller or blanket credentials anywhere in the supplied environment. */
export function forbiddenCredentialKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && env[k] !== '')
    .filter((k) => /TELLER/i.test(k) || (/^BOB_/i.test(k) && !ALLOWED_BOB_KEYS.has(k)))
    .sort()
}

export function loadConfig<R extends Role>(role: R, env: Record<string, string | undefined>): Config<R> {
  const problems: string[] = []
  const forbidden = forbiddenCredentialKeys(env)
  if (forbidden.length > 0) {
    problems.push(
      `forbidden BOB credential key(s) present: ${forbidden.join(', ')} (the server holds no BOB teller or blanket credential)`,
    )
  }
  if (role !== 'jobs' && env.BOB_ALLOWANCE_CREDENTIAL) {
    problems.push('BOB_ALLOWANCE_CREDENTIAL is only permitted in the jobs process')
  }
  const schema = role === 'jobs' ? base.extend(jobsExtra.shape) : base
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '(root)'
      // Never echo values: only the key and the rule.
      // zod 4 issues carry no `received`; a missing top-level key is read from the input itself.
      const missing = issue.code === 'invalid_type' && issue.path.length === 1 && env[String(issue.path[0])] === undefined
      problems.push(missing ? `${key} is required` : `${key}: ${issue.message}`)
    }
  }
  if (parsed.success && parsed.data.MONGO_MIN_POOL_SIZE > parsed.data.MONGO_MAX_POOL_SIZE) {
    problems.push('MONGO_MIN_POOL_SIZE must not exceed MONGO_MAX_POOL_SIZE')
  }
  if (parsed.success && role === 'jobs') {
    const j = parsed.data as unknown as z.infer<typeof jobsExtra>
    if (j.JOB_TICK_INTERVAL_MS >= j.JOB_LEASE_TTL_MS) {
      problems.push('JOB_TICK_INTERVAL_MS must be shorter than JOB_LEASE_TTL_MS so the lease is renewed before it expires')
    }
  }
  if (problems.length > 0 || !parsed.success) throw new ConfigError(problems)
  return Object.freeze(parsed.data) as Config<R>
}
