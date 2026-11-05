/**
 * The child's charity preference (CS-3962; D12, D51; bob-family/1 §6.3).
 *
 * The server owns the choice as product state (identity model 2). BOB needs
 * the child's own confirmation to sweep, so every choice is written to BOB
 * under the CHILD'S session (`PUT /api/v1/children/me/give-recipient`). BOB
 * never takes a recipient on the server's say-so (contract §9.4). This write
 * replaces the "BOB-facing read" in the ticket.
 *
 * Consistency with BOB (D51): what the server shows as the child's charity
 * must be what BOB sweeps to.
 * - A write first reserves the next version and records itself as `pending`.
 *   Only then is BOB called.
 * - The doc shows the new charity only after BOB has confirmed it.
 * - While a write is pending, a different write is refused. That stops two
 *   in-flight PUTs from landing in BOB in the other order. A pending write
 *   whose answer was lost is resumed by the same idempotencyKey. Once
 *   PENDING_LEASE_MS has passed, it may be superseded by a new key: by then
 *   the old request has long timed out.
 * - If BOB refuses (CHARITY_NOT_ELIGIBLE, FORBIDDEN), it records nothing, so
 *   the earlier confirmed choice stays on both sides.
 *
 * Saving a preference moves no money and never releases held Give (HOLD-2).
 * DocumentDB: no upserts and no transactions; there are conditional
 * single-document updates only.
 */
import { MongoServerError, type Collection, type Db } from 'mongodb'
import { audit } from '../audit.js'
import type { BobGivingClient } from '../bob/family.js'
import { CsError, forbidden, invalid, notAllowedInState, stale, upstreamUnavailable, unauthenticated } from '../errors.js'
import { assertChildSelf } from '../identity/authz.js'
import type { Actor } from '../identity/principal.js'

export const PREFERENCES = 'charity_preferences'
export const PENDING_LEASE_MS = 60_000
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/
const CHARITY_RE = /^[A-Za-z0-9_-]{1,200}$/
const KEEP_WRITES = 20

export type Availability = 'NONE_SELECTED' | 'UNAVAILABLE' | 'AVAILABLE'

interface WriteRecord {
  key: string
  bobCharityId: string
  version: number
  outcome: 'PENDING' | 'CONFIRMED' | 'CHARITY_UNAVAILABLE' | 'FORBIDDEN' | 'SUPERSEDED'
}

export interface CharityPreferenceDoc {
  childCustomerId: string
  tenantId: string
  /** The charity BOB confirmed for this child, or null before the first confirmation. */
  bobCharityId: string | null
  revision: number | null
  confirmedAt: Date | null
  /** AVAILABLE once BOB confirms; UNAVAILABLE when BOB later can't resolve it (a held sweep or a refused quote). */
  availability: 'AVAILABLE' | 'UNAVAILABLE' | null
  version: number
  pending: { key: string; bobCharityId: string; since: Date } | null
  /** The latest writes, for idempotent replays. */
  writes: WriteRecord[]
  /** Monotonic held-Give review counter (CS-3957); separate from version so a review never stales a choice. */
  reviewSeq: number
  updatedAt: Date
}

export const availabilityOf = (d: CharityPreferenceDoc | null): Availability =>
  !d || !d.bobCharityId ? 'NONE_SELECTED' : d.availability === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE'

export const charityUnavailable = (msg = 'that charity is not available; nothing changed') => new CsError('CHARITY_UNAVAILABLE', msg)

export async function readPreference(db: Db, childCustomerId: string, tenantId: string): Promise<CharityPreferenceDoc | null> {
  const d = await db.collection<CharityPreferenceDoc>(PREFERENCES).findOne({ childCustomerId }, { projection: { _id: 0 } })
  return d && d.tenantId === tenantId ? d : null
}

/**
 * BOB could not resolve the confirmed charity (a held sweep while AVAILABLE,
 * or a refused quote). This only reports it; the child must choose or confirm
 * again. Nothing is replaced silently (HOLD-1).
 */
export async function markUnavailable(db: Db, childCustomerId: string, now: Date, bobCharityId?: string): Promise<void> {
  const filter = bobCharityId ? { childCustomerId, bobCharityId, availability: 'AVAILABLE' as const } : { childCustomerId, availability: 'AVAILABLE' as const }
  await db.collection<CharityPreferenceDoc>(PREFERENCES).updateOne(filter, { $set: { availability: 'UNAVAILABLE', updatedAt: now } })
}

