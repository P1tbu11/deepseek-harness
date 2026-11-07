import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, Inbox, InboxTarget } from '@deepseek-ai/dsh-agent'
import { agentEvents, type AgentEventDispatch } from '@deepseek-ai/dsh-agent'
import { AgentModel } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionProjectionState } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type {
  AgentCancelCause, Session, UserMessage,
} from '@deepseek-ai/dsh-session'
import {
  createAssistantMessage, createToolResultMessage, createUserMessage, LlmAttemptId, ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { CliBinding } from './bindings.ts'
import { handleBridgeCall, type McpCall } from './bridge.ts'
import { BRIDGE_TOOL, CLI_DEFAULT_MODEL, CODEBUDDY_PROVIDER, CREATOR_PRESET } from './constants.ts'
import {
  Projector, withoutDuplicateResultText, type ProtocolFault, type ProtocolMessage,
} from './protocol.ts'
import { startQuery, type CliQuery } from './transport.ts'

/**
 * Text sent to the CLI. Non-text blocks refuse the turn before any process starts.
 * @param message - the user message taken from the inbox.
 * @returns the joined text blocks.
 */
export function promptText(message: UserMessage): string {
  const blocks: readonly ContentBlock[] = message.content
  const foreign = blocks.filter(block => block.type !== 'text').map(block => block.type)
  if (foreign.length > 0) {
    throw new Error(`UNSUPPORTED_INPUT: CodeBuddy prompt keeps text only; refused block types ${foreign.join(',')}`)
  }
  return blocks.map(block => block.type === 'text' ? block.text : '').join('\n')
}

/**
 * Run one CLI turn and append the projected events.
 * @param input - the host, session, prompt, and CLI launch for this turn.
 * @returns nothing. The CLI session id is stored through `input.onSession`.
 */
export async function runCliTurn(input: {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly turn: number
  readonly prompt: string
  readonly creator: boolean
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly model?: string
  readonly resume?: string
  readonly graceMs: number
  readonly signal: AbortSignal
  readonly onSession: (id: string) => Promise<void> | void
  readonly dispatch: AgentEventDispatch
}): Promise<void> {
  const session = input.session
  session.append('turn/start', { turn: input.turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: input.prompt }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const query = await startQuery(input.ctx, {
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    ...input.resume !== undefined && input.resume !== '' ? { resume: input.resume } : {},
    ...input.model !== undefined && input.model !== '' ? { model: input.model } : {},
    creator: input.creator,
    prompt: input.prompt,
    graceMs: input.graceMs,
  })
  const abortQuery = () => { void query.cancel() }
  input.signal.addEventListener('abort', abortQuery, { once: true })
  const projector = new Projector()
  const committed: string[] = []
  let usage: TokenUsage | undefined
  let fault: ProtocolFault | undefined
  let resultError = false
  let step = 1
  const attempt = LlmAttemptId(`codebuddy-${input.turn}`)
  let revision = 1
  let chunkIndex = 0
  const dispatch = agentEvents(input.ctx, input.agent)
  let started = false
  const finishLive = (seq: number | undefined): void => {
    if (!started) return
    dispatch.emit('agent/assistant-stream', {
      frame: {
        type: 'end', attemptId: attempt, revision, index: chunkIndex,
        outcome: seq === undefined
          ? { kind: 'abandoned' }
          : { kind: 'committed', eventType: 'assistant/message', seq: SessionSeq(seq) },
      },
    })
    started = false
    revision += 1
    chunkIndex = 0
  }
  try {
    if (input.signal.aborted) throw abortError()
    for await (const message of query.messages) {
      if (input.signal.aborted) break
      if (message.type === 'control_request') {
        await answerControl(input, query, message, input.turn, step)
        continue
      }
      if (message.type === 'control_response') continue
      const projected = projector.push(message)
      if (projected.fault !== undefined) fault = projected.fault
      const events = withoutDuplicateResultText(projected.events, committed)
      for (const event of events) {
        if (event.kind === 'session') await input.onSession(event.cliSessionId)
        else if (event.kind === 'live-text') {
          if (!started) {
            dispatch.emit('agent/assistant-stream', {
              frame: { type: 'start', attemptId: attempt, revision, turn: input.turn, step },
            })
            started = true
          }
          dispatch.emit('agent/assistant-stream', {
            frame: {
              type: 'chunk', attemptId: attempt, revision, index: chunkIndex, time: Date.now(),
              chunk: { type: 'text-delta', index: 0, text: event.text },
            },
          })
          chunkIndex += 1
        } else if (event.kind === 'usage') {
          usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
        } else if (event.kind === 'assistant') {
          const text = event.blocks.filter(block => block.type === 'text').map(block => block.text).join('')
          if (text !== '') committed.push(text)
          const seq = appendAssistant(session, input.turn, step, event.blocks, usage)
          finishLive(seq)
          step += 1
        } else if (event.kind === 'tool-call') {
          session.append('tool/call', {
            turn: input.turn, step, callId: ToolCallId(event.id), name: event.name, arguments: event.arguments,
          })
        } else if (event.kind === 'tool-result') {
          const call = findCall(session, event.id) ?? previousSeq(session)
          session.append('tool/result', {
            turn: input.turn,
            step,
            message: createToolResultMessage({
              callId: ToolCallId(event.id),
              content: [{ type: 'text', text: event.text }],
              isError: event.isError,
            }),
          }, { surfaceOp: 'append', sourceEventSeqs: [call] })
        } else if (event.kind === 'result') {
          resultError = event.isError
        } else if (event.kind === 'diagnostic') {
          input.ctx.logger.warn(`codebuddy ${event.code}: ${event.detail}`)
        }
      }
      if (fault !== undefined || events.some(event => event.kind === 'result')) break
    }
  } finally {
    input.signal.removeEventListener('abort', abortQuery)
    finishLive(undefined)
    if (input.signal.aborted) await query.cancel()
    const done = await query.finished()
    if (input.signal.aborted) {
      session.append('turn/end', { turn: input.turn, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    } else if (fault !== undefined || done.exitCode !== 0 && done.exitCode !== null) {
      const detail = fault?.detail ?? `cli exited ${done.exitCode}`
      const stderr = done.stderr === '' ? '' : `; stderr: ${done.stderr}`
      session.append('turn/end', {
        turn: input.turn,
        reason: { kind: 'error', error: { message: `${fault?.code ?? 'CLI_EXIT'}: ${detail}${stderr}`, code: fault?.code ?? 'CLI_EXIT' } },
      })
    } else if (resultError) {
      session.append('turn/end', {
        turn: input.turn,
        reason: { kind: 'error', error: { message: 'cli result reported an error', code: 'CLI_RESULT' } },
      })
    } else {
      session.append('turn/end', { turn: input.turn, reason: { kind: 'completed' } })
    }
    await input.dispatch.serial('agent/turn-stopping', { turn: input.turn, signal: input.signal })
  }
}

function previousSeq(session: Session): ReturnType<typeof SessionSeq> {
  const events = session.snapshotEvents()
  return events.at(-1)?.seq ?? SessionSeq(0)
}

function appendAssistant(
  session: Session,
  turn: number,
  step: number,
  blocks: readonly { type: 'text' | 'reasoning'; text: string }[],
  usage: TokenUsage | undefined,
): number {
  const content: ContentBlock[] = blocks.map(block => block.type === 'text'
    ? { type: 'text', text: block.text }
    : { type: 'reasoning', text: block.text })
  const text = blocks.filter(block => block.type === 'text').map(block => block.text)
  const event = session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content,
      source: { provider: CODEBUDDY_PROVIDER, model: CLI_DEFAULT_MODEL },
    }),
    stream: text.length === 0 ? [] : [{
      type: 'text-chunks',
      time0: Date.now(),
      index: 0,
      dt: text.map(() => 0),
      texts: text,
    }],
    ...usage === undefined ? {} : { usage },
  }, { surfaceOp: 'append' })
  return event.seq
}

