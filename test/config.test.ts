import { describe, expect, it } from 'vitest'
import { ConfigError, forbiddenCredentialKeys, loadConfig } from '../src/config.js'
import { mongoClientOptions } from '../src/db.js'
import { baseEnv } from './helpers/mongo.js'

const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn()
  } catch (err) {
    if (err instanceof ConfigError) return err.problems
    throw err
  }
  throw new Error('expected ConfigError')
}

describe('config: fail closed (T4)', () => {
  it('refuses an empty environment and names every required key', () => {
    const p = problemsOf(() => loadConfig('api', {}))
    expect(p).toEqual(expect.arrayContaining(['GIT_SHA is required', 'MONGODB_URI is required', 'MONGODB_DB is required']))
  })

  it.each(['GIT_SHA', 'MONGODB_URI', 'MONGODB_DB'])('refuses when %s is missing', (key) => {
    const env = baseEnv()
    delete (env as Record<string, string | undefined>)[key]
    expect(problemsOf(() => loadConfig('api', env))).toContain(`${key} is required`)
  })

  it('rejects a mutable or non-SHA image identity', () => {
    for (const sha of ['latest', 'main', 'dev', 'ABCDEF0']) {
      expect(problemsOf(() => loadConfig('api', { ...baseEnv(), GIT_SHA: sha })).join()).toMatch(/GIT_SHA/)
    }
  })

  it('never echoes secret values in problems', () => {
    const secret = 'postgres://user:hunter2-not-a-mongo-uri@host'
    const p = problemsOf(() => loadConfig('api', { ...baseEnv(), MONGODB_URI: secret }))
    expect(p.join(' ')).not.toContain('hunter2')
  })

  it('jobs process requires the scoped BOB allowance credential slot', () => {
    expect(problemsOf(() => loadConfig('jobs', baseEnv()))).toContain('BOB_ALLOWANCE_CREDENTIAL is required')
    const cfg = loadConfig('jobs', { ...baseEnv(), BOB_ALLOWANCE_CREDENTIAL: 'x'.repeat(32) })
    expect(cfg.JOB_LEASE_TTL_MS).toBe(30_000)
  })

  it('jobs tick must be shorter than the lease TTL', () => {
    const env = { ...baseEnv(), BOB_ALLOWANCE_CREDENTIAL: 'x'.repeat(32), JOB_TICK_INTERVAL_MS: '30000', JOB_LEASE_TTL_MS: '30000' }
    expect(problemsOf(() => loadConfig('jobs', env)).join()).toMatch(/JOB_TICK_INTERVAL_MS/)
  })

  it('accepts a complete environment and freezes it', () => {
    const cfg = loadConfig('api', baseEnv())
    expect(cfg.PORT).toBe(3000)
    expect(Object.isFrozen(cfg)).toBe(true)
  })
})

describe('config: no BOB teller or blanket credential (T5, code side)', () => {
  it.each(['BOB_TELLER_TOKEN', 'TELLER_TOKEN', 'BOB_API_KEY', 'BOB_SERVICE_KEY', 'bob_teller_session'])('refuses start-up when %s is present', (key) => {
    const p = problemsOf(() => loadConfig('api', { ...baseEnv(), [key]: 'something' }))
    expect(p.join()).toContain(key)
  })

  it('the allowance credential is refused outside the jobs process', () => {
    expect(problemsOf(() => loadConfig('api', { ...baseEnv(), BOB_ALLOWANCE_CREDENTIAL: 'x'.repeat(32) })).join()).toMatch(/only permitted in the jobs process/)
  })

  it('only BOB_ALLOWANCE_CREDENTIAL is an allowed BOB credential key; BOB_API_URL is the one non-credential key', () => {
    expect(forbiddenCredentialKeys({ BOB_ALLOWANCE_CREDENTIAL: 'x', BOB_API_URL: 'http://bob', BOB_X: 'y', bob_api_url: 'z', PATH: '/bin' })).toEqual(['BOB_X', 'bob_api_url'])
  })
})

describe('config: BOB_API_URL (CS-3942)', () => {
  it('is optional, and accepted as a plain http(s) URL', () => {
    expect(loadConfig('api', baseEnv()).BOB_API_URL).toBeUndefined()
    expect(loadConfig('api', { ...baseEnv(), BOB_API_URL: 'https://bob.internal:8443/base' }).BOB_API_URL).toBe('https://bob.internal:8443/base')
  })

  it.each(['https://user:pass@bob.internal', 'https://tok@bob.internal', 'https://bob.internal/?key=abc', 'https://bob.internal/#k', 'ftp://bob.internal', 'not a url'])(
    'refuses %s without echoing the value',
    (v) => {
      const p = problemsOf(() => loadConfig('api', { ...baseEnv(), BOB_API_URL: v })).join()
      expect(p).toMatch(/BOB_API_URL must be an http\(s\) URL with no credentials/)
      expect(p).not.toContain(v)
    },
  )

  it('session cache TTL is capped at 30 s (bob-session/1 §6)', () => {
    expect(loadConfig('api', baseEnv()).SESSION_CACHE_TTL_MS).toBe(30_000)
    expect(problemsOf(() => loadConfig('api', { ...baseEnv(), SESSION_CACHE_TTL_MS: '30001' })).join()).toMatch(/SESSION_CACHE_TTL_MS/)
  })
})

describe('database pool settings are explicit', () => {
  it('passes every pool and timeout setting and disables retryable writes (DocumentDB)', () => {
    const o = mongoClientOptions(loadConfig('api', { ...baseEnv(), MONGO_MAX_POOL_SIZE: '25' }))
    expect(o).toMatchObject({
      maxPoolSize: 25,
      minPoolSize: 0,
      maxIdleTimeMS: 60_000,
      waitQueueTimeoutMS: 5_000,
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
      socketTimeoutMS: 30_000,
      retryWrites: false,
    })
    expect(o.tls).toBeUndefined()
  })

  it('enables TLS with the CA file when configured', () => {
    const o = mongoClientOptions(loadConfig('api', { ...baseEnv(), MONGODB_TLS_CA_FILE: '/app/global-bundle.pem' }))
    expect(o).toMatchObject({ tls: true, tlsCAFile: '/app/global-bundle.pem' })
  })

  it('rejects min pool above max pool', () => {
    expect(problemsOf(() => loadConfig('api', { ...baseEnv(), MONGO_MIN_POOL_SIZE: '20', MONGO_MAX_POOL_SIZE: '5' })).join()).toMatch(/MIN_POOL/)
  })
})
