/**
 * CS-3992 / CS-3979: scripts/deploy-jobs.sh against stubbed aws and git
 * (test/fixtures/deploy-stubs). Nothing here reaches AWS or a registry.
 *
 * The rules under test: one bank per run; never build; the API must already run
 * the same digest (so its migrations ran); the jobs task definition is pinned by
 * digest and carries only its bank's role, secret and tenant; the desired count
 * is never set, so a stopped jobs service stays stopped; a running one is
 * refused unless acknowledged.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from './helpers/run.js'

const SCRIPT = resolve('scripts/deploy-jobs.sh')
const STUBS = resolve('test/fixtures/deploy-stubs')
const SHA = '0123456789abcdef0123456789abcdef01234567'
const REPO = '932027117528.dkr.ecr.ap-southeast-2.amazonaws.com/chore-scout-server'
const DIGEST = `sha256:${'a'.repeat(64)}`
const PREV_DIGEST = `sha256:${'b'.repeat(64)}`
const API_TD = 'arn:aws:ecs:ap-southeast-2:932027117528:task-definition/chore-scout-api:9'
const JOBS_PREV_TD = (bank: string) => `arn:aws:ecs:ap-southeast-2:932027117528:task-definition/chore-scout-jobs-${bank}:3`
const NETCFG = { awsvpcConfiguration: { subnets: ['subnet-0aaa'], securityGroups: ['sg-0ddd'], assignPublicIp: 'ENABLED' } }
const service = (td: string, desired: number, status = 'ACTIVE', netcfg: object = NETCFG) => JSON.stringify({ services: [{ status, taskDefinition: td, desiredCount: desired, networkConfiguration: netcfg }], failures: [] })
const MISSING = JSON.stringify({ services: [], failures: [{ arn: 'x', reason: 'MISSING' }] })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cs-deploy-jobs-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface Setup {
  bank?: string
  jobs?: string // the jobs service's describe-services answer
  jobsDesired?: number
  api?: string
  apiImage?: string
  jobsPrevImage?: string
  imageExists?: boolean
  sgName?: string
  env?: Record<string, string>
}
function deployJobs(sha: string | undefined, bank: string | undefined, o: Setup = {}) {
  const b = o.bank ?? bank ?? 'bank_bilgola'
  writeFileSync(join(dir, 'service-chore-scout-api.json'), o.api ?? service(API_TD, 1))
  writeFileSync(join(dir, `service-chore-scout-jobs-${b}.json`), o.jobs ?? service(JOBS_PREV_TD(b), o.jobsDesired ?? 0))
  writeFileSync(join(dir, 'td-image-chore-scout-api'), o.apiImage ?? `${REPO}@${DIGEST}`)
  writeFileSync(join(dir, `td-image-chore-scout-jobs-${b}`), o.jobsPrevImage ?? `${REPO}@${PREV_DIGEST}`)
  const env: Record<string, string> = {
    PATH: `${STUBS}:${process.env.PATH ?? ''}`,
    STUB_DIR: dir,
    STUB_HEAD: SHA,
    STUB_SERVICES_JSON: '{"services":[],"failures":[{"reason":"UNEXPECTED"}]}',
    STUB_PREV_IMAGE: 'None',
    STUB_DIGEST: DIGEST,
    STUB_IMAGE_EXISTS: o.imageExists === false ? '0' : '1',
    STUB_DESIRED: String(o.jobsDesired ?? 0),
    STUB_SG_NAME: o.sgName ?? 'chore-scout-jobs-sg',
    STUB_MIGRATE_EXIT: '0',
    ...o.env,
  }
  const args = [SCRIPT, ...(sha === undefined ? [] : [sha]), ...(bank === undefined ? [] : [bank])]
  return run('bash', args, env)
}
const calls = () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n') : [])
const registered = (family: string) => JSON.parse(readFileSync(join(dir, `registered-${family}.json`), 'utf8'))
const changed = () => calls().filter((l) => /register-task-definition|update-service|run-task|create-service/.test(l))

describe('deploy-jobs.sh guards', () => {
  it.each([
    ['a short SHA', SHA.slice(0, 7), 'bank_bilgola', 'a full 40-character commit SHA is required'],
    ['no bank', SHA, undefined, 'unknown bank'],
    ['an unknown bank', SHA, 'bank_elsewhere', 'unknown bank'],
    ['a bank id with a path in it', SHA, 'bank_bilgola/../x', 'unknown bank'],
  ])('refuses %s before any aws call', async (_l, sha, bank, msg) => {
    const r = await deployJobs(sha, bank)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(msg)
    expect(calls()).toEqual([])
  })

  it('never builds: an image not yet pushed by the API deploy is refused, and nothing changes', async () => {
    const r = await deployJobs(SHA, 'bank_bilgola', { imageExists: false })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('Deploy the API for this SHA first')
    expect(calls().some((l) => l.startsWith('docker'))).toBe(false)
    expect(changed()).toEqual([])
  })

  it('refuses when the API does not run this digest (its migrations have not run for this code)', async () => {
    const r = await deployJobs(SHA, 'bank_bilgola', { apiImage: `${REPO}@${PREV_DIGEST}` })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('Deploy the API (and its migrations)')
    expect(changed()).toEqual([])
  })

  it('refuses a running jobs service without JOBS_RUNNING_ACK=1, before anything changes', async () => {
    const r = await deployJobs(SHA, 'bank_manly', { jobsDesired: 1 })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('Jobs stay stopped until activation')
    expect(changed()).toEqual([])
  })

  it.each([
    ['another security group', { sgName: 'chore-scout-server-sg' }, 'expected chore-scout-jobs-sg'],
    ['no public IP', { jobs: service(JOBS_PREV_TD('bank_bilgola'), 0, 'ACTIVE', { awsvpcConfiguration: { subnets: ['subnet-0aaa'], securityGroups: ['sg-0ddd'], assignPublicIp: 'DISABLED' } }) }, 'assignPublicIp ENABLED'],
    ['a rollback image that is a tag', { jobsPrevImage: `${REPO}:latest` }, 'not pinned by digest'],
    ['a DRAINING service', { jobs: service(JOBS_PREV_TD('bank_bilgola'), 0, 'DRAINING') }, 'status is DRAINING'],
    ['a missing service without bootstrap', { jobs: MISSING }, 'does not exist'],
  ])('refuses %s, and changes nothing', async (_l, o, msg) => {
    const r = await deployJobs(SHA, 'bank_bilgola', o as Setup)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(msg)
    expect(changed()).toEqual([])
  })
})

describe('deploy-jobs.sh flow (stubbed AWS)', () => {
  it.each(['bank_bilgola', 'bank_manly'])('%s: registers its own pinned task definition and points the stopped service at it; desired stays 0', async (bank) => {
    const r = await deployJobs(SHA, bank)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const td = registered(`chore-scout-jobs-${bank}`)
    const c = td.containerDefinitions[0]
    const env = Object.fromEntries(c.environment.map((e: { name: string; value: string }) => [e.name, e.value]))
    expect(c.image).toBe(`${REPO}@${DIGEST}`)
    expect(td.taskRoleArn).toBe(`arn:aws:iam::932027117528:role/chore-scout-jobs-${bank}-task-role`)
    expect(env).toMatchObject({ ALLOWANCE_TENANT_ID: bank, CS_SECRETS_ID: `chore-scout-server/jobs-${bank}` })
    expect(JSON.stringify(td)).not.toContain('__TENANT_ID__')
    expect(c.logConfiguration.options['awslogs-stream-prefix']).toBe(`jobs-${bank}`)

    const upd = calls().filter((l) => l.includes('ecs update-service'))
    expect(upd).toEqual([`aws ecs update-service --cluster moroku-dsl-dev --service chore-scout-jobs-${bank} --task-definition arn:aws:ecs:ap-southeast-2:932027117528:task-definition/chore-scout-jobs-${bank}:7 --region ap-southeast-2 --output json`])
    expect(calls().some((l) => l.includes('--desired-count'))).toBe(false)
    expect(calls().some((l) => l.includes('wait services-stable'))).toBe(false)
    expect(calls().some((l) => l.startsWith('docker') || l.includes('run-task') || l.includes('create-service'))).toBe(false)
    // The other bank is never touched.
    const other = bank === 'bank_bilgola' ? 'bank_manly' : 'bank_bilgola'
    expect(calls().some((l) => l.includes(other))).toBe(false)
    expect(r.stdout).toContain('desired count: 0 (unchanged by this deploy)')
    expect(r.stdout).toContain(`rollback digest: ${PREV_DIGEST}`)
    expect(r.stdout).toContain(`rollback task definition: ${JOBS_PREV_TD(bank)}`)
    expect(r.stdout).toContain('stable wait: not needed (desired 0, nothing started)')
  })

  it('a running service is replaced only with JOBS_RUNNING_ACK=1, then waits for stable; the desired count is still not set', async () => {
    const r = await deployJobs(SHA, 'bank_bilgola', { jobsDesired: 1, env: { JOBS_RUNNING_ACK: '1' } })
    expect(r.status).toBe(0)
    expect(calls().some((l) => l.includes('--desired-count'))).toBe(false)
    expect(calls().some((l) => l.includes('wait services-stable --cluster moroku-dsl-dev --services chore-scout-jobs-bank_bilgola'))).toBe(true)
    expect(r.stdout).toContain('stable wait: passed (desired 1)')
  })

  it('a failed stable wait prints the stop command (scale to 0), not a restart', async () => {
    const r = await deployJobs(SHA, 'bank_bilgola', { jobsDesired: 1, env: { JOBS_RUNNING_ACK: '1', STUB_STABLE_RC: '1' } })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('--desired-count 0')
  })

  it('stops if the desired count moved during the deploy', async () => {
    const r = await deployJobs(SHA, 'bank_bilgola', { env: { STUB_DESIRED: '2' } })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('desired count changed from 0 to 2')
  })

  it('bootstrap on a MISSING service registers the task definition only and says so', async () => {
    const r = await deployJobs(SHA, 'bank_manly', { jobs: MISSING, env: { DEPLOY_BOOTSTRAP: '1' } })
    expect(r.status).toBe(0)
    expect(registered('chore-scout-jobs-bank_manly').containerDefinitions[0].image).toBe(`${REPO}@${DIGEST}`)
    expect(calls().some((l) => l.includes('update-service'))).toBe(false)
    expect(r.stdout).toContain('--desired-count 0')
    expect(r.stdout).toContain('BOOTSTRAP: nothing deployed')
  })

  it('bootstrap against an ACTIVE service is refused', async () => {
    const r = await deployJobs(SHA, 'bank_manly', { env: { DEPLOY_BOOTSTRAP: '1' } })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('bootstrap was requested but')
    expect(changed()).toEqual([])
  })
})

describe('deploy workflow (.github/workflows/deploy.yml)', () => {
  const wf = readFileSync('.github/workflows/deploy.yml', 'utf8')
  it('offers the API and one bank’s jobs at a time; jobs run deploy-jobs.sh and never touch the desired count', () => {
    expect(wf).toMatch(/options:\n\s+- api\n\s+- jobs-bank_bilgola\n\s+- jobs-bank_manly\n/)
    expect(wf).toContain('bash scripts/deploy-jobs.sh "$GITHUB_SHA" "${TARGET#jobs-}"')
    expect(wf).toContain("if: ${{ inputs.target == 'api' }}")
    expect(wf).toContain("if: ${{ startsWith(inputs.target, 'jobs-') }}")
    expect(wf).not.toMatch(/desired-count|scale/i)
    // Still manual only, and still main only.
    expect(wf).toMatch(/^on:\n {2}workflow_dispatch:/m)
    expect(wf).not.toMatch(/^\s+push:/m)
    expect(wf).toContain("github.ref == 'refs/heads/main'")
  })
})
