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
      return projected.events.filter(event => event.kind !== 'live-text' && event.kind !== 'usage' && event.kind !== 'diagnostic' && event.kind !== 'session' && event.kind !== 'result')
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
