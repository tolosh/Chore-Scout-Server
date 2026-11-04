/**
 * CS-3992 test 2 and the deploy.sh flow, against stubbed aws, docker and git
 * (test/fixtures/deploy-stubs). Nothing here reaches AWS or a registry.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from './helpers/run.js'

const SCRIPT = resolve('scripts/deploy.sh')
const STUBS = resolve('test/fixtures/deploy-stubs')
const SHA = '0123456789abcdef0123456789abcdef01234567'
const REPO = '932027117528.dkr.ecr.ap-southeast-2.amazonaws.com/chore-scout-server'
const DIGEST = `sha256:${'a'.repeat(64)}`
const PREV_DIGEST = `sha256:${'b'.repeat(64)}`
const PREV_TD = 'arn:aws:ecs:ap-southeast-2:932027117528:task-definition/chore-scout-api:6'
const NETCFG = {
  // The agreed configuration (D48 as amended): public IP, and only chore-scout-server-sg.
  awsvpcConfiguration: { subnets: ['subnet-0aaa', 'subnet-0bbb'], securityGroups: ['sg-0ccc'], assignPublicIp: 'ENABLED' },
}
const activeService = (desired = 1, status = 'ACTIVE', netcfg: object = NETCFG) =>
  JSON.stringify({
    services: [{ status, taskDefinition: PREV_TD, desiredCount: desired, networkConfiguration: netcfg }],
    failures: [],
  })
const missingService = JSON.stringify({ services: [], failures: [{ arn: 'x', reason: 'MISSING' }] })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cs-deploy-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function deploy(arg: string | undefined, overrides: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: `${STUBS}:${process.env.PATH ?? ''}`,
    STUB_DIR: dir,
    STUB_HEAD: SHA,
    STUB_SERVICES_JSON: activeService(1),
    STUB_PREV_IMAGE: `${REPO}@${PREV_DIGEST}`,
    STUB_DIGEST: DIGEST,
    STUB_MIGRATE_EXIT: '0',
    STUB_DESIRED: '1',
    ...overrides,
  }
  return run('bash', arg === undefined ? [SCRIPT] : [SCRIPT, arg], env)
}
const calls = () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n') : [])
const registered = (family: string) => JSON.parse(readFileSync(join(dir, `registered-${family}.json`), 'utf8'))

describe('deploy.sh guards (CS-3992 T2)', () => {
  it.each([
    ['a short SHA', SHA.slice(0, 7)],
    ['a tag', 'latest'],
    ['an upper-case SHA', SHA.toUpperCase()],
    ['a 41-character value', `${SHA}0`],
    ['no argument', undefined],
  ])('refuses %s before any aws or docker call', async (_label, arg) => {
    const r = await deploy(arg)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('a full 40-character commit SHA is required')
    expect(calls()).toEqual([])
  })

  it('refuses when the checkout is not the requested SHA', async () => {
    const r = await deploy(SHA, { STUB_HEAD: 'f'.repeat(40) })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('is not')
    expect(calls()).toEqual([])
  })

  it.each([
    ['a tag', `${REPO}:latest`],
    ['a SHA tag', `${REPO}:${SHA}`],
    ['a digest in another repo', `932027117528.dkr.ecr.ap-southeast-2.amazonaws.com/moroku-dsl@${PREV_DIGEST}`],
    ['a malformed digest', `${REPO}@sha256:abc`],
    ['nothing', 'None'],
  ])('refuses a rollback image that is %s, before building or changing anything', async (_label, prev) => {
    const r = await deploy(SHA, { STUB_PREV_IMAGE: prev })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('not pinned by digest')
    const c = calls()
    expect(c.some((l) => l.startsWith('docker'))).toBe(false)
    expect(c.some((l) => /register-task-definition|run-task|update-service/.test(l))).toBe(false)
  })

  it('the guard functions can be sourced and checked directly', async () => {
    const check = (fn: string, value: string) =>
      run('bash', ['-c', `source "${SCRIPT}"; ${fn} "$1"`, 'x', value], { PATH: process.env.PATH ?? '' })
    expect((await check('require_full_sha', SHA)).status).toBe(0)
    expect((await check('require_full_sha', SHA.slice(0, 12))).status).not.toBe(0)
    expect((await check('require_digest_ref', `${REPO}@${DIGEST}`)).status).toBe(0)
    expect((await check('require_digest_ref', `${REPO}:${SHA}`)).status).not.toBe(0)
    expect((await check('require_digest', DIGEST)).status).toBe(0)
    expect((await check('require_digest', 'sha256:XYZ')).status).not.toBe(0)
  })
})

describe('deploy.sh flow (stubbed AWS)', () => {
  it('builds, pushes, pins, migrates, updates and waits for stable', async () => {
    const r = await deploy(SHA)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const c = calls()
    const idx = (re: RegExp) => c.findIndex((l) => re.test(l))

    expect(c).toContain(`docker build --platform linux/amd64 --build-arg GIT_SHA=${SHA} -t ${REPO}:${SHA} .`)
    expect(c).toContain(`docker push ${REPO}:${SHA}`)
    expect(c.some((l) => l.startsWith('docker login --username AWS --password-stdin'))).toBe(true)

    const pinned = `${REPO}@${DIGEST}`
    expect(registered('chore-scout-api').containerDefinitions[0].image).toBe(pinned)
    expect(registered('chore-scout-migrate').containerDefinitions[0].image).toBe(pinned)
    expect(registered('chore-scout-migrate').containerDefinitions[0].command).toEqual(['node', 'dist/migrate-main.js'])

    const runTask = c[idx(/ecs run-task/)]!
    expect(runTask).toContain('--task-definition arn:aws:ecs:ap-southeast-2:932027117528:task-definition/chore-scout-migrate:7')
    expect(runTask).toContain(`--network-configuration ${JSON.stringify(NETCFG)}`)

    // Order: rollback read -> build -> register -> migrate -> wait stopped -> update -> stable wait.
    const order = [
      idx(/ecs describe-task-definition/),
      idx(/^docker build/),
      idx(/register-task-definition/),
      idx(/ecs run-task/),
      idx(/ecs wait tasks-stopped/),
      idx(/ecs update-service .*task-definition\/chore-scout-api:7/),
      idx(/ecs wait services-stable --cluster moroku-dsl-dev --services chore-scout-api/),
    ]
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)

    expect(r.stdout).toContain(`sha: ${SHA}`)
    expect(r.stdout).toContain(`digest: ${DIGEST}`)
    expect(r.stdout).toContain('task definition (api): arn:aws:ecs:ap-southeast-2:932027117528:task-definition/chore-scout-api:7')
    expect(r.stdout).toContain('migrate exit code: 0')
    expect(r.stdout).toContain('stable wait: passed (desired 1)')
    expect(r.stdout).toContain(`rollback digest: ${PREV_DIGEST}`)
    expect(r.stdout).toContain(`rollback task definition: ${PREV_TD}`)
  })

  it('fails on a non-zero migration exit and does not update the service', async () => {
    const r = await deploy(SHA, { STUB_MIGRATE_EXIT: '1' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('migrate task exit code 1')
    expect(r.stdout).toContain('migrate exit code: 1')
    expect(calls().some((l) => l.includes('update-service'))).toBe(false)
  })

  it('fails when the migrate task never reports an exit code', async () => {
    const r = await deploy(SHA, { STUB_MIGRATE_EXIT: 'null' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('migrate task exit code none')
    expect(calls().some((l) => l.includes('update-service'))).toBe(false)
  })

  it('fails when the migrate task does not stop in time', async () => {
    const r = await deploy(SHA, { STUB_TASKS_STOPPED_RC: '255' })
    expect(r.status).not.toBe(0)
    expect(calls().some((l) => l.includes('update-service'))).toBe(false)
  })

  it('fails the job when the service does not become stable, printing the rollback', async () => {
    const r = await deploy(SHA, { STUB_STABLE_RC: '255' })
    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain('stable wait: FAILED (desired 1)')
    expect(r.stderr).toContain(`--task-definition ${PREV_TD}`)
  })

  it('skips the stable wait only when desiredCount is 0', async () => {
    const r = await deploy(SHA, { STUB_SERVICES_JSON: activeService(0), STUB_DESIRED: '0' })
    expect(r.status).toBe(0)
    expect(calls().some((l) => l.includes('services-stable'))).toBe(false)
    expect(r.stdout).toContain('stable wait: not needed (desired 0, nothing started)')
  })

  it('reuses an image already pushed for this SHA (immutable tag) without rebuilding', async () => {
    const r = await deploy(SHA, { STUB_IMAGE_EXISTS: '1' })
    expect(r.status).toBe(0)
    expect(calls().some((l) => /^docker (build|push)/.test(l))).toBe(false)
    expect(registered('chore-scout-api').containerDefinitions[0].image).toBe(`${REPO}@${DIGEST}`)
  })

  it('refuses a pushed image whose digest cannot be resolved', async () => {
    const r = await deploy(SHA, { STUB_DIGEST: 'None' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('not an image digest')
    expect(calls().some((l) => l.includes('register-task-definition'))).toBe(false)
  })

  it('fails when register-task-definition fails, before any migration or update', async () => {
    const r = await deploy(SHA, { STUB_REGISTER_RC: '254' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('register-task-definition failed')
    expect(calls().some((l) => /run-task|update-service/.test(l))).toBe(false)
  })

})

describe('deploy.sh agreed network configuration (D48 as amended)', () => {
  const vpc = (over: Record<string, unknown>) => ({ awsvpcConfiguration: { subnets: ['subnet-0aaa'], ...over } })
  const nothingChanged = () => {
    const c = calls()
    expect(c.some((l) => /^docker /.test(l))).toBe(false)
    expect(c.some((l) => /ecr get-login-password|register-task-definition|run-task|update-service/.test(l))).toBe(false)
  }

  it('passes with assignPublicIp ENABLED and the single security group chore-scout-server-sg', async () => {
    const r = await deploy(SHA, {
      STUB_SERVICES_JSON: activeService(1, 'ACTIVE', vpc({ securityGroups: ['sg-0ccc'], assignPublicIp: 'ENABLED' })),
    })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const c = calls()
    const lookup = c.findIndex((l) => l === 'aws ec2 describe-security-groups --group-ids sg-0ccc --region ap-southeast-2 --query SecurityGroups[0].GroupName --output text')
    expect(lookup).toBeGreaterThanOrEqual(0)
    expect(lookup).toBeLessThan(c.findIndex((l) => l.startsWith('docker build')))
    expect(r.stdout).toContain('Network: public IP ENABLED, security group sg-0ccc (chore-scout-server-sg)')
    expect(c.some((l) => l.includes('update-service'))).toBe(true)
  })

  it.each([
    ['DISABLED', vpc({ securityGroups: ['sg-0ccc'], assignPublicIp: 'DISABLED' }), 'assignPublicIp ENABLED (D48 as amended), got DISABLED'],
    ['missing', vpc({ securityGroups: ['sg-0ccc'] }), 'assignPublicIp ENABLED (D48 as amended), got absent'],
  ])('fails when assignPublicIp is %s, before any change', async (_l, netcfg, msg) => {
    const r = await deploy(SHA, { STUB_SERVICES_JSON: activeService(1, 'ACTIVE', netcfg) })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(msg)
    expect(calls().some((l) => l.includes('describe-security-groups'))).toBe(false)
    nothingChanged()
  })

  it.each([
    ['two', ['sg-0ccc', 'sg-0ddd'], 'got 2'],
    ['zero', [], 'got 0'],
    ['no list of', undefined, 'got 0'],
  ])('fails with %s security groups, before any change', async (_l, groups, msg) => {
    const netcfg = vpc(groups === undefined ? { assignPublicIp: 'ENABLED' } : { securityGroups: groups, assignPublicIp: 'ENABLED' })
    const r = await deploy(SHA, { STUB_SERVICES_JSON: activeService(1, 'ACTIVE', netcfg) })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(`exactly one security group (chore-scout-server-sg), ${msg}`)
    nothingChanged()
  })

  it.each(['default', 'odyssey-demo-sg', 'chore-scout-server-sg-old', 'CHORE-SCOUT-SERVER-SG'])(
    'fails when the single security group is named %s, before any change',
    async (name) => {
      const r = await deploy(SHA, { STUB_SG_NAME: name })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain(`security group sg-0ccc is '${name}', expected chore-scout-server-sg`)
      nothingChanged()
    },
  )

  it('fails when the security group cannot be resolved, before any change', async () => {
    const r = await deploy(SHA, { STUB_SG_RC: '254' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('could not resolve security group sg-0ccc')
    nothingChanged()
  })

  it('fails on a malformed security group id without calling EC2', async () => {
    const r = await deploy(SHA, {
      STUB_SERVICES_JSON: activeService(1, 'ACTIVE', vpc({ securityGroups: ['sg-0ccc --dry-run'], assignPublicIp: 'ENABLED' })),
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('security group id is malformed')
    expect(calls().some((l) => l.includes('describe-security-groups'))).toBe(false)
    nothingChanged()
  })

  it('the expected values are set once, by name, in deploy.sh', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    expect(src.match(/^EXPECTED_ASSIGN_PUBLIC_IP=ENABLED$/gm)).toHaveLength(1)
    expect(src.match(/^EXPECTED_SECURITY_GROUP_NAME=chore-scout-server-sg$/gm)).toHaveLength(1)
    // Used only through the settings: no other literal comparison against the values.
    expect(src.match(/== *"?(ENABLED|DISABLED)"?/g)).toBeNull()
    expect(src.split('\n').filter((l) => l.includes('chore-scout-server-sg') && !l.trimStart().startsWith('#'))).toEqual([
      'EXPECTED_SECURITY_GROUP_NAME=chore-scout-server-sg',
    ])
  })
})

describe('deploy.sh bootstrap is opt-in (CS-3992 R2)', () => {
  const nothingChanged = () => {
    const c = calls()
    expect(c.some((l) => /^docker (build|push)/.test(l))).toBe(false)
    expect(c.some((l) => /register-task-definition|run-task|update-service/.test(l))).toBe(false)
  }

  it('without bootstrap, a MISSING service fails the run and changes nothing', async () => {
    const r = await deploy(SHA, { STUB_SERVICES_JSON: missingService })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('does not exist')
    expect(r.stderr).toContain('bootstrap')
    nothingChanged()
  })

  it('with bootstrap and a MISSING service: registers both task definitions, warns, and deploys nothing', async () => {
    const summaryFile = join(dir, 'step-summary.md')
    const r = await deploy(SHA, { STUB_SERVICES_JSON: missingService, DEPLOY_BOOTSTRAP: '1', GITHUB_STEP_SUMMARY: summaryFile })
    expect(r.status).toBe(0)
    const c = calls()
    expect(c.some((l) => l.includes('register-task-definition'))).toBe(true)
    expect(c.some((l) => /run-task|update-service|describe-task-definition/.test(l))).toBe(false)
    expect(r.stdout).toMatch(/^::warning::BOOTSTRAP: .*nothing deployed, no migration/m)
    expect(r.stdout).toContain('migrate exit code: not run (bootstrap)')
    expect(r.stdout).toContain('BOOTSTRAP: create moroku-dsl-dev/chore-scout-api')
    expect(readFileSync(summaryFile, 'utf8')).toContain('BOOTSTRAP: nothing deployed, no migration')
  })

  it.each(['DRAINING', 'INACTIVE'])('a %s service always fails, with or without bootstrap', async (status) => {
    for (const b of ['0', '1']) {
      rmSync(join(dir, 'calls.log'), { force: true })
      const r = await deploy(SHA, { STUB_SERVICES_JSON: activeService(1, status), DEPLOY_BOOTSTRAP: b })
      expect(r.status, `bootstrap=${b}`).not.toBe(0)
      expect(r.stderr).toContain(`status is ${status}`)
      nothingChanged()
    }
  })

  it('an unrecognised describe-services answer fails, even with bootstrap', async () => {
    const r = await deploy(SHA, { STUB_SERVICES_JSON: JSON.stringify({ services: [], failures: [] }), DEPLOY_BOOTSTRAP: '1' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('status is UNKNOWN')
    nothingChanged()
  })

  it('bootstrap against an ACTIVE service fails and changes nothing', async () => {
    const r = await deploy(SHA, { DEPLOY_BOOTSTRAP: '1' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('bootstrap was requested but')
    nothingChanged()
  })

  it('a DEPLOY_BOOTSTRAP value other than 0 or 1 is refused before any call', async () => {
    const r = await deploy(SHA, { DEPLOY_BOOTSTRAP: 'true' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('DEPLOY_BOOTSTRAP must be 0 or 1')
    expect(calls()).toEqual([])
  })

  it('a normal run writes no bootstrap line to the job summary', async () => {
    const summaryFile = join(dir, 'step-summary.md')
    const r = await deploy(SHA, { GITHUB_STEP_SUMMARY: summaryFile })
    expect(r.status).toBe(0)
    const md = readFileSync(summaryFile, 'utf8')
    expect(md).toContain(`- sha: ${SHA}`)
    expect(md).not.toContain('BOOTSTRAP')
  })
})