function findCall(session: Session, id: string): ReturnType<typeof SessionSeq> | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'tool/call' && event.data.callId === id) return event.seq
  }
  return undefined
}

async function answerControl(input: {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly signal: AbortSignal
}, query: CliQuery, message: ProtocolMessage, turn: number, step: number): Promise<void> {
  const requestId = typeof message.request_id === 'string' ? message.request_id : ''
  const request = message.request
  const body = request !== null && typeof request === 'object' ? request as ProtocolMessage : {}
  const subtype = typeof body.subtype === 'string' ? body.subtype : ''
  if (subtype === 'can_use_tool') {
    const toolName = typeof body.tool_name === 'string' ? body.tool_name : 'tool'
    const outcome = await ask(input.ctx, input.agent, toolName, input.signal)
    query.send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: outcome === 'allowed-once'
          ? { behavior: 'allow', updatedInput: body.input ?? {} }
          : { behavior: 'deny', message: outcome },
      },
    })
    return
  }
  if (subtype === 'mcp_message') {
    const mcp = body.message
    const call = mcp !== null && typeof mcp === 'object' ? mcp as McpCall & { method?: string } : { method: '' }
    const method = typeof call.method === 'string' ? call.method : ''
    const id = 'id' in call ? (call as { id?: string | number }).id : undefined
    const params = 'params' in call ? (call as { params?: unknown }).params : undefined
    const result = await handleBridgeCall(input.ctx, input.agent, input.signal, {
      method,
      ...id !== undefined ? { id } : {},
      ...params !== undefined ? { params } : {},
    })
    if (result.executed) {
      const callId = ToolCallId(`bridge-${String(call.id ?? 'call')}`)
      const raw = JSON.stringify((call as { params?: unknown }).params ?? {})
      const recorded = input.session.append('tool/call', {
        turn, step, callId, name: BRIDGE_TOOL, arguments: raw,
      })
      const content = (result.body as { content?: { text?: string }[] }).content
      const first = content?.[0]?.text
      const text = typeof first === 'string' ? first : JSON.stringify(result.body)
      input.session.append('tool/result', {
        turn,
        step,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text }],
          isError: false,
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [recorded.seq] })
    }
    query.send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { mcp_response: { jsonrpc: '2.0', id: call.id ?? null, result: result.body } },
      },
    })
    return
  }
  query.send({
    type: 'control_response',
    response: { subtype: 'error', request_id: requestId, error: `unsupported control ${subtype}` },
  })
}

