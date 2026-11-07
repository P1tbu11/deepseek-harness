import { BRIDGE_SERVER } from './constants.ts'

/** One NDJSON object from the CLI stdout stream. */
export type ProtocolMessage = Readonly<Record<string, unknown>>

/** What the driver commits. Payloads are the CLI's own text, ids, and arguments. */
export type Projected =
  | { readonly kind: 'session'; readonly cliSessionId: string }
  | { readonly kind: 'live-text'; readonly text: string }
  | { readonly kind: 'assistant'; readonly blocks: readonly AssistantOut[] }
  | { readonly kind: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }
  | { readonly kind: 'tool-result'; readonly id: string; readonly text: string; readonly isError: boolean }
  | { readonly kind: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: 'result'; readonly text: string; readonly isError: boolean }
  | { readonly kind: 'diagnostic'; readonly code: string; readonly detail: string }

/** One text or reasoning block copied from an assistant message. */
export type AssistantOut =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }

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
 * `--permission-mode` stays `default`. `--setting-sources` is omitted so the
 * installed CLI keeps its own login and settings.
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
    'default',
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
  /** Live deltas already represented by a committed assistant message. */
  liveText = ''

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
    const delta = event === undefined ? undefined : record(event.delta)
    const text = delta?.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : undefined
    if (text === undefined) return [diagnostic('IGNORED_EVENT', 'stream_event')]
    this.liveText += text
    return [{ kind: 'live-text', text }]
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
        if (item.type === 'text' && typeof item.text === 'string') blocks.push({ type: 'text', text: item.text })
        else if (item.type === 'thinking' && typeof item.thinking === 'string') blocks.push({ type: 'reasoning', text: item.thinking })
        else if (item.type === 'redacted_thinking') events.push(diagnostic('REDACTED_THINKING', 'redacted thinking was not copied'))
        else if (item.type === 'tool_use') {
          if (blocks.length > 0) {
            events.push({ kind: 'assistant', blocks: [...blocks] })
            blocks.length = 0
            this.liveText = ''
          }
          events.push(...this.toolUse(item))
        }
        else if (item.type === 'image') events.push(diagnostic('IMAGE_OMITTED', 'assistant image bytes were not copied'))
        else events.push(diagnostic('UNKNOWN_BLOCK', `assistant block "${String(item.type)}"`))
      }
    }
    if (blocks.length > 0) {
      events.push({ kind: 'assistant', blocks })
      this.liveText = ''
    }
    const usage = usageOf(body?.usage)
    if (usage !== undefined) events.push({ kind: 'usage', ...usage })
    return events
  }

  private toolUse(item: ProtocolMessage): Projected[] {
    const id = typeof item.id === 'string' ? item.id : ''
    const name = typeof item.name === 'string' ? item.name : ''
    if (id === '' || name === '') return [diagnostic('MALFORMED_TOOL', 'tool_use is missing id or name')]
    this.openTools.add(id)
    let args = ''
    try {
      args = JSON.stringify(item.input ?? {})
    } catch {
      return [diagnostic('MALFORMED_TOOL', `tool_use "${id}" input is not JSON`)]
    }
    return [{ kind: 'tool-call', id, name, arguments: args }]
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
    if (this.liveText !== '') {
      events.push({ kind: 'assistant', blocks: [{ type: 'text', text: this.liveText }] })
      this.liveText = ''
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

function usageOf(value: unknown): { inputTokens: number; outputTokens: number } | undefined {
  const usage = record(value)
  if (usage === undefined) return undefined
  const input = numberField(usage, 'input_tokens')
  const output = numberField(usage, 'output_tokens')
  if (input === undefined || output === undefined) return undefined
  return { inputTokens: input, outputTokens: output }
}

function numberField(message: ProtocolMessage, key: string): number | undefined {
  const value = message[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
