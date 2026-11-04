/**
 * CS-3992 test 3: the container health check (node dist/healthcheck.js, here
 * run from source) exits 0 when /ready is up and non-zero when the database is
 * unreachable, shown against a local MongoDB that is then stopped.
 */
import { createServer, type AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { VALID_SHA } from './helpers/mongo.js'
import { run } from './helpers/run.js'

const TSX = resolve('node_modules/.bin/tsx')
const healthcheck = (port: number) => run(TSX, [resolve('src/healthcheck.ts')], { PATH: process.env.PATH ?? '', PORT: String(port) })

let server: MongoMemoryServer
let client: MongoClient
let app: FastifyInstance
let port: number

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri(), {
    retryWrites: false,
    serverSelectionTimeoutMS: 1_000,
    connectTimeoutMS: 1_000,
    socketTimeoutMS: 1_000,
  })
  app = buildApp({ gitSha: VALID_SHA, logLevel: 'silent', db: client.db('cs_healthcheck'), pingTimeoutMs: 1_500 })
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as AddressInfo).port
})

afterAll(async () => {
  await app?.close()
  await client?.close(true).catch(() => undefined)
  await server?.stop().catch(() => undefined)
})

describe('container health check (CS-3992 T3)', () => {
  it('exits 0 while the database is up', async () => {
    const r = await healthcheck(port)
    expect(r.status).toBe(0)
  })

  it('exits non-zero once the database is stopped', async () => {
    await server.stop({ doCleanup: false })
    const ready = await fetch(`http://127.0.0.1:${port}/ready`)
    expect(ready.status).toBe(503)
    const r = await healthcheck(port)
    expect(r.status).not.toBe(0)
  })

  it('exits non-zero when nothing is listening', async () => {
    const probe = createServer()
    await new Promise<void>((ok) => probe.listen(0, '127.0.0.1', ok))
    const closed = (probe.address() as AddressInfo).port
    await new Promise((ok) => probe.close(ok))
    const r = await healthcheck(closed)
    expect(r.status).not.toBe(0)
  })
})
