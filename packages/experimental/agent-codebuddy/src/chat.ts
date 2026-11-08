/**
 * One-shot model call over the CodeBuddy CLI.
 *
 * The session driver (`driver.ts`) keeps a resident CLI in stream-json mode and
 * lets that process own the conversation. A `ctx.llm` caller has no session to
 * continue: it wants one assembled request answered. Those get `codebuddy -p`
 * instead, which answers a single prompt and exits.
 *
 * The CLI does stream. `--output-format stream-json` emits NDJSON, and
 * `--include-partial-messages` adds token-level `stream_event` frames; both were
 * verified against build 2.181.0. That is what lets the adapter hand a real
 * chunk stream to consumers such as the media desk, session titles, and
 * compaction.
 *
 * Nothing in the request can run a tool. `--strict-mcp-config` keeps every MCP
 * server out, and neither `--permission-mode` nor `-y` is passed, so the CLI's
 * own gate — which the CLI documents as requiring explicit pre-authorization in
 * headless mode — refuses any tool call the model attempts. Every prompt is
 * flattened to text turns for the same reason: no message in the request can
 * ask for a tool this call is unable to answer.
 *
 * @module @deepseek-ai/dsh-agent-codebuddy/chat
 */
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, StreamChunk, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { DEFAULT_MODEL_ID } from './constants.ts'
import { resolveCliPath } from './probe.ts'
import type CodeBuddySettingsService from './settings.ts'
import { redact } from './transport.ts'

/** The prompt one one-shot call sends, plus the replacement system prompt. */
export interface OneShotInput {
  /** Text written to the CLI's stdin. */
  readonly prompt: string
  /** Replacement system prompt, or `''` to leave the CLI's own in place. */
  readonly system: string
}

/**
 * Render one message's blocks as model-visible text.
 *
 * An image occurrence becomes a placeholder, never bytes: the one-shot call has
 * no tool that could open a staged file, and an attachment reference means
 * nothing to a CLI that never sees the harness. The session driver still sends
 * images natively, so this projection is this module's alone and does not
 * change the modalities the catalog advertises.
 * @param content - the message's content blocks.
 * @returns the joined visible text.
 */
function visibleText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image omitted: this one-shot call sends text only]')
  }
  return parts.filter(part => part !== '').join('\n')
}

/**
 * Flatten an assembled request into the single prompt the CLI accepts.
 *
 * A one-shot process has no history of its own, so earlier turns are written
 * into the prompt with role labels. A lone user turn — the shape of an auxiliary
 * call — is sent bare instead of labelled, which keeps a caller's own wording
 * intact. System text becomes `--system-prompt` so the CLI's coding-agent
 * persona is replaced rather than competing with the caller's instructions.
 * @param options - the assembled request.
 * @returns the prompt text and the replacement system prompt.
 * @throws LlmError when the request carries nothing to answer.
 */
export function buildOneShotInput(options: GenerateOptions): OneShotInput {
  const system: string[] = []
  if (options.system !== undefined && options.system !== '') system.push(options.system)
  const turns: { role: string; text: string }[] = []
  for (const message of options.messages) {
    if (message.role === 'developer') continue
    const text = visibleText(message.content)
    if (text === '') continue
    if (message.role === 'system') system.push(text)
    else turns.push({ role: message.role, text })
  }
  if (turns.length === 0) {
    throw new LlmError('CodeBuddy one-shot call has no user content to answer', 'INVALID_ARGS')
  }
  const only = turns.length === 1 ? turns[0] : undefined
  const prompt = only !== undefined && only.role === 'user'
    ? only.text
    : turns.map((turn) => {
      if (turn.role === 'user') return turn.text
      if (turn.role === 'assistant') return `Assistant: ${turn.text}`
      return `Tool result: ${turn.text}`
    }).join('\n\n')
  return { prompt, system: system.join('\n\n') }
}

