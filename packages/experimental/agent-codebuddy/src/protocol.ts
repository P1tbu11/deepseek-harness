import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { BRIDGE_SERVER } from './constants.ts'
import { stripInlineToolCalls } from './dsml.ts'

/** One NDJSON object from the CLI stdout stream. */
export type ProtocolMessage = Readonly<Record<string, unknown>>

/**
 * One live chunk of the model's own token stream.
 *
 * Every `stream_event` carries the index of the content block its delta belongs
 * to. Projecting that index rather than flattening everything onto block 0 keeps
 * reasoning and answer text in separate blocks, so the client appends each delta
 * to the block it belongs to while the reply is still arriving.
 */
export type LiveChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: 'text' | 'reasoning' }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }

/** What the driver commits. Payloads are the CLI's own text, ids, and arguments. */
export type Projected =
  | { readonly kind: 'session'; readonly cliSessionId: string }
  | { readonly kind: 'live-chunk'; readonly chunk: LiveChunk }
  | { readonly kind: 'assistant'; readonly blocks: readonly AssistantOut[] }
  | { readonly kind: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }
  | { readonly kind: 'tool-result'; readonly id: string; readonly text: string; readonly isError: boolean }
  | { readonly kind: 'usage'; readonly usage: TokenUsage }
  | { readonly kind: 'result'; readonly text: string; readonly isError: boolean }
  | { readonly kind: 'diagnostic'; readonly code: string; readonly detail: string }

/** One text or reasoning block copied from an assistant message. */
export type AssistantOut =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }

/** A block the CLI streams token by token, and the text accumulated so far. */
interface LiveBlock {
  readonly type: 'text' | 'reasoning'
  text: string
}

/** Fatal protocol condition. `detail` never includes the raw object. */
export interface ProtocolFault {
  readonly code: string
  readonly detail: string
}

const IGNORED = new Set([
  'tool_progress',
  'topic',
  'ai-title',
  'file-history-snapshot',
])

/**
 * CLI arguments for one query. No system prompt and no DSH tool whitelist.
 *
 * `--permission-mode` is always `bypassPermissions`: the driver never answers a
 * permission question, so the CLI must not ask one. A mode that asks would leave
 * every gated tool denied, which reads to a user as a silently dropped turn.
 * `--setting-sources` is omitted so the installed CLI keeps its own login and settings.
 * @param input - resume id, optional explicit model, and partial-message flag.
 * @returns argv after the executable.
 */
export function launchArgs(input: {
  readonly resume?: string
  readonly model?: string
  readonly partial: boolean
}): string[] {
  const args = [
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
  ]
  if (input.partial) args.push('--include-partial-messages')
  if (input.model !== undefined && input.model !== '') args.push('--model', input.model)
  if (input.resume !== undefined && input.resume !== '') args.push('--resume', input.resume)
  return args
}

/**
 * Control initialize body. Creator mode names the in-process bridge server.
 * The body has no system prompt.
 * @param creator - whether this session selected the cordis preset.
 * @returns the `initialize` request payload.
 */
export function initializeRequest(creator: boolean): Record<string, unknown> {
  return {
    subtype: 'initialize',
    hooks: {},
    hasPrompt: true,
    capabilities: { askUserQuestion: true },
    ...creator ? { sdkMcpServers: [BRIDGE_SERVER] } : {},
  }
}

/** Fold one CLI message. Unknown types become a fault and are not treated as success. */
export class Projector {
  private sawResult = false
  private readonly openTools = new Set<string>()
  /**
   * Streamable blocks the CLI has opened, by its own content-block index.
   *
   * A `stream_event` carries the index of the block its delta belongs to, so the
   * map is what decides whether a delta extends a text block or a reasoning one.
   * A block whose type cannot stream (a tool call) is recorded with a null type
   * so its later deltas are not mistaken for text.
   */
  private readonly blocks = new Map<number, LiveBlock | null>()

  /**
   * Project one message.
   * @param message - parsed NDJSON object.
   * @returns zero or more projections, or a fault that fails the turn.
   */
  push(message: ProtocolMessage): { readonly events: readonly Projected[]; readonly fault?: ProtocolFault } {
    const type = typeof message.type === 'string' ? message.type : ''
    if (type === '') return { events: [], fault: { code: 'UNKNOWN_PROTOCOL', detail: 'event has no type' } }
    if (type === 'result') {
      if (this.sawResult) return { events: [], fault: { code: 'DUPLICATE_RESULT', detail: 'a second result arrived' } }
      return { events: this.result(message) }
    }
    if (this.sawResult) return { events: [], fault: { code: 'LATE_EVENT', detail: `event type "${type}" arrived after result` } }
    switch (type) {
      case 'system': return { events: this.system(message) }
      case 'stream_event': return { events: this.stream(message) }
      case 'assistant': return { events: this.assistant(message) }
      case 'user': return { events: this.user(message) }
      case 'error': return { events: [], fault: { code: 'CLI_ERROR', detail: textField(message, 'error') || 'cli error' } }
      default:
        if (IGNORED.has(type) || (type === 'system')) return { events: [diagnostic('IGNORED_EVENT', type)] }
        return { events: [], fault: { code: 'UNKNOWN_PROTOCOL', detail: `unrecognized event type "${type}"` } }
    }
  }

