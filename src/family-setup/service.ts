/**
 * Family set-up orchestration (CS-3948; spec §4; identity model §3).
 *
 * Under Sarah's own session only. There is no background completion: nothing
 * here runs except inside her request.
 *
 * 1. The set-up is recorded (family_setups, keyed by the client's setupRef)
 *    BEFORE any call to BOB.
 * 2. Each unfinished slot calls BOB §4.1 POST /api/v1/children with
 *    Idempotency-Key `cs:<setupRef>:child:<slot>` (the page's format). BOB's
 *    idempotency, and its one-child-per-set-up-reference rule, mean a retry
 *    or a crash between BOB's success and our write can never create a child
 *    twice: the retry gets the same child back.
 * 3. Slot outcomes:
 *    - CREATED: BOB's customer number, link id and the three account ids are recorded;
 *    - REFUSED: BOB decided (EMAIL_IN_USE, AGE_OUT_OF_RANGE, VALIDATION_ERROR).
 *      Final for this setupRef: BOB replays the same refusal for the same key,
 *      so that child needs a new set-up;
 *    - PENDING: not tried, or the outcome is unknown (timeout, 5xx,
 *      IDEMPOTENCY_IN_PROGRESS), or IDEMPOTENCY_CONFLICT (the retry changed a
 *      child's details; BOB may already hold that child under the original
 *      details, so the slot is never given up). Resumed by Sarah retrying with
 *      the same setupRef and the same details.
 * 4. When every slot is settled (CREATED or REFUSED) the family pointer
 *    record is written with the created children, and the state becomes
 *    COMPLETE (all created) or PARTIAL (some refused; not resumable). While any
 *    slot is PENDING the state is PARTIAL and resumable.
 *
 * Contact details (first name, date of birth, email) pass through to BOB and
 * are never written to the database or logs.
 */
import { createHash } from 'node:crypto'
import { MongoServerError, type Collection, type Db } from 'mongodb'
import { audit } from '../audit.js'
import type { BobFamilyClient } from '../bob/family.js'
import { forbidden, invalid, unauthenticated } from '../errors.js'
import { isAdult, type Actor } from '../identity/principal.js'

export type SlotState = 'PENDING' | 'CREATED' | 'REFUSED'
export type SetupState = 'IN_PROGRESS' | 'PARTIAL' | 'COMPLETE'

export interface SetupSlot {
  slot: number
  state: SlotState
  childCustomerId?: string
  linkId?: string
  accounts?: { spend: string; save: string; give: string }
  /** BOB's refusal code, or UPSTREAM_UNAVAILABLE while the outcome is unknown. */
  reason?: string
  attempts: number
}

export interface FamilySetupDoc {
  setupRef: string
  tenantId: string
  guardianCustomerId: string
  state: SetupState
  slotCount: number
  slots: SetupSlot[]
  familyId?: string
  createdAt: Date
  updatedAt: Date
}

export interface SetupChildInput {
  firstName: string
  dateOfBirth: string
  email: string
}

export const SETUP_REF_RE = /^[A-Za-z0-9_-]{8,128}$/
export const MAX_CHILDREN = 6
const FINAL_REFUSALS = new Set(['EMAIL_IN_USE', 'AGE_OUT_OF_RANGE', 'VALIDATION_ERROR'])

export const slotKey = (setupRef: string, slot: number) => `cs:${setupRef}:child:${slot}`

/** One family pointer per Guardian per bank; deterministic so concurrent set-ups converge. */
export const familyIdFor = (tenantId: string, guardianCustomerId: string) =>
  `fam-${createHash('sha256').update(`${tenantId}:${guardianCustomerId}`).digest('hex').slice(0, 24)}`