/**
 * Arguments that make one `-p` call answer a single prompt.
 *
 * `--verbose` is the CLI's own requirement for `--output-format stream-json`.
 * `--tools ''` and `--strict-mcp-config` keep the request tool-free where the
 * build honors them; omitting `--permission-mode` and `-y` is what actually
 * prevents execution on a build that ignores `--tools`.
 * @param input - model id (absent for the CLI's own default) and system prompt.
 * @returns argv after the executable.
 */
export function oneShotArgs(input: { readonly model?: string; readonly system?: string }): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--tools', '',
    '--strict-mcp-config',
    '--no-session-persistence',
  ]
  if (input.model !== undefined && input.model !== '') args.push('--model', input.model)
  if (input.system !== undefined && input.system !== '') args.push('--system-prompt', input.system)
  return args
}

/** One text or reasoning block accumulating from stream deltas. */
interface OpenBlock {
  /** Adapter-side index, assigned in the order blocks open. */
  readonly index: number
  readonly block: Extract<ContentBlock, { type: 'text' | 'reasoning' }>
}

/** Read one value as a plain record, without trusting its shape. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Wire field to harness field for the token counters the two vocabularies share. */
const USAGE_FIELDS = {
  input_tokens: 'inputTokens',
  output_tokens: 'outputTokens',
  cache_read_input_tokens: 'cacheReadTokens',
  cache_creation_input_tokens: 'cacheWriteTokens',
} as const

/**
 * Copy cumulative usage onto the harness vocabulary.
 *
 * The CLI reports the same counters in several frames that supersede one
 * another, so later values overwrite earlier ones instead of accumulating.
 *
 * `input_tokens` is reduced to its uncached part. The CLI folds cache reads
 * into that total (a live call reported 30513 alongside 30336 cached, leaving
 * 177 uncached), while the harness requires the counters to be disjoint and
 * sums them for its context gauge. Keeping the total double-counted the prompt.
 * @param target - the running usage value.
 * @param raw - a provider usage object.
 */
function readUsage(target: TokenUsage, raw: unknown): void {
  const usage = record(raw)
  if (usage === undefined) return
  const counters: Record<string, number> = {}
  for (const [wire, local] of Object.entries(USAGE_FIELDS)) {
    const value = usage[wire]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) counters[local] = value
  }
  if (counters.outputTokens !== undefined) target.outputTokens = counters.outputTokens
  const cacheRead = counters.cacheReadTokens ?? 0
  const cacheWrite = counters.cacheWriteTokens ?? 0
  if (counters.inputTokens !== undefined) {
    // Clamped: a proxy reporting cache counters without folding them in would
    // otherwise produce a negative count and a NaN ratio downstream.
    target.inputTokens = Math.max(0, counters.inputTokens - cacheRead - cacheWrite)
  }
  if (counters.cacheReadTokens !== undefined) target.cacheReadTokens = cacheRead
  if (counters.cacheWriteTokens !== undefined) target.cacheWriteTokens = cacheWrite
}

/** Map the CLI's stop reason onto the harness vocabulary. */
function stopReason(raw: unknown): FinishReason {
  switch (raw) {
    case 'tool_use': return { kind: 'tool-calls' }
    case 'max_tokens': return { kind: 'max-tokens' }
    default: return { kind: 'stop' }
  }
}

/**
 * Translate one CLI transcript into harness chunks.
 *
 * Deltas are authoritative when the build streams them; a build that answers
 * with only whole `assistant` messages still produces blocks, because that
 * fallback runs whenever no delta arrived in the current message. `result` is
 * the only terminal frame — an assistant message can be followed by another
 * round, so ending on it would truncate a multi-round answer.
 */
export class CliStream {
  private open: OpenBlock | undefined
  private nextIndex = 0
  private sawDelta = false
  private textSeen = false
  private settled = false
  private reason: FinishReason = { kind: 'stop' }
  private readonly usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  private failed: string | undefined

  /**
   * Fold one parsed NDJSON line.
   * @param message - the parsed object.
   * @returns chunks to emit, in order.
   */
  push(message: Record<string, unknown>): StreamChunk[] {
    const type = typeof message.type === 'string' ? message.type : ''
    if (type === 'stream_event') return this.event(record(message.event))
    if (type === 'assistant') return this.assistant(record(message.message))
    if (type === 'system') {
      readUsage(this.usage, turnUsage(message))
      return []
    }
    if (type === 'result') return this.result(message)
    return []
  }

