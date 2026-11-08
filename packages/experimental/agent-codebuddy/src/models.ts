/**
 * Model discovery for the CodeBuddy CLI.
 *
 * The CLI has no listing subcommand and its `models.json` is empty until a
 * session writes one, so the only authoritative source is the `--model`
 * description inside its own help output:
 *
 *   --model <model>  ... Currently supported: (a, b, c)
 *
 * Help text never wraps by terminal width, so the parenthesized list is a
 * single line. A CLI that drops or reformats that sentence yields no models;
 * callers fall back to the built-in snapshot instead of failing the session.
 *
 * @module @deepseek-ai/dsh-agent-codebuddy/models
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { DEFAULT_MODEL_ID } from './constants.ts'

/** Sentence the CLI uses to introduce the model ids it accepts. */
const SUPPORTED_PREFIX = 'Currently supported:'

/** Model ids seen before the `--model` description added the supported list. */
const BUILTIN_MODELS: readonly string[] = [
  'claude-sonnet-5',
  'claude-sonnet-5-1m',
  'claude-sonnet-4.6',
  'claude-opus-5.5',
  'claude-sonnet-5.5',
  'claude-haiku-5.5',
  'claude-opus-5',
  'claude-opus-4.8-1m',
  'claude-opus-4.7-1m',
  'claude-opus-4.6-1m',
  'gemini-3.1-pro',
  'gemini-3.5-flash',
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'glm-5.3-ioa',
  'glm-5.3-flash-ioa',
  'glm-5.3-flashx',
  'glm-5.2-ioa',
  'glm-5.2-internal-ioa',
  'minimax-m3.1-flash',
  'minimax-m3-ioa',
  'minimax-m2.7-ioa',
  'kimi-k3.1-pro',
  'kimi-k3-ioa',
  'kimi-k2.8-preview',
  'hy4std',
  'hy3-ioa',
  'echo',
  'deepseek-v4.1-flash',
  'deepseek-v4-pro-ioa',
  'mimo-v2.6-pro',
]

/** Model ids the CLI listed when this package was last released. */
export { BUILTIN_MODELS }

/**
 * Pull the supported model ids out of CLI help text.
 *
 * The synthetic default id is dropped: the catalog owns that row, and a CLI
 * that ever listed it would otherwise produce a duplicate picker entry.
 * @param help - combined stdout and stderr of `<cli> --help`.
 * @returns ids in the order the CLI printed them, without duplicates.
 */
export function parseSupportedModels(help: string): readonly string[] {
  const at = help.indexOf(SUPPORTED_PREFIX)
  if (at < 0) return []
  const open = help.indexOf('(', at + SUPPORTED_PREFIX.length)
  if (open < 0) return []
  const close = help.indexOf(')', open + 1)
  if (close < 0) return []
  const ids = help
    .slice(open + 1, close)
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '' && entry !== DEFAULT_MODEL_ID)
  return [...new Set(ids)]
}

/**
 * Read the model named by the CLI's own settings file.
 *
 * This is the model a session uses when the harness passes no `--model`, so
 * the picker can show that value as the active default instead of inventing
 * a name the CLI would reject.
 * @param settingsPath - absolute path to the CLI's `settings.json`.
 * @returns the configured model id, or `''` when the file is absent or unreadable.
 */
export async function readConfiguredModel(settingsPath: string): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return ''
    const model = (parsed as { model?: unknown }).model
    return typeof model === 'string' ? model : ''
  } catch {
    return ''
  }
}

/** Cached discovery result for one CLI executable. */
export interface ModelCatalog {
  /** Model ids the CLI accepts, in display order. */
  readonly models: readonly string[]
  /** Model the CLI uses when the harness passes no `--model`. */
  readonly configured: string
  /**
   * Whether the CLI ships the `ViewImage` tool.
   *
   * Builds before 2.174 do not have it: a session on 2.129 reports 91 tools with
   * no `ViewImage`, while 2.174 reports 69 that include it. The prompt names the
   * tool so the model opens the staged image, so this decides whether it may.
   */
  readonly viewImage: boolean
}

const cache = new Map<string, ModelCatalog>()

/**
 * Run `<cli> --help` once and read the CLI's configured model.
 * @param ctx - context whose subprocess service owns the child process.
 * @param input - absolute CLI path, settings path, and timeout.
 * @returns discovered ids and the configured default, both may be empty.
 */
