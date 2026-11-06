/**
 * Child allocation of unsplit job pay (CS-3953; bob-family/1 §6.1, §6.2;
 * CS-3904 MISSION-1, MISSION-2, HOLD-1).
 *
 * Under the child's own session only: no Guardian or sibling can split.
 *
 * splitUnsplit(childId, legs, expectedVersion, idempotencyKey):
 * 1. Validates exact cents per jar (each of SPEND, SAVE, GIVE at most once;
 *    zero allowed and dropped), and that the legs add up to the current
 *    unsplit balance at expectedVersion (the whole balance is split at once).
 * 2. Records the split money operation (key `cs:<splitOpId>:split`, splitOpId
 *    derived from the child and the client key) before anything moves.
 * 3. Debits the ledger atomically, conditional on version and balance.
 * 4. Calls BOB once, under the child's session: from Spend, one leg each to
 *    Save and Give for the non-zero shares. The Spend share needs no move:
 *    job pay already sits in Spend. BOB stamps purpose `allocation` and origin
 *    `child` (distinct from the allowance's `split`/`automatic`), and in the
 *    same transaction donates the Give credit to the child's confirmed
 *    recipient, or holds it (§6.2). A zero Give makes no Give leg, so no donation.
 * 5. BOB refused in a way that guarantees nothing moved: FAILED, and the debit
 *    is restored once. Unknown outcome, IDEMPOTENCY_CONFLICT or IN_PROGRESS:
 *    PENDING with the balance held; the same request re-sends the same key.
 */
import { createHash } from 'node:crypto'
import { MongoServerError, type Collection, type Db } from 'mongodb'
import { audit } from '../audit.js'
import type { BobFamilyClient, BobJar } from '../bob/family.js'
import { invalid, stale, unauthenticated } from '../errors.js'
import { assertChildSelf } from '../identity/authz.js'
import type { Actor } from '../identity/principal.js'
import { debitForSplit, readLedger, restoreFailedSplit } from './ledger.js'

export type Jar = 'SPEND' | 'SAVE' | 'GIVE'

export interface SplitOperationDoc {
  idempotencyKey: string
  opId: string
  kind: 'split'
  tenantId: string
  childCustomerId: string
  actorCustomerId: string
  clientKey: string
  /** Cents per jar, as the child asked. */
  shares: Record<Jar, number>
  amountCents: number
  expectedVersion: number
  status: 'PENDING' | 'COMPLETED' | 'FAILED'
  bobOperationRef: string | null
  giveOutcome: { status: 'DONATED' | 'HELD' | 'NONE'; donationRef: string | null; amountCents: number; recipient: { charityId: string; revision: number } | null } | null
  reason: string | null
  createdAt: Date
  updatedAt: Date
}

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/
const CENTS_RE = /^(0|[1-9]\d{0,6})\.(\d{2})$/
/**
 * Refusals that guarantee nothing moved under this key; only these restore the
 * unsplit balance. IDEMPOTENCY_CONFLICT is NOT one: §2.3 says only the
 * conflicting call did nothing, and the original call under the key may have
 * committed. It stays PENDING with the balance held (CS-3953 review R1).
 */
const FINAL = new Set(['CHILD_LIMIT', 'FORBIDDEN', 'INSUFFICIENT_FUNDS', 'VALIDATION_ERROR'])

export const splitOpId = (childCustomerId: string, clientKey: string) =>
  `spl-${createHash('sha256').update(`${childCustomerId}:${clientKey}`).digest('hex').slice(0, 24)}`
export const splitKey = (opId: string) => `cs:${opId}:split`

export interface LegInput {
  jar: Jar
  amount: { amount: string; currency: string }
}

export function parseShares(legs: LegInput[]): Record<Jar, number> {
  const shares: Record<Jar, number> = { SPEND: 0, SAVE: 0, GIVE: 0 }
  const seen = new Set<Jar>()
  if (legs.length === 0) throw invalid('at least one leg')
  for (const l of legs) {
    if (seen.has(l.jar)) throw invalid(`${l.jar} appears twice`)
    seen.add(l.jar)
    if (l.amount.currency !== 'AUD') throw invalid('currency must be AUD')
    const m = CENTS_RE.exec(l.amount.amount)
    if (!m) throw invalid('amounts must be decimals with two places, e.g. 0.60')
    shares[l.jar] = Number(m[1]) * 100 + Number(m[2])
  }
  return shares
}

