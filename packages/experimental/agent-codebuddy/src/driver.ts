import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, Inbox, InboxTarget } from '@deepseek-ai/dsh-agent'
import { agentEvents, type AgentEventDispatch } from '@deepseek-ai/dsh-agent'
import { AgentModel } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionProjectionState } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import type {
  AgentCancelCause, Session, UserMessage,
} from '@deepseek-ai/dsh-session'
import {
  createAssistantMessage, createToolResultMessage, LlmAttemptId, ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import { handleBridgeCall, type McpCall } from './bridge.ts'
import type { CliBinding } from './bindings.ts'
import { BRIDGE_TOOL, CODEBUDDY_PROVIDER, CREATOR_PRESET, DEFAULT_MODEL_ID } from './constants.ts'
import { discoverModels } from './models.ts'
import {
  Projector, withoutDuplicateResultText, type ProtocolFault, type ProtocolMessage,
} from './protocol.ts'
import { startQuery, type CliQuery } from './transport.ts'

/** Directory, relative to the session cwd, where attached images are staged. */
export const IMAGE_STAGE_DIR = '.dsh-attachments'

/**
 * Name one attached image in the prompt through a link beside the session.
 *
 * The CLI ships `ViewImage`, a local tool that reads a path the model is told
 * about; a probe against build 2.181.0 showed the model calls it reliably when
 * the prompt names the file, and that it follows a symlink whose target lies
 * outside the session directory. That is the CLI's own design, and it keeps
 * image bytes out of the conversation history: a path costs the same tokens on
 * every later turn, while the bytes are read once by the tool instead of
 * re-sent with each request.
 *
 * The attachment store names its objects by sha256 with no extension, and
 * `ViewImage` refuses a path without one. A link carrying the media type's
 * extension satisfies both sides without a second copy of the bytes: the store
 * stays the only place an image is written.
 *
 * The bytes behind that link are already the size the model should see. The
 * attachment provider normalizes on upload — a 2048² pixel budget, a 4 MiB
 * encoded target, and a 85/75/60 quality ladder that picks WebP when the source
 * carries alpha and JPEG otherwise, all keyed off a signature-detected format.
 * `imageHostPath()` returns that normalized object, so resizing or re-encoding
 * here would only add a second lossy generation and a native image dependency
 * for work already done upstream.
 * @param message - the user message taken from the inbox.
 * @param input - session cwd, the attachment resolver, and the link creator.
 * @returns the prompt text, with one `[image: …]` line per attached image.
 */
export function promptContent(
  message: UserMessage,
  input: {
    readonly cwd: string
    readonly hostPath: (ref: ImageAttachmentRef) => string | undefined
    readonly link?: (target: string, path: string) => void
    /** Whether the CLI ships `ViewImage`; false names no tool and leaves `Read`. */
    readonly viewImage?: boolean
  },
): string {
  const blocks: readonly ContentBlock[] = message.content
  const text = blocks.map(block => block.type === 'text' ? block.text : '').filter(part => part !== '').join('\n')
  const images = blocks.filter(block => block.type === 'image')
  if (images.length === 0) return text
  const stage = join(input.cwd, IMAGE_STAGE_DIR)
  mkdirSync(stage, { recursive: true })
  const lines: string[] = []
  for (const [index, image] of images.entries()) {
    const source = input.hostPath(image.attachment)
    if (source === undefined) {
      throw new Error(
        `UNSUPPORTED_INPUT: CodeBuddy cannot read image ${image.attachment.attachmentId}; it has no readable file on this host`,
      )
    }
    // Fail here rather than link a path that is already gone.
    //
    // An attachment object can be pruned after the message was recorded. A link
    // to it still lints as a symlink, so the turn starts, `ViewImage` answers
    // ENOENT, and the model has no way to tell "wrong path" from "file removed":
    // it retries with every other tool until the turn is killed, and the user
    // sees a spinner and no answer. Refusing before the link is created turns
    // that into one recorded error.
    if (!existsSync(source)) {
      throw new Error(
        `UNSUPPORTED_INPUT: CodeBuddy cannot read image ${image.attachment.attachmentId}; its attachment object is gone from ${source}`,
      )
    }
    const extension = image.attachment.mediaType.split('/')[1] ?? 'png'
    // Name the link after the stored object, so the same image reached twice
    // in one session maps to one link instead of a new name per message.
    const base = basename(source) === '' ? `${message.id}-${index + 1}` : basename(source)
    const name = `${base}.${extension}`
    const path = join(stage, name)
    // Overwrite a stale link from an earlier turn; the target never changes for
    // a content-addressed object, so the replacement is equivalent.
    rmSync(path, { force: true })
    if (input.link !== undefined) input.link(source, path)
    else symlinkSync(source, path)
    lines.push(describeImage(`${IMAGE_STAGE_DIR}/${name}`, input.viewImage !== false))
  }
  return [text, ...lines].filter(part => part !== '').join('\n')
}

/**
 * One `[image: …]` line, phrased for the tools this CLI build provides.
 *
 * The staged path is what the model acts on. Naming `ViewImage` tells it which
 * tool opens the image in a build that has one; a build without it is given the
 * path alone, and the model reaches for `Read`, which reads image files too.
 * @param line - the staged path, relative to the session directory.
 * @param hasViewImage - whether the CLI advertises `ViewImage`.
 * @returns the prompt line for one image.
 */
function describeImage(line: string, hasViewImage: boolean): string {
  return hasViewImage ? `[image: ${line}]` : `[image file: ${line} — open it with Read]`
}

/**
 * Text half of a message. Images are staged as files and named in the text, so
 * this only joins the text blocks.
 * @param message - the user message taken from the inbox.
 * @returns the joined text blocks.
 */
export function promptText(message: UserMessage): string {
  const blocks: readonly ContentBlock[] = message.content
  const foreign = blocks.filter(block => block.type !== 'text' && block.type !== 'image').map(block => block.type)
  if (foreign.length > 0) {
    throw new Error(`UNSUPPORTED_INPUT: CodeBuddy prompt keeps text and images only; refused block types ${foreign.join(',')}`)
  }
  return blocks.map(block => block.type === 'text' ? block.text : '').filter(part => part !== '').join('\n')
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
  /** The claimed inbox message; appended as-is so the client can retire its row. */
  readonly message: UserMessage
  readonly prompt: string
  readonly creator: boolean
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly model?: string
  /** Model to record on assistant messages; the CLI resolves it when the flag is omitted. */
  readonly recordModel: string
  readonly resume?: string
  readonly graceMs: number
  readonly signal: AbortSignal
  readonly onSession: (id: string) => Promise<void> | void
  readonly dispatch: AgentEventDispatch
  /**
   * Allocate the next assistant-stream revision.
   *
   * Every frame in one attached Agent lifecycle must carry the previous
   * revision plus one, across turns and attempts: the Host keeps one dense
   * stream per live Session and drops an attempt whose numbering breaks, and
   * the Web client rejects a skipped revision as a lost carrier. Only a
   * replacement may restart at 1.
   */
  readonly nextRevision: () => number
}): Promise<void> {
  const session = input.session
  session.append('turn/start', { turn: input.turn })
  // Append the claimed message itself, not a rebuilt copy.
  //
  // The Chat client hides an inbox row by the id it claimed (`currentClaimed`).
  // `createUserMessage()` mints a fresh id, so a rebuilt message never matches
  // the row the user already sees and the prompt renders twice until the turn
  // closes. The stock `agent-loop` appends the claimed message unchanged.
  session.append('user/message', input.message, { surfaceOp: 'append' })
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
  const abortQuery = () => { query.terminate() }
  input.signal.addEventListener('abort', abortQuery, { once: true })
  if (input.signal.aborted) abortQuery()
  const projector = new Projector()
  const committed: string[] = []
  let usage: TokenUsage | undefined
  let fault: ProtocolFault | undefined
  let sawResult = false
  let resultError = false
  let step = 1
  const attempt = LlmAttemptId(`codebuddy-${input.turn}`)
  /** Dense position of the next chunk frame within this attempt. */
  let chunkIndex = 0
  const dispatch = agentEvents(input.ctx, input.agent)
  let started = false
  /**
   * Step boundary bookkeeping.
   *
   * The Chat client keeps an assistant message's transient stream rows until
   * the Step that owns it ends, so it can retire them and reveal the durable
   * message in their place. A driver that never records `step/end` leaves both
   * visible at once, which reads as the same reply printed twice until the turn
   * closes. The stock `agent-loop` brackets every step with `step/start` and
   * `step/end`; this driver has to do the same.
   */
  let openStep: number | undefined
  const stepStart = (value: number): void => {
    if (openStep === value) return
    if (openStep !== undefined) session.append('step/end', { turn: input.turn, step: openStep })
    session.append('step/start', { turn: input.turn, step: value })
    openStep = value
  }
  const stepEnd = (value?: number): void => {
    const closing = value ?? openStep
    if (closing === undefined) return
    session.append('step/end', { turn: input.turn, step: closing })
    if (openStep === closing) openStep = undefined
  }
  const finishLive = (seq: number | undefined): void => {
    if (!started) return
    dispatch.emit('agent/assistant-stream', {
      frame: {
        type: 'end', attemptId: attempt, revision: input.nextRevision(), index: chunkIndex,
        outcome: seq === undefined
          ? { kind: 'abandoned' }
          : { kind: 'committed', eventType: 'assistant/message', seq: SessionSeq(seq) },
      },
    })
    started = false
    chunkIndex = 0
  }
  // `for await` on a quiet CLI blocks until a line arrives or the process
  // exits, which can be a whole SIGTERM grace period after a stop. Race each
  // read against the abort signal so the turn ends when the user asks.
  const closed = new AbortController()
  const stopReading = (): void => { closed.abort() }
  try {
    if (input.signal.aborted) throw abortError()
    input.signal.addEventListener('abort', stopReading, { once: true })
    const lines = query.messages[Symbol.asyncIterator]()
    for (;;) {
      const next = await raceAbort(lines.next(), closed.signal)
      if (next === undefined || next.done === true || input.signal.aborted) {
        void lines.return?.(undefined)
        break
      }
      const message = next.value
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
        else if (event.kind === 'live-chunk') {
          if (!started) {
            // The Step opens before its first token, the way `agent-loop`
            // brackets a model call. A transient chunk that arrived before its
            // own `step/start` would be an update whose start is missing, which
            // the conversation assembler rejects as an out-of-order Match.
            stepStart(step)
            dispatch.emit('agent/assistant-stream', {
              frame: { type: 'start', attemptId: attempt, revision: input.nextRevision(), turn: input.turn, step },
            })
            started = true
          }
          dispatch.emit('agent/assistant-stream', {
            frame: {
              type: 'chunk', attemptId: attempt, revision: input.nextRevision(), index: chunkIndex, time: Date.now(),
              chunk: event.chunk,
            },
          })
          chunkIndex += 1
        } else if (event.kind === 'usage') {
          usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
        } else if (event.kind === 'assistant') {
          const text = event.blocks.filter(block => block.type === 'text').map(block => block.text).join('')
          if (text !== '') committed.push(text)
          // Open the step before its message lands: the client matches a
          // settlement to the attempt by turn and step, so the message must
          // belong to a step the reader has already seen start.
          stepStart(step)
          const seq = appendAssistant(session, input.turn, step, event.blocks, usage, input.recordModel)
          finishLive(seq)
          // Close it before the next step inherits the same transient rows.
          stepEnd(step)
          step += 1
        } else if (event.kind === 'tool-call') {
          stepStart(step)
          session.append('tool/call', {
            turn: input.turn, step, callId: ToolCallId(event.id), name: event.name, arguments: event.arguments,
          })
        } else if (event.kind === 'tool-result') {
          stepStart(step)
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
          sawResult = true
          resultError = event.isError
        } else if (event.kind === 'diagnostic') {
          input.ctx.logger.warn(`codebuddy ${event.code}: ${event.detail}`)
        }
      }
      if (fault !== undefined || events.some(event => event.kind === 'result')) break
    }
  } finally {
    input.signal.removeEventListener('abort', stopReading)
    input.signal.removeEventListener('abort', abortQuery)
    finishLive(undefined)
    // A turn that ends mid-step (abort, protocol fault, CLI exit) would
    // otherwise leave the client's transient rows unreleased.
    stepEnd()
    if (input.signal.aborted) {
      // Record the turn boundary before any teardown wait. The CLI may ignore
      // SIGTERM for the whole grace period, and a user asking to stop must not
      // watch the UI stay "running" while the process is still being reaped.
      query.terminate()
      session.append('turn/end', {
        turn: input.turn,
        reason: { kind: 'aborted', reason: abortedCause(input.signal) },
      })
    } else if (sawResult) {
      if (resultError) {
        session.append('turn/end', {
          turn: input.turn,
          reason: { kind: 'error', error: { message: 'cli result reported an error', code: 'CLI_RESULT' } },
        })
      } else {
        session.append('turn/end', { turn: input.turn, reason: { kind: 'completed' } })
      }
      query.terminate()
    } else {
      const done = await query.finished()
      if (fault !== undefined || done.exitCode !== 0 && done.exitCode !== null) {
        const detail = fault?.detail ?? `cli exited ${done.exitCode}`
        const stderr = done.stderr === '' ? '' : `; stderr: ${done.stderr}`
        session.append('turn/end', {
          turn: input.turn,
          reason: { kind: 'error', error: { message: `${fault?.code ?? 'CLI_EXIT'}: ${detail}${stderr}`, code: fault?.code ?? 'CLI_EXIT' } },
        })
      } else {
        session.append('turn/end', { turn: input.turn, reason: { kind: 'completed' } })
      }
    }
    await input.dispatch.serial('agent/turn-stopping', { turn: input.turn, signal: input.signal })
  }
}

