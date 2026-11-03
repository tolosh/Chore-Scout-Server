/**
 * CLI: compare schema/ on the working tree against schema/ at a base git ref.
 *   tsx scripts/schema-compat.ts --base origin/main
 * Exit 0 compatible, 1 incompatible, 2 usage or git error.
 * If the base ref has no schema/ directory there is no baseline and only the
 * head files are validated.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareSchemaSets } from './schema-compat-lib.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const baseRef = arg('--base')
const cwd = arg('--cwd') ?? process.cwd()
if (!baseRef) {
  process.stderr.write('usage: schema-compat --base <git-ref> [--cwd <repo>]\n')
  process.exit(2)
}

const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const base = new Map<string, string>()
try {
  git(['rev-parse', '--verify', `${baseRef}^{commit}`])
} catch {
  process.stderr.write(`schema-compat: base ref ${baseRef} not found\n`)
  process.exit(2)
}
const listing = git(['ls-tree', '--name-only', `${baseRef}`, 'schema/']).split('\n').filter(Boolean)
for (const path of listing) {
  if (path.endsWith('.graphql')) base.set(path.replace(/^schema\//, ''), git(['show', `${baseRef}:${path}`]))
}

const head = new Map<string, string>()
for (const f of readdirSync(join(cwd, 'schema'))) {
  if (f.endsWith('.graphql')) head.set(f, readFileSync(join(cwd, 'schema', f), 'utf8'))
}

const result = compareSchemaSets(base, head)
process.stdout.write(
  `schema-compat: base=${baseRef} baseFiles=${base.size} headFiles=${head.size}${base.size === 0 ? ' (no baseline)' : ''}\n`,
)
for (const w of result.warnings) process.stdout.write(`WARN ${w}\n`)
for (const e of result.errors) process.stdout.write(`FAIL ${e}\n`)
process.stdout.write(result.ok ? 'schema-compat: OK\n' : 'schema-compat: INCOMPATIBLE\n')
process.exit(result.ok ? 0 : 1)
