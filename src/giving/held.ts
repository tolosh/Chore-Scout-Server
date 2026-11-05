/**
 * Held Give: the child's review and explicit confirmation, and the release
 * under the child's own session (CS-3957; CS-3904 HOLD-1 to HOLD-5; identity
 * model §6, ID-4; bob-family/1 §6.4, §6.5).
 *
 * - A review is BOB's own quote (§6.5): all money held now, to the child's
 *   confirmed charity, for 5 minutes. It is stored with a review version and
 *   is the only thing the child can confirm. A held read (§6.4) alone, or a
 *   Guardian's read, never creates one.
 * - Only the child confirms (a Guardian, operator or Odyssey gets FORBIDDEN).
 *   The confirmation is recorded first (actor, amount, currency, recipient,
 *   version, correlation), then one BOB confirm is sent with key
 *   `cs:<quoteId>:release`. BOB pays at most once per quote whatever the key.
 * - Anything that changed after the review (amount, recipient, eligibility,
 *   expiry, a newer review) refuses the confirmation with STALE_VERSION and a
 *   new review is needed. Checked here before BOB, and by BOB (FRESH_QUOTE_NEEDED).
 * - Choosing a charity, a later cycle, a sweep or a retry never releases held
 *   money (HOLD-2): only this confirm does.
 * DocumentDB: no upserts and no transactions; conditional single-document updates.
 */
import { MongoServerError, type Collection, type Db } from 'mongodb'
import { audit } from '../audit.js'
import { releaseKey, type BobGivingClient } from '../bob/family.js'
import { forbidden, invalid, stale, unauthenticated, upstreamUnavailable } from '../errors.js'
import { assertChildAccess, assertChildSelf } from '../identity/authz.js'
import { isChild, type Actor } from '../identity/principal.js'
import { markUnavailable, PREFERENCES, readPreference, type CharityPreferenceDoc } from './preference.js'

export const REVIEWS = 'held_give_reviews'
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/
/** A review this close to BOB's quote expiry is not reused; a fresh quote is taken instead. */
const REUSE_MARGIN_MS = 60_000

export interface HeldReviewDoc {
  childCustomerId: string
  tenantId: string
  reviewVersion: number
  quoteId: string
  amountCents: number
  currency: 'AUD'
  charityId: string
  recipientName: string
  revision: number
  expiresAt: Date
  status: 'OPEN' | 'CONFIRMED' | 'SUPERSEDED' | 'INVALIDATED'
  confirmation: { clientKey: string; actor: string; amountCents: number; currency: 'AUD'; charityId: string; revision: number; at: Date; correlation: string } | null
  createdAt: Date
  updatedAt: Date
}

export interface ReleaseOperationDoc {
  idempotencyKey: string
  kind: 'release'
  tenantId: string
  childCustomerId: string
  actorCustomerId: string
  reviewVersion: number
  quoteId: string
  amountCents: number
  charityId: string
  revision: number
  status: 'PENDING' | 'COMPLETED' | 'FAILED'
  bobOperationRef: string | null
  reason: string | null
  attempts: number
  createdAt: Date
  updatedAt: Date
}

/** What the child (or a Guardian, read only) sees. `reviewVersion` 0 means there is nothing the child can confirm yet. */
export interface HeldView {
  childCustomerId: string
  amountCents: number
  recipientName: string | null
  recipientUnavailable: boolean
  reviewVersion: number
  confirmedAt: Date | null
}

const viewOf = (r: HeldReviewDoc): HeldView => ({
  childCustomerId: r.childCustomerId,
  amountCents: r.amountCents,
  recipientName: r.recipientName,
  recipientUnavailable: false,
  reviewVersion: r.reviewVersion,
  confirmedAt: r.confirmation?.at ?? null,
})

export class HeldGiveService {
  private readonly reviews: Collection<HeldReviewDoc>
  private readonly ops: Collection<ReleaseOperationDoc>

