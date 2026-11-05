import { readFileSync } from 'node:fs'
import { buildSchema, isEnumType, isObjectType, type GraphQLSchema } from 'graphql'
import { describe, expect, it } from 'vitest'
import dsl from './fixtures/dsl-schema-names.json' with { type: 'json' }

const sdl = readFileSync(new URL('../schema/chorescout.v1.graphql', import.meta.url), 'utf8')
const schema: GraphQLSchema = buildSchema(sdl)
const query = schema.getQueryType()!
const mutation = schema.getMutationType()!

describe('schema/chorescout.v1.graphql', () => {
  it('builds', () => {
    expect(query).toBeDefined()
    expect(mutation).toBeDefined()
  })

  it('has no subscriptions (D14)', () => {
    expect(schema.getSubscriptionType()).toBeFalsy()
  })

  it("does not collide with the DSL's types (Money, Node, Account, ...)", () => {
    const ours = Object.keys(schema.getTypeMap()).filter((n) => !n.startsWith('__'))
    const collisions = ours.filter((n) => dsl.types.includes(n))
    expect(collisions).toEqual([])
    for (const n of ours) if (!['Query', 'Mutation', 'String', 'Int', 'Float', 'Boolean', 'ID'].includes(n)) expect(n).toMatch(/^Cs/)
  })

  it("does not reuse the DSL's root field names", () => {
    expect(Object.keys(query.getFields()).filter((f) => dsl.queryFields.includes(f))).toEqual([])
    expect(Object.keys(mutation.getFields()).filter((f) => dsl.mutationFields.includes(f))).toEqual([])
  })

  it('has every query and mutation listed in spec §6', () => {
    expect(Object.keys(query.getFields()).sort()).toEqual(
      ['viewer', 'family', 'child', 'allowance', 'jobs', 'approvals', 'unsplit', 'giving', 'goals', 'capabilities', 'card', 'demoMerchants', 'publishedTheme', 'familySetup', 'changes'].sort(),
    )
    expect(Object.keys(mutation.getFields()).sort()).toEqual(
      // Spec §6, plus createJob and retryJobPayment (CS-3949: jobs must be created; payments retried under a live session).
      ['startFamilySetup', 'setAllowance', 'createJob', 'submitJob', 'decideJob', 'retryJobPayment', 'splitUnsplit', 'setCharityPreference', 'confirmHeldRelease', 'decideUnlock', 'purchase', 'setSavingsBoost'].sort(),
    )
  })

  it('every mutation takes a required idempotency key (startFamilySetup: setupRef)', () => {
    for (const [name, f] of Object.entries(mutation.getFields())) {
      const key = name === 'startFamilySetup' ? 'setupRef' : 'idempotencyKey'
      const arg = f.args.find((a) => a.name === key)
      expect(arg, name).toBeDefined()
      expect(String(arg!.type), name).toBe('ID!')
    }
  })

  it('mutations on stale-able state take an expected version', () => {
    for (const name of ['setAllowance', 'submitJob', 'decideJob', 'retryJobPayment', 'splitUnsplit', 'setCharityPreference', 'decideUnlock', 'setSavingsBoost']) {
      expect(mutation.getFields()[name]!.args.map((a) => a.name), name).toContain('expectedVersion')
    }
    expect(mutation.getFields().confirmHeldRelease!.args.map((a) => a.name)).toContain('reviewVersion')
  })

  it('viewer comes from the session: no arguments', () => {
    expect(query.getFields().viewer!.args).toEqual([])
    expect(String(query.getFields().viewer!.type)).toBe('CsViewer!')
  })

  it('declares the spec error codes', () => {
    const e = schema.getType('CsErrorCode')
    expect(isEnumType(e) ? e.getValues().map((v) => v.name) : []).toEqual([
      'UNAUTHENTICATED', 'FORBIDDEN', 'STALE_VERSION', 'INVALID', 'INSUFFICIENT_FUNDS', 'NOT_ALLOWED_IN_STATE', 'CHARITY_UNAVAILABLE', 'UPSTREAM_UNAVAILABLE',
    ])
  })

  it('holds no card number or charity routing fields', () => {
    const fields = Object.values(schema.getTypeMap())
      .filter(isObjectType)
      .flatMap((t) => Object.keys(t.getFields()))
    for (const f of fields) expect(f).not.toMatch(/^(cardNumber|pan|cvv|bsb|accountNumber|routing|email|password)$/i)
  })

  // Storyline steps 1-7 (parent spec 3214508033 §13) and the set-up flow (identity model §3, spec §4).
  const coverage: Record<string, { q?: string[]; m?: string[] }> = {
    'set-up flow': { q: ['viewer', 'familySetup', 'family', 'allowance'], m: ['startFamilySetup', 'setAllowance'] },
    '1 family overview, jobs waiting': { q: ['family', 'child', 'jobs', 'approvals'] },
    '2 approve job, coins land': { q: ['changes'], m: ['decideJob', 'submitJob'] },
    '3 jars, goal ring, mission': { q: ['unsplit', 'goals', 'giving', 'changes'], m: ['splitUnsplit', 'setCharityPreference', 'confirmHeldRelease'] },
    '4 card tap and Pay from Spend': { q: ['card', 'demoMerchants'], m: ['purchase'] },
    '5 teen mode approval issues card': { q: ['capabilities', 'approvals', 'card'], m: ['decideUnlock'] },
    '6 boost (S1)': { m: ['setSavingsBoost'] },
    '7 second bank re-skin': { q: ['publishedTheme', 'viewer'] },
  }
  it.each(Object.entries(coverage))('covers %s', (_step, need) => {
    for (const q of need.q ?? []) expect(query.getFields()[q], q).toBeDefined()
    for (const m of need.m ?? []) expect(mutation.getFields()[m], m).toBeDefined()
  })
})