  private system(message: ProtocolMessage): Projected[] {
    const subtype = typeof message.subtype === 'string' ? message.subtype : ''
    if (subtype === 'init') {
      const id = typeof message.session_id === 'string' ? message.session_id : ''
      return id === '' ? [diagnostic('MISSING_SESSION', 'init event has no session_id')] : [{ kind: 'session', cliSessionId: id }]
    }
    if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_updated'
      || subtype === 'task_notification' || subtype === 'status' || subtype === 'compact_boundary') {
      return [diagnostic('IGNORED_EVENT', `system/${subtype}`)]
    }
    return [diagnostic('IGNORED_EVENT', subtype === '' ? 'system' : `system/${subtype}`)]
  }

  private stream(message: ProtocolMessage): Projected[] {
    const event = record(message.event)
    if (event === undefined) return [diagnostic('IGNORED_EVENT', 'stream_event')]
    switch (event.type) {
      case 'content_block_start': {
        // A build that numbers its blocks is followed exactly; one that does
        // not gets a single implicit text block, which is what its stream is.
        const index = blockIndex(event.index) ?? 0
        const type = record(event.content_block)?.type
        const blockType = type === 'text' ? 'text' : type === 'thinking' ? 'reasoning' : undefined
        // Record the block either way: a tool call streams no text, and an
        // unrecorded index would let its deltas fall through as unknown.
        if (blockType === undefined) {
          this.blocks.set(index, null)
          return [diagnostic('IGNORED_EVENT', `stream_event/content_block_start/${String(type)}`)]
        }
        this.blocks.set(index, { type: blockType, text: '' })
        return [{ kind: 'live-chunk', chunk: { type: 'block-start', index, blockType } }]
      }
      case 'content_block_delta': {
        const delta = record(event.delta)
        if (delta === undefined) return [diagnostic('IGNORED_EVENT', 'stream_event/content_block_delta')]
        const text = delta.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : undefined
        const thinking = delta.type === 'thinking_delta' && typeof delta.thinking === 'string' ? delta.thinking : undefined
        if (text === undefined && thinking === undefined) {
          return [diagnostic('IGNORED_EVENT', `stream_event/content_block_delta/${String(delta.type)}`)]
        }
        const index = blockIndex(event.index) ?? 0
        // An unnumbered delta implies its own block: the CLI that sends bare
        // deltas also sends no `content_block_start` to open them.
        let open = this.blocks.get(index)
        if (open === undefined) {
          const implied: LiveBlock = { type: text === undefined ? 'reasoning' : 'text', text: '' }
          this.blocks.set(index, implied)
          open = implied
        }
        if (open === null) {
          return [diagnostic('IGNORED_EVENT', `stream_event/content_block_delta/${index}`)]
        }
        if (text !== undefined && open.type === 'text') {
          if (text === '') return []
          open.text += text
          return [{ kind: 'live-chunk', chunk: { type: 'text-delta', index, text } }]
        }
        if (thinking !== undefined && open.type === 'reasoning') {
          if (thinking === '') return []
          open.text += thinking
          return [{ kind: 'live-chunk', chunk: { type: 'reasoning-delta', index, text: thinking } }]
        }
        return [diagnostic('IGNORED_EVENT', `stream_event/content_block_delta/${String(delta.type)}`)]
      }
      default:
        // `message_start`, `message_delta`, and `message_stop` are accounting
        // only: the harness takes usage from the assistant message and closes
        // the block when the assistant message lands.
        return [diagnostic('IGNORED_EVENT', `stream_event/${String(event.type ?? '')}`)]
    }
  }

  private assistant(message: ProtocolMessage): Projected[] {
    const body = record(message.message)
    const content = body?.content
    const blocks: AssistantOut[] = []
    const events: Projected[] = []
    if (typeof content === 'string') blocks.push({ type: 'text', text: content })
    else if (Array.isArray(content)) {
      for (const block of content) {
        const item = record(block)
        if (item === undefined) {
          events.push(diagnostic('UNKNOWN_BLOCK', 'assistant content block is not an object'))
          continue
        }
        if (item.type === 'text' && typeof item.text === 'string') {
          // A model occasionally writes its tool intent as inline markup instead
          // of using the structured channel; strip it so the transcript shows
          // prose rather than tag syntax. The diagnostic records that this
          // happened, so the frequency stays observable even when prose survives.
          const text = stripInlineToolCalls(item.text)
          if (text !== item.text) {
            events.push(diagnostic('INLINE_TOOL_MARKUP', 'stripped inline tool markup from assistant text'))
          }
          if (text !== '') blocks.push({ type: 'text', text })
        }
        else if (item.type === 'thinking' && typeof item.thinking === 'string') blocks.push({ type: 'reasoning', text: item.thinking })
        else if (item.type === 'redacted_thinking') events.push(diagnostic('REDACTED_THINKING', 'redacted thinking was not copied'))
        else if (item.type === 'tool_use') {
          // The assistant message CARRIES the tool call, exactly as `agent-loop`
          // records one (`live.blocks()` includes tool-call blocks). This is not
          // cosmetic: `tool/result` is a surface event and projects into the
          // model-visible history, while `tool/call` is not, so a call recorded
          // only as its own event leaves the following result orphaned. A native
          // turn then fails DeepSeek's serializer with "tool result has no
          // matching call" the moment it reads that history.
          const call = this.toolUse(item)
          if (call.blocks !== undefined) blocks.push(call.blocks)
          events.push(...call.projected)
        }
        else if (item.type === 'image') events.push(diagnostic('IMAGE_OMITTED', 'assistant image bytes were not copied'))
        else events.push(diagnostic('UNKNOWN_BLOCK', `assistant block "${String(item.type)}"`))
      }
    }
    if (blocks.length > 0) {
      events.unshift({ kind: 'assistant', blocks })
    }
    // One `assistant` frame closes one CLI message, whether or not it carried
    // text: its streamed blocks are now durable, and the next round numbers its
    // blocks from 0 again.
    this.resetLive()
    // Usage is emitted BEFORE the blocks it prices: the driver commits the
    // assistant message as soon as it sees that projection, so a later usage
    // event would arrive after the message had already been written without it,
    // leaving every CLI turn's usage empty.
    const usage = usageOf(body?.usage)
    if (usage !== undefined) events.unshift({ kind: 'usage', usage })
    return events
  }

  /**
   * Forget the live blocks a committed assistant message has taken over.
   *
   * The CLI restarts content-block numbering at 0 for each assistant message,
   * so a retained map would attribute the next round's deltas to the previous
   * round's blocks.
   */
  private resetLive(): void {
    this.blocks.clear()
  }

  /**
   * Turn whatever the CLI streamed into assistant blocks, for a build that
   * never sent the closing `assistant` message.
   *
   * The streamed blocks are returned in the order the CLI opened them, with
   * their accumulated text. A block the CLI opened but never filled is skipped:
   * an empty answer is not worth a fabricated message.
   * @returns the streamed blocks, or nothing when no text arrived.
   */
  private liveBlocks(): AssistantOut[] {
    const blocks: AssistantOut[] = []
    for (const block of this.blocks.values()) {
      if (block === null || block.text === '') continue
      blocks.push({ type: block.type, text: block.text })
    }
    // Reasoning is context, not an answer: the harness needs visible text.
    return blocks.some(block => block.type === 'text') ? blocks : []
  }

  /**
   * Read one `tool_use` block as both a message block and its presentation event.
   *
   * The block goes into the assistant message so the model-visible history pairs
   * it with the `tool/result` that follows; the event tells the driver to record
   * that call row. Both are needed, and they are produced together so a caller
   * cannot take one without the other.
   * @param item - the CLI `tool_use` content block.
   * @returns the assistant block and the tool-call projection.
   */
  private toolUse(item: ProtocolMessage): {
    blocks?: Extract<AssistantOut, { type: 'tool-call' }>
    projected: Projected[]
  } {
    const id = typeof item.id === 'string' ? item.id : ''
    const name = typeof item.name === 'string' ? item.name : ''
    if (id === '' || name === '') return { projected: [diagnostic('MALFORMED_TOOL', 'tool_use is missing id or name')] }
    this.openTools.add(id)
    let args = ''
    try {
      args = JSON.stringify(item.input ?? {})
    } catch {
      return { projected: [diagnostic('MALFORMED_TOOL', `tool_use "${id}" input is not JSON`)] }
    }
    return {
      blocks: { type: 'tool-call', id, name, arguments: args },
      projected: [{ kind: 'tool-call', id, name, arguments: args }],
    }
  }

  private user(message: ProtocolMessage): Projected[] {
    const body = record(message.message)
    const content = body?.content
    if (typeof content === 'string') return [{ kind: 'assistant', blocks: [{ type: 'text', text: content }] }]
    if (!Array.isArray(content)) return [diagnostic('IGNORED_EVENT', 'user')]
    const events: Projected[] = []
    for (const block of content) {
      const item = record(block)
      if (item?.type !== 'tool_result') {
        events.push(diagnostic('UNKNOWN_BLOCK', 'user content is not a tool_result'))
        continue
      }
      const id = typeof item.tool_use_id === 'string' ? item.tool_use_id : ''
      if (id === '' || !this.openTools.has(id)) events.push(diagnostic('UNPAIRED_TOOL_RESULT', id === '' ? 'missing tool_use_id' : id))
      this.openTools.delete(id)
      events.push({
        kind: 'tool-result',
        id,
        text: toolResultText(item.content),
        isError: item.is_error === true,
      })
    }
    return events
  }

  private result(message: ProtocolMessage): Projected[] {
    if (this.sawResult) return []
    this.sawResult = true
    const events: Projected[] = []
    const live = this.liveBlocks()
    if (live.length > 0) {
      events.push({ kind: 'assistant', blocks: live })
      this.resetLive()
    }
    const subtype = typeof message.subtype === 'string' ? message.subtype : ''
    const text = typeof message.result === 'string' ? message.result : ''
    const isError = message.is_error === true || subtype !== 'success'
    events.push({ kind: 'result', text, isError })
    if (this.openTools.size > 0) events.push(diagnostic('UNCLOSED_TOOL', [...this.openTools].join(',')))
    return events
  }
}