async function ask(ctx: Context, agent: Agent, toolName: string, signal: AbortSignal): Promise<string> {
  const approval = ctx.get('approval')
  if (approval === undefined) return 'unavailable'
  const outcome = await approval.request({
    agent,
    toolName,
    reason: `CodeBuddy CLI asks to use ${toolName}`,
    signal,
  })
  return outcome
}

function abortError(): Error {
  return new Error('codebuddy turn aborted')
}

/** Pending inbox that also records `agent/inbox/spliced`. */
export class RecordingInbox implements Inbox {
  private nextTurnMessages: UserMessage[] = []
  private nextStepMessages: UserMessage[] = []

  constructor(private readonly session: Session) {}

  get nextTurn(): readonly UserMessage[] { return this.nextTurnMessages }
  get nextStep(): readonly UserMessage[] { return this.nextStepMessages }

  clear(): void {
    this.splice('next-step', 0, this.nextStepMessages.length, [])
    this.splice('next-turn', 0, this.nextTurnMessages.length, [])
  }

  append(target: InboxTarget, message: UserMessage): void {
    const list = target === 'next-turn' ? this.nextTurnMessages : this.nextStepMessages
    this.splice(target, list.length, 0, [message])
  }

  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  replace(messageId: string, newMessage: UserMessage): boolean {
    return this.replaceIn('next-turn', messageId, newMessage) || this.replaceIn('next-step', messageId, newMessage)
  }

  remove(messageId: string): boolean {
    return this.removeIn('next-turn', messageId) || this.removeIn('next-step', messageId)
  }

  splice(target: InboxTarget, start: number, deleteCount: number, inserted: readonly UserMessage[]): UserMessage[] {
    const list = target === 'next-turn' ? this.nextTurnMessages : this.nextStepMessages
    const removed = list.splice(start, deleteCount, ...inserted)
    this.session.append('agent/inbox/spliced', {
      target,
      start,
      removedCount: removed.length,
      inserted: [...inserted],
    })
    return removed
  }

  private replaceIn(target: InboxTarget, messageId: string, message: UserMessage): boolean {
    const list = target === 'next-turn' ? this.nextTurnMessages : this.nextStepMessages
    const index = list.findIndex(item => item.id === messageId)
    if (index < 0) return false
    this.splice(target, index, 1, [message])
    return true
  }

  private removeIn(target: InboxTarget, messageId: string): boolean {
    const list = target === 'next-turn' ? this.nextTurnMessages : this.nextStepMessages
    const index = list.findIndex(item => item.id === messageId)
    if (index < 0) return false
    this.splice(target, index, 1, [])
    return true
  }
}

/** Live CodeBuddy agent. One CLI process per turn; later turns pass `--resume`. */
export class CodeBuddyAgent implements Agent {
  get id() { return this.session.id }
  readonly options: AgentOptions
  readonly session: Session
  readonly model: AgentModel
  readonly inbox: RecordingInbox
  readonly ctx: Context
  private phase: 'idle' | 'running' = 'idle'
  private turn = 0
  private idle = Promise.resolve()
  private active: AbortController | undefined
  private readonly dispatch: AgentEventDispatch
  /** CLI session id remembered for the next `--resume`, when one exists. */
  binding: CliBinding | undefined

