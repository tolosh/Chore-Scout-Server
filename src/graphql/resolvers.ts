/** All resolvers, merged per type. Each ticket adds its own module here. */
import { identityResolvers } from './identity-resolvers.js'
import type { ResolverMap } from './schema.js'

export function mergeResolvers(...maps: ResolverMap[]): ResolverMap {
  const out: ResolverMap = {}
  for (const m of maps) {
    for (const [type, fields] of Object.entries(m)) {
      out[type] ??= {}
      for (const [name, fn] of Object.entries(fields)) {
        if (out[type][name]) throw new Error(`duplicate resolver ${type}.${name}`)
        out[type][name] = fn
      }
    }
  }
  return out
}

export const RESOLVERS: ResolverMap = mergeResolvers(identityResolvers)