export class SplitService {
  private readonly ops: Collection<SplitOperationDoc>

  constructor(
    private readonly db: Db,
    private readonly bob: BobFamilyClient,
    private readonly now: () => Date,
  ) {
    this.ops = db.collection<SplitOperationDoc>('money_operations')
  }

  async split(actor: Actor, childId: string, legs: LegInput[], expectedVersion: number, clientKey: string, correlation: string): Promise<SplitOperationDoc> {
    const p = actor.principal
    assertChildSelf(p, childId)
    if (!KEY_RE.test(clientKey)) throw invalid('idempotencyKey must be 8-128 characters of A-Z, a-z, 0-9, . _ : -')
    const shares = parseShares(legs)
    const total = shares.SPEND + shares.SAVE + shares.GIVE
    if (total <= 0) throw invalid('nothing to split')
    const opId = splitOpId(childId, clientKey)
    const key = splitKey(opId)

    let op = await this.ops.findOne({ idempotencyKey: key }, { projection: { _id: 0 } })
    if (op) {
      if (op.shares.SPEND !== shares.SPEND || op.shares.SAVE !== shares.SAVE || op.shares.GIVE !== shares.GIVE) throw invalid('idempotencyKey reused with a different split')
      return op.status === 'PENDING' ? this.resume(actor, op, correlation) : op
    }

    const ledger = await readLedger(this.db, childId)
    if (!ledger || ledger.tenantId !== p.tenantId) throw invalid('nothing unsplit')
    if (ledger.version !== expectedVersion) throw stale()
    if (total !== ledger.balanceCents) throw invalid(`the legs must add up to the unsplit amount exactly`)

    const now = this.now()
    const doc: SplitOperationDoc = {
      idempotencyKey: key,
      opId,
      kind: 'split',
      tenantId: p.tenantId,
      childCustomerId: childId,
      actorCustomerId: p.customerId,
      clientKey,
      shares,
      amountCents: total,
      expectedVersion,
      status: 'PENDING',
      bobOperationRef: null,
      giveOutcome: null,
      reason: null,
      createdAt: now,
      updatedAt: now,
    }
    try {
      await this.ops.insertOne({ ...doc })
    } catch (err) {
      if (!(err instanceof MongoServerError && err.code === 11000)) throw err
      op = (await this.ops.findOne({ idempotencyKey: key }, { projection: { _id: 0 } }))!
      return op.status === 'PENDING' ? this.resume(actor, op, correlation) : op
    }

    const debit = await debitForSplit(this.db, childId, key, total, expectedVersion, now)
    if (debit === 'stale' || debit === 'amount_mismatch' || debit === 'missing') {
      await this.ops.updateOne({ idempotencyKey: key, status: 'PENDING' }, { $set: { status: 'FAILED', reason: debit === 'stale' ? 'STALE_VERSION' : 'INVALID', updatedAt: now } })
      if (debit === 'stale') throw stale()
      throw invalid('the legs must add up to the unsplit amount exactly')
    }
    await audit(this.db, { actor: p.customerId, tenantId: p.tenantId, action: 'unsplit.debited', subject: key, after: { shares }, correlation }, now)
    return this.execute(actor, doc, correlation)
  }

  /**
   * A PENDING split seen again (replay, or a crash between recording it and
   * debiting): BOB is called only once the ledger debit for this key is
   * certain. If the debit can no longer be made, the split fails and nothing moves.
   */
  private async resume(actor: Actor, op: SplitOperationDoc, correlation: string): Promise<SplitOperationDoc> {
    const debit = await debitForSplit(this.db, op.childCustomerId, op.idempotencyKey, op.amountCents, op.expectedVersion, this.now())
    if (debit !== 'debited' && debit !== 'already') {
      await this.ops.updateOne({ idempotencyKey: op.idempotencyKey, status: 'PENDING' }, { $set: { status: 'FAILED', reason: debit === 'stale' ? 'STALE_VERSION' : 'INVALID', updatedAt: this.now() } })
      return (await this.ops.findOne({ idempotencyKey: op.idempotencyKey }, { projection: { _id: 0 } }))!
    }
    return this.execute(actor, op, correlation)
  }

