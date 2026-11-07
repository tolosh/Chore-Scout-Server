import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LeaseLock } from '../src/lease.js'
import { REGISTERED_JOBS } from '../src/jobs/registry.js'
import { JobRunner, type ScheduledJob } from '../src/jobs/runner.js'
import { startMongo, type TestMongo } from './helpers/mongo.js'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }

describe('lease lock (no upserts; DocumentDB E11000 finding)', () => {
  it('exactly one of many concurrent contenders acquires', async () => {
    const db = mongo.db()
    const lock = new LeaseLock(db)
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => lock.tryAcquire('scheduler', `h${i}`, 30_000)))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await db.collection('leases').countDocuments()).toBe(1)
  })

  it('holder renews and token increments; others are refused while live', async () => {
    const lock = new LeaseLock(mongo.db())
    const a = await lock.tryAcquire('x', 'A', 30_000)
    expect(a?.token).toBe(1)
    expect(await lock.tryAcquire('x', 'B', 30_000)).toBeNull()
    const a2 = await lock.tryAcquire('x', 'A', 30_000)
    expect(a2?.token).toBe(2)
  })

  it('an expired lease is taken over with a higher fencing token', async () => {
    let t = new Date('2026-11-04T00:00:00Z')
    const db = mongo.db()
    const lock = new LeaseLock(db, () => t)
    expect((await lock.tryAcquire('x', 'A', 1_000))?.token).toBe(1)
    t = new Date(t.getTime() + 1_001)
    const b = await lock.tryAcquire('x', 'B', 1_000)
    expect(b).toMatchObject({ holder: 'B', token: 2 })
  })

  it('release only by the holder; released lease is free', async () => {
    const lock = new LeaseLock(mongo.db())
    await lock.tryAcquire('x', 'A', 30_000)
    expect(await lock.release('x', 'B')).toBe(false)
    expect(await lock.release('x', 'A')).toBe(true)
    expect(await lock.tryAcquire('x', 'B', 30_000)).toMatchObject({ holder: 'B' })
  })
})

describe('job runner (single runner)', () => {
  it('the jobs process registers exactly the allowance-cycle job (CS-3979)', () => {
    expect([...REGISTERED_JOBS]).toEqual(['allowance-cycles'])
  })

  it('stillLeader is true for the holder and false once another runner takes over the lease', async () => {
    let t = new Date('2026-11-04T00:00:00Z')
    const db = mongo.db()
    const checks: boolean[] = []
    const job: ScheduledJob = { name: 'probe', run: async (ctx) => void checks.push(await ctx.stillLeader()) }
    await new JobRunner(db, 'leader-a', 1_000, [job], silent, () => t).tick()
    let later: (() => Promise<boolean>) | null = null
    const slow: ScheduledJob = { name: 'slow', run: async (ctx) => void (later = ctx.stillLeader) }
    await new JobRunner(db, 'leader-a', 1_000, [slow], silent, () => t).tick()
    t = new Date(t.getTime() + 1_001)
    await new JobRunner(db, 'leader-b', 1_000, [], silent, () => t).tick()
    expect(checks).toEqual([true])
    expect(await later!()).toBe(false)
  })

  it('only the lease holder runs jobs, with its fencing token', async () => {
    const db = mongo.db()
    const runs: string[] = []
    const job: ScheduledJob = { name: 'probe', run: async (ctx) => void runs.push(`${ctx.fencingToken}`) }
    const r1 = new JobRunner(db, 'r1', 30_000, [job], silent)
    const r2 = new JobRunner(db, 'r2', 30_000, [job], silent)
    const [t1, t2] = await Promise.all([r1.tick(), r2.tick()])
    expect([t1.leader, t2.leader].filter(Boolean)).toHaveLength(1)
    expect(runs).toEqual(['1'])
  })

  it('a failing job is reported and does not stop the tick', async () => {
    const db = mongo.db()
    const bad: ScheduledJob = { name: 'bad', run: async () => Promise.reject(new Error('boom')) }
    const good: ScheduledJob = { name: 'good', run: async () => undefined }
    const res = await new JobRunner(db, 'r', 30_000, [bad, good], silent).tick()
    expect(res).toEqual({ leader: true, ran: ['good'], failed: ['bad'] })
  })
})
