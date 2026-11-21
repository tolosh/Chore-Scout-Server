/**
 * Jobs container health check (CS-3992): `node dist/jobs-healthcheck.js`, run by
 * ECS (infra/ecs-task-definition.jobs.json). Exit 0 while the jobs loop has
 * touched its heartbeat within the allowed age, else 1, so ECS replaces a task
 * whose loop has hung. Reads no secrets: only JOB_TICK_INTERVAL_MS (default
 * 10000) to size the allowed age (3 ticks, at least 60 s).
 */
import { heartbeatFresh } from './jobs/heartbeat.js'

const tick = Number(process.env.JOB_TICK_INTERVAL_MS ?? '10000')
const maxAgeMs = Math.max(60_000, 3 * (Number.isFinite(tick) && tick > 0 ? tick : 10_000))
process.exit(heartbeatFresh(maxAgeMs) ? 0 : 1)
