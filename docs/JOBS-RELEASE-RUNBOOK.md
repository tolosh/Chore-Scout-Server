# Allowance jobs: deploy, stop, recover and activate (CS-3979, CS-3992, CS-3970)

Operator: Colin (AWS operator, CS-3992 / CS-3994). Account `932027117528`, region `ap-southeast-2`, cluster `moroku-dsl-dev`.
Nothing in this file authorises a merge, deployment, credential issue or activation. Each step is run only when its gate below has passed and the release owner has approved that step.

**Rule zero: deploying jobs is not activating them.** Every jobs service is created and deployed at **desired count 0**. No step before J7 starts a jobs task. The deploy script never sets a desired count, and it refuses a running jobs service unless explicitly acknowledged.

## Where this sits in the release sequence (CS-3970 review 40505)

| 40505 step | What | Jobs runbook |
| --- | --- | --- |
| A | Accepted candidates, isolated evidence, BOB readiness checked route by route | J1 |
| B | Locked DSL deploys (PR20, then PR23), independent of the server | none (no jobs dependency) |
| C | Server API deploy of the accepted SHA, with migrations (includes `002-cycle-child-status`) | J1 (prerequisite) |
| D | Jobs artifacts provisioned at desired 0 against persistent data | J2 to J6 |
| E | Unlock and jobs start / family activation: separate later gates | J7 |

The jobs process calls BOB route 7.5 directly with its bank's allowance credential. It does not go through the DSL, so the DSL lock does not affect it. The DSL lock is also not a reason to start jobs.

## J0. Stop rule (any step)

Stop and record evidence on CS-3979 / CS-3992 if any of these happens:
- a check fails;
- a SHA or digest is not the accepted one;
- a jobs service shows desired > 0 before J7;
- any `ALLOWANCE_*` alarm fires unexpectedly;
- BOB shows an allowance execution the server cannot account for.

To stop jobs: `aws ecs update-service --cluster moroku-dsl-dev --service chore-scout-jobs-<bank> --desired-count 0 --region ap-southeast-2`, then follow J8. Stopping does not cancel a BOB call already in flight.

## J1. Prerequisites (read-only checks, recorded with time and observer)

1. **Exact candidate.** The independently accepted server SHA (full 40 characters). API and jobs run the same image digest.
2. **API deployed at that SHA (step C).** The API deploy (`target: api`) ran migrate with exit 0. Check:
   `aws ecs describe-services --cluster moroku-dsl-dev --services chore-scout-api --region ap-southeast-2 --query 'services[0].{td:taskDefinition,desired:desiredCount,running:runningCount}'`
   Then `describe-task-definition` on that TD and confirm the image is `…/chore-scout-server@sha256:<digest>` for the SHA. `scripts/deploy-jobs.sh` refuses to run otherwise.
3. **Rollback schema compatibility.** Migration 002 only adds a non-unique index on `allowance_cycles` (`child_decision_status`). Older images ignore it. No migration in this candidate rewrites or removes data.
4. **BOB readiness, route by route** (BOB stream, not this repo), at BOB `204ceaaa4334f0fa4fdbd9a54fefce6669770602` or its accepted successor:
   - 7.1, 7.2, 7.3, 7.4 and 7.5 are registered in `src/bob/routes/standing-authorities.routes.ts`. The source at that SHA confirms this; hosted config evidence is still needed.
   - Per-bank allowance credential issuance and retirement tooling exists. **Gap: BOB has `AllowanceCredentialRepository.issue()` but no operator command yet.**
   - Single initiator. At `204ceaa`, `runBobMode` does not construct `ChoreScoutScheduler` (`src/server.ts`, CS-3958 note), and the class refuses Guardian-managed children. Verify the running BOB task's mode and entry point before J7 (CS-3972 owns removing the code).
5. **Inventory (operator, read-only):** `aws ecs list-services --cluster moroku-dsl-dev`. Record any existing jobs or scheduled tasks, and `aws events list-rules` / `aws scheduler list-schedules` for any standalone runner. AccessDenied is "unknown", not "absent".

## J2. IAM and network (once per bank; reviewed delta only)

- **Task role** `chore-scout-jobs-<bank>-task-role`, trusted by `infra/iam/ecs-tasks-trust-policy.json`. Its policy is `infra/iam/jobs-task-role-policy.json` with `__TENANT_ID__` replaced by the bank. That policy reads only `chore-scout-server/jobs-<bank>`: there is no ECS Exec and no other secret.
- **Execution role:** the existing `chore-scout-server-execution-role` (pull plus logs), unchanged.
- **Deploy role:** apply the updated `infra/iam/deploy-role-policy.json`. It adds DescribeServices/UpdateService on the two jobs services and PassRole for the two jobs task roles, and nothing that creates, starts, stops or scales a service.
- **Security group** `chore-scout-jobs-sg` in the cluster VPC:
  - **no inbound rules**;
  - outbound 443 to BOB (`bob.moroku.digital`) and 27017 to the DocumentDB cluster's security group;
  - add it to DocumentDB's inbound list.
  - It runs in the public subnets with a public IP (no NAT in dev, D48 as amended), the same as the API.