  constructor(
    private readonly db: Db,
    private readonly bob: BobGivingClient,
    private readonly now: () => Date,
  ) {
    this.reviews = db.collection<HeldReviewDoc>(REVIEWS)
    this.ops = db.collection<ReleaseOperationDoc>('money_operations')
  }

  /** BOB's held amount for the child, read live under the actor's own session (§6.4). */
  private async held(actor: Actor, childId: string): Promise<number> {
    const out = await this.bob.heldGive(actor.session, isChild(actor.principal) ? 'me' : childId)
    if (out.kind === 'ok') {
      if (out.value.childCustomerId !== childId) throw upstreamUnavailable('BOB answered for another child')
      return out.value.heldCents
    }
    if (out.kind === 'refused' && out.code === 'UNAUTHORIZED') throw unauthenticated()
    if (out.kind === 'refused' && out.code === 'FORBIDDEN') throw forbidden()
    throw upstreamUnavailable('the bank did not answer the held-Give read')
  }

  private latest(childId: string): Promise<HeldReviewDoc | null> {
    return this.reviews.find({ childCustomerId: childId }, { projection: { _id: 0 } }).sort({ reviewVersion: -1 }).limit(1).next()
  }

  /**
   * heldGiving: null when nothing is held. The child gets a reviewable quote
   * when their confirmed charity is eligible; otherwise recipientUnavailable and
   * reviewVersion 0. A Guardian sees the amount read only, and never a quote.
   */
  async review(actor: Actor, childId: string): Promise<HeldView | null> {
    const p = actor.principal
    assertChildAccess(p, childId)
    const heldCents = await this.held(actor, childId)
    if (heldCents === 0) return null
    const pref = await readPreference(this.db, childId, p.tenantId)
    const latest = await this.latest(childId)
    const now = this.now()
    const usable = (r: HeldReviewDoc | null): r is HeldReviewDoc =>
      !!r && r.tenantId === p.tenantId && r.status === 'OPEN' && r.amountCents === heldCents && r.charityId === pref?.bobCharityId && r.expiresAt.getTime() - now.getTime() > REUSE_MARGIN_MS
    const unavailable: HeldView = { childCustomerId: childId, amountCents: heldCents, recipientName: null, recipientUnavailable: true, reviewVersion: 0, confirmedAt: null }

    if (!isChild(p)) return usable(latest) ? viewOf(latest) : { ...unavailable, recipientUnavailable: !pref?.bobCharityId || pref.availability !== 'AVAILABLE' }
    assertChildSelf(p, childId)
    if (!pref?.bobCharityId) return unavailable
    if (usable(latest)) return viewOf(latest)

    const q = await this.bob.releaseQuote(actor.session, pref.bobCharityId)
    if (q.kind === 'refused' && q.code === 'NOTHING_HELD') return null
    if (q.kind === 'refused' && q.code === 'CHARITY_NOT_ELIGIBLE') {
      await markUnavailable(this.db, childId, now, pref.bobCharityId)
      return unavailable
    }
    if (q.kind === 'refused' && q.code === 'UNAUTHORIZED') throw unauthenticated()
    if (q.kind === 'refused' && q.code === 'FORBIDDEN') throw forbidden()
    if (q.kind !== 'ok') throw upstreamUnavailable('the bank did not quote the held Give')

    // The next review version comes from the preference document's own counter (no upsert; it exists here).
    const bumped = await this.db
      .collection<CharityPreferenceDoc>(PREFERENCES)
      .findOneAndUpdate({ childCustomerId: childId, tenantId: p.tenantId }, { $inc: { reviewSeq: 1 } }, { returnDocument: 'after', projection: { _id: 0, reviewSeq: 1 } })
    if (!bumped) throw stale('the charity choice changed; review again')
    const doc: HeldReviewDoc = {
      childCustomerId: childId,
      tenantId: p.tenantId,
      reviewVersion: bumped.reviewSeq,
      quoteId: q.value.quoteId,
      amountCents: q.value.amountCents,
      currency: 'AUD',
      charityId: q.value.charityId,
      recipientName: q.value.name,
      revision: q.value.revision,
      expiresAt: q.value.expiresAt,
      status: 'OPEN',
      confirmation: null,
      createdAt: now,
      updatedAt: now,
    }
    // BOB's new quote superseded every earlier open one (§6.5); mirror that before showing the new review.
    await this.reviews.updateMany({ childCustomerId: childId, status: 'OPEN', reviewVersion: { $lt: doc.reviewVersion } }, { $set: { status: 'SUPERSEDED', updatedAt: now } })
    await this.reviews.insertOne({ ...doc })
    return viewOf(doc)
  }

