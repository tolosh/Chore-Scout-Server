/**
 * Alert and heartbeat markers on the jobs process's structured logs (CS-3979;
 * review 40015 optional 2 and 3, review 40503 item 6).
 *
 * Each is a stable `alert` (or `event`) field on one JSON log line, so a log
 * metric filter can count it without parsing messages, for example
 * `{ $.alert = "ALLOWANCE_MISSED_RUN" }`. The metric filters, alarms and their
 * owner are deployment work (CS-3992); this file only fixes the names.
 *
 * - ALLOWANCE_TICK (event): one per completed tick of a bank's leader. Its
 *   absence for longer than a few tick intervals means no runner is paying that
 *   bank's allowances promptly, which the no-backfill condition depends on.
 * - ALLOWANCE_MISSED_RUN: a cycle was decided after a later week had already
 *   ended, so a run was missed (an outage).
 * - ALLOWANCE_UNEXPECTED_FAILED: BOB refused a PAY with anything but
 *   AUTHORITY_REVOKED (for example NOT_FOUND or FORBIDDEN from a wrong-bank
 *   credential, or INSUFFICIENT_FUNDS). Recorded FAILED and not retried, so it
 *   would otherwise be silent.
 * - ALLOWANCE_OPERATOR_HOLD: a cycle was held after repeated mismatched answers.
 * - ALLOWANCE_CYCLE_ERROR: a cycle threw (database or programming error); it is
 *   retried next tick.
 * - ALLOWANCE_LEASE_LOST: a leader lost its bank's lease mid-tick and stopped.
 * - JOB_FAILED: a registered job threw out of its run.
 * - ALLOWANCE_HOLD_RECHECKED: an operator rechecked a held cycle (jobs-recover);
 *   counted for visibility, not an alarm on its own.
 */
export const ALLOWANCE_TICK_EVENT = 'ALLOWANCE_TICK'

export const ALERT = {
  MISSED_RUN: 'ALLOWANCE_MISSED_RUN',
  UNEXPECTED_FAILED: 'ALLOWANCE_UNEXPECTED_FAILED',
  OPERATOR_HOLD: 'ALLOWANCE_OPERATOR_HOLD',
  CYCLE_ERROR: 'ALLOWANCE_CYCLE_ERROR',
  LEASE_LOST: 'ALLOWANCE_LEASE_LOST',
  JOB_FAILED: 'JOB_FAILED',
  HOLD_RECHECKED: 'ALLOWANCE_HOLD_RECHECKED',
} as const

/** BOB refusals that are an expected product outcome, not an alert. */
export const EXPECTED_FAILED_REASONS: ReadonlySet<string> = new Set(['AUTHORITY_REVOKED'])
