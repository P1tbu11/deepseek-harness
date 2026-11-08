import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** How long a single path stat may take before the probe treats it as missing. */
export const DEFAULT_PROBE_TIMEOUT_MS = 1500

/**
 * Fixed locations checked only after the plugin is explicitly enabled.
 * `CODEBUDDY_BIN` is used only when it is already an absolute path.
 * @param env - environment to read `CODEBUDDY_BIN` from.
 * @returns absolute candidate paths, without searching `PATH`.
 */
export function candidateCliPaths(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const home = homedir()
  const configured = env.CODEBUDDY_BIN
  const paths = [
    ...configured !== undefined && isAbsolute(configured) ? [configured] : [],
    join(home, '.local', 'bin', 'codebuddy'),
    join(home, '.local', 'bin', 'cbc'),
    '/usr/local/bin/codebuddy',
    '/opt/homebrew/bin/codebuddy',
    '/usr/bin/codebuddy',
  ]
  return [...new Set(paths)]
}

/**
 * Resolve the CLI executable. An absolute `command` wins and is not probed.
 * Probing stats candidates until the timeout; it never spawns or downloads.
 * @param input - explicit command and probe budget.
 * @returns the absolute executable path.
 */
export async function resolveCliPath(input: {
  readonly command: string
  readonly probe: boolean
  readonly timeoutMs: number
  readonly env?: NodeJS.ProcessEnv
}): Promise<string> {
  if (input.command !== '') {
    if (!isAbsolute(input.command)) {
      throw new Error('codebuddy command must be an absolute path')
    }
    await assertFile(input.command, input.timeoutMs)
    return input.command
  }
  if (!input.probe) throw new Error('codebuddy command is empty and probing is disabled')
  const misses: string[] = []
  for (const path of candidateCliPaths(input.env)) {
    try {
      await assertFile(path, input.timeoutMs)
      return path
    } catch (error: unknown) {
      misses.push(`${path}: ${error instanceof Error ? error.message : 'missing'}`)
    }
  }
  throw new Error(`codebuddy CLI was not found (${misses.join('; ')})`)
}

async function assertFile(path: string, timeoutMs: number): Promise<void> {
  const check = stat(path).then((info) => {
    if (!info.isFile()) throw new Error('not a file')
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`stat timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    await Promise.race([check, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
