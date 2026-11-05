/**
 * CS-3949: jobs and Guardian approvals; approved job pay arrives unsplit,
 * paid under Sarah's session (bob-family/1 §5). Through POST /graphql.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from 'mongodb'
import { jobPaymentKey } from '../src/chores/service.js'
import { runMigrations } from '../src/migrations/index.js'
import { creditFromJobPayment, readLedger } from '../src/unsplit/ledger.js'
import { FakeBob } from './fakes/bob.js'
import { buildTestApi, codeOf } from './helpers/api.js'
import { LEO, MIA, OTHER, OTHER_KID, SARAH, seedFamily } from './helpers/family.js'
import { startMongo, type TestMongo } from './helpers/mongo.js'

let mongo: TestMongo
let db: Db
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})

let bob: FakeBob
let t: number
let funding: string
beforeEach(async () => {
  db = mongo.db()
  await runMigrations(db, { holder: 'test' })
  t = Date.parse('2026-11-05T03:00:00Z')
  bob = new FakeBob()
  bob.clock = () => new Date(t)
  ;({ funding } = seedFamily(bob))
})

const JOB = 'jobId status version reward { amount currency } points payment { idempotencyKey status reason bobOperationRef amount { amount } }'
const CREATE = `mutation($c: ID!, $k: CsJobKind!, $t: String!, $r: CsMoneyInput, $p: Int, $key: ID!) { createJob(childId: $c, kind: $k, title: $t, reward: $r, points: $p, idempotencyKey: $key) { ${JOB} } }`
const SUBMIT = `mutation($j: ID!, $v: Int!, $key: ID!) { submitJob(jobId: $j, expectedVersion: $v, idempotencyKey: $key) { ${JOB} } }`
const DECIDE = `mutation($j: ID!, $d: CsDecision!, $v: Int!, $key: ID!, $f: ID) { decideJob(jobId: $j, decision: $d, expectedVersion: $v, idempotencyKey: $key, fromAccountId: $f) { job { ${JOB} } approval { status } payment { status reason } } }`
const RETRY = `mutation($j: ID!, $v: Int!, $key: ID!) { retryJobPayment(jobId: $j, expectedVersion: $v, idempotencyKey: $key) { job { ${JOB} } payment { status reason } } }`
const APPROVALS = '{ approvals { approvalId subjectId status childCustomerId } }'

type Job = { jobId: string; status: string; version: number; payment: { status: string; reason: string | null; idempotencyKey: string } | null }
type Api = ReturnType<typeof buildTestApi>

async function waitingJob(api: Api, sarah: string, mia: string, opts: { kind?: string; reward?: string | null; points?: number | null; child?: string } = {}) {
  const c = await api.gql(sarah, CREATE, {
    c: opts.child ?? MIA,
    k: opts.kind ?? 'EXTRA_EARNER',
    t: 'Washed the car',
    r: opts.reward === null ? null : { amount: opts.reward ?? '2.00', currency: 'AUD' },
    p: opts.points ?? null,
    key: `create-${Math.random().toString(36).slice(2, 12)}`,
  })
  const job = c.body.data!.createJob as Job
  const s = await api.gql(mia, SUBMIT, { j: job.jobId, v: job.version, key: `submit-${job.jobId.slice(4, 14)}` })
  return s.body.data!.submitJob as Job
}

const jobLegs = () => bob.ledger.filter((l) => l.purpose === 'job')
const payCalls = () => bob.calls.filter((c) => c.path.endsWith('/job-payments'))
const unsplitCents = async (child = MIA) => (await readLedger(db, child))?.balanceCents ?? 0

describe('T1: create, submit, approve', () => {
  it('one BOB job leg under Sarah’s session, unsplit rises, job PAID', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const mia = bob.signIn(MIA)
    const w = await waitingJob(api, sarah, mia)
    expect(w.status).toBe('WAITING')
    expect((await api.gql(sarah, APPROVALS)).body.data!.approvals).toEqual([{ approvalId: expect.any(String), subjectId: w.jobId, status: 'PENDING', childCustomerId: MIA }])

    const d = await api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-key-1', f: funding })
    const r = d.body.data!.decideJob as { job: Job; approval: { status: string }; payment: { status: string } }
    expect(r.job.status).toBe('PAID')
    expect(r.approval.status).toBe('APPROVED')
    expect(r.payment.status).toBe('COMPLETED')
    expect(payCalls().map((c) => [c.bearer, c.key, c.body])).toEqual([
      [sarah, jobPaymentKey(w.jobId), { job_ref: w.jobId, from_account_id: funding, amount_cents: 200, currency: 'AUD', description: 'Washed the car' }],
    ])
    expect(jobLegs()).toHaveLength(1)
    expect(jobLegs()[0]).toMatchObject({ from: funding, to: bob.accountOf(MIA, 'spend'), amountCents: 200 })
    expect(bob.balance(MIA, 'spend')).toBe(200)
    expect(bob.balance(MIA, 'save')).toBe(0) // unsplit: no split legs
    expect(await unsplitCents()).toBe(200)
    expect((await api.gql(sarah, APPROVALS)).body.data!.approvals).toEqual([])
    await api.app.close()
  })

  it('send back, then resubmit', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const mia = bob.signIn(MIA)
    const w = await waitingJob(api, sarah, mia)
    const back = (await api.gql(sarah, DECIDE, { j: w.jobId, d: 'REJECT', v: w.version, key: 'decide-back-1' })).body.data!.decideJob as { job: Job; approval: { status: string } }
    expect(back.job.status).toBe('SENT_BACK')
    expect(back.approval.status).toBe('REJECTED')
    expect(payCalls()).toHaveLength(0)
    const again = (await api.gql(mia, SUBMIT, { j: w.jobId, v: back.job.version, key: 'submit-again-1' })).body.data!.submitJob as Job
    expect(again.status).toBe('WAITING')
    expect((await api.gql(sarah, APPROVALS)).body.data!.approvals).toHaveLength(1)
    await api.app.close()
  })
})

describe('T2: concurrent or replayed approvals give one debit', () => {
  it('two concurrent approvals with different keys', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const w = await waitingJob(api, sarah, bob.signIn(MIA))
    const [a, b] = await Promise.all([
      api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-conc-a', f: funding }),
      api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-conc-b', f: funding }),
    ])
    const codes = [codeOf(a.body), codeOf(b.body)]
    expect(codes.filter((c) => c === undefined)).toHaveLength(1)
    expect(codes.filter((c) => c === 'STALE_VERSION')).toHaveLength(1)
    expect(jobLegs()).toHaveLength(1)
    expect(bob.balance(SARAH, 'funding')).toBe(10_000 - 200)
    expect(await unsplitCents()).toBe(200)
    await api.app.close()
  })

  it('a replay with the same key returns the same result and moves nothing', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const w = await waitingJob(api, sarah, bob.signIn(MIA))
    const vars = { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-replay-1', f: funding }
    const first = await api.gql(sarah, DECIDE, vars)
    const second = await api.gql(sarah, DECIDE, vars)
    expect(second.body).toEqual(first.body)
    expect(payCalls()).toHaveLength(1)
    expect(jobLegs()).toHaveLength(1)
    expect(await unsplitCents()).toBe(200)
    await api.app.close()
  })

  it('a second approval of a PAID job is refused and moves nothing', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const w = await waitingJob(api, sarah, bob.signIn(MIA))
    const r = (await api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-once-1', f: funding })).body.data!.decideJob as { job: Job }
    expect(codeOf((await api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: r.job.version, key: 'decide-twice-1', f: funding })).body)).toBe('NOT_ALLOWED_IN_STATE')
    expect(jobLegs()).toHaveLength(1)
    await api.app.close()
  })
})

describe('T3: a stale version gets STALE_VERSION', () => {
  it('approve with an old version', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const w = await waitingJob(api, sarah, bob.signIn(MIA))
    const r = await api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version - 1, key: 'decide-stale-1', f: funding })
    expect(codeOf(r.body)).toBe('STALE_VERSION')
    expect(payCalls()).toHaveLength(0)
    await api.app.close()
  })
})

describe('T4: a BOB timeout followed by a reconcile gives one debit', () => {
  it('BOB commits but the answer is lost: PENDING (not PAID), then retry with the original key: PAID once', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const w = await waitingJob(api, sarah, bob.signIn(MIA))
    bob.dropResponses = { re: /job-payments$/, count: 1 }
    const d = (await api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-lost-1', f: funding })).body.data!.decideJob as { job: Job; payment: { status: string; reason: string } }
    expect(d.job.status).toBe('APPROVED_PAYMENT_PENDING')
    expect(d.payment).toEqual({ status: 'PENDING', reason: 'UPSTREAM_UNAVAILABLE' })
    expect(jobLegs()).toHaveLength(1) // BOB did pay
    expect(await unsplitCents()).toBe(0) // but nothing is credited before BOB reports completion
    const r = (await api.gql(sarah, RETRY, { j: w.jobId, v: d.job.version, key: 'retry-lost-1' })).body.data!.retryJobPayment as { job: Job; payment: { status: string } }
    expect(r.job.status).toBe('PAID')
    expect(payCalls().map((c) => c.key)).toEqual([jobPaymentKey(w.jobId), jobPaymentKey(w.jobId)])
    expect(jobLegs()).toHaveLength(1)
    expect(await unsplitCents()).toBe(200)
    await api.app.close()
  })

  it('BOB unavailable before processing: retry pays once', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const w = await waitingJob(api, sarah, bob.signIn(MIA))
    bob.failBefore = { re: /job-payments$/, count: 1, status: 503, code: 'UNAVAILABLE' }
    const d = (await api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-503-1', f: funding })).body.data!.decideJob as { job: Job }
    expect(jobLegs()).toHaveLength(0)
    const r = (await api.gql(sarah, RETRY, { j: w.jobId, v: d.job.version, key: 'retry-503-1' })).body.data!.retryJobPayment as { job: Job }
    expect(r.job.status).toBe('PAID')
    expect(jobLegs()).toHaveLength(1)
    await api.app.close()
  })

  it('a payment already made under another key (JOB_ALREADY_PAID) is treated as done', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const w = await waitingJob(api, sarah, bob.signIn(MIA))
    bob.jobPayments.set(`${MIA}|${w.jobId}`, 'pay_T_EARLIER')
    const d = (await api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-already-1', f: funding })).body.data!.decideJob as { job: Job }
    expect(d.job.status).toBe('PAID')
    expect(d.job.payment).toMatchObject({ status: 'COMPLETED', bobOperationRef: 'pay_T_EARLIER' })
    expect(jobLegs()).toHaveLength(0)
    await api.app.close()
  })

  it('nothing retries in the background: the job stays pending until the Guardian retries', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const w = await waitingJob(api, sarah, bob.signIn(MIA))
    bob.failBefore = { re: /job-payments$/, count: 1, status: 503, code: 'UNAVAILABLE' }
    await api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-bg-1', f: funding })
    const before = payCalls().length
    await new Promise((r) => setTimeout(r, 50))
    expect(payCalls().length).toBe(before)
    expect((await db.collection('jobs').findOne({ jobId: w.jobId }))!.status).toBe('APPROVED_PAYMENT_PENDING')
    await api.app.close()
  })
})

describe('T5: approving a good deed makes zero BOB calls', () => {
  it('points only, DONE', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const w = await waitingJob(api, sarah, bob.signIn(MIA), { kind: 'GOOD_DEED', reward: null, points: 50 })
    const d = (await api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-deed-1' })).body.data!.decideJob as { job: Job & { points: number }; payment: null }
    expect(d.job).toMatchObject({ status: 'DONE', points: 50, payment: null })
    expect(d.payment).toBeNull()
    expect(payCalls()).toHaveLength(0)
    expect(await unsplitCents()).toBe(0)
    await api.app.close()
  })

  it('a good deed with a reward is refused', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const r = await api.gql(bob.signIn(SARAH), CREATE, { c: MIA, k: 'GOOD_DEED', t: 'Helped', r: { amount: '1.00', currency: 'AUD' }, p: 5, key: 'create-deed-bad' })
    expect(codeOf(r.body)).toBe('INVALID')
    await api.app.close()
  })
})

describe('T6: a child cannot approve; an unlinked child cannot be paid (AUTH-3)', () => {
  it('Mia approving her own job gets FORBIDDEN', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const mia = bob.signIn(MIA)
    const w = await waitingJob(api, bob.signIn(SARAH), mia)
    expect(codeOf((await api.gql(mia, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-child-1', f: funding })).body)).toBe('FORBIDDEN')
    expect(payCalls()).toHaveLength(0)
    await api.app.close()
  })

  it('a child cannot create jobs, and cannot submit a sibling’s job', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    expect(codeOf((await api.gql(bob.signIn(MIA), CREATE, { c: MIA, k: 'EXTRA_EARNER', t: 'x', r: { amount: '9.00', currency: 'AUD' }, key: 'create-child-1' })).body)).toBe('FORBIDDEN')
    const c = (await api.gql(sarah, CREATE, { c: LEO, k: 'EXTRA_EARNER', t: 'Mow', r: { amount: '3.00', currency: 'AUD' }, key: 'create-leo-1' })).body.data!.createJob as Job
    expect(codeOf((await api.gql(bob.signIn(MIA), SUBMIT, { j: c.jobId, v: c.version, key: 'submit-sib-1' })).body)).toBe('FORBIDDEN')
    await api.app.close()
  })

  it('another family’s Guardian cannot see or approve Mia’s job', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const w = await waitingJob(api, bob.signIn(SARAH), bob.signIn(MIA))
    const other = bob.signIn(OTHER)
    expect(codeOf((await api.gql(other, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-other-1', f: funding })).body)).toBe('FORBIDDEN')
    expect((await api.gql(other, APPROVALS)).body.data!.approvals).toEqual([])
    expect(codeOf((await api.gql(other, `query($c: ID) { jobs(childId: $c) { jobId } }`, { c: MIA })).body)).toBe('FORBIDDEN')
    expect(codeOf((await api.gql(other, CREATE, { c: MIA, k: 'EXTRA_EARNER', t: 'x', r: { amount: '1.00', currency: 'AUD' }, key: 'create-other-1' })).body)).toBe('FORBIDDEN')
    await api.app.close()
  })

  it('BOB refuses pay to a child whose link was revoked (inside the cache window): PAYMENT_FAILED, nothing moved', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const w = await waitingJob(api, sarah, bob.signIn(MIA))
    bob.revokeLink(SARAH, MIA) // the server's cached answer still lists Mia; BOB checks live
    const d = (await api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-revoked-1', f: funding })).body.data!.decideJob as { job: Job; payment: { status: string; reason: string } }
    expect(d.job.status).toBe('PAYMENT_FAILED')
    expect(d.payment).toEqual({ status: 'FAILED', reason: 'FORBIDDEN' })
    expect(jobLegs()).toHaveLength(0)
    expect(await unsplitCents()).toBe(0)
    await api.app.close()
  })

  it('a source account that isn’t Sarah’s is refused by BOB', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const w = await waitingJob(api, sarah, bob.signIn(MIA))
    const d = (await api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-acct-1', f: bob.accountOf(OTHER, 'funding') })).body.data!.decideJob as { payment: { reason: string } }
    expect(d.payment.reason).toBe('FORBIDDEN')
    expect(jobLegs()).toHaveLength(0)
    await api.app.close()
  })
})

describe('T7: approval-to-credit latency (target 5 s or less)', () => {
  it('measured in process against the in-memory BOB', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const w = await waitingJob(api, sarah, bob.signIn(MIA))
    const t0 = performance.now()
    await api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-lat-1', f: funding })
    const ms = performance.now() - t0
    expect(await unsplitCents()).toBe(200)
    console.log(`T7 approval-to-credit: ${ms.toFixed(1)} ms (in-memory BOB; not a deployed measurement)`)
    expect(ms).toBeLessThan(5_000)
    await api.app.close()
  })
})

describe('other refusals and inputs', () => {
  it('insufficient funds: PAYMENT_FAILED with BOB’s reason, nothing moved', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const w = await waitingJob(api, sarah, bob.signIn(MIA), { reward: '200.00' })
    const d = (await api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-poor-1', f: funding })).body.data!.decideJob as { job: Job; payment: { reason: string } }
    expect(d.job.status).toBe('PAYMENT_FAILED')
    expect(d.payment.reason).toBe('INSUFFICIENT_FUNDS')
    expect(bob.balance(SARAH, 'funding')).toBe(10_000)
    await api.app.close()
  })

  it('approving a paid job without fromAccountId is INVALID and changes nothing', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const w = await waitingJob(api, sarah, bob.signIn(MIA))
    expect(codeOf((await api.gql(sarah, DECIDE, { j: w.jobId, d: 'APPROVE', v: w.version, key: 'decide-noacct-1' })).body)).toBe('INVALID')
    expect((await db.collection('jobs').findOne({ jobId: w.jobId }))!.status).toBe('WAITING')
    expect(await db.collection('money_operations').countDocuments()).toBe(0)
    await api.app.close()
  })

  it.each([['2', 'AUD'], ['2.5', 'AUD'], ['0.00', 'AUD'], ['-1.00', 'AUD'], ['2.00', 'NZD']])('reward %s %s is INVALID', async (amount, currency) => {
    const api = buildTestApi({ db, bob, now: () => t })
    expect(codeOf((await api.gql(bob.signIn(SARAH), CREATE, { c: MIA, k: 'EXTRA_EARNER', t: 'x', r: { amount, currency }, key: 'create-bad-amt' })).body)).toBe('INVALID')
    await api.app.close()
  })

  it('createJob is idempotent per Guardian key', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    const v = { c: MIA, k: 'EXTRA_EARNER', t: 'Wash', r: { amount: '1.00', currency: 'AUD' }, key: 'create-same-key' }
    const a = (await api.gql(sarah, CREATE, v)).body.data!.createJob as Job
    const b = (await api.gql(sarah, CREATE, v)).body.data!.createJob as Job
    expect(b.jobId).toBe(a.jobId)
    expect(await db.collection('jobs').countDocuments()).toBe(1)
    await api.app.close()
  })

  it('a child sees only their own jobs', async () => {
    const api = buildTestApi({ db, bob, now: () => t })
    const sarah = bob.signIn(SARAH)
    await api.gql(sarah, CREATE, { c: MIA, k: 'HOME_JOB', t: 'Bed', key: 'create-mia-bed' })
    await api.gql(sarah, CREATE, { c: LEO, k: 'HOME_JOB', t: 'Bed', key: 'create-leo-bed' })
    const r = await api.gql(bob.signIn(MIA), '{ jobs { childCustomerId } }')
    expect(r.body.data!.jobs).toEqual([{ childCustomerId: MIA }])
    expect((await api.gql(sarah, '{ jobs { childCustomerId } }')).body.data!.jobs).toHaveLength(2)
    expect(codeOf((await api.gql(bob.signIn(OTHER_KID), `query($c: ID) { jobs(childId: $c) { jobId } }`, { c: MIA })).body)).toBe('FORBIDDEN')
    await api.app.close()
  })
})

describe('the unsplit ledger accepts only completed job pay', () => {
  it('refuses any other credit', async () => {
    const bad = { idempotencyKey: 'x', kind: 'allowance', status: 'COMPLETED', jobId: 'j', childCustomerId: MIA, tenantId: 'bank_bilgola', amountCents: 1 }
    await expect(creditFromJobPayment(db, bad as never, new Date())).rejects.toThrow(/only completed job pay/)
    await expect(creditFromJobPayment(db, { ...bad, kind: 'job', status: 'PENDING' } as never, new Date())).rejects.toThrow(/only completed job pay/)
  })
})
