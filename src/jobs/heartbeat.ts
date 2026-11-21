/**
 * Liveness of the jobs process loop (CS-3992). The loop touches this file after
 * every tick, leader or not, so the container health check
 * (src/jobs-healthcheck.ts) can tell a live loop from a hung one. It says
 * nothing about payments: the ALLOWANCE_TICK alarm covers that (alerts.ts).
 */
import { statSync, writeFileSync } from 'node:fs'

export const HEARTBEAT_FILE = '/tmp/chore-scout-jobs.heartbeat'

export function touchHeartbeat(path = HEARTBEAT_FILE, now = new Date()): void {
  writeFileSync(path, now.toISOString())
}

/** True when the heartbeat was touched within `maxAgeMs` of `now`. A missing file is not fresh. */
export function heartbeatFresh(maxAgeMs: number, path = HEARTBEAT_FILE, now = Date.now()): boolean {
  try {
    return now - statSync(path).mtimeMs <= maxAgeMs
  } catch {
    return false
  }
}