function previousSeq(session: Session): ReturnType<typeof SessionSeq> {
  const events = session.snapshotEvents()
  return events.at(-1)?.seq ?? SessionSeq(0)
}

/**
 * Await one async-iterator step, or give up as soon as `signal` aborts.
 * @param step - the pending read from a CLI stream.
 * @param signal - aborts when the turn is cancelled.
 * @returns the step result, or `undefined` once the signal aborted first.
 */
async function raceAbort<R>(
  step: Promise<R>,
  signal: AbortSignal,
): Promise<R | undefined> {
  if (signal.aborted) return undefined
  const aborted = Promise.withResolvers<undefined>()
  const onAbort = (): void => { aborted.resolve(undefined) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([step, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Copy only the fields `turn/end` records from the cancel cause carried by an
 * Agent-owned signal. The live reason may carry a `stack` that the log cannot.
 * @param signal - the turn signal aborted by {@link Agent.cancel}.
 * @returns the durable cancel cause, defaulting to a user stop.
 */
function abortedCause(signal: AbortSignal): AgentCancelCause {
  const cause = signal.reason as AgentCancelCause | undefined
  switch (cause?.kind) {
    case 'user':
    case 'parent':
    case 'disposed':
      return { kind: cause.kind }
    case 'hook':
      return { kind: 'hook', reason: cause.reason }
    default:
      return { kind: 'user' }
  }
}

function appendAssistant(
  session: Session,
  turn: number,
  step: number,
  blocks: readonly { type: 'text' | 'reasoning'; text: string }[],
  usage: TokenUsage | undefined,
  model: string,
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
      source: { provider: CODEBUDDY_PROVIDER, model },
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
    // `bypassPermissions` means the CLI should not ask, but an older or
    // differently configured build can still send this request. Allow it
    // outright: the driver has no approval channel to consult, and denying here
    // is what silently swallowed tool calls before.
    // No `callId`: the CLI sends this request before its `tool_use`, so the
    // Chat detail slot would find no correlated call when the card renders and
    // would show the command a second time once the call is logged.
    query.send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { allowed: true, updatedInput: body.input ?? {}, tool_use_id: body.tool_use_id },
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
  /**
   * Revision of the last assistant-stream frame this Agent emitted.
   *
   * The Host folds frames into one dense stream per live Session and drops an
   * attempt whose numbering skips, and the Web client refuses a gap as a lost
   * carrier. Counters therefore live on the Agent, not on one turn: a turn that
   * restarted at 1 would break every later turn's stream.
   */
  private assistantRevision = 0
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
    /** Live model-selection projection for this Session; re-read on every turn. */
    private readonly readSelection: () => ModelSelectionProjectionState = () => ({ lastUsed: null, pending: null }),
  ) {
    this.options = options
    this.session = session
    this.binding = binding
    this.inbox = new RecordingInbox(session)
    const scope = createScope(host, this)
    this.ctx = scope.ctx
    this.dispatch = agentEvents(host, this)
    this.model = new AgentModel(this.readSelection, session, options)
    this.session.append('model/selection', {
      provider: CODEBUDDY_PROVIDER,
      model: this.modelId(),
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

  /**
 * Model this agent reports for the current selection.
 *
 * The live selection wins. Selecting {@link DEFAULT_MODEL_ID}, or having no
 * selection at all, reports that id: the harness record must name something,
 * and the CLI resolves the concrete model itself.
 * @returns the model id to record and display.
 */
  private modelId(): string {
    return this.cliModel() === '' ? DEFAULT_MODEL_ID : this.cliModel()
  }

  /**
   * The `--model` value for the next CLI process.
   *
   * An empty string means "send no flag", which is how the CLI's own configured
   * model takes effect. {@link DEFAULT_MODEL_ID} is a synthetic selection that
   * maps to that empty string; it is never passed as an argument.
   *
   * Only a selection owned by this provider may become a `--model` value.
   * Model ids are provider-scoped, and the same underlying model can carry a
   * different id on another route — the native DeepSeek catalog calls one
   * `deepseek-flash` while this CLI calls it `deepseek-v4.1-flash`. Forwarding
   * a foreign id asks the CLI for a model it has never heard of, and the
   * gateway answers 400 with its whole model list, which the turn then renders
   * as a wall of text. A foreign selection therefore falls through to the
   * CLI's own configured model, the one route this driver can always honour.
   * @returns the model id to pass, or an empty string to omit the flag.
   */
  private cliModel(): string {
    const selected = this.model.current()
    const chosen = selected?.provider === CODEBUDDY_PROVIDER ? selected.model : ''
    if (chosen !== '' && chosen !== DEFAULT_MODEL_ID) return chosen
    // A settings-level model still pins every session, including `default`.
    if (this.launch.model !== undefined && this.launch.model !== '' && this.launch.model !== DEFAULT_MODEL_ID) {
      return this.launch.model
    }
    return ''
  }

  /**
   * The recorded selection when it belongs to another provider, or undefined.
   *
   * Model ids are provider-scoped, so a selection from another route names a
   * model this driver cannot run. Reported before a turn starts rather than
   * forwarded to the CLI as an unknown id.
   * @returns the foreign selection, or undefined when the session's own
   * provider is selected (or nothing is recorded yet).
   */
  private foreignSelection(): { provider: string; model: string } | undefined {
    const selected = this.model.current()
    if (selected === undefined || selected.provider === CODEBUDDY_PROVIDER) return undefined
    return { provider: selected.provider, model: selected.model }
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

  /**
   * Whether the running CLI ships `ViewImage`, cached after the first answer.
   *
   * Undefined until the catalog has been read, which happens on the first turn
   * that carries an image.
   */
  private viewImageSupport: boolean | undefined = undefined

  /**
   * Resolve whether this CLI build has `ViewImage`.
   * @returns the probe's answer, or true when discovery is unavailable so the
   * common case keeps naming the tool.
   */
  private async supportsViewImage(): Promise<boolean> {
    if (this.viewImageSupport !== undefined) return this.viewImageSupport
    const catalog = await discoverModels(this.host, {
      command: this.launch.command,
      args: this.launch.args,
      settingsPath: this.host.codebuddySettings.config.cliSettingsPath,
      timeoutMs: this.host.codebuddySettings.config.modelsTimeoutMs,
    }).catch(() => undefined)
    this.viewImageSupport = catalog?.viewImage ?? true
    return this.viewImageSupport
  }

  private async pump(): Promise<void> {
    while (this.inbox.nextTurn.length > 0 || this.inbox.nextStep.length > 0) {
      const message = this.inbox.nextTurn[0] ?? this.inbox.nextStep[0]
      if (message === undefined) return
      const target: InboxTarget = this.inbox.nextTurn.length > 0 ? 'next-turn' : 'next-step'
      this.inbox.splice(target, 0, 1, [])
      let text: string
      try {
        const attachments = this.host.get('attachments')
        text = promptContent(message, {
          cwd: this.session.header.cwd ?? process.cwd(),
          hostPath: ref => attachments?.imageHostPath(ref),
          // A build without the tool must not be told to use it; the staged
          // path alone is enough for `Read`.
          viewImage: await this.supportsViewImage(),
        })
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
      const foreign = this.foreignSelection()
      if (foreign !== undefined) {
        // The session is a CodeBuddy session for life: selecting a model from
        // another provider records a choice this driver cannot run, and no
        // retry can change that. Say so once, with the two ways out, instead of
        // sending an id the CLI does not know.
        this.session.append('turn/start', { turn: this.turn + 1 })
        this.session.append('turn/end', {
          turn: this.turn + 1,
          reason: {
            kind: 'error',
            error: {
              message: 'This session runs the CodeBuddy CLI, whose model ids are its own: '
                + `${foreign.provider}/${foreign.model} cannot be passed to it. `
                + 'Select a CodeBuddy model, or start a new session on that provider.',
              code: 'UNSUPPORTED_MODEL',
            },
          },
        })
        this.turn += 1
        continue
      }
      this.turn += 1
      const controller = new AbortController()
      this.active = controller
      try {
        const creator = this.currentPreset() === CREATOR_PRESET
        const model = this.cliModel()
        await runCliTurn({
          ctx: this.host,
          agent: this,
          session: this.session,
          turn: this.turn,
          message,
          prompt: text,
          creator,
          command: this.launch.command,
          args: this.launch.args,
          cwd: this.session.header.cwd ?? process.cwd(),
          ...model !== '' ? { model } : {},
          recordModel: this.modelId(),
          ...this.binding?.cliSessionId !== undefined ? { resume: this.binding.cliSessionId } : {},
          graceMs: this.launch.graceMs,
          signal: controller.signal,
          dispatch: this.dispatch,
          nextRevision: () => ++this.assistantRevision,
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
