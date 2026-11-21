/**
 * Operator recovery for one allowance cycle (CS-3979; review 40045 A3; review
 * 40503 item 6). Run as a one-off task of a bank's jobs task definition, so it
 * holds that bank's allowance credential and nothing else:
 *
 *   node dist/jobs-recover-main.js --cycle <childId:YYYY-MM-DD> --operator <name> --reason "<text>" [--recheck]
 *
 * Without --recheck it only diagnoses: the cycle record and its audit trail, no
 * BOB call. With --recheck, a held cycle (operatorHold set) is re-sent once with
 * its ORIGINAL key and amount (AllowanceCycleService.recheckHeld) and BOB's
 * answer is recorded. The hold is cleared only when that answer settles the
 * cycle. There is no option to clear a hold, change an amount or use a new key.
 *
 * A cycle of another bank is refused: the credential can't act on it anyway,
 * and the operator must use that bank's task definition.
 */
import type { Db } from 'mongodb'
import { CYCLES, type AllowanceCycleService, type AllowanceCycleDoc, type RecheckOutcome } from '../allowance/cycle.js'

export interface RecoverArgs {
  cycleKey: string
  operator: string
  reason: string
  recheck: boolean
}

export type RecoverResult =
  | { kind: 'REFUSED'; message: string }
  | { kind: 'DIAGNOSED'; cycle: CycleView; audit: AuditView[] }
  | { kind: 'RECHECKED'; outcome: RecheckOutcome; cycle: CycleView | null; audit: AuditView[] }

/** Exit codes: 0 diagnosed or resolved; 2 still held or busy; 3 refused or not found. */
export function exitCodeOf(r: RecoverResult): number {
  if (r.kind === 'REFUSED') return 3
  if (r.kind === 'DIAGNOSED') return 0
  if (r.outcome === 'RESOLVED_EXECUTED' || r.outcome === 'RESOLVED_FAILED') return 0
  if (r.outcome === 'NOT_HELD') return 3
  return 2
}

type CycleView = Pick<AllowanceCycleDoc, 'cycleKey' | 'tenantId' | 'periodStart' | 'decision' | 'status' | 'amountCents' | 'bobReason' | 'bobOperationRef' | 'attempts' | 'decidedAt' | 'updatedAt'> & { mismatches: number; operatorHold: string | null }
interface AuditView {
  action: string
  actor: string
  at: Date
}

const CYCLE_KEY = /^[A-Za-z0-9_-]{1,64}:\d{4}-\d{2}-\d{2}$/
const OPERATOR = /^[A-Za-z0-9._@-]{2,64}$/

export function parseRecoverArgs(argv: readonly string[]): RecoverArgs | string {
  const get = (flag: string) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const known = new Set(['--cycle', '--operator', '--reason', '--recheck'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    if (!known.has(a)) return `unknown option ${a}`
  }
  const cycleKey = get('--cycle')
  const operator = get('--operator')
  const reason = get('--reason')
  if (!cycleKey || !CYCLE_KEY.test(cycleKey)) return '--cycle <childCustomerId:YYYY-MM-DD> is required'
  if (!operator || !OPERATOR.test(operator)) return '--operator <name> is required (letters, digits, . _ @ -)'
  if (!reason || reason.trim().length < 10 || reason.length > 500) return '--reason "<why>" is required (10 to 500 characters)'
  return { cycleKey, operator, reason: reason.trim(), recheck: argv.includes('--recheck') }
}

export async function recoverCycle(db: Db, tenantId: string, cycles: AllowanceCycleService, args: RecoverArgs, correlation: string): Promise<RecoverResult> {
  const doc = await db.collection<AllowanceCycleDoc>(CYCLES).findOne({ cycleKey: args.cycleKey }, { projection: { _id: 0 } })
  if (!doc) return { kind: 'REFUSED', message: `no allowance cycle ${args.cycleKey}` }
  if (doc.tenantId !== tenantId) return { kind: 'REFUSED', message: `cycle ${args.cycleKey} belongs to another bank; use that bank's jobs task definition` }
  if (!args.recheck) return { kind: 'DIAGNOSED', cycle: view(doc), audit: await trail(db, args.cycleKey) }
  if (!doc.operatorHold) return { kind: 'REFUSED', message: `cycle ${args.cycleKey} is not held (status ${doc.status}); the job settles unknown outcomes itself with the original key` }
  const r = await cycles.recheckHeld(args.cycleKey, tenantId, args.operator, args.reason, correlation)
  return { kind: 'RECHECKED', outcome: r.outcome, cycle: r.cycle ? view(r.cycle) : null, audit: await trail(db, args.cycleKey) }
}

function view(c: AllowanceCycleDoc): CycleView {
  return {
    cycleKey: c.cycleKey,
    tenantId: c.tenantId,
    periodStart: c.periodStart,
    decision: c.decision,
    status: c.status,
    amountCents: c.amountCents,
    bobReason: c.bobReason,
    bobOperationRef: c.bobOperationRef,
    attempts: c.attempts,
    mismatches: c.mismatches ?? 0,
    operatorHold: c.operatorHold ?? null,
    decidedAt: c.decidedAt,
    updatedAt: c.updatedAt,
  }
}

async function trail(db: Db, cycleKey: string): Promise<AuditView[]> {
  return db
    .collection<AuditView & { subject: string }>('audit')
    .find({ subject: cycleKey }, { projection: { _id: 0, action: 1, actor: 1, at: 1 } })
    .sort({ at: 1 })
    .toArray()
}