/**
 * True when this projection is a duplicate of the result text already committed.
 * @param events - projections from one result message.
 * @param committed - assistant texts already committed in this turn.
 * @returns events with a trailing assistant copy of the result removed.
 */
export function withoutDuplicateResultText(events: readonly Projected[], committed: readonly string[]): readonly Projected[] {
  const result = events.find(event => event.kind === 'result')
  if (result === undefined || result.kind !== 'result' || result.text === '') return events
  if (!committed.includes(result.text)) return events
  return events.filter(event => event.kind !== 'assistant')
}

function diagnostic(code: string, detail: string): Projected {
  return { kind: 'diagnostic', code, detail }
}

/**
 * Read a content-block index as the non-negative integer the CLI numbers with.
 * @param value - the `index` field on a `stream_event`.
 * @returns the index, or undefined when it is not a usable position.
 */
function blockIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function record(value: unknown): ProtocolMessage | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ProtocolMessage : undefined
}

function textField(message: ProtocolMessage, key: string): string {
  const value = message[key]
  return typeof value === 'string' ? value : ''
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    const item = record(block)
    return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
  }).join('')
}

/**
 * Wire field to harness field for every token counter the two vocabularies share.
 *
 * The CLI and the harness name the same four numbers; only the spelling of the
 * cache counters differs.
 */
