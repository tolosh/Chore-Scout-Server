/**
 * Executable schema for schema/chorescout.v1.graphql (CS-3942 onwards).
 *
 * The SDL file is the contract; resolvers attach to it here. Root fields that
 * no ticket has built yet refuse with UPSTREAM_UNAVAILABLE and say so, rather
 * than returning a made-up or empty answer.
 */
import { readFileSync } from 'node:fs'
import { buildSchema, isObjectType, type GraphQLFieldResolver, type GraphQLSchema } from 'graphql'
import { CsError } from '../errors.js'
import type { RequestContext } from './context.js'

export const SDL_URL = new URL('../../schema/chorescout.v1.graphql', import.meta.url)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Resolver = GraphQLFieldResolver<any, RequestContext, any>
export type ResolverMap = Record<string, Record<string, Resolver>>

export function buildExecutableSchema(resolvers: ResolverMap, sdl = readFileSync(SDL_URL, 'utf8')): GraphQLSchema {
  const schema = buildSchema(sdl)
  for (const [typeName, fields] of Object.entries(resolvers)) {
    const type = schema.getType(typeName)
    if (!isObjectType(type)) throw new Error(`resolver for unknown type ${typeName}`)
    const defs = type.getFields()
    for (const [fieldName, fn] of Object.entries(fields)) {
      const def = defs[fieldName]
      if (!def) throw new Error(`resolver for unknown field ${typeName}.${fieldName}`)
      def.resolve = fn
    }
  }
  for (const root of [schema.getQueryType(), schema.getMutationType()]) {
    if (!root) continue
    for (const [name, def] of Object.entries(root.getFields())) {
      if (resolvers[root.name]?.[name]) continue
      def.resolve = () => {
        throw new CsError('UPSTREAM_UNAVAILABLE', `${root.name}.${name} is not built in this release`)
      }
    }
  }
  return schema
}
