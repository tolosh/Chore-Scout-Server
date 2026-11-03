import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareSchemaSets } from '../scripts/schema-compat-lib.js'

const V1 = readFileSync(new URL('../schema/chorescout.v1.graphql', import.meta.url), 'utf8')
const CLI = resolve('scripts/schema-compat.ts')
const TSX = resolve('node_modules/.bin/tsx')
const m = (o: Record<string, string>) => new Map(Object.entries(o))

describe('compareSchemaSets', () => {
  it('identical schemas are compatible', () => {
    expect(compareSchemaSets(m({ 'chorescout.v1.graphql': V1 }), m({ 'chorescout.v1.graphql': V1 })).ok).toBe(true)
  })

  it('an additive change is compatible', () => {
    const head = V1.replace('type CsGoal {', 'type CsGoal {\n  emoji: String')
    expect(compareSchemaSets(m({ 'chorescout.v1.graphql': V1 }), m({ 'chorescout.v1.graphql': head })).ok).toBe(true)
  })

  it('a breaking change in place fails and asks for a bump', () => {
    const head = V1.replace('  maskedNumber: String!\n', '')
    const r = compareSchemaSets(m({ 'chorescout.v1.graphql': V1 }), m({ 'chorescout.v1.graphql': head }))
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/FIELD_REMOVED.*maskedNumber.*chorescout\.v2\.graphql/)
  })

  it('a breaking change shipped as v2, with v1 unchanged, passes', () => {
    const v2 = V1.replace('  maskedNumber: String!\n', '')
    expect(compareSchemaSets(m({ 'chorescout.v1.graphql': V1 }), m({ 'chorescout.v1.graphql': V1, 'chorescout.v2.graphql': v2 })).ok).toBe(true)
  })

  it('removing a published version fails; gaps in versions fail; bad names fail', () => {
    expect(compareSchemaSets(m({ 'chorescout.v1.graphql': V1 }), m({ 'chorescout.v2.graphql': V1 })).ok).toBe(false)
    expect(compareSchemaSets(m({}), m({ 'chorescout.v1.graphql': V1, 'chorescout.v3.graphql': V1 })).ok).toBe(false)
    expect(compareSchemaSets(m({}), m({ 'chorescout.graphql': V1 })).ok).toBe(false)
  })

  it('a schema that does not build fails', () => {
    expect(compareSchemaSets(m({}), m({ 'chorescout.v1.graphql': 'type Query { x: Missing }' })).ok).toBe(false)
  })
})

describe('schema-compat CLI against a real git base (T3)', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'cs-compat-'))
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@example.invalid')
    g('config', 'user.name', 't')
    cpSync(resolve('schema'), join(dir, 'schema'), { recursive: true })
    g('add', '.')
    g('commit', '-q', '-m', 'base')
    return dir
  }
  const run = () => spawnSync(TSX, [CLI, '--base', 'main', '--cwd', dir], { encoding: 'utf8' })

  it('passes with no change', () => {
    setup()
    const r = run()
    expect(r.status, r.stdout + r.stderr).toBe(0)
  })

  it('exits 1 on a breaking change without a version bump', () => {
    setup()
    writeFileSync(join(dir, 'schema/chorescout.v1.graphql'), V1.replace('  maskedNumber: String!\n', ''))
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/INCOMPATIBLE/)
  })

  it('exits 0 when the breaking change is a new v2 file', () => {
    setup()
    writeFileSync(join(dir, 'schema/chorescout.v2.graphql'), V1.replace('  maskedNumber: String!\n', ''))
    expect(run().status).toBe(0)
  })

  it('exits 2 on an unknown base ref', () => {
    setup()
    expect(spawnSync(TSX, [CLI, '--base', 'nope', '--cwd', dir], { encoding: 'utf8' }).status).toBe(2)
  })
})
