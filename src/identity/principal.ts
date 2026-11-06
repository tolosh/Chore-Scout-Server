/**
 * The signed-in person, as BOB's session check answers (contract bob-session/1,
 * Confluence 3224666113; spec 3220570116 §3.2; identity model 3220897793 §4.5).
 * The BOB adapter (src/bob/session-check.ts) maps the wire response to this
 * shape; nothing else in the server reads BOB's wire format.
 *
 * Identifiers are BOB customer numbers, link ids and BOB's anonymous player
 * numbers only. No names, emails or dates of birth (CS-3942 §4; contract §4.1).
 */
export type BobRole = 'customer' | 'guardian' | 'child'
export type AgeBand = 'CHILD' | 'YOUTH'

export interface LinkedPerson {
  readonly customerId: string
  readonly linkId: string
  /** Child entries: pending until the child's first sign-in. Guardian entries: always active. */
  readonly status: 'pending' | 'active'
  /** Child entries only: the child's anonymous player number, as BOB returned it. */
  readonly playerRef: string | null
}

export interface Principal {
  readonly customerId: string
  /** BOB's bank id (bank_bilgola, bank_manly). The tenant; never taken from the request. */
  readonly tenantId: string
  readonly roles: readonly BobRole[]
  /** Child sessions only (from child.age_band). Null for adults. */
  readonly ageBand: AgeBand | null
  readonly playerRef: string
  /** Guardian sessions: BOB's non-revoked links to children. The only source of family scope. */
  readonly children: readonly LinkedPerson[]
  /** Child sessions: BOB's non-revoked links to guardians. */
  readonly guardians: readonly LinkedPerson[]
  /** Non-secret session id; safe to log (contract §4.1). */
  readonly sessionId: string
}

export const isChild = (p: Principal): boolean => p.roles.includes('child')
/** An adult customer: may start a family set-up; is a Guardian once BOB links a child. */
export const isAdult = (p: Principal): boolean => !isChild(p) && p.roles.includes('customer')
export const isGuardian = (p: Principal): boolean => !isChild(p) && p.roles.includes('guardian')

/**
 * The person's BOB access token, as forwarded by the DSL. Opaque: never parsed
 * (contract §3.1). It is passed to BOB on every call made on this person's
 * behalf and is never logged, stored or serialised: toString and toJSON redact it.
 */
export class SessionToken {
  readonly #value: string
  constructor(value: string) {
    this.#value = value
  }
  /** The raw token, for an outbound BOB call's Authorization header only. */
  reveal(): string {
    return this.#value
  }
  toString(): string {
    return '[session]'
  }
  toJSON(): string {
    return '[session]'
  }
}

/** A request's acting person: who BOB says they are, plus their session for onward BOB calls. */
export interface Actor {
  readonly principal: Principal
  readonly session: SessionToken
}
