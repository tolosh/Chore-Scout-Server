/**
 * Shared boot: resolve the environment (env or secrets store), validate config,
 * and fail closed. Writes only key names and rule messages, never values.
 */
import { ConfigError, loadConfig, type Config, type Role } from './config.js'
import { resolveEnvironment, SecretsError } from './secrets.js'

export const EXIT_CONFIG = 78 // EX_CONFIG

export async function bootConfig<R extends Role>(role: R): Promise<Config<R>> {
  try {
    const env = await resolveEnvironment(process.env)
    return loadConfig(role, env)
  } catch (err) {
    if (err instanceof ConfigError || err instanceof SecretsError) {
      process.stderr.write(
        JSON.stringify({ level: 'fatal', service: 'chore-scout-server', role, msg: 'start-up refused (fail closed)', problems: err instanceof ConfigError ? err.problems : [err.message] }) + '\n',
      )
      process.exit(EXIT_CONFIG)
    }
    throw err
  }
}