/**
 * A Give credit BOB donated tells the server which recipient BOB actually has
 * for the child (bob-family/1 §6.1, §6.2). Reconcile with it so the server's
 * charity stays the one BOB sweeps to (D51):
 * - it is the pending choice, whose answer was lost: BOB recorded it, so it is
 *   settled as CONFIRMED (the child made this choice; nothing is invented);
 * - it is the confirmed choice, shown UNAVAILABLE after an earlier hold: BOB
 *   resolved it again, so it is AVAILABLE again;
 * - it is neither: drift. It is audited, and nothing is replaced silently.
 * Conditional single-document updates only (DocumentDB); moves no money.
 */
export async function reconcileWithSweep(
  db: Db,
  childCustomerId: string,
  tenantId: string,
  recipient: { charityId: string; revision: number },
  now: Date,
  correlation: string,
): Promise<void> {
  const prefs = db.collection<CharityPreferenceDoc>(PREFERENCES)
  const d = await prefs.findOne({ childCustomerId }, { projection: { _id: 0 } })
  if (d && d.tenantId !== tenantId) return
  const before = d ? { bobCharityId: d.bobCharityId, revision: d.revision, availability: availabilityOf(d), pending: d.pending?.bobCharityId ?? null } : null
  if (d?.pending && d.pending.bobCharityId === recipient.charityId) {
    const r = await prefs.updateOne(
      { childCustomerId, 'pending.key': d.pending.key, 'writes.key': d.pending.key },
      { $set: { bobCharityId: recipient.charityId, revision: recipient.revision, confirmedAt: now, availability: 'AVAILABLE', pending: null, 'writes.$.outcome': 'CONFIRMED', updatedAt: now } },
    )
    if (r.modifiedCount === 1) {
      await audit(db, { actor: 'bob-sweep', tenantId, action: 'giving.preference_confirmed_by_sweep', subject: childCustomerId, before, after: { bobCharityId: recipient.charityId, revision: recipient.revision, key: d.pending.key }, correlation }, now)
    }
    return
  }
  if (d && d.bobCharityId === recipient.charityId) {
    await prefs.updateOne({ childCustomerId, bobCharityId: recipient.charityId, availability: 'UNAVAILABLE' }, { $set: { availability: 'AVAILABLE', updatedAt: now } })
    return
  }
  await audit(db, { actor: 'bob-sweep', tenantId, action: 'giving.recipient_drift', subject: childCustomerId, before, after: { bobCharityId: recipient.charityId, revision: recipient.revision }, correlation }, now)
}

export class CharityPreferenceService {
  private readonly prefs: Collection<CharityPreferenceDoc>

  constructor(
    private readonly db: Db,
    private readonly bob: BobGivingClient,
    private readonly now: () => Date,
  ) {
    this.prefs = db.collection<CharityPreferenceDoc>(PREFERENCES)
  }

