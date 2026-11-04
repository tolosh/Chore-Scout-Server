/**
 * Container health check (CS-3992).
 *
 * Run by ECS (infra/ecs-task-definition.api.json) and by the Dockerfile
 * HEALTHCHECK as `node dist/healthcheck.js`. The image has no curl, so this
 * uses Node's built-in fetch. It calls /ready, which pings the database, so a
 * task whose database is unreachable reports UNHEALTHY.
 *
 * Exit 0 only on a 2xx from /ready. Any other status, a refused connection or
 * a timeout exits 1. It reads no configuration or secrets: only PORT (the
 * port the API listens on, default 3000) and an optional timeout.
 */
const port = Number(process.env.PORT ?? '3000')
const timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS ?? '4000')

try {
  const res = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(timeoutMs) })
  process.exit(res.ok ? 0 : 1)
} catch {
  process.exit(1)
}
