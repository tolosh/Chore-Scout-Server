import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXIT_CONFIG } from '../src/boot.js'
import { baseEnv, startMongo, type TestMongo } from './helpers/mongo.js'

const TSX = resolve('node_modules/.bin/tsx')
// Minimal environment: no inherited secrets; PATH only so node can run.
// Async spawn: a blocking spawnSync would stall the in-memory mongod's output pipe.
const run = (entry: string, env: Record<string, string>) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
    const child = spawn(TSX, [resolve(entry)], { env: { PATH: process.env.PATH ?? '', ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const t = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.on('close', (status) => {
      clearTimeout(t)
      res({ status, stdout, stderr })
    })
  })

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})

describe('process boot fails closed (T4)', () => {
  it.each(['src/main.ts', 'src/jobs-main.ts', 'src/migrate-main.ts'])('%s exits with EX_CONFIG and no secrets', async (entry) => {
    const r = await run(entry, {})
    expect(r.status).toBe(EXIT_CONFIG)
    const line = JSON.parse(r.stderr.trim().split('\n').pop()!)
    expect(line.msg).toBe('start-up refused (fail closed)')
    expect(line.problems).toContain('MONGODB_URI is required')
  })

  it('api refuses to start with a BOB teller token present', async () => {
    const r = await run('src/main.ts', { ...baseEnv(mongo.uri), BOB_TELLER_TOKEN: 'tok' })
    expect(r.status).toBe(EXIT_CONFIG)
    expect(r.stderr).toContain('BOB_TELLER_TOKEN')
    expect(r.stderr).not.toContain('tok"')
  })

  it('jobs process refuses to start without the scoped credential slot filled', async () => {
    const r = await run('src/jobs-main.ts', baseEnv(mongo.uri))
    expect(r.status).toBe(EXIT_CONFIG)
    expect(r.stderr).toContain('BOB_ALLOWANCE_CREDENTIAL is required')
  })

  it('migrate entry runs migrations with a complete environment', async () => {
    const r = await run('src/migrate-main.ts', { ...baseEnv(mongo.uri), MONGODB_DB: 'boot_migrate', LOG_LEVEL: 'info' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('migrations complete')
  })
})