  private async execute(actor: Actor, op: SplitOperationDoc, correlation: string): Promise<SplitOperationDoc> {
    const moves: { toJar: BobJar; amountCents: number }[] = []
    if (op.shares.SAVE > 0) moves.push({ toJar: 'save', amountCents: op.shares.SAVE })
    if (op.shares.GIVE > 0) moves.push({ toJar: 'give', amountCents: op.shares.GIVE })
    const now = this.now()
    if (moves.length === 0) {
      // Everything stays in Spend, where job pay already is: no BOB call.
      await this.ops.updateOne({ idempotencyKey: op.idempotencyKey, status: 'PENDING' }, { $set: { status: 'COMPLETED', giveOutcome: { status: 'NONE', donationRef: null, amountCents: 0, recipient: null }, updatedAt: now } })
    } else {
      const out = await this.bob.allocate(actor.session, op.idempotencyKey, { allocationRef: op.opId, fromJar: 'spend', legs: moves })
      if (out.kind === 'ok') {
        const legsMatch =
          out.value.legs.length === moves.length && moves.every((m) => out.value.legs.some((l) => l.toJar === m.toJar && l.amountCents === m.amountCents))
        // The Give outcome must account for exactly the Give share (review optional 1).
        const g0 = out.value.giveOutcome
        const giveMatch =
          op.shares.GIVE > 0
            ? (g0.status === 'donated' || g0.status === 'held') && g0.amountCents === op.shares.GIVE && (g0.status !== 'donated' || (g0.donationId !== null && g0.recipient !== null))
            : g0.status === 'none'
        if (!legsMatch || !giveMatch) {
          await this.ops.updateOne({ idempotencyKey: op.idempotencyKey, status: 'PENDING' }, { $set: { reason: 'UPSTREAM_MISMATCH', updatedAt: now } })
        } else {
          const g = out.value.giveOutcome
          await this.ops.updateOne(
            { idempotencyKey: op.idempotencyKey, status: 'PENDING' },
            {
              $set: {
                status: 'COMPLETED',
                bobOperationRef: out.value.allocationRef,
                giveOutcome: { status: g.status === 'donated' ? 'DONATED' : g.status === 'held' ? 'HELD' : 'NONE', donationRef: g.donationId, amountCents: g.amountCents, recipient: g.recipient },
                reason: null,
                updatedAt: now,
              },
            },
          )
        }
      } else if (out.kind === 'refused' && out.code === 'UNAUTHORIZED') {
        await this.ops.updateOne({ idempotencyKey: op.idempotencyKey, status: 'PENDING' }, { $set: { reason: 'UNAUTHORIZED', updatedAt: now } })
        throw unauthenticated()
      } else if (out.kind === 'refused' && FINAL.has(out.code)) {
        const r = await this.ops.updateOne(
          { idempotencyKey: op.idempotencyKey, status: 'PENDING' },
          { $set: { status: 'FAILED', reason: out.reason ? `${out.code}:${out.reason}` : out.code, updatedAt: now } },
        )
        if (r.modifiedCount === 1) await restoreFailedSplit(this.db, op.childCustomerId, op.idempotencyKey, op.amountCents, now)
      } else {
        await this.ops.updateOne({ idempotencyKey: op.idempotencyKey, status: 'PENDING' }, { $set: { reason: out.kind === 'refused' ? out.code : 'UPSTREAM_UNAVAILABLE', updatedAt: now } })
      }
    }
    const done = (await this.ops.findOne({ idempotencyKey: op.idempotencyKey }, { projection: { _id: 0 } }))!
    if (done.status !== 'PENDING') {
      await audit(this.db, { actor: actor.principal.customerId, tenantId: done.tenantId, action: `unsplit.split_${done.status.toLowerCase()}`, subject: done.idempotencyKey, after: { giveOutcome: done.giveOutcome, reason: done.reason }, correlation }, now)
    }
    return done
  }
}
