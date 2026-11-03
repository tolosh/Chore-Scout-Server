/**
 * Schema-compatibility rule (CS-3941 T3).
 *
 * Contract files are schema/chorescout.v<N>.graphql. For each version file on
 * the base ref:
 *   - it must still exist on the head (a published version is never deleted here);
 *   - graphql-js findBreakingChanges(base, head) must be empty.
 * A breaking change is made by adding chorescout.v<N+1>.graphql instead.
 * New version files are allowed; each must parse and build. Dangerous changes
 * (e.g. an added enum value) are reported but do not fail.
 */
import { buildSchema, findBreakingChanges, findDangerousChanges } from 'graphql'

export const VERSION_FILE_RE = /^chorescout\.v(\d+)\.graphql$/

export interface CompatResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export function compareSchemaSets(base: Map<string, string>, head: Map<string, string>): CompatResult {
  const errors: string[] = []
  const warnings: string[] = []

  for (const [file, sdl] of head) {
    if (!VERSION_FILE_RE.test(file)) {
      errors.push(`${file}: contract files must be named chorescout.v<N>.graphql`)
      continue
    }
    try {
      buildSchema(sdl)
    } catch (err) {
      errors.push(`${file}: does not build: ${(err as Error).message}`)
    }
  }

  const headVersions = [...head.keys()]
    .map((f) => VERSION_FILE_RE.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b)
  headVersions.forEach((v, i) => {
    if (v !== i + 1) errors.push(`schema versions must be contiguous from v1; found v${headVersions.join(', v')}`)
  })

  for (const [file, baseSdl] of base) {
    if (!VERSION_FILE_RE.test(file)) continue
    const headSdl = head.get(file)
    if (headSdl === undefined) {
      errors.push(`${file}: published version removed`)
      continue
    }
    let b, h
    try {
      b = buildSchema(baseSdl)
      h = buildSchema(headSdl)
    } catch {
      continue // build errors already reported above
    }
    const n = Number(VERSION_FILE_RE.exec(file)?.[1])
    for (const c of findBreakingChanges(b, h)) {
      errors.push(`${file}: BREAKING ${c.type}: ${c.description} (bump: add chorescout.v${n + 1}.graphql)`)
    }
    for (const c of findDangerousChanges(b, h)) warnings.push(`${file}: dangerous ${c.type}: ${c.description}`)
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings }
}