  constructor(
    private readonly host: Context,
    session: Session,
    options: AgentOptions,
    readonly presetHint: string | undefined,
    binding: CliBinding | undefined,
    private readonly launch: {
      readonly command: string
      readonly args: readonly string[]
      readonly model?: string
      readonly graceMs: number
      readonly remember: (id: string, binding: CliBinding) => Promise<void>
    },
  ) {
    this.options = options
    this.session = session
    this.binding = binding
    this.inbox = new RecordingInbox(session)
    const scope = createScope(host, this)
    this.ctx = scope.ctx
    this.dispatch = agentEvents(host, this)
    this.model = new AgentModel(() => this.selection(), session, options)
    this.session.append('model/selection', {
      provider: CODEBUDDY_PROVIDER,
      model: launch.model === undefined || launch.model === '' ? CLI_DEFAULT_MODEL : launch.model,
    })
  }

  get status(): 'idle' | 'running' { return this.phase }

  /**
   * Preset selected for this session.
   * Later `agent-preset/selected` events replace the value from creation.
   * @returns the preset name, or `undefined` when the session has none.
   */
  currentPreset(): string | undefined {
    const events = this.session.snapshotEvents()
    let preset = this.presetHint
    for (const event of events) {
      const typed = event as { type: string; data: unknown }
      if (typed.type !== 'agent-preset/selected' || typed.data === null || typeof typed.data !== 'object') continue
      const value = (typed.data as { agentPreset?: unknown }).agentPreset
      if (typeof value === 'string') preset = value
    }
    return preset
  }

  cancel(cause: AgentCancelCause): void {
    this.inbox.clear()
    this.active?.abort(cause)
  }

  whenIdle(): Promise<void> { return this.idle }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase !== 'idle') throw new Error('agent is busy')
    const signal = new AbortController()
    this.active = signal
    return task(signal.signal)
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.inbox.append(target, message)
    if (wakeup) this.wake()
  }

  followup(message: UserMessage): void { this.send(message, 'next-turn', true) }
  steer(message: UserMessage): void { this.send(message, 'next-step', true) }
  inject(message: UserMessage): void { this.send(message, 'next-step', false) }

  private selection(): ModelSelectionProjectionState {
    return { lastUsed: null, pending: { provider: CODEBUDDY_PROVIDER, model: CLI_DEFAULT_MODEL } }
  }

  private wake(): void {
    if (this.phase === 'running') return
    const done = Promise.withResolvers<void>()
    this.idle = done.promise
    this.phase = 'running'
    this.dispatch.emit('agent/status', { status: 'running' })
    void this.pump().finally(() => {
      this.phase = 'idle'
      this.dispatch.emit('agent/status', { status: 'idle' })
      done.resolve()
      if (this.inbox.nextTurn.length > 0) this.wake()
    })
  }

  private async pump(): Promise<void> {
    while (this.inbox.nextTurn.length > 0 || this.inbox.nextStep.length > 0) {
      const message = this.inbox.nextTurn[0] ?? this.inbox.nextStep[0]
      if (message === undefined) return
      const target: InboxTarget = this.inbox.nextTurn.length > 0 ? 'next-turn' : 'next-step'
      this.inbox.splice(target, 0, 1, [])
      let text: string
      try {
        text = promptText(message)
      } catch (error: unknown) {
        const messageText = error instanceof Error ? error.message : 'codebuddy turn failed'
        this.session.append('turn/start', { turn: this.turn + 1 })
        this.session.append('turn/end', {
          turn: this.turn + 1,
          reason: { kind: 'error', error: { message: messageText, code: 'UNSUPPORTED_INPUT' } },
        })
        this.turn += 1
        continue
      }
      this.turn += 1
      const controller = new AbortController()
      this.active = controller
      try {
        const creator = this.currentPreset() === CREATOR_PRESET
        await runCliTurn({
          ctx: this.host,
          agent: this,
          session: this.session,
          turn: this.turn,
          prompt: text,
          creator,
          command: this.launch.command,
          args: this.launch.args,
          cwd: this.session.header.cwd ?? process.cwd(),
          ...this.launch.model !== undefined && this.launch.model !== '' ? { model: this.launch.model } : {},
          ...this.binding?.cliSessionId !== undefined ? { resume: this.binding.cliSessionId } : {},
          graceMs: this.launch.graceMs,
          signal: controller.signal,
          dispatch: this.dispatch,
          onSession: async (id) => {
            this.binding = { cliSessionId: id, creator }
            await this.launch.remember(this.session.id, this.binding)
          },
        })
      } catch (error: unknown) {
        const messageText = error instanceof Error ? error.message : 'codebuddy turn failed'
        this.session.append('turn/end', {
          turn: this.turn,
          reason: { kind: 'error', error: { message: messageText, code: 'CODEBUDDY' } },
        })
      }
    }
  }
}