  private event(event: Record<string, unknown> | undefined): StreamChunk[] {
    if (event === undefined) return []
    if (event.type === 'message_start') {
      this.sawDelta = false
      readUsage(this.usage, record(event.message)?.usage)
      return []
    }
    if (event.type === 'content_block_start') return this.startBlock(record(event.content_block))
    if (event.type === 'content_block_delta') return this.delta(record(event.delta))
    if (event.type === 'content_block_stop') return this.stopBlock()
    if (event.type === 'message_delta') {
      const reason = record(event.delta)?.stop_reason
      if (reason !== undefined && reason !== null) this.reason = stopReason(reason)
      readUsage(this.usage, event.usage)
    }
    return []
  }

  private startBlock(block: Record<string, unknown> | undefined): StreamChunk[] {
    if (block === undefined || this.open !== undefined) return []
    if (block.type === 'text') this.open = { index: this.nextIndex, block: { type: 'text', text: '' } }
    else if (block.type === 'thinking') this.open = { index: this.nextIndex, block: { type: 'reasoning', text: '' } }
    else {
      // Nobody here could execute a tool block, and the request carries none.
      // Failing loudly beats writing a call whose result will never arrive.
      this.failed = `CodeBuddy one-shot call produced a "${String(block.type)}" block, which this route cannot execute`
      return []
    }
    this.nextIndex += 1
    return [{ type: 'block-start', index: this.open.index, blockType: this.open.block.type }]
  }

  private delta(delta: Record<string, unknown> | undefined): StreamChunk[] {
    const open = this.open
    if (delta === undefined || open === undefined) return []
    if (delta.type === 'text_delta' && open.block.type === 'text' && typeof delta.text === 'string') {
      if (delta.text === '') return []
      this.sawDelta = true
      this.textSeen = true
      open.block.text += delta.text
      return [{ type: 'text-delta', index: open.index, text: delta.text }]
    }
    if (delta.type === 'thinking_delta' && open.block.type === 'reasoning' && typeof delta.thinking === 'string') {
      if (delta.thinking === '') return []
      this.sawDelta = true
      open.block.text += delta.thinking
      return [{ type: 'reasoning-delta', index: open.index, text: delta.thinking }]
    }
    return []
  }

  private stopBlock(): StreamChunk[] {
    const open = this.open
    if (open === undefined) return []
    this.open = undefined
    return [{ type: 'block-end', index: open.index, block: { ...open.block } }]
  }

  /**
   * Fallback for a build that does not stream deltas.
   * @param message - the assistant message body.
   * @returns the chunks a delta stream would have produced.
   */
  private assistant(message: Record<string, unknown> | undefined): StreamChunk[] {
    if (message === undefined) return []
    readUsage(this.usage, message.usage)
    if (this.sawDelta || !Array.isArray(message.content)) return []
    const chunks: StreamChunk[] = []
    for (const entry of message.content) {
      const block = record(entry)
      if (block === undefined) continue
      const text = block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : block.type === 'thinking' && typeof block.thinking === 'string' ? block.thinking : undefined
      if (text === undefined || text === '') continue
      const index = this.nextIndex
      this.nextIndex += 1
      if (block.type === 'text') {
        this.textSeen = true
        chunks.push({ type: 'block-start', index, blockType: 'text' })
        chunks.push({ type: 'text-delta', index, text })
        chunks.push({ type: 'block-end', index, block: { type: 'text', text } })
      } else {
        chunks.push({ type: 'block-start', index, blockType: 'reasoning' })
        chunks.push({ type: 'reasoning-delta', index, text })
        chunks.push({ type: 'block-end', index, block: { type: 'reasoning', text } })
      }
    }
    return chunks
  }

  private result(message: Record<string, unknown>): StreamChunk[] {
    readUsage(this.usage, message.usage)
    if (message.is_error === true || message.subtype !== 'success') {
      const detail = typeof message.result === 'string' && message.result !== ''
        ? redact(message.result).slice(0, 500)
        : 'the CLI reported a failed turn'
      this.failed = `CodeBuddy one-shot call failed: ${detail}`
    }
    return this.settle()
  }