  /** confirmHeldRelease: the child's explicit confirmation of exactly the reviewed amount and recipient, then one BOB release. */
  async confirm(actor: Actor, childId: string, reviewVersion: number, clientKey: string, correlation: string): Promise<{ review: HeldView; operation: ReleaseOperationDoc }> {
    const p = actor.principal
    assertChildSelf(p, childId)
    if (!KEY_RE.test(clientKey)) throw invalid('idempotencyKey must be 8-128 characters of A-Z, a-z, 0-9, . _ : -')
    if (!Number.isInteger(reviewVersion) || reviewVersion < 1) throw stale('nothing to confirm; review the held Give first')

    let r = await this.reviews.findOne({ childCustomerId: childId, reviewVersion }, { projection: { _id: 0 } })
    if (!r || r.tenantId !== p.tenantId) throw stale('that review is not current; review again')
    const now = this.now()

    if (r.status === 'OPEN') {
      const newer = await this.reviews.findOne({ childCustomerId: childId, reviewVersion: { $gt: reviewVersion } }, { projection: { _id: 0, reviewVersion: 1 } })
      const pref = await readPreference(this.db, childId, p.tenantId)
      const invalidate = async (why: string) => {
        await this.reviews.updateOne({ childCustomerId: childId, reviewVersion, status: 'OPEN' }, { $set: { status: newer ? 'SUPERSEDED' : 'INVALIDATED', updatedAt: now } })
        throw stale(`${why}; review again`)
      }
      if (newer) await invalidate('a newer review replaced this one')
      if (now >= r.expiresAt) await invalidate('the review expired')
      if (pref?.bobCharityId !== r.charityId || pref.availability !== 'AVAILABLE') await invalidate('the charity changed or is not available')
      if ((await this.held(actor, childId)) !== r.amountCents) await invalidate('the amount held changed')

      const confirmation = { clientKey, actor: p.customerId, amountCents: r.amountCents, currency: r.currency, charityId: r.charityId, revision: r.revision, at: now, correlation }
      const c = await this.reviews.updateOne({ childCustomerId: childId, reviewVersion, status: 'OPEN' }, { $set: { status: 'CONFIRMED', confirmation, updatedAt: now } })
      if (c.modifiedCount === 1) {
        await audit(
          this.db,
          { actor: p.customerId, tenantId: r.tenantId, action: 'giving.held_release_confirmed', subject: childId, after: { reviewVersion, amountCents: r.amountCents, currency: r.currency, charityId: r.charityId, revision: r.revision, quoteId: r.quoteId }, correlation },
          now,
        )
      }
      r = (await this.reviews.findOne({ childCustomerId: childId, reviewVersion }, { projection: { _id: 0 } }))!
    }
    if (r.status !== 'CONFIRMED' || !r.confirmation) throw stale('that review is not current; review again')

    const op: ReleaseOperationDoc = {
      idempotencyKey: releaseKey(r.quoteId),
      kind: 'release',
      tenantId: r.tenantId,
      childCustomerId: childId,
      actorCustomerId: r.confirmation.actor,
      reviewVersion,
      quoteId: r.quoteId,
      amountCents: r.amountCents,
      charityId: r.charityId,
      revision: r.revision,
      status: 'PENDING',
      bobOperationRef: null,
      reason: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }
    try {
      await this.ops.insertOne({ ...op })
    } catch (err) {
      if (!(err instanceof MongoServerError && err.code === 11000)) throw err
    }
    const operation = await this.settle(actor, op.idempotencyKey, correlation)
    if (operation.status === 'FAILED' && operation.reason?.startsWith('FRESH_QUOTE_NEEDED')) throw stale(`the bank needs a fresh review (${operation.reason}); review again`)
    if (operation.status === 'FAILED' && operation.reason === 'FORBIDDEN') throw forbidden()
    return { review: viewOf(r), operation }
  }

