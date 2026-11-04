/**
 * CS-3992: static checks on infra/ (task definitions and IAM JSON) and the
 * Dockerfile's CA bundle pin. Test 4 (policy review against the runbook) is a
 * human review; these checks hold the parts of it that can be automated.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { forbiddenCredentialKeys } from '../src/config.js'

const ACCOUNT = '932027117528'
const REGION = 'ap-southeast-2'
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

interface Statement {
  Sid: string
  Effect: string
  Action: string | string[]
  Resource: string | string[]
  Condition?: Record<string, Record<string, string>>
}
const list = <T>(v: T | T[]) => (Array.isArray(v) ? v : [v])
const statements = (p: string): Statement[] => json(p).Statement

// The only actions allowed on Resource "*": the AWS API offers no resource-level permission for them.
const WILDCARD_OK = new Set([
  'ecr:GetAuthorizationToken',
  'ecs:RegisterTaskDefinition',
  'ecs:DescribeTaskDefinition',
  'ssmmessages:CreateControlChannel',
  'ssmmessages:CreateDataChannel',
  'ssmmessages:OpenControlChannel',
  'ssmmessages:OpenDataChannel',
])

const POLICIES = ['infra/iam/task-role-policy.json', 'infra/iam/execution-role-policy.json', 'infra/iam/deploy-role-policy.json']
const TASK_DEFS = {
  api: 'infra/ecs-task-definition.api.json',
  migrate: 'infra/ecs-task-definition.migrate.json',
} as const

describe('IAM policies (CS-3992)', () => {
  it.each(POLICIES)('%s: Allow only, no wildcard actions, "*" resources only where the API requires it', (p) => {
    for (const s of statements(p)) {
      expect(s.Effect).toBe('Allow')
      for (const a of list(s.Action)) expect(a).not.toContain('*')
      for (const r of list(s.Resource)) {
        if (r === '*') for (const a of list(s.Action)) expect(WILDCARD_OK.has(a), `${s.Sid}: ${a} on *`).toBe(true)
        else expect(r).toContain(ACCOUNT)
      }
    }
  })

  it('task role reads only chore-scout-server/api and writes only its own log group', () => {
    const s = statements('infra/iam/task-role-policy.json')
    const secrets = s.filter((x) => list(x.Action).some((a) => a.startsWith('secretsmanager:')))
    expect(secrets.flatMap((x) => list(x.Action))).toEqual(['secretsmanager:GetSecretValue'])
    expect(secrets.flatMap((x) => list(x.Resource))).toEqual([
      `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:chore-scout-server/api-??????`,
    ])
    const logs = s.filter((x) => list(x.Action).some((a) => a.startsWith('logs:')))
    expect(logs.flatMap((x) => list(x.Resource))).toEqual([`arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/ecs/chore-scout-server:*`])
  })

  it('execution role pulls only from chore-scout-server and reads no secrets', () => {
    const s = statements('infra/iam/execution-role-policy.json')
    expect(s.some((x) => list(x.Action).some((a) => a.startsWith('secretsmanager:')))).toBe(false)
    const ecr = s.filter((x) => list(x.Resource).some((r) => r.includes(':repository/')))
    expect(ecr.flatMap((x) => list(x.Resource))).toEqual([`arn:aws:ecr:${REGION}:${ACCOUNT}:repository/chore-scout-server`])
  })

  it('deploy role: one repo, one service, the migrate family, PassRole to ECS tasks for the two server roles', () => {
    const s = statements('infra/iam/deploy-role-policy.json')
    const resourcesFor = (action: string) => s.filter((x) => list(x.Action).includes(action)).flatMap((x) => list(x.Resource))

    expect(resourcesFor('ecr:PutImage')).toEqual([`arn:aws:ecr:${REGION}:${ACCOUNT}:repository/chore-scout-server`])
    expect(resourcesFor('ecs:UpdateService')).toEqual([`arn:aws:ecs:${REGION}:${ACCOUNT}:service/moroku-dsl-dev/chore-scout-api`])
    expect(resourcesFor('ecs:RunTask')).toEqual([`arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/chore-scout-migrate:*`])
    const runTask = s.find((x) => list(x.Action).includes('ecs:RunTask'))!
    expect(runTask.Condition).toEqual({ ArnEquals: { 'ecs:cluster': `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/moroku-dsl-dev` } })
    expect(resourcesFor('ecs:DescribeTasks')).toEqual([`arn:aws:ecs:${REGION}:${ACCOUNT}:task/moroku-dsl-dev/*`])

    const pass = s.filter((x) => list(x.Action).includes('iam:PassRole'))
    expect(pass).toHaveLength(1)
    expect(list(pass[0]!.Resource).sort()).toEqual([
      `arn:aws:iam::${ACCOUNT}:role/chore-scout-server-execution-role`,
      `arn:aws:iam::${ACCOUNT}:role/chore-scout-server-task-role`,
    ])
    expect(pass[0]!.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } })

    const forbidden = ['ecs:CreateService', 'ecs:DeleteService', 'ecs:StopTask', 'iam:CreateRole', 'secretsmanager:GetSecretValue']
    for (const a of forbidden) expect(resourcesFor(a)).toEqual([])
  })

  it('deploy role trust: GitHub OIDC, this repo, main only', () => {
    const [t, ...rest] = statements('infra/iam/deploy-role-trust-policy.json') as unknown as Array<{
      Principal: { Federated: string }
      Action: string
      Condition: Record<string, Record<string, string>>
    }>
    expect(rest).toHaveLength(0)
    expect(t!.Principal.Federated).toBe(`arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`)
    expect(t!.Action).toBe('sts:AssumeRoleWithWebIdentity')
    expect(t!.Condition).toEqual({
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': 'repo:tolosh/chore-scout-server:ref:refs/heads/main',
      },
    })
  })
})

describe('task definition templates (CS-3992)', () => {
  it.each(Object.entries(TASK_DEFS))('%s: Fargate awsvpc, the two roles, placeholder image, no secrets inline', (_k, p) => {
    const td = json(p)
    expect(td.networkMode).toBe('awsvpc')
    expect(td.requiresCompatibilities).toEqual(['FARGATE'])
    expect(td.executionRoleArn).toBe(`arn:aws:iam::${ACCOUNT}:role/chore-scout-server-execution-role`)
    expect(td.taskRoleArn).toBe(`arn:aws:iam::${ACCOUNT}:role/chore-scout-server-task-role`)
    expect(td.containerDefinitions).toHaveLength(1)
    const c = td.containerDefinitions[0]
    expect(c.image).toBe('__IMAGE_PINNED_AT_DEPLOY__')
    expect(c.secrets).toBeUndefined()
    const env = Object.fromEntries(c.environment.map((e: { name: string; value: string }) => [e.name, e.value]))
    expect(env).toMatchObject({
      CS_SECRETS_ID: 'chore-scout-server/api',
      MONGODB_DB: 'chorescout',
      MONGODB_TLS_CA_FILE: '/app/certs/rds-global-bundle.pem',
      AWS_REGION: REGION,
    })
    // Secrets come only from the secrets store; no BOB credential slot in the environment.
    for (const k of ['MONGODB_URI', 'GIT_SHA', 'BOB_ALLOWANCE_CREDENTIAL']) expect(env[k]).toBeUndefined()
    expect(forbiddenCredentialKeys(env)).toEqual([])
    expect(c.logConfiguration.logDriver).toBe('awslogs')
    expect(c.logConfiguration.options['awslogs-group']).toBe('/ecs/chore-scout-server')
  })

  it('api: family, port 3000, health check is node dist/healthcheck.js (/ready)', () => {
    const td = json(TASK_DEFS.api)
    expect(td.family).toBe('chore-scout-api')
    const c = td.containerDefinitions[0]
    expect(c.name).toBe('chore-scout-api')
    expect(c.portMappings).toEqual([{ name: 'chore-scout-api', containerPort: 3000, protocol: 'tcp', appProtocol: 'http' }])
    expect(c.healthCheck.command).toEqual(['CMD', 'node', 'dist/healthcheck.js'])
    expect(c.healthCheck.timeout).toBeGreaterThanOrEqual(5)
  })

  it('migrate: family and command, no ports', () => {
    const td = json(TASK_DEFS.migrate)
    expect(td.family).toBe('chore-scout-migrate')
    const c = td.containerDefinitions[0]
    expect(c.name).toBe('chore-scout-migrate')
    expect(c.command).toEqual(['node', 'dist/migrate-main.js'])
    expect(c.portMappings).toBeUndefined()
  })
})

describe('Dockerfile CA bundle (CS-3992)', () => {
  it('fetches the RDS global bundle into the path the task definitions use, verified by a pinned SHA-256', () => {
    const d = readFileSync('Dockerfile', 'utf8')
    expect(d).toContain('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem')
    expect(d).toContain('/app/certs/rds-global-bundle.pem')
    expect(d).toContain('COPY --from=build /app/certs ./certs')
    expect(d).toMatch(/pinned="[0-9a-f]{64}"/)
    expect(d).toContain('CMD ["node", "dist/healthcheck.js"]')
  })
})