  /**
   * Settle a run that never produced a `result` frame.
   * @param outcome - exit code and the redacted stderr tail.
   * @returns nothing; `result` is the only frame that yields terminal chunks.
   * @throws LlmError when the turn failed or ended without settling.
   */
  end(outcome: { readonly exitCode: number | null; readonly stderr: string }): StreamChunk[] {
    if (this.settled) return []
    const tail = outcome.stderr === '' ? '' : `: ${redact(outcome.stderr).slice(-400)}`
    throw new LlmError(
      `CodeBuddy one-shot call ended without a result frame (exit ${String(outcome.exitCode)})${tail}`,
      'CODEBUDDY_ONE_SHOT',
    )
  }

  /**
   * Emit usage and finish exactly once.
   * @returns the terminal chunks, or nothing after a repeated frame.
   * @throws LlmError when the turn failed or carried no visible text.
   */
  private settle(): StreamChunk[] {
    if (this.settled) return []
    this.settled = true
    if (this.failed !== undefined) throw new LlmError(this.failed, 'CODEBUDDY_ONE_SHOT')
    if (!this.textSeen) throw new LlmError('CodeBuddy one-shot call returned no content', 'EMPTY_RESPONSE')
    // Every counter is disjoint here, so the total is their plain sum.
    this.usage.totalTokens = this.usage.inputTokens + this.usage.outputTokens
      + (this.usage.cacheReadTokens ?? 0) + (this.usage.cacheWriteTokens ?? 0)
    return [
      { type: 'usage', usage: this.usage },
      { type: 'finish', reason: this.reason },
    ]
  }
}

/** Pull the cumulative usage out of a `system`/`usage_update` frame. */
function turnUsage(message: Record<string, unknown>): unknown {
  const meta = record(message._meta)
  const turn = record(meta?.['codebuddy.ai/turnUsage'])
  return record(turn?.total)?.usage
}

/**
 * Answer one request with a single `codebuddy -p` process.
 * @param ctx - context whose subprocess service owns the child process.
 * @param settings - deployment settings carrying the CLI path and grace period.
 * @param options - the assembled request.
 * @returns harness chunks, ending with exactly one terminal finish.
 */
export async function* streamOneShot(
  ctx: Context,
  settings: CodeBuddySettingsService,
  options: GenerateOptions,
): AsyncGenerator<StreamChunk> {
  const input = buildOneShotInput(options)
  const command = await resolveCliPath({
    command: settings.config.command,
    probe: settings.config.probe,
    timeoutMs: settings.config.probeTimeoutMs,
  })
  const handle = ctx.subprocess.spawn({
    argv: [
      command,
      ...settings.config.args,
      ...oneShotArgs({
        ...options.model === DEFAULT_MODEL_ID ? {} : { model: options.model },
        system: input.system,
      }),
    ],
    cwd: process.cwd(),
    stdio: {
      stdin: { data: input.prompt },
      stdout: 'pipe',
      stderr: { maxBytes: 64 << 10 },
    },
    graceMs: settings.config.graceMs,
    ...options.signal === undefined ? {} : { signal: options.signal },
    // Lets a test fixture tell this one-shot call apart from a driven turn.
    env: { ...process.env, CODEBUDDY_ONESHOT_TOKEN: '1' },
  })
  const stream = new CliStream()
  try {
    if (handle.stdout !== undefined) {
      const lines = createInterface({ input: handle.stdout, crlfDelay: Infinity })
      for await (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          continue
        }
        const message = record(parsed)
        if (message === undefined) continue
        for (const chunk of stream.push(message)) yield chunk
      }
    }
    const outcome = await handle.done.catch(() => ({ exitCode: null }))
    for (const chunk of stream.end({
      exitCode: outcome.exitCode,
      stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    })) yield chunk
    options.signal?.throwIfAborted()
  } finally {
    handle.terminate()
  }
}