## J3. Credentials (per bank; secrets never printed)

1. BOB engineering supplies the reviewed issuance procedure. BOB issues one allowance credential per bank, keeps only its SHA-256, and returns the raw value exactly once.
2. The operator puts it straight into the secret `chore-scout-server/jobs-<bank>` as JSON with exactly two keys:
   - `MONGODB_URI` (the server database; the same cluster as the API);
   - `BOB_ALLOWANCE_CREDENTIAL`.
   Do not echo, paste or log the value.
3. **Rotation:** issue a new credential, update the secret, restart the jobs task (when running), then retire the old one in BOB. A retired credential gets 401 at once, and the cycle stays DECIDED and is retried with the original key.
4. The API secret `chore-scout-server/api` must not contain `BOB_ALLOWANCE_CREDENTIAL`. The API refuses to start if it does.
5. BOB's charity-routing keys (`odyssey-demo/charity-routing-keys`) are a different, BOB-owned secret. They never go in a jobs or DSL secret.

## J4. First run per bank: bootstrap, then create the service at desired 0

1. Run Actions -> deploy on `main` with `target: jobs-<bank>` and `bootstrap: true`. This is accepted only when the service is MISSING: it registers `chore-scout-jobs-<bank>` pinned by digest and stops.
2. Create the service **at desired 0** on the printed task definition:
   ```
   aws ecs create-service --cluster moroku-dsl-dev --service-name chore-scout-jobs-<bank> \
     --task-definition <printed TD ARN> --desired-count 0 --launch-type FARGATE \
     --network-configuration 'awsvpcConfiguration={subnets=[<api subnets>],securityGroups=[<chore-scout-jobs-sg id>],assignPublicIp=ENABLED}' \
     --deployment-configuration 'maximumPercent=100,minimumHealthyPercent=0' --region ap-southeast-2
   ```
   `maximumPercent=100` means a deploy never runs an old and a new task together. The lease would keep them single anyway, but this avoids a second runner.
3. Check: `describe-services` shows `desiredCount 0, runningCount 0`.

## J5. Deploy (every release after J4)

Run Actions -> deploy on `main` with `target: jobs-<bank>` (`bootstrap: false`, `jobs_running_ack: false`). `scripts/deploy-jobs.sh` then:
- refuses unless the API already runs this SHA's digest;
- reads the jobs service and records the rollback task definition and digest;
- checks the agreed networking;
- registers the bank's task definition and updates the service's task definition only;
- confirms the desired count did not change.

It prints a summary: bank, SHA, digest, task definition, desired count (unchanged), stable wait, and rollback digest and task definition. Copy it into the capture (J10).

## J6. Monitoring (per bank)

1. The alarm owner and their SNS topic are named by the release owner. **Gap: still unnamed.**
2. Dry run, review the output, then apply. `--with-heartbeat` is not used yet:
   ```
   scripts/jobs-alarms.sh <bank> arn:aws:sns:ap-southeast-2:932027117528:<topic>
   scripts/jobs-alarms.sh <bank> arn:aws:sns:ap-southeast-2:932027117528:<topic> --apply
   ```
3. This creates metric filters on `/ecs/chore-scout-server` for every marker in `src/jobs/alerts.ts`, plus the alarms:

   | Alarm | Fires on |
   | --- | --- |
   | missed-run | a cycle decided after a later week had already ended |
   | unexpected-failed | a FAILED other than `AUTHORITY_REVOKED` |
   | operator-hold | a cycle held for an operator |
   | cycle-error | a cycle threw |
   | lease-lost | 2 or more in 15 min |
   | job-failed | a registered job threw |

   The no-heartbeat alarm is created at J7, because while jobs are stopped it would always be in ALARM.

## J7. Activation (a separate gate; NOT part of any deploy)

Activation starts the bank's allowance payments on the real clock. It requires, recorded on the tickets:
- real bank and family access proven;
- BOB credential and reconciliation;
- one initiator (J1.4);
- full Giving: selection, future sweep, held-child confirmation, real payment and event, once-only recognition;
- alerts wired with an owner (J6);
- this runbook's stop/recovery rehearsed in the isolated environment;
- explicit before/after evidence.

No simulator reset, acceleration or backdating.