export function validateInput(setupRef: string, children: SetupChildInput[]): void {
  if (!SETUP_REF_RE.test(setupRef)) throw invalid('setupRef must be 8-128 characters of A-Z, a-z, 0-9, _ or -')
  if (children.length < 1 || children.length > MAX_CHILDREN) throw invalid(`between 1 and ${MAX_CHILDREN} children`)
  for (const c of children) {
    if (c.firstName.trim().length < 1 || c.firstName.length > 50) throw invalid('first name must be 1-50 characters')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.dateOfBirth) || Number.isNaN(Date.parse(`${c.dateOfBirth}T00:00:00Z`))) throw invalid('date of birth must be YYYY-MM-DD')
    if (c.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) throw invalid('email is not valid')
  }
}

export function stateOf(slots: SetupSlot[]): SetupState {
  if (slots.some((s) => s.state === 'PENDING')) return 'PARTIAL'
  return slots.every((s) => s.state === 'CREATED') ? 'COMPLETE' : 'PARTIAL'
}

export const isResumable = (doc: FamilySetupDoc) => doc.slots.some((s) => s.state === 'PENDING')

export class FamilySetupService {
  private readonly setups: Collection<FamilySetupDoc>

  constructor(
    private readonly db: Db,
    private readonly bob: BobFamilyClient,
    private readonly now: () => Date,
  ) {
    this.setups = db.collection<FamilySetupDoc>('family_setups')
  }

  /** The set-up, if it is this Guardian's in this bank; FORBIDDEN otherwise. */
  async get(actor: Actor, setupRef: string): Promise<FamilySetupDoc | null> {
    const doc = await this.setups.findOne({ setupRef }, { projection: { _id: 0 } })
    if (!doc) return null
    this.assertOwner(actor, doc)
    return doc
  }

  private assertOwner(actor: Actor, doc: FamilySetupDoc): void {
    const p = actor.principal
    if (!isAdult(p) || doc.guardianCustomerId !== p.customerId || doc.tenantId !== p.tenantId) throw forbidden()
  }

  async start(actor: Actor, setupRef: string, children: SetupChildInput[], correlation: string): Promise<FamilySetupDoc> {
    const p = actor.principal
    if (!isAdult(p)) throw forbidden()
    validateInput(setupRef, children)

    let doc = await this.recordFirst(actor, setupRef, children.length, correlation)
    if (doc.slotCount !== children.length) throw invalid('a retry must send the same children as the first attempt')

    for (const slot of doc.slots) {
      if (slot.state !== 'PENDING') continue
      const input = children[slot.slot - 1]!
      const out = await this.bob.createLinkedChild(actor.session, slotKey(setupRef, slot.slot), input)
      if (out.kind === 'ok') {
        const v = out.value
        if (v.guardianCustomerId !== p.customerId || v.bankId !== p.tenantId) {
          // Outside the contract: never record a child that isn't linked to this Guardian in this bank.
          await this.markSlot(setupRef, slot.slot, { state: 'PENDING', reason: 'UPSTREAM_UNAVAILABLE' })
          continue
        }
        await this.markSlot(setupRef, slot.slot, {
          state: 'CREATED',
          childCustomerId: v.childCustomerId,
          linkId: v.linkId,
          accounts: v.accounts,
          reason: undefined,
        })
        await audit(this.db, { actor: p.customerId, tenantId: p.tenantId, action: 'family_setup.child_created', subject: `${setupRef}:${slot.slot}`, after: { childCustomerId: v.childCustomerId, replay: out.replay }, correlation }, this.now())
      } else if (out.kind === 'refused' && out.code === 'UNAUTHORIZED') {
        throw unauthenticated()
      } else if (out.kind === 'refused' && out.code === 'FORBIDDEN') {
        throw forbidden()
      } else if (out.kind === 'refused' && FINAL_REFUSALS.has(out.code)) {
        await this.markSlot(setupRef, slot.slot, { state: 'REFUSED', reason: out.code })
        await audit(this.db, { actor: p.customerId, tenantId: p.tenantId, action: 'family_setup.child_refused', subject: `${setupRef}:${slot.slot}`, after: { reason: out.code }, correlation }, this.now())
      } else {
        await this.markSlot(setupRef, slot.slot, { state: 'PENDING', reason: out.kind === 'refused' ? out.code : 'UPSTREAM_UNAVAILABLE' })
      }
    }

    doc = (await this.setups.findOne({ setupRef }, { projection: { _id: 0 } }))!
    const state = stateOf(doc.slots)
    let familyId = doc.familyId
    if (!isResumable(doc) && !familyId) {
      const created = doc.slots.filter((s) => s.state === 'CREATED').map((s) => s.childCustomerId!)
      if (created.length > 0) familyId = await this.writeFamily(p.tenantId, p.customerId, created)
    }
    await this.setups.updateOne({ setupRef }, { $set: { state, ...(familyId ? { familyId } : {}), updatedAt: this.now() } })
    return (await this.setups.findOne({ setupRef }, { projection: { _id: 0 } }))!
  }

