import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config.js'
import { resolveEnvironment, SecretsError, type SecretsClient } from '../src/secrets.js'
import { baseEnv } from './helpers/mongo.js'

const fake = (value: string | undefined | Error) => async (): Promise<SecretsClient> => ({
  async getSecretString() {
    if (value instanceof Error) throw value
    return value
  },
})

describe('secrets store source', () => {
  it('uses the environment alone when CS_SECRETS_ID is unset', async () => {
    const env = { A: '1' }
    expect(await resolveEnvironment(env, fake(new Error('must not be called')))).toEqual(env)
  })

  it('merges the secret JSON into the environment view', async () => {
    const { MONGODB_URI, ...rest } = baseEnv()
    const merged = await resolveEnvironment({ ...rest, CS_SECRETS_ID: 'id' }, fake(JSON.stringify({ MONGODB_URI })))
    expect(loadConfig('api', merged).MONGODB_URI).toBe(MONGODB_URI)
  })

  it('fails closed on read errors, empty values, non-JSON and non-string values', async () => {
    await expect(resolveEnvironment({ CS_SECRETS_ID: 'id' }, fake(new Error('AccessDenied')))).rejects.toBeInstanceOf(SecretsError)
    await expect(resolveEnvironment({ CS_SECRETS_ID: 'id' }, fake(undefined))).rejects.toBeInstanceOf(SecretsError)
    await expect(resolveEnvironment({ CS_SECRETS_ID: 'id' }, fake('not json'))).rejects.toBeInstanceOf(SecretsError)
    await expect(resolveEnvironment({ CS_SECRETS_ID: 'id' }, fake('{"A":1}'))).rejects.toBeInstanceOf(SecretsError)
  })

  it('refuses a key set in both places', async () => {
    await expect(resolveEnvironment({ CS_SECRETS_ID: 'id', MONGODB_URI: 'x' }, fake('{"MONGODB_URI":"y"}'))).rejects.toThrow(/both/)
  })

  it('a BOB teller key placed in the secret refuses start-up (T5)', async () => {
    const merged = await resolveEnvironment({ ...baseEnv(), CS_SECRETS_ID: 'id' }, fake('{"BOB_TELLER_TOKEN":"t"}'))
    expect(() => loadConfig('api', merged)).toThrow(ConfigError)
  })
})
