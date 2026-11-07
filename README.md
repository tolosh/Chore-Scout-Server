# Chore Scout server

Chore Scout 3.0 product server: family set-up records, allowance set-up and the per-cycle decision, jobs and approvals, the unsplit ledger, held-Give review, teen-mode grants and the change feed. BOB owns identity, sessions and money. This server never decides banking access, and it never moves money except under a person's session or a recorded standing authority.

- Spec: Confluence 3220570116 (Server and DSL Integration Specification). Identity model: 3220897793.
- This scaffold: Jira CS-3941. Feature work starts at CS-3942.

## Stack

The spec names Node/TypeScript, MongoDB and in-memory database tests. Where it is silent, this repo follows BOB and the DSL: TypeScript (ESM, NodeNext), Fastify, the MongoDB driver used against DocumentDB 5.0, vitest and ESLint (as the DSL uses), and zod for config.

## Layout

| Path | What |
| --- | --- |
| `schema/chorescout.v1.graphql` | The versioned GraphQL contract, exposed through the DSL (CS-3935) |
| `scripts/schema-compat.ts` | CI check: no breaking change to a published `vN` without a new `vN+1` file |
| `src/graphql/` | `POST /graphql`: the session check first, then the v1 schema's resolvers (CS-3942 onwards) |
| `src/identity/` | Principal, session-check port and cache (bob-session/1 §6), authorisation helpers (CS-3942) |
| `src/bob/` | BOB adapters, each written to a published BOB contract. Session check: bob-session/1, Confluence 3224666113. Family routes: bob-family/1, Confluence 3224731649 |
| `src/chores/`, `src/unsplit/` | Jobs and Guardian approvals, job pay under the Guardian's session (CS-3949); the unsplit ledger (CS-3949 credit, CS-3953 split) |
| `src/family-setup/` | Family set-up orchestration under the Guardian's session (CS-3948) |
| `src/config.ts`, `src/secrets.ts` | Config from the environment or the secrets store; fails closed |
| `src/app.ts`, `src/main.ts` | API process: `/health` (reports the git SHA), `/ready` (database ping), correlation ids |
| `src/healthcheck.ts` | Container health check: `/ready` via Node's fetch (CS-3992) |
| `scripts/deploy.sh`, `infra/` | Digest-pinned dev deploy and its task definitions and IAM JSON (CS-3992) |
| `src/jobs/`, `src/jobs-main.ts` | Single-runner job host (lease lock) and the scheduled allowance-cycle job (CS-3979), run by `npm run start:jobs` |
| `src/migrations/` | Collections and indexes for the spec §5 data model |
| `src/lease.ts` | Lease lock without upserts (DocumentDB E11000 finding) |

## Run locally

```sh
npm ci
npm run typecheck && npm run lint && npm test
npx tsx scripts/schema-compat.ts --base origin/main
```

Tests start an in-memory MongoDB. The first run downloads the pinned binary from fastdl.mongodb.org.

To run the API against a local MongoDB:

```sh
GIT_SHA=$(git rev-parse HEAD) MONGODB_URI=mongodb://localhost:27017 MONGODB_DB=chorescout npx tsx src/main.ts
```

## Configuration rules

- Secrets have no defaults in code. Without `GIT_SHA`, `MONGODB_URI` or `MONGODB_DB` every process exits with code 78.
- Set `CS_SECRETS_ID` to read a JSON secret from AWS Secrets Manager. A key set in both the environment and the secret is refused.
- The server holds no BOB teller credential and no blanket BOB credential. Any `*TELLER*` key, or any `BOB_*` key other than `BOB_ALLOWANCE_CREDENTIAL`, refuses start-up. `BOB_ALLOWANCE_CREDENTIAL` is required by the jobs process and refused by the API process.
- The jobs process also requires `BOB_API_URL` and `ALLOWANCE_TENANT_ID`, the BOB bank the allowance credential was issued for. The allowance job runs only that bank's children.
- Real clock only: there is no test-clock or time-offset setting, and any key that looks like one refuses start-up in every process.
- `BOB_API_URL` is the one non-credential `BOB_*` key. It is refused if it carries userinfo, a query or a fragment. Without it the API starts, but every GraphQL request gets 503 `UPSTREAM_UNAVAILABLE`.
- See `.env.example` for every key.

## Sessions (CS-3942)