1. **Before:** capture J10's activation fields.
2. Apply the heartbeat alarm: `scripts/jobs-alarms.sh <bank> <topic> --with-heartbeat --apply`.
3. Start one runner:
   `aws ecs update-service --cluster moroku-dsl-dev --service chore-scout-jobs-<bank> --desired-count 1 --region ap-southeast-2`
   then `aws ecs wait services-stable …`. A second runner for failover is optional; the bank's lease keeps one leader.
4. **After:** capture J10 again. In the logs, confirm `job process started` with `lease: scheduler:allowance:<bank>`, and an `event: ALLOWANCE_TICK` heartbeat every tick from the leader.
5. On the first cut-off (Monday 00:00 Australia/Sydney), confirm one `allowance cycle executed` per due child and the matching BOB execution.
6. Later deploys of a running service need `jobs_running_ack: true`, as an approved release.

## J8. Stop, rollback and recovery

- **Stop:** desired 0 (J0). Then reconcile:
  - every cycle `DECIDED` with `decision PAY` is an unknown outcome. Read it with J9 diagnose;
  - after a restart the job re-sends the **original key** after `RETRY_AFTER_MS`, and BOB replays the stored answer;
  - never invent a replacement key or bulk-clear anything.
- **Rollback:** point the service at the recorded rollback task definition only after the migration-compatibility check (J1.3):
  `aws ecs update-service --cluster moroku-dsl-dev --service chore-scout-jobs-<bank> --task-definition <rollback TD> --region ap-southeast-2`
  This leaves the desired count unchanged. No database rollback or reset by assumption.
- **A failed stable wait on a running service:** scale to 0 first, then investigate. Never restore an older image just because it ran before.

## J9. Hold recovery (a cycle with `operatorHold`, alarm operator-hold)

The Guardian cannot change that child's allowance until the hold is resolved. Run a **one-off task** of the bank's jobs task definition. It holds that bank's credential only, and no ECS Exec is needed:

```
aws ecs run-task --cluster moroku-dsl-dev --task-definition chore-scout-jobs-<bank> --launch-type FARGATE \
  --network-configuration '<same as the service>' --region ap-southeast-2 \
  --overrides '{"containerOverrides":[{"name":"chore-scout-jobs","command":["node","dist/jobs-recover-main.js","--cycle","<childId>:<YYYY-MM-DD>","--operator","<name>","--reason","<why, 10 to 500 chars>"]}]}'
```

1. **Diagnose first** (no `--recheck`). The task prints one JSON line with the cycle record and its audit trail, and makes no BOB call.
2. Investigate with BOB why its answer disagreed: the asked/got record is in the `allowance.cycle_mismatch` audit entries.
3. When BOB confirms its record, run again with `--recheck`. This re-sends the **original key and amount once**, and BOB replays its stored answer. The outcome is one of:

   | Outcome | Exit code | What it means |
   | --- | --- | --- |
   | `RESOLVED_EXECUTED` | 0 | The answer now matches, or `CYCLE_ALREADY_PAID`. The hold is cleared. |
   | `RESOLVED_FAILED` | 0 | BOB returned a final refusal. The hold is cleared. |
   | `STILL_MISMATCHED` or `STILL_UNKNOWN` | 2 | The hold is kept. Escalate to BOB; do not retry blindly. |
   | `BUSY` | 2 | Another sender has the cycle claimed. Retry after 60 s. |
   | Refused | 3 | Not held, another bank's cycle, or unknown. |

4. There is no command to clear a hold, set an amount or choose a key. Every recheck is audited with the operator and reason (`allowance.cycle_hold_recheck`, `…_resolved` or `…_kept`).

## J10. Capture template (full identifiers only)

| Field | Before | After |
| --- | --- | --- |
| Server SHA (40 chars) | | |
| Image digest (`sha256:` + 64 hex) | | |
| API task definition and image | | |
| `chore-scout-jobs-bank_bilgola` task definition / desired / running | | |
| `chore-scout-jobs-bank_manly` task definition / desired / running | | |
| Rollback task definition and digest (from the deploy summary) | | |
| Stable wait | | |
| Alarms present (`aws cloudwatch describe-alarms --alarm-name-prefix chore-scout-jobs-`) | | |
| Activation fields: each jobs service's `desiredCount` and `runningCount` (jobs are activated only when > 0) | | |
| Observer, time (AEDT) and evidence class (engineering-reported, independently verified, unknown) | | |

## Isolated integration (before any of the above)

`integration/bob-local/run.sh <server SHA> <BOB repo> <BOB SHA>` runs the real `jobs-main` and `jobs-recover` against real BOB, on an internal-only Docker network on the real clock. It covers:
- one payment per cycle;
- missed-run catch-up;
- original-key retry after a lost answer;
- revocation;
- the exact amount;
- two banks and their leases;
- failover;
- hold and recovery;
- single initiator.

See the header of `integration/bob-local/harness.ts`. This is local evidence, not CS-3903's hosted rehearsal environment.
