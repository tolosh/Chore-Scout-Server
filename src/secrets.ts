/**
 * Secrets source (CS-3941).
 *
 * If CS_SECRETS_ID is set, the named secret is read from the secrets store
 * (AWS Secrets Manager, matching BOB and the DSL) as a JSON object of
 * KEY -> string. Every key in it is merged into the environment view passed to
 * loadConfig, so a BOB teller or blanket key placed in the secret is refused at
 * boot exactly as it would be in the environment. If CS_SECRETS_ID is unset,
 * the environment alone is used (local and CI).
 *
 * Nothing here has a default value; a failed or malformed read throws, and the
 * entry points exit non-zero (fail closed). Hosting is undecided (owner gap
 * G3), so no secret ARN or region is written into this repository.
 */
export interface SecretsClient {
  getSecretString(secretId: string): Promise<string | undefined>
}

export class SecretsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretsError'
  }
}

export async function awsSecretsClient(region: string | undefined): Promise<SecretsClient> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager')
  const client = new SecretsManagerClient(region ? { region } : {})
  return {
    async getSecretString(secretId) {
      const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }))
      return out.SecretString
    },
  }
}

export async function resolveEnvironment(
  env: Record<string, string | undefined>,
  clientFactory: (region: string | undefined) => Promise<SecretsClient> = awsSecretsClient,
): Promise<Record<string, string | undefined>> {
  const secretId = env.CS_SECRETS_ID
  if (!secretId) return { ...env }

  let raw: string | undefined
  try {
    const client = await clientFactory(env.AWS_REGION)
    raw = await client.getSecretString(secretId)
  } catch (err) {
    throw new SecretsError(`secrets store read failed: ${(err as Error).name}`)
  }
  if (!raw) throw new SecretsError('secrets store returned no string value')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new SecretsError('secrets store value is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SecretsError('secrets store value must be a JSON object')
  }
  const merged: Record<string, string | undefined> = { ...env }
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new SecretsError(`secrets store key ${k} must be a string`)
    if (env[k] !== undefined && env[k] !== '') {
      throw new SecretsError(`key ${k} is set in both the environment and the secrets store`)
    }
    merged[k] = v
  }
  return merged
}
