/**
 * Errors carried to clients as GraphQL errors with extensions.code set to a
 * CsErrorCode value (schema/chorescout.v1.graphql, spec 3220570116 §6).
 */
import { GraphQLError } from 'graphql'

export type CsErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'STALE_VERSION'
  | 'INVALID'
  | 'INSUFFICIENT_FUNDS'
  | 'NOT_ALLOWED_IN_STATE'
  | 'CHARITY_UNAVAILABLE'
  | 'UPSTREAM_UNAVAILABLE'

export class CsError extends GraphQLError {
  constructor(
    public readonly code: CsErrorCode,
    message: string,
  ) {
    super(message, { extensions: { code } })
    this.name = 'CsError'
  }
}

export const unauthenticated = (msg = 'session not valid') => new CsError('UNAUTHENTICATED', msg)
export const forbidden = (msg = 'not permitted for this session') => new CsError('FORBIDDEN', msg)
export const invalid = (msg: string) => new CsError('INVALID', msg)
export const stale = (msg = 'expected version does not match') => new CsError('STALE_VERSION', msg)
export const notAllowedInState = (msg: string) => new CsError('NOT_ALLOWED_IN_STATE', msg)
export const upstreamUnavailable = (msg = 'BOB unavailable') => new CsError('UPSTREAM_UNAVAILABLE', msg)