The DSL forwards each person's BOB access token unchanged as `Authorization: Bearer <token>` on `POST /graphql`. Before parsing or executing anything, the server asks BOB `GET /api/v1/auth/session` with that same token (contract `bob-session/1`, Confluence 3224666113):

- no or malformed header, BOB 401 or 429: HTTP 401 `UNAUTHENTICATED`;
- BOB 5xx, a timeout, or an answer outside the contract: HTTP 503 `UPSTREAM_UNAVAILABLE` (fail closed, no fallback);
- otherwise the operation runs as that person.

A successful answer is cached in process memory only, keyed by the token's SHA-256, for at most 30 seconds from BOB's `checked_at` (and of our own clock), and never past the token's `access_expires_at`. Failures are never cached, and a 401 from any BOB route drops the entry. Family scope is BOB's `children` list (Guardian) or the child's own id, never the `families` table or a client-supplied id. The token is never logged; log lines carry BOB's `session_id` and `customer_id`. Introspection is refused in production.

## Allowance job (CS-3979)

The jobs process runs one scheduled job, `allowance-cycles`, as the holder of the `scheduler` lease, on the real clock. Every allowance week runs Monday 00:00 to Monday 00:00 Australia/Sydney (D55), so each week's cut-off is the next Monday 00:00 Sydney. On each tick the job:

- takes every cycle of the credential's bank whose cut-off has passed and that has no final record, from the rule's first effective period onwards, and runs it through `AllowanceCycleService`: one recorded decision per cycle key, and on PAY one BOB execution (bob-family/1 §7.5) with key `cs:<cycleKey>:allowance` for exactly the rule's amount;
- never decides a week before its cut-off, never creates a cycle before the rule's start date or its `effectiveFrom`, and pays a cycle missed during an outage once, at its own amount, logging it as late;
- claims a cycle before its BOB call, so two runners never send the same instruction at once, and checks it still holds the lease before each cycle;
- re-sends an unknown outcome with the original key only, no sooner than a minute after the last attempt; records BOB's refusals (revoked authority, amount not authorised, ...) as FAILED, without retrying them;
- holds a cycle for an operator after repeated answers that don't match what was asked: audited, logged at error level, and not re-sent.

While a decided payment is unsettled, `setAllowance` refuses a change to the mode, amount, split or source account (NOT_ALLOWED_IN_STATE), so the payment always settles under the rule it was decided on.

Deploying the jobs process as its own ECS service is separate work.

## Images and deploys

CI (`.github/workflows/ci.yml`) builds `chore-scout-server:<full commit SHA>` on every PR and on `main`, smoke-tests it, and pushes and deploys nothing. There are no mutable tags.

Deploys are manual: **Actions -> deploy -> Run workflow** on `main` (`.github/workflows/deploy.yml`, CS-3992). The workflow reruns the CI checks (typecheck, lint, test, schema check) on the exact commit. The deploy job runs only on `main` and only when the repo variable `AWS_DEPLOY_ROLE_ARN` is set; until then it is skipped. It assumes `chore-scout-server-github-deploy` through GitHub OIDC, so nobody holds long-lived AWS keys. The workflow grants `contents: read`; only the deploy job also gets `id-token: write`, so the verify job (npm ci, tests) cannot mint a token.

`scripts/deploy.sh <full SHA>` does the work, in this order:

1. Refuses anything but the full 40-character SHA of the checked-out commit.
2. Requires the service to be ACTIVE with the agreed network configuration (below), reads its current task definition and records the **rollback image by digest**. A tag there is refused before anything changes.
3. Builds for `linux/amd64` with `--build-arg GIT_SHA`, pushes `:<SHA>` to the immutable ECR repo `chore-scout-server`, and resolves the digest. A SHA already pushed is reused.
4. Registers `chore-scout-api` and `chore-scout-migrate` pinned to `repo@sha256:...`.
5. Runs the one-shot migrate task (`node dist/migrate-main.js`) on the service's own subnets and security group, waits for it to stop, and fails on any exit code but 0. The service is not touched on failure.
6. Updates `moroku-dsl-dev/chore-scout-api`, and runs `aws ecs wait services-stable` whenever the desired count is above 0. A failed wait fails the job and prints the rollback command.
7. Prints the summary: SHA, digest, task definitions, migrate exit code, stable wait, rollback digest and rollback task definition.