  async set(actor: Actor, childId: string, bobCharityId: string, expectedVersion: number | null | undefined, key: string, correlation: string): Promise<CharityPreferenceDoc> {
    const p = actor.principal
    assertChildSelf(p, childId)
    if (!KEY_RE.test(key)) throw invalid('idempotencyKey must be 8-128 characters of A-Z, a-z, 0-9, . _ : -')
    if (!CHARITY_RE.test(bobCharityId)) throw invalid('bobCharityId is not a BOB charity id')

    const doc = await this.prefs.findOne({ childCustomerId: childId }, { projection: { _id: 0 } })
    if (doc && doc.tenantId !== p.tenantId) throw forbidden()

    // Replay of a key already seen.
    const seen = doc?.writes.find((w) => w.key === key)
    if (doc && seen) {
      if (seen.bobCharityId !== bobCharityId) throw invalid('idempotencyKey reused with a different charity')
      if (seen.outcome === 'PENDING' && doc.pending?.key === key) return this.confirm(actor, doc, correlation)
      if (seen.outcome === 'CHARITY_UNAVAILABLE') throw charityUnavailable()
      if (seen.outcome === 'FORBIDDEN') throw forbidden()
      if (seen.outcome === 'SUPERSEDED' || seen.outcome === 'PENDING') throw stale('a later choice replaced this one')
      return doc
    }

    const now = this.now()
    const pending = { key, bobCharityId, since: now }
    let reserved: CharityPreferenceDoc
    if (!doc) {
      if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== 0) throw stale()
      reserved = {
        childCustomerId: childId,
        tenantId: p.tenantId,
        bobCharityId: null,
        revision: null,
        confirmedAt: null,
        availability: null,
        version: 1,
        pending,
        writes: [{ key, bobCharityId, version: 1, outcome: 'PENDING' }],
        reviewSeq: 0,
        updatedAt: now,
      }
      try {
        await this.prefs.insertOne({ ...reserved })
      } catch (err) {
        if (err instanceof MongoServerError && err.code === 11000) throw stale()
        throw err
      }
    } else {
      if (expectedVersion !== doc.version) throw stale()
      const lapsed = doc.pending && now.getTime() - doc.pending.since.getTime() >= PENDING_LEASE_MS
      if (doc.pending && !lapsed) throw notAllowedInState('an earlier choice is still being confirmed with the bank; retry it with its own idempotencyKey')
      const filter = { childCustomerId: childId, version: doc.version, 'pending.key': doc.pending?.key ?? null }
      const writes = doc.writes.map((w) => (doc.pending && w.key === doc.pending.key ? { ...w, outcome: 'SUPERSEDED' as const } : w))
      writes.push({ key, bobCharityId, version: doc.version + 1, outcome: 'PENDING' })
      const r = await this.prefs.updateOne(filter, { $set: { pending, writes: writes.slice(-KEEP_WRITES), updatedAt: now }, $inc: { version: 1 } })
      if (r.matchedCount !== 1) throw stale()
      reserved = { ...doc, pending, version: doc.version + 1, writes }
    }
    return this.confirm(actor, reserved, correlation)
  }

  /** Confirm the pending choice with BOB under the child's session, then settle the doc. */
  private async confirm(actor: Actor, doc: CharityPreferenceDoc, correlation: string): Promise<CharityPreferenceDoc> {
    const pend = doc.pending!
    const out = await this.bob.setGiveRecipient(actor.session, pend.bobCharityId)
    const now = this.now()
    const mine = { childCustomerId: doc.childCustomerId, 'pending.key': pend.key, 'writes.key': pend.key }
    const before = { bobCharityId: doc.bobCharityId, revision: doc.revision, availability: availabilityOf(doc) }
    const settle = async (outcome: WriteRecord['outcome'], set: Partial<CharityPreferenceDoc>, action: string) => {
      await this.prefs.updateOne(mine, { $set: { ...set, pending: null, 'writes.$.outcome': outcome, updatedAt: now } })
      await audit(this.db, { actor: actor.principal.customerId, tenantId: doc.tenantId, action, subject: doc.childCustomerId, before, after: { bobCharityId: pend.bobCharityId, ...set, key: pend.key }, correlation }, now)
    }
    if (out.kind === 'ok') {
      // §6.3: a 200 means BOB recorded it. eligible:false is outside the documented
      // shape, so it is shown as UNAVAILABLE (BOB will hold) and never as AVAILABLE.
      await settle(
        'CONFIRMED',
        { bobCharityId: out.value.charityId, revision: out.value.revision, confirmedAt: out.value.confirmedAt, availability: out.value.eligible ? 'AVAILABLE' : 'UNAVAILABLE' },
        'giving.preference_confirmed',
      )
      return (await this.prefs.findOne({ childCustomerId: doc.childCustomerId }, { projection: { _id: 0 } }))!
    }
    if (out.kind === 'refused' && out.code === 'CHARITY_NOT_ELIGIBLE') {
      await settle('CHARITY_UNAVAILABLE', {}, 'giving.preference_refused')
      throw charityUnavailable()
    }
    if (out.kind === 'refused' && (out.code === 'FORBIDDEN' || out.code === 'CHILD_LIMIT')) {
      await settle('FORBIDDEN', {}, 'giving.preference_refused')
      throw forbidden()
    }
    if (out.kind === 'refused' && out.code === 'UNAUTHORIZED') throw unauthenticated()
    if (out.kind === 'refused' && out.code === 'VALIDATION_ERROR') {
      await settle('CHARITY_UNAVAILABLE', {}, 'giving.preference_refused')
      throw invalid('BOB refused the charity id')
    }
    // Unknown outcome: stays pending. The same request re-sends the same choice (the PUT is idempotent).
    throw upstreamUnavailable('the bank did not confirm the choice; retry with the same idempotencyKey')
  }
}
