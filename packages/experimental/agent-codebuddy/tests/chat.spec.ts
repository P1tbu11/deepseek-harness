/**
 * The one-shot path answers a `ctx.llm` caller that owns no session. These
 * tests drive the synthetic CLI peer through `stream()`, so they pin the
 * translation from stream-json frames to harness chunks and the argument
 * surface that keeps the call tool-free.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { buildOneShotInput, CliStream, oneShotArgs, streamOneShot } from '../src/chat.ts'
import { registerCodeBuddyCatalog } from '../src/catalog.ts'
import CodeBuddySettings from '../src/settings.ts'

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url))
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(run => run()))
  delete process.env.CODEBUDDY_ONESHOT
  delete process.env.CODEBUDDY_ARGV_LOG
})

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), 'codebuddy-oneshot-'))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(CodeBuddySettings, {
    enabled: true,
    command: process.execPath,
    args: [fixture],
    probe: false,
    stateDir: dir,
  })
  // The route under test is the catalog adapter, so mount only that plugin
  // rather than the whole loop: a one-shot call needs no session, agent, or
  // tool runtime.
  const release = registerCodeBuddyCatalog(ctx, ctx.codebuddySettings)
  cleanups.push(async () => {
    release()
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return { ctx, dir, settings: ctx.codebuddySettings }
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'codebuddy',
    model: 'deepseek-v4.1-flash',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } })],
    ...overrides,
  }
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

describe('buildOneShotInput', () => {
  it('sends a lone user turn bare, without a role label', () => {
    expect(buildOneShotInput(request())).toEqual({ prompt: 'hello there', system: '' })
  })

  it('lifts every system message into the replacement system prompt', () => {
    const input = buildOneShotInput(request({
      system: 'one-shot caller text',
      messages: [
        { id: 'sys', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'history system' }] },
        createUserMessage({ content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } }),
      ] as GenerateOptions['messages'],
    }))
    expect(input.system).toBe('one-shot caller text\n\nhistory system')
    expect(input.prompt).toBe('question')
  })

  it('labels earlier turns so a one-shot process still sees the history', () => {
    const input = buildOneShotInput(request({
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }),
        { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'codebuddy', model: 'm' }, content: [{ type: 'text', text: 'reply' }] },
        createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }),
      ] as GenerateOptions['messages'],
    }))
    expect(input.prompt).toBe('first\n\nAssistant: reply\n\nsecond')
  })

  it('names an image instead of sending bytes this route cannot carry', () => {
    const input = buildOneShotInput(request({
      messages: [createUserMessage({
        content: [
          { type: 'text', text: 'caption this' },
          { type: 'image', attachment: { attachmentId: AttachmentId('a1'), mediaType: 'image/png', bytes: 4, width: 1, height: 1 } },
        ],
        source: { kind: 'user' },
      })],
    }))
    expect(input.prompt).toBe('caption this\n[image omitted: this one-shot call sends text only]')
  })

  it('refuses a request with nothing to answer', () => {
    expect(() => buildOneShotInput(request({ messages: [] })))
      .toThrow(/no user content/)
  })
})

describe('oneShotArgs', () => {
  it('streams deltas and closes every tool path the build honors', () => {
    const args = oneShotArgs({ model: 'deepseek-v4.1-flash', system: 'be brief' })
    expect(args).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--tools', '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--model', 'deepseek-v4.1-flash',
      '--system-prompt', 'be brief',
    ])
    // Headless tool use needs explicit pre-authorization; neither flag appears.
    expect(args).not.toContain('--permission-mode')
    expect(args).not.toContain('-y')
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('omits --model for the synthetic default so the CLI keeps its own', () => {
    expect(oneShotArgs({})).not.toContain('--model')
    expect(oneShotArgs({})).not.toContain('--system-prompt')
  })
})

describe('CliStream', () => {
  it('turns deltas into blocks and settles once on result', () => {
    const stream = new CliStream()
    const chunks = [
      ...stream.push({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 4 } } } }),
      ...stream.push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }),
      ...stream.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'he' } } }),
      ...stream.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'llo' } } }),
      ...stream.push({ type: 'stream_event', event: { type: 'content_block_stop' } }),
      // A second round must not be cut short by the first assistant message.
      ...stream.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
      ...stream.push({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 4, output_tokens: 2 } }),
    ]
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toHaveLength(2)
    expect(chunks.filter(chunk => chunk.type === 'finish')).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(stream.push({ type: 'result', subtype: 'success', is_error: false })).toEqual([])
    expect(stream.end({ exitCode: 0, stderr: '' })).toEqual([])
  })

  it('rebuilds blocks from a whole assistant message when the build never streams', () => {
    const stream = new CliStream()
    const chunks = [
      ...stream.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'whole' }] } }),
      ...stream.push({ type: 'result', subtype: 'success', is_error: false }),
    ]
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'whole' }])
  })

  it('reports an empty answer rather than a silent stop', () => {
    const stream = new CliStream()
    expect(() => stream.push({ type: 'result', subtype: 'success', is_error: false }))
      .toThrow(/no content/)
  })

  it('fails on a tool block this route cannot execute', () => {
    const stream = new CliStream()
    stream.push({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Bash' } } })
    expect(() => stream.push({ type: 'result', subtype: 'success', is_error: false }))
      .toThrow(/cannot execute/)
  })

  it('carries the CLI failure text, with credentials redacted', () => {
    const stream = new CliStream()
    expect(() => stream.push({ type: 'result', subtype: 'error', is_error: true, result: 'boom api_key=abc123' }))
      .toThrow(/boom api_key=\[redacted\]/)
  })
})

describe('streamOneShot', () => {
  it('streams a real transcript through the adapter', async () => {
    const { ctx, settings } = await boot()
    const chunks = await collect(ctx.llm.stream(request()))
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: 'plan' },
      { type: 'text', text: 'answer from prompt' },
    ])
    // The fixture reports input_tokens 11 with cache_read 2, the Messages shape
    // where the total already contains the cache. The harness keeps counters
    // disjoint, so the uncached input is 11 − 2 = 9 and the context gauge
    // (9 + 2) still totals the 11 the provider counted.
    expect(assembler.usage).toMatchObject({ inputTokens: 9, outputTokens: 3, cacheReadTokens: 2 })
    expect(assembler.usage?.totalTokens).toBe(14)
    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(settings.config.enabled).toBe(true)
  })

  it('passes the flattened prompt on stdin, not as a control frame', async () => {
    const { ctx, settings } = await boot()
    process.env.CODEBUDDY_ONESHOT = 'stream'
    const chunks = await collect(streamOneShot(ctx, settings, request()))
    const text = chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : []).join('')
    expect(text).toBe('answer from prompt')
  })

  it('answers from a build that never streams deltas', async () => {
    process.env.CODEBUDDY_ONESHOT = 'whole'
    const { ctx } = await boot()
    const assembler = new BlockAssembler()
    for (const chunk of await collect(ctx.llm.stream(request()))) assembler.push(chunk)
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'whole answer' }])
  })

  it('turns a failed turn into one terminal error finish', async () => {
    process.env.CODEBUDDY_ONESHOT = 'error'
    const { ctx } = await boot()
    const last = (await collect(ctx.llm.stream(request()))).at(-1)
    expect(last).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(last).toMatchObject({ reason: { failure: { code: 'CODEBUDDY_ONE_SHOT' } } })
  })

  it('reports a process that dies before any result frame', async () => {
    process.env.CODEBUDDY_ONESHOT = 'silent'
    const { ctx } = await boot()
    const last = (await collect(ctx.llm.stream(request()))).at(-1)
    expect(last).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'CODEBUDDY_ONE_SHOT' } } })
    expect(JSON.stringify(last)).toContain('crashed before result')
  })
})
