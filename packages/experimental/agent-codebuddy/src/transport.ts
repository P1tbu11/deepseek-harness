import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { initializeRequest, launchArgs, type ProtocolMessage } from './protocol.ts'

/** A running CLI query. `finished` resolves only after the process group is gone. */
export interface CliQuery {
  readonly messages: AsyncIterable<ProtocolMessage>
  /** CLI lines written by the host, for tests. */
  readonly sent: readonly unknown[]
  /** Write one more NDJSON line. Used for permission and bridge replies. */
  send(value: unknown): void
  /**
   * Send `interrupt` when the pipe still accepts it, then start the provider's
   * termination ladder. Returns without awaiting exit so a caller can end its
   * turn immediately: the provider still escalates to SIGKILL after `graceMs`,
   * and owns the range until it is empty.
   */
  terminate(): void
  finished(): Promise<{ readonly exitCode: number | null; readonly stderr: string }>
}

/**
 * Spawn the configured CLI and speak stream-json. Interrupt acknowledgement
 * does not count as exit; `cancel` always terminates the managed process range.
 * @param ctx - context whose subprocess service owns the process group.
 * @param input - executable, arguments, directory, and creator-mode flag.
 * @returns the live query.
 */
export async function startQuery(ctx: Context, input: {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly resume?: string
  readonly model?: string
  readonly creator: boolean
  readonly prompt: string
  readonly graceMs: number
}): Promise<CliQuery> {
  const handle = ctx.subprocess.spawn({
    argv: [input.command, ...input.args, ...launchArgs({
      ...input.resume !== undefined && input.resume !== '' ? { resume: input.resume } : {},
      ...input.model !== undefined && input.model !== '' ? { model: input.model } : {},
      partial: true,
    })],
    cwd: input.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: input.graceMs,
  })
  const sent: unknown[] = []
  // A stopped CLI closes stdin; later writes (interrupt, permission replies)
  // must not surface as an unhandled EPIPE on the host stream.
  handle.stdin?.on('error', () => { /* stdin is best-effort after termination */ })
  const write = (value: unknown): void => {
    sent.push(value)
    handle.stdin?.write(`${JSON.stringify(value)}\n`)
  }
  let stderr = ''
  handle.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4000)
  })
  const messages = readMessages(handle)
  write({
    type: 'control_request',
    request_id: 'init',
    request: initializeRequest(input.creator),
  })
  write({
    type: 'user',
    session_id: '',
    message: { role: 'user', content: input.prompt },
    parent_tool_use_id: null,
  })
  return {
    messages,
    sent,
    send: write,
    terminate: () => {
      // `interrupt` is a courtesy: the CLI may be mid-stream and either ignores
      // it or has already closed stdin. Termination owns the guarantee.
      try {
        write({
          type: 'control_request',
          request_id: 'interrupt',
          request: { subtype: 'interrupt', reason: 'User interrupt' },
        })
      } catch {
        // A closed stdin means the CLI is already going away.
      }
      handle.terminate()
    },
    finished: async () => {
      const outcome = await handle.done.catch(() => ({ exitCode: null, signal: 'SIGKILL' as const }))
      return { exitCode: outcome.exitCode, stderr: redact(stderr) }
    },
  }
}

async function* readMessages(handle: SubprocessHandle): AsyncIterable<ProtocolMessage> {
  if (handle.stdout === undefined) return
  const lines = createInterface({ input: handle.stdout, crlfDelay: Infinity })
  for await (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      yield JSON.parse(trimmed) as ProtocolMessage
    } catch {
      yield { type: 'error', error: 'stdout line is not JSON' }
    }
  }
}

/**
 * Drop obvious credential material from a diagnostic tail.
 * @param text - stderr or protocol detail that may contain a token.
 * @returns the same text with bearer tokens, `sk-` keys, and secret assignments replaced.
 */
export function redact(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/(api[_-]?key|token|secret)(["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1$2[redacted]')
}