export const USAGE_FIELDS = {
  input_tokens: 'inputTokens',
  output_tokens: 'outputTokens',
  cache_read_input_tokens: 'cacheReadTokens',
  cache_creation_input_tokens: 'cacheWriteTokens',
} as const

/**
 * Copy one CLI usage object onto the harness vocabulary.
 *
 * Two corrections make the numbers mean what the harness expects.
 *
 * 1. The cache counters are carried over at all. Reading only input/output
 *    threw them away, so a CLI-driven Session reported no cache hit rate even
 *    though the CLI sends it in every assistant frame.
 *
 * 2. `input_tokens` is reduced to its uncached part. The CLI follows the
 *    Messages convention and folds cache reads into that total — a live call
 *    reported `input_tokens: 30513` beside `cache_read_input_tokens: 30336`,
 *    where 30513 − 30336 = 177 is the uncached input, the same 177 the CLI
 *    publishes as `modelUsage.inputTokens`. The harness requires the three
 *    counters to be disjoint, and its context gauge sums them, so leaving the
 *    total in place double-counted the prompt and halved the hit rate.
 * @param value - a provider usage object from any frame that carries one.
 * @returns the disjoint harness usage, or undefined when nothing was reported.
 */
function usageOf(value: unknown): TokenUsage | undefined {
  const usage = record(value)
  if (usage === undefined) return undefined
  const counters: Record<string, number> = {}
  for (const [wire, local] of Object.entries(USAGE_FIELDS)) {
    const counter = numberField(usage, wire)
    if (counter !== undefined) counters[local] = counter
  }
  const output = counters.outputTokens
  const rawInput = counters.inputTokens
  if (output === undefined || rawInput === undefined) return undefined
  const cacheRead = counters.cacheReadTokens ?? 0
  const cacheWrite = counters.cacheWriteTokens ?? 0
  return {
    // Clamped: a proxy that reports cache counters without folding them in
    // would otherwise produce a negative input count and a NaN ratio downstream.
    inputTokens: Math.max(0, rawInput - cacheRead - cacheWrite),
    outputTokens: output,
    totalTokens: rawInput + output,
    ...cacheRead === 0 ? {} : { cacheReadTokens: cacheRead },
    ...cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite },
  }
}

function numberField(message: ProtocolMessage, key: string): number | undefined {
  const value = message[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