export async function discoverModels(ctx: Context, input: {
  readonly command: string
  readonly args: readonly string[]
  readonly settingsPath: string
  readonly timeoutMs: number
}): Promise<ModelCatalog> {
  const key = `${input.command}\u0000${input.args.join('\u0000')}\u0000${input.settingsPath}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const configured = await readConfiguredModel(input.settingsPath)
  const models = await readHelpModels(ctx, input.command, input.args, input.timeoutMs)
  const viewImage = await readViewImageSupport(ctx, input.command, input.args, input.timeoutMs)
  const result: ModelCatalog = {
    models: models.length > 0 ? models : BUILTIN_MODELS,
    configured,
    viewImage,
  }
  cache.set(key, result)
  return result
}

/** Drop cached discovery, so the next read spawns the CLI again. */
export function clearModelCache(): void {
  cache.clear()
}

/** Spawn `<cli> --help` and parse its supported-model sentence. */
async function readHelpModels(
  ctx: Context,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<readonly string[]> {
  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv: [command, ...args, '--help'],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1 << 20 },
        stderr: { maxBytes: 1 << 20 },
      },
      graceMs: 1000,
    })
  } catch {
    return []
  }
  const timer = setTimeout(() => { handle?.terminate() }, timeoutMs)
  try {
    await handle.done
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
  const collected = handle.collected
  const stdout = collected.stdout?.readFrom(0).text ?? ''
  const stderr = collected.stderr?.readFrom(0).text ?? ''
  return parseSupportedModels(`${stdout}\n${stderr}`)
}

/** Tool name the CLI's image reader is registered under. */
const VIEW_IMAGE_TOOL = 'ViewImage'

/**
 * Detect whether the installed CLI ships `ViewImage`.
 *
 * The help text cannot answer this: 2.129 and 2.174 print byte-identical
 * `--help`, and neither lists tool names. A build's tool inventory is only
 * published in the `system`/`init` line of a live stream-json session, emitted
 * once the CLI has a prompt to answer. So this opens a throwaway session, sends
 * a one-word prompt, reads that line, and stops the process before it can spend
 * a model call — the tool list arrives before the first request is dispatched.
 *
 * A CLI that fails to start, or never reaches `init`, reports no support: the
 * staged path is then announced without naming a tool, which every build can
 * still open with `Read`.
 * @param ctx - context whose subprocess service owns the child process.
 * @param command - absolute CLI path.
 * @param args - fixed arguments configured for the CLI.
 * @param timeoutMs - deadline for the whole probe.
 * @returns whether `ViewImage` appears in the CLI's tool list.
 */
async function readViewImageSupport(
  ctx: Context,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<boolean> {
  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv: [command, ...args, ...launchProbeArgs()],
      cwd: process.cwd(),
      stdio: {
        stdin: 'pipe',
        stdout: { maxBytes: 8 << 20 },
        stderr: { maxBytes: 1 << 20 },
      },
      graceMs: 1000,
      // Lets a test fixture tell this probe apart from a real turn launch.
      env: { ...process.env, CODEBUDDY_PROBE_TOKEN: '1' },
    })
  } catch {
    return false
  }
  const write = (value: unknown): void => {
    try {
      handle?.stdin?.write(`${JSON.stringify(value)}\n`)
    } catch {
      /* a stopped CLI closes stdin; the probe then reports no support */
    }
  }
  const timer = setTimeout(() => { handle?.terminate() }, timeoutMs)
  try {
    write({
      type: 'control_request',
      request_id: 'probe-init',
      request: { subtype: 'initialize', hooks: {}, hasPrompt: true, capabilities: { askUserQuestion: true } },
    })
    // `init` is only emitted once a prompt exists, so send one. The process is
    // stopped as soon as the tool list arrives, which is before the request is
    // dispatched, so the probe never spends a model call.
    const kickoff = setTimeout(() => write({ type: 'user', message: { role: 'user', content: 'hi' } }), 100)
    try {
      for (;;) {
        if (parseToolList(handle.collected.stdout?.readFrom(0).text ?? '')) return true
        const outcome = await Promise.race([
          handle.done.then(() => 'exited' as const),
          new Promise<'tick'>(resolve => setTimeout(() => resolve('tick'), 50)),
        ])
        if (outcome === 'exited') return false
      }
    } finally {
      clearTimeout(kickoff)
    }
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    handle.terminate()
  }
}

/** Arguments that make the CLI speak stream-json for a tool-list probe. */
function launchProbeArgs(): readonly string[] {
  return ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']
}

/**
 * Read the tool list out of a stream-json transcript.
 * @param text - everything the CLI printed.
 * @returns whether `ViewImage` is among the advertised tools.
 */
export function parseToolList(text: string): boolean {
  for (const line of text.split('\n')) {
    if (line === '' || !line.includes(VIEW_IMAGE_TOOL)) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object') continue
      const entry = parsed as { type?: unknown; subtype?: unknown; tools?: unknown }
      if (entry.type !== 'system' || entry.subtype !== 'init') continue
      if (!Array.isArray(entry.tools)) continue
      return entry.tools.includes(VIEW_IMAGE_TOOL)
    } catch {
      /* not a JSON line */
    }
  }
  return false
}