Any service state other than ACTIVE fails the run, with one opt-in exception for the very first run. Tick the workflow's **bootstrap** input (default off) while the service does not exist yet: the run is accepted only if the service is MISSING, pushes the image, registers both task definitions and stops. It deploys and migrates nothing, and says so as a `::warning::` and a "BOOTSTRAP: nothing deployed, no migration" line in the job summary. Create the service on the printed revision (runbook A6), then run the workflow again without bootstrap. DRAINING or INACTIVE always fail, and so does bootstrap against an ACTIVE service.

### Network (D48 as amended)

The VPC's private subnets have no NAT gateway, so `chore-scout-api` runs in the public subnets **with a public IP**, behind a firewall that admits only the DSL: `chore-scout-server-sg` allows inbound port 3000 from the DSL's security group and nothing else. There is still no public hostname, load balancer or URL. The DSL reaches the server through ECS Service Connect at `chore-scout-api:3000`. Production should move to private subnets with a NAT gateway (D47).

`deploy.sh` refuses to deploy unless the service has all of:

- `assignPublicIp` equal to `EXPECTED_ASSIGN_PUBLIC_IP` (`ENABLED`);
- exactly one security group;
- that group's name, resolved with `ec2:DescribeSecurityGroups`, equal to `EXPECTED_SECURITY_GROUP_NAME` (`chore-scout-server-sg`).

Both expected values are set once, at the top of `scripts/deploy.sh`. A public IP is therefore never accepted with any other firewall. The check runs before anything is built or changed, and the migrate task uses the same networking. A bootstrap run has no service yet, so there is nothing to check; the first full deploy after A6 checks it.

### `infra/`

| Path | What |
| --- | --- |
| `infra/ecs-task-definition.api.json` | API task definition template: Fargate, awsvpc, port 3000 (Service Connect port name `chore-scout-api`), `CS_SECRETS_ID=chore-scout-server/api`, awslogs to `/ecs/chore-scout-server`, health check `node dist/healthcheck.js` |
| `infra/ecs-task-definition.migrate.json` | Migrate task definition template: same image and secret, `node dist/migrate-main.js` |
| `infra/iam/task-role-policy.json` | `chore-scout-server-task-role`: read `chore-scout-server/api` only, and ECS Exec. No logs permissions: the awslogs driver writes with the execution role |
| `infra/iam/execution-role-policy.json` | `chore-scout-server-execution-role`: pull from `chore-scout-server` only, write logs |
| `infra/iam/ecs-tasks-trust-policy.json` | Trust policy for both runtime roles (`ecs-tasks.amazonaws.com`, this account only) |
| `infra/iam/deploy-role-policy.json` | `chore-scout-server-github-deploy`: one ECR repo, one service, RunTask for the migrate family in `moroku-dsl-dev` only, PassRole for the two server roles to `ecs-tasks.amazonaws.com` only, and read-only `ec2:DescribeSecurityGroups` for the network check |
| `infra/iam/deploy-role-trust-policy.json` | GitHub OIDC trust, `StringEquals` on audience `sts.amazonaws.com` and subject `repo:tolosh@9541661/Chore-Scout-Server@1442469518:ref:refs/heads/main` |

The subject uses GitHub's immutable format (owner and repo ids) and the repo's canonical casing, `Chore-Scout-Server`. Both were confirmed from a real token's claims (CS-3992 probe, actions run 41813888223). `StringEquals` is case-sensitive, so `repo:tolosh/chore-scout-server:...` would never match.

The templates hold no secrets. The image placeholder is replaced with the digest at deploy time. `"*"` resources appear only where the AWS API has no resource-level permission: `ecr:GetAuthorizationToken`, `ecs:RegisterTaskDefinition`, `ecs:DescribeTaskDefinition`, `ec2:DescribeSecurityGroups` and `ssmmessages`. `ec2:DescribeSecurityGroups` is read-only and cannot be scoped to a resource; it is the deploy role's only EC2 action. `ecs:DescribeTasks` is limited to tasks in `moroku-dsl-dev`; a task ARN does not carry its family, so it cannot be narrowed further.

### DocumentDB TLS and the health check

The image carries the RDS global CA bundle at `/app/certs/rds-global-bundle.pem`, fetched at build time and checked against a SHA-256 pinned in the `Dockerfile`. The task definitions set `MONGODB_TLS_CA_FILE` to that path, which turns TLS on in `src/db.ts`. If AWS changes the bundle, the build fails until the pin is reviewed and updated.

The image has no curl. The container health check (`src/healthcheck.ts`, run as `node dist/healthcheck.js`) calls `/ready` with Node's fetch, so a task whose database is unreachable reports UNHEALTHY.
