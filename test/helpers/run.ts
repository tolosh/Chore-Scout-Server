import { spawn } from 'node:child_process'

export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

/** Async spawn with a minimal environment (blocking spawnSync stalls the in-memory mongod's pipes). */
export function run(cmd: string, args: string[], env: Record<string, string>, opts: { cwd?: string; timeoutMs?: number } = {}) {
  return new Promise<RunResult>((res) => {
    const child = spawn(cmd, args, { env, cwd: opts.cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const t = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000)
    child.on('close', (status) => {
      clearTimeout(t)
      res({ status, stdout, stderr })
    })
  })
}
