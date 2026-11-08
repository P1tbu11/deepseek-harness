import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** CLI session remembered for one DSH session. No credentials or raw streams. */
export interface CliBinding {
  readonly cliSessionId: string
  readonly creator: boolean
}

interface BindingFile {
  readonly sessions: Readonly<Record<string, CliBinding>>
}

/**
 * Read the session map. A missing file is an empty map. Malformed JSON throws.
 * @param stateDir - directory that holds `bindings.json`.
 * @returns remembered CLI sessions.
 */
export async function readBindings(stateDir: string): Promise<Map<string, CliBinding>> {
  if (stateDir === '') return new Map()
  try {
    const text = await readFile(join(stateDir, 'bindings.json'), 'utf8')
    const parsed = JSON.parse(text) as BindingFile
    return new Map(Object.entries(parsed.sessions ?? {}))
  } catch (error: unknown) {
    if (isNotFound(error)) return new Map()
    throw error
  }
}

/**
 * Replace the session map. The write is a temp file plus rename.
 * @param stateDir - directory that holds `bindings.json`. Empty skips the write.
 * @param sessions - complete map to store.
 */
export async function writeBindings(stateDir: string, sessions: ReadonlyMap<string, CliBinding>): Promise<void> {
  if (stateDir === '') return
  await mkdir(stateDir, { recursive: true })
  const body: BindingFile = { sessions: Object.fromEntries(sessions) }
  const path = join(stateDir, 'bindings.json')
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(body)}\n`, 'utf8')
  await rename(temporary, path)
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
