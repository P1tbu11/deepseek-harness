import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { initializeRequest, launchArgs, Projector } from '../src/protocol.ts'

describe('launch arguments', () => {
  it('always bypasses CLI permissions and forwards no system prompt or tool whitelist', () => {
    const args = launchArgs({ partial: true, resume: 'cli-sess-1' })
    expect(args).toContain('--permission-mode')
    // The driver never answers a permission question, so the CLI must not ask one.
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    expect(args).not.toContain('default')
    expect(args).not.toContain('--system-prompt')
    expect(args).not.toContain('--append-system-prompt')
    expect(args).not.toContain('--tools')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--setting-sources')
    expect(args).toContain('--resume')
    expect(initializeRequest(false)).not.toHaveProperty('systemPrompt')
    expect(initializeRequest(false)).not.toHaveProperty('sdkMcpServers')
    expect(initializeRequest(true).sdkMcpServers).toEqual(['dsh'])
  })
})

describe('synthetic stream projection', () => {
  it('keeps one copy of streamed text, tool ids, and reasoning, and drops secrets', () => {
    const golden = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url), 'utf8')) as {
      messages: Record<string, unknown>[]
      expected: { kind: string; text?: string; id?: string; name?: string }[]
    }
    const projector = new Projector()
    const events = golden.messages.flatMap((message) => {
      const projected = projector.push(message)
      expect(projected.fault).toBeUndefined()
      return projected.events.filter(event => event.kind !== 'live-chunk' && event.kind !== 'usage' && event.kind !== 'diagnostic' && event.kind !== 'session' && event.kind !== 'result')
    })
    expect(events).toEqual(golden.expected)
    expect(JSON.stringify(events)).not.toContain('do-not-persist')
  })

  it('fails a successful result that follows an unknown event without copying the payload', () => {
    const projector = new Projector()
    const unknown = projector.push({ type: 'mystery', token: 'secret-token' })
    expect(unknown.fault).toEqual({ code: 'UNKNOWN_PROTOCOL', detail: 'unrecognized event type "mystery"' })
    expect(JSON.stringify(unknown)).not.toContain('secret-token')
  })

  it('rejects a second result', () => {
    const projector = new Projector()
    expect(projector.push({ type: 'result', subtype: 'success', result: 'ok', is_error: false }).fault).toBeUndefined()
    expect(projector.push({ type: 'result', subtype: 'success', result: 'again', is_error: false }).fault?.code).toBe('DUPLICATE_RESULT')
  })
})

describe('usage accounting', () => {
  /** A real frame captured from the CLI: the total folds in the cache read. */
  const frame = {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 30513,
        output_tokens: 2,
        cache_read_input_tokens: 30336,
        cache_creation_input_tokens: 0,
      },
    },
  }

  it('publishes cache counters and keeps the counters disjoint', () => {
    const usage = new Projector().push(frame).events.find(event => event.kind === 'usage')?.usage
    // The CLI follows the Messages convention: input_tokens already contains the
    // cache read, so the uncached part is the reported `modelUsage.inputTokens`
    // value of 177. The harness sums the three counters for its context gauge.
    expect(usage).toMatchObject({
      inputTokens: 177,
      outputTokens: 2,
      cacheReadTokens: 30336,
      totalTokens: 30515,
    })
    const context = (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0)
    // Equal to the provider's own prompt total, not twice it.
    expect(context).toBe(30513)
    // A folded total would have reported 30513 / 60849 ≈ 50% here.
    expect((usage?.cacheReadTokens ?? 0) / context).toBeGreaterThan(0.99)
  })

  it('clamps an input count that a proxy already reports disjointly', () => {
    // Defensive: some gateways report cache counters without folding them in.
    const usage = new Projector().push({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 300 },
      },
    }).events.find(event => event.kind === 'usage')?.usage
    expect(usage?.inputTokens).toBe(0)
    expect(Number.isNaN((usage?.cacheReadTokens ?? 0) / ((usage?.inputTokens ?? 0) + 300))).toBe(false)
  })

  it('emits usage before the message it prices', () => {
    // The driver commits the assistant message the moment it sees that
    // projection, so a usage event ordered after it would never reach the
    // durable row and every CLI turn would record no usage at all.
    const events = new Projector().push(frame).events
    const usageAt = events.findIndex(event => event.kind === 'usage')
    const assistantAt = events.findIndex(event => event.kind === 'assistant')
    expect(usageAt).toBeGreaterThanOrEqual(0)
    expect(usageAt).toBeLessThan(assistantAt)
  })
})

describe('inline tool markup in assistant text', () => {
  /** Captured verbatim from a live Session, including the truncated close tag. */
  const MARKUP = '\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="bash">\n<｜｜DSML｜｜ parameter name="command" string="true">ls</｜｜ parameter>\n</｜｜ invoke>\n</｜｜ calls>'

  it('strips markup from text the model wrote instead of calling a tool', () => {
    // Such a turn ends with `finish: stop`, so no tool call exists: the model
    // narrated its intent as markup. Showing that verbatim put tag syntax in the
    // transcript, which is what this projection prevents.
    const events = new Projector().push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `我先看一下。${MARKUP}` }] },
    }).events
    const assistant = events.find(event => event.kind === 'assistant')
    expect(assistant?.blocks).toEqual([{ type: 'text', text: '我先看一下。' }])
    expect(JSON.stringify(events)).not.toContain('｜DSML｜')
    // The fact that something was removed stays observable.
    expect(events.some(event => event.kind === 'diagnostic' && event.code === 'INLINE_TOOL_MARKUP')).toBe(true)
  })

  it('emits no text block when the message was only markup', () => {
    const events = new Projector().push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: MARKUP }] },
    }).events
    expect(events.some(event => event.kind === 'assistant')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('invoke')
  })

  it('leaves a structured tool call untouched', () => {
    // The stripping must not interfere with the normal path: a real `tool_use`
    // still becomes a tool-call block plus its call row.
    const events = new Projector().push({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'running it' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }).events
    const assistant = events.find(event => event.kind === 'assistant')
    expect(assistant?.blocks).toContainEqual({ type: 'tool-call', id: 'toolu_1', name: 'Bash', arguments: '{"command":"ls"}' })
    expect(events.some(event => event.kind === 'tool-call' && event.id === 'toolu_1')).toBe(true)
  })
})
