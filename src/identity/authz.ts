/**
 * Authorisation helpers (CS-3942). Every decision is BOB's answer:
 * family scope is the presenting Guardian's own `children` list, or a child's
 * own customer id (contract bob-session/1 §7; identity model §6). No server
 * table, manifest or client-supplied id ever widens it. Client ids select;
 * they never authorise (spec §3.4).
 *
 * Refusals are FORBIDDEN with one message, whether or not the object exists.
 */
import { forbidden } from '../errors.js'
import { isAdult, isChild, type Principal } from './principal.js'

/** May this person see or act on objects belonging to this child? */
export function canAccessChild(p: Principal, childCustomerId: string): boolean {
  if (isChild(p)) return childCustomerId === p.customerId
  if (isAdult(p)) return p.children.some((c) => c.customerId === childCustomerId)
  return false
}

export function assertChildAccess(p: Principal, childCustomerId: string): void {
  if (!canAccessChild(p, childCustomerId)) throw forbidden()
}

/** Guardian-only actions on a linked child (approve, set allowance, ...). */
export function assertGuardianOf(p: Principal, childCustomerId: string): void {
  if (isChild(p) || !p.children.some((c) => c.customerId === childCustomerId)) throw forbidden()
}

/** Child-only actions on their own objects (split, purchase, ...). */
export function assertChildSelf(p: Principal, childCustomerId: string): void {
  if (!isChild(p) || p.customerId !== childCustomerId) throw forbidden()
}

/** Defence in depth: a stored object from another bank is never served, whatever the links say. */
export function assertSameTenant(p: Principal, tenantId: string): void {
  if (p.tenantId !== tenantId) throw forbidden()
}

/** Children this person may see: a Guardian's linked children, or a child themselves. */
export function visibleChildIds(p: Principal): string[] {
  if (isChild(p)) return [p.customerId]
  if (isAdult(p)) return p.children.map((c) => c.customerId)
  return []
}