  /** Record the set-up before calling BOB. A concurrent first insert (E11000) reads the winner. */
  private async recordFirst(actor: Actor, setupRef: string, count: number, correlation: string): Promise<FamilySetupDoc> {
    const p = actor.principal
    const existing = await this.setups.findOne({ setupRef }, { projection: { _id: 0 } })
    if (existing) {
      this.assertOwner(actor, existing)
      return existing
    }
    const now = this.now()
    const doc: FamilySetupDoc = {
      setupRef,
      tenantId: p.tenantId,
      guardianCustomerId: p.customerId,
      state: 'IN_PROGRESS',
      slotCount: count,
      slots: Array.from({ length: count }, (_, i) => ({ slot: i + 1, state: 'PENDING' as const, attempts: 0 })),
      createdAt: now,
      updatedAt: now,
    }
    try {
      await this.setups.insertOne({ ...doc })
      await audit(this.db, { actor: p.customerId, tenantId: p.tenantId, action: 'family_setup.started', subject: setupRef, after: { slotCount: count }, correlation }, now)
      return doc
    } catch (err) {
      if (!(err instanceof MongoServerError && err.code === 11000)) throw err
      const winner = (await this.setups.findOne({ setupRef }, { projection: { _id: 0 } }))!
      this.assertOwner(actor, winner)
      return winner
    }
  }

  private async markSlot(setupRef: string, slot: number, set: Partial<SetupSlot>): Promise<void> {
    const $set: Record<string, unknown> = { updatedAt: this.now() }
    const $unset: Record<string, ''> = {}
    for (const [k, v] of Object.entries(set)) {
      if (v === undefined) $unset[`slots.$.${k}`] = ''
      else $set[`slots.$.${k}`] = v
    }
    // Only a slot that is not yet CREATED can change: a created child is never overwritten.
    await this.setups.updateOne(
      { setupRef, slots: { $elemMatch: { slot, state: { $ne: 'CREATED' } } } },
      { $set, ...(Object.keys($unset).length ? { $unset } : {}), $inc: { 'slots.$.attempts': 1 } },
    )
  }

  /** The family pointer (spec §5): no upsert (DocumentDB); a duplicate insert means another request won. */
  private async writeFamily(tenantId: string, guardianCustomerId: string, childIds: string[]): Promise<string> {
    const families = this.db.collection('families')
    const familyId = familyIdFor(tenantId, guardianCustomerId)
    const existing = await families.findOne({ tenantId, guardianCustomerIds: guardianCustomerId }, { projection: { familyId: 1 } })
    if (existing) {
      await families.updateOne({ familyId: existing.familyId }, { $addToSet: { childCustomerIds: { $each: childIds } } })
      return existing.familyId as string
    }
    try {
      await families.insertOne({ familyId, tenantId, guardianCustomerIds: [guardianCustomerId], childCustomerIds: childIds, createdAt: this.now() })
    } catch (err) {
      if (!(err instanceof MongoServerError && err.code === 11000)) throw err
      await families.updateOne({ familyId }, { $addToSet: { childCustomerIds: { $each: childIds } } })
    }
    return familyId
  }
}