  /** Sends the one release while it is PENDING, under the confirming child's own session; otherwise returns the record. */
  private async settle(actor: Actor, key: string, correlation: string): Promise<ReleaseOperationDoc> {
    const op = (await this.ops.findOne({ idempotencyKey: key }, { projection: { _id: 0 } }))!
    if (op.status !== 'PENDING' || op.actorCustomerId !== actor.principal.customerId) return op
    const out = await this.bob.confirmRelease(actor.session, op.quoteId, { amountCents: op.amountCents, charityId: op.charityId, revision: op.revision })
    const now = this.now()
    const pending = { idempotencyKey: key, status: 'PENDING' as const }
    let final = false
    if (out.kind === 'ok') {
      const v = out.value
      if (v.amountCents !== op.amountCents || v.charityId !== op.charityId || v.revision !== op.revision) {
        await this.ops.updateOne(pending, { $set: { reason: 'UPSTREAM_MISMATCH', updatedAt: now }, $inc: { attempts: 1 } })
      } else {
        final = (await this.ops.updateOne(pending, { $set: { status: 'COMPLETED', bobOperationRef: v.donationId, reason: null, updatedAt: now }, $inc: { attempts: 1 } })).modifiedCount === 1
      }
    } else if (out.kind === 'refused' && out.code === 'QUOTE_ALREADY_CONFIRMED') {
      // §8: already done, here is the original. No second payment.
      final = (await this.ops.updateOne(pending, { $set: { status: 'COMPLETED', bobOperationRef: String(out.error.donation_id ?? ''), reason: null, updatedAt: now }, $inc: { attempts: 1 } })).modifiedCount === 1
    } else if (out.kind === 'refused' && out.code === 'UNAUTHORIZED') {
      await this.ops.updateOne(pending, { $set: { reason: 'UNAUTHORIZED', updatedAt: now }, $inc: { attempts: 1 } })
      throw unauthenticated()
    } else if (out.kind === 'refused' && (out.code === 'FRESH_QUOTE_NEEDED' || out.code === 'FORBIDDEN')) {
      // Both are refusals of this quote: no money moved (§6.5). The review can't be confirmed again.
      const reason = out.code === 'FRESH_QUOTE_NEEDED' ? `FRESH_QUOTE_NEEDED:${out.reason ?? 'unknown'}` : 'FORBIDDEN'
      final = (await this.ops.updateOne(pending, { $set: { status: 'FAILED', reason, updatedAt: now }, $inc: { attempts: 1 } })).modifiedCount === 1
      if (final) {
        await this.reviews.updateOne({ childCustomerId: op.childCustomerId, reviewVersion: op.reviewVersion }, { $set: { status: 'INVALIDATED', updatedAt: now } })
        if (out.reason === 'recipient_disabled') await markUnavailable(this.db, op.childCustomerId, now, op.charityId)
      }
    } else {
      // Unknown outcome, IDEMPOTENCY_CONFLICT or IN_PROGRESS: the original call may have paid. Stay PENDING; retry with the same key.
      await this.ops.updateOne(pending, { $set: { reason: out.kind === 'refused' ? out.code : 'UPSTREAM_UNAVAILABLE', updatedAt: now }, $inc: { attempts: 1 } })
    }
    const done = (await this.ops.findOne({ idempotencyKey: key }, { projection: { _id: 0 } }))!
    if (final) {
      await audit(this.db, { actor: actor.principal.customerId, tenantId: done.tenantId, action: `giving.held_release_${done.status.toLowerCase()}`, subject: key, after: { bobOperationRef: done.bobOperationRef, reason: done.reason, amountCents: done.amountCents }, correlation }, now)
    }
    return done
  }
}
