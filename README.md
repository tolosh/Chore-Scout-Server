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
| `src/config.ts`, `src/secrets.ts` | Config from the environment or the secrets store; fails closed |
| `src/app.ts`, `src/main.ts` | API process: `/health` (reports the git SHA), `/ready` (database ping), correlation ids |
| `src/jobs/`, `src/jobs-main.ts` | Single-runner job host (lease lock). No jobs registered yet: the allowance job is CS-3979 |
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
- See `.env.example` for every key.

## Images and deploys

CI builds `chore-scout-server:<commit SHA>`. There are no mutable tags. Deploys must pin the image by digest. Hosting is undecided (owner gap G3), so CI pushes nothing and deploys nothing. The registry push is a disabled step in `.github/workflows/ci.yml`.
