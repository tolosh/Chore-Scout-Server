/**
 * POST /graphql (CS-3942). Reached only from the DSL (CS-3994).
 *
 * Inbound session: `Authorization: Bearer <the person's BOB access token>`,
 * forwarded unchanged by the DSL (spec §3.3; contract bob-session/1 §3).
 * The token is checked with BOB before anything else (parsing, validation,
 * introspection or execution). Then:
 * - no or malformed header, or BOB refuses   -> HTTP 401, UNAUTHENTICATED;
 * - BOB unavailable or outside its contract   -> HTTP 503, UPSTREAM_UNAVAILABLE;
 * - otherwise the operation runs as that person, HTTP 200, with any
 *   per-field errors in the GraphQL response.
 * The token is never logged. Log lines carry BOB's session_id and customer_id.
 * Introspection is refused in production; the contract is the SDL in this repo.
 */
import { GraphQLError, NoSchemaIntrospectionCustomRule, execute, parse, specifiedRules, validate, type GraphQLSchema } from 'graphql'
import type { FastifyInstance } from 'fastify'
import { CsError } from '../errors.js'
import { SessionToken } from '../identity/principal.js'
import type { SessionCheck } from '../identity/session-check.js'
import type { RequestContext, Services } from './context.js'

/** RFC 6750 bearer token characters; anything else is refused without calling BOB. */
const BEARER_RE = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/
const MAX_TOKEN_LENGTH = 512

export interface GraphqlRouteDeps {
  schema: GraphQLSchema
  sessionCheck: SessionCheck
  services: Services
  production: boolean
}

const errorBody = (err: CsError) => ({ errors: [{ message: err.message, extensions: { code: err.code } }] })

export function extractSession(header: string | string[] | undefined): SessionToken | null {
  if (typeof header !== 'string' || header.length > MAX_TOKEN_LENGTH + 7) return null
  const m = BEARER_RE.exec(header)
  return m?.[1] ? new SessionToken(m[1]) : null
}

export function registerGraphql(app: FastifyInstance, deps: GraphqlRouteDeps): void {
  const rules = deps.production ? [...specifiedRules, NoSchemaIntrospectionCustomRule] : specifiedRules

  app.post('/graphql', async (req, reply) => {
    const session = extractSession(req.headers.authorization)
    if (!session) return reply.code(401).send(errorBody(new CsError('UNAUTHENTICATED', 'session required')))

    let principal
    try {
      principal = (await deps.sessionCheck.check(session)).principal
    } catch (err) {
      const e = err instanceof CsError ? err : new CsError('UPSTREAM_UNAVAILABLE', 'session check unavailable')
      req.log.info({ code: e.code }, 'session refused')
      return reply.code(e.code === 'UNAUTHENTICATED' ? 401 : 503).send(errorBody(e))
    }
    const log = req.log.child({ sessionId: principal.sessionId, customerId: principal.customerId, tenantId: principal.tenantId })

    const b = req.body as { query?: unknown; variables?: unknown; operationName?: unknown } | undefined
    if (!b || typeof b.query !== 'string') return reply.code(400).send(errorBody(new CsError('INVALID', 'query required')))
    let doc
    try {
      doc = parse(b.query)
    } catch (err) {
      return reply.code(400).send({ errors: [{ message: (err as GraphQLError).message, extensions: { code: 'INVALID' } }] })
    }
    const validationErrors = validate(deps.schema, doc, rules)
    if (validationErrors.length > 0) {
      return reply.code(400).send({ errors: validationErrors.map((e) => ({ message: e.message, extensions: { code: 'INVALID' } })) })
    }
    const ctx: RequestContext = { ...deps.services, actor: { principal, session }, log, correlationId: req.id }
    const result = await execute({
      schema: deps.schema,
      document: doc,
      variableValues: b.variables && typeof b.variables === 'object' ? (b.variables as Record<string, unknown>) : undefined,
      operationName: typeof b.operationName === 'string' ? b.operationName : undefined,
      contextValue: ctx,
    })
    const errors = result.errors?.map((e) => {
      const code = e.extensions?.code ?? (e.originalError instanceof CsError ? e.originalError.code : undefined)
      if (code) return { message: e.message, path: e.path, extensions: { code } }
      log.error({ err: e.originalError?.message ?? e.message, path: e.path }, 'resolver error')
      return { message: 'internal error', path: e.path, extensions: { code: 'INTERNAL' } }
    })
    return reply.code(200).send(errors ? { data: result.data ?? null, errors } : { data: result.data })
  })
}
