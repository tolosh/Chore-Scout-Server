/** Builds the API with the real session-check adapter and cache over a FakeBob. */
import type { Db } from 'mongodb'
import { buildApp } from '../../src/app.js'
import { BobSessionCheck } from '../../src/bob/session-check.js'
import { BobFamilyClient } from '../../src/bob/family.js'
import { BobHttp } from '../../src/bob/http.js'
import { RESOLVERS } from '../../src/graphql/resolvers.js'
import { buildExecutableSchema } from '../../src/graphql/schema.js'
import { CachedSessionCheck } from '../../src/identity/session-check.js'
import type { FakeBob } from '../fakes/bob.js'
import { VALID_SHA } from './mongo.js'

export const BOB_URL = 'http://bob.test'

export function buildTestApi(opts: { db: Db; bob: FakeBob; now?: () => number; ttlMs?: number; clock?: () => Date }) {
  const cache = new CachedSessionCheck(new BobSessionCheck({ baseUrl: BOB_URL, timeoutMs: 1_000, fetch: opts.bob.fetch }), {
    ttlMs: opts.ttlMs,
    now: opts.now,
  })
  const http = new BobHttp({ baseUrl: BOB_URL, timeoutMs: 1_000, fetch: opts.bob.fetch, onUnauthorized: (s) => cache.invalidate(s) })
  const ports = { family: new BobFamilyClient(http) }
  const app = buildApp({
    gitSha: VALID_SHA,
    logLevel: 'silent',
    db: opts.db,
    graphql: {
      schema: buildExecutableSchema(RESOLVERS),
      sessionCheck: cache,
      services: { db: opts.db, bob: ports, sessions: cache, now: opts.clock ?? (() => new Date()) },
      production: true,
    },
  })
  const gql = async (token: string | null, query: string, variables?: Record<string, unknown>) => {
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: { query, variables },
    })
    return { status: res.statusCode, body: res.json() as { data?: Record<string, unknown> | null; errors?: { message: string; extensions?: { code?: string } }[] } }
  }
  return { app, cache, gql, ports }
}

/** The first error code of a GraphQL response, if any. */
export const codeOf = (body: { errors?: { extensions?: { code?: string } }[] }) => body.errors?.[0]?.extensions?.code
