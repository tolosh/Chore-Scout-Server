import { Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { startMongo, VALID_SHA, type TestMongo } from './helpers/mongo.js'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})

describe('health and readiness', () => {
  it('/health returns the git SHA (T2, local)', async () => {
    const app = buildApp({ gitSha: VALID_SHA, logLevel: 'silent', db: mongo.db() })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', service: 'chore-scout-server', sha: VALID_SHA })
    await app.close()
  })

  it('/ready pings the database', async () => {
    const app = buildApp({ gitSha: VALID_SHA, logLevel: 'silent', db: mongo.db() })
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ db: 'up', sha: VALID_SHA })
    await app.close()
  })

  it('/ready returns 503 when the database is unavailable', async () => {
    const db = { command: () => Promise.reject(new Error('down')) } as unknown as ReturnType<TestMongo['db']>
    const app = buildApp({ gitSha: VALID_SHA, logLevel: 'silent', db })
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ db: 'down', sha: VALID_SHA })
    await app.close()
  })
})

describe('correlation ids', () => {
  it('echoes a well-formed inbound id and generates one otherwise', async () => {
    const app = buildApp({ gitSha: VALID_SHA, logLevel: 'silent', db: mongo.db() })
    const a = await app.inject({ method: 'GET', url: '/health', headers: { 'x-correlation-id': 'abc-123' } })
    expect(a.headers['x-correlation-id']).toBe('abc-123')
    const b = await app.inject({ method: 'GET', url: '/health', headers: { 'x-correlation-id': 'bad id with spaces\n' } })
    expect(b.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/)
    const c = await app.inject({ method: 'GET', url: '/health' })
    expect(c.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/)
    await app.close()
  })

  it('request log lines carry correlationId and gitSha', async () => {
    const lines: Record<string, unknown>[] = []
    const stream = new Writable({
      write(chunk, _enc, cb) {
        for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l))
        cb()
      },
    })
    const app = buildApp({ gitSha: VALID_SHA, logLevel: 'info', db: mongo.db(), logStream: stream })
    await app.inject({ method: 'GET', url: '/health', headers: { 'x-correlation-id': 'corr-42' } })
    await app.close()
    const reqLines = lines.filter((l) => l.correlationId === 'corr-42')
    expect(reqLines.length).toBeGreaterThanOrEqual(2) // incoming request + request completed
    for (const l of reqLines) expect(l.gitSha).toBe(VALID_SHA)
  })
})
