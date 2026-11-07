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
  const result: ModelCatalog = { models: models.length > 0 ? models : BUILTIN_MODELS, configured }
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
