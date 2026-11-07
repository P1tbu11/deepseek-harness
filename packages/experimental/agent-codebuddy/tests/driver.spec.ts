import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as applyPluginTools } from '@deepseek-ai/dsh-plugin-manager/tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import CodeBuddyLoop from '../src/index.ts'
import CodeBuddySettings from '../src/settings.ts'

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url))

class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = 'deepseek-ok'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(
  config: Record<string, unknown>,
  decision: 'allowed-once' | 'rejected' | 'hold' = 'allowed-once',
) {
  const dir = await mkdtemp(join(tmpdir(), 'codebuddy-'))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(ApprovalService)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) })
  const calls = { pluginLists: 0 }
  ctx.provide('pluginManager', {
    listPlugins: async () => {
      calls.pluginLists += 1
      return [{ id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools' }]
    },
    listBundles: async () => [],
  })
  applyPluginTools(ctx)
  const approvals: ApprovalRequestEvent[] = []
  ctx.on('approval/request', (request) => {
    approvals.push(request)
    return decision === 'hold' ? new Promise(() => {}) : Promise.resolve(decision)
  })
  const adapter = new MockAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(CodeBuddySettings, { stateDir: dir, ...config })
  await ctx.plugin(CodeBuddyLoop, { agents: [] })
  return {
    ctx,
    dir,
    adapter,
    calls,
    approvals,
    async stop() { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) },
  }
}

const dirs: { stop(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(item => item.stop()))
  delete process.env.CODEBUDDY_FIXTURE
  delete process.env.CODEBUDDY_ARGV_LOG
  delete process.env.CODEBUDDY_CHILD_PID_FILE
})

function codebuddyConfig(dir: string) {
  return {
    enabled: true,
    command: process.execPath,
    args: [fixture],
    probe: false,
    stateDir: dir,
  }
}

async function bootCodeBuddy(
  scenario: string,
  decision: 'allowed-once' | 'rejected' | 'hold' = 'allowed-once',
) {
  const dir = await mkdtemp(join(tmpdir(), 'codebuddy-run-'))
  process.env.CODEBUDDY_FIXTURE = scenario
  process.env.CODEBUDDY_ARGV_LOG = join(dir, 'argv.log')
  process.env.CODEBUDDY_CHILD_PID_FILE = join(dir, 'child.pid')
  const started = await harness(codebuddyConfig(dir), decision)
  dirs.push({ stop: async () => { await started.stop(); await rm(dir, { recursive: true, force: true }) } })
  const handle = await started.ctx.agents.create({
    sessionId: SessionId(`cb-${scenario}-${decision}`),
    agentOptions: { provider: 'codebuddy', model: 'cli-default' },
    meta: { cwd: dir, agentPreset: scenario === 'creator' ? 'cordis' : 'standard' },
  })
  return { ...started, dir, agent: handle.agent }
}

function texts(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap((event) => {
    if (event.type !== 'assistant/message') return []
    return event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
  })
}

describe('CodeBuddy fixture sessions', () => {
  it('replays two turns through one CLI session id and does not duplicate streamed text', async () => {
    const { agent, dir, adapter, calls: pluginCalls } = await bootCodeBuddy('chat')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(texts(agent)).toEqual(['你好', 'done ```js\nconst x = 1\n```', '你好', 'done ```js\nconst x = 1\n```'])
    expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain('do-not-persist')
    const calls = agent.session.snapshotEvents().filter(event => event.type === 'tool/call')
    expect(calls.map(event => event.type === 'tool/call' ? event.data.callId : '')).toEqual(['toolu_1', 'toolu_1'])
    const argv = (await readFile(join(dir, 'argv.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(argv[0]?.includes('--resume')).toBe(false)
    expect(argv[1]).toContain('--resume')
    expect(argv[1]).toContain('cli-sess-1')
    expect(argv[0]?.includes('--system-prompt')).toBe(false)
    expect(argv[0]?.includes('--tools')).toBe(false)
    expect(pluginCalls.pluginLists).toBe(0)
    expect(adapter.requests).toHaveLength(0)
  })

  it('resumes the same CLI session from a new factory instance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codebuddy-resume-'))
    process.env.CODEBUDDY_FIXTURE = 'chat'
    process.env.CODEBUDDY_ARGV_LOG = join(dir, 'argv.log')
    const first = await harness(codebuddyConfig(dir))
    const created = await first.ctx.agents.create({
      sessionId: SessionId('cb-resume'),
      agentOptions: { provider: 'codebuddy', model: 'cli-default' },
      meta: { cwd: dir },
    })
    created.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await created.agent.whenIdle()
    await first.ctx.fiber.dispose()
    const second = await harness(codebuddyConfig(dir))
    dirs.push(first, second, { stop: async () => rm(dir, { recursive: true, force: true }) })
    const resumed = await second.ctx.agents.resume({
      resumeSessionId: SessionId('cb-resume'),
      agentOptions: { provider: 'codebuddy', model: 'cli-default' },
    })
    resumed.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await resumed.agent.whenIdle()
    const argv = (await readFile(join(dir, 'argv.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(argv.at(-1)).toContain('cli-sess-1')
  })

  it.each(['allowed-once', 'rejected'] as const)('returns the human %s decision to the fixture', async (decision) => {
    const { agent } = await bootCodeBuddy('permission', decision)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'echo hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' ? result.data.message.content : []).toEqual([
      { type: 'text', text: decision === 'allowed-once' ? 'allowed' : 'denied' },
    ])
    const end = agent.session.snapshotEvents().find(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' ? end.data.reason.kind : '').toBe('completed')
  })

  it('asks the human about the CLI command, not only the tool name', async () => {
    const { agent, approvals } = await bootCodeBuddy('permission')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'echo hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(approvals).toHaveLength(1)
    expect(approvals[0]?.toolName).toBe('Bash')
    expect(approvals[0]?.displayReason?.en).toContain('echo hi')
    expect(approvals[0]?.displayReason?.zh).toContain('echo hi')
    expect(approvals[0]?.displayReason?.ja).toContain('echo hi')
    expect(approvals[0]?.reason).toBe('CodeBuddy CLI asks to use Bash')
  })

  it('keeps the CLI command out of the durable approval audit', async () => {
    const { agent } = await bootCodeBuddy('permission')
    const command = 'export TOKEN=hunter2 && curl -H "Authorization: Bearer hunter2" https://example.test'
    agent.followup(createUserMessage({ content: [{ type: 'text', text: command }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const approvalEvents = agent.session.snapshotEvents()
      .filter(event => event.type === 'approval/asked' || event.type === 'approval/decided')
    expect(JSON.stringify(approvalEvents)).not.toContain('hunter2')
    const asked = agent.session.snapshotEvents().find(event => event.type === 'approval/asked')
    expect(asked?.type === 'approval/asked' ? asked.data.reason : '').toBe('CodeBuddy CLI asks to use Bash')
    // The call itself stays logged: the tool/call arguments are the model-visible record.
    const call = agent.session.snapshotEvents().find(event => event.type === 'tool/call')
    expect(call?.type === 'tool/call' ? call.data.arguments : '').toContain('hunter2')
  })

  it('ends the turn on result while the CLI process stays up, then stops that process', async () => {
    const { agent, dir } = await bootCodeBuddy('persist')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const pid = Number(await readFile(join(dir, 'child.pid'), 'utf8'))
    // The turn ends on `result`; teardown of the resident process follows it.
    expect(turnEnds(agent)).toEqual(['completed'])
    expect(await waitForDeath(pid)).toBe(true)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(turnEnds(agent)).toEqual(['completed', 'completed'])
    const argv = (await readFile(join(dir, 'argv.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(argv[1]).toContain('--resume')
    expect(argv[1]).toContain('cli-sess-1')
  })

  it('ends an approved resident turn on result instead of waiting for process exit', async () => {
    const { agent } = await bootCodeBuddy('persist-approval')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'echo hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(texts(agent)).toContain('allowed')
    expect(turnEnds(agent)).toEqual(['completed'])
  })

  it('records a resident error result without treating the later stop as the outcome', async () => {
    const { agent } = await bootCodeBuddy('persist-error')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const end = agent.session.snapshotEvents().find(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' ? end.data.reason : {}).toMatchObject({ kind: 'error', error: { code: 'CLI_RESULT' } })
  })

  it('kills the fixture and its child when approval is cancelled', async () => {
    const { agent, dir } = await bootCodeBuddy('hang', 'hold')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'sleep' }], source: { kind: 'user' } }))
    await new Promise(resolve => setTimeout(resolve, 300))
    const pid = Number(await readFile(join(dir, 'child.pid'), 'utf8'))
    expect(pid).toBeGreaterThan(0)
    const started = Date.now()
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    // A stop while the approval card is open must end the turn, not wait for an answer.
    expect(turnEnds(agent)).toEqual(['aborted'])
    expect(Date.now() - started).toBeLessThan(2000)
    expect(await waitForDeath(pid)).toBe(true)
  })

  it('ends an aborted turn without waiting for a CLI that ignores SIGTERM', async () => {
    const { agent, dir } = await bootCodeBuddy('stubborn')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'a long question' }], source: { kind: 'user' } }))
    await waitForEvent(agent, 'assistant/message')
    const pid = Number(await readFile(join(dir, 'child.pid'), 'utf8'))
    const started = Date.now()
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    const elapsed = Date.now() - started
    // The default grace is 3000ms; waiting for a graceful exit would take that long.
    expect(elapsed).toBeLessThan(2000)
    // The decisive part: the turn boundary is durable while teardown is still
    // running. Otherwise the UI keeps showing the turn as active.
    expect(turnEnds(agent)).toEqual(['aborted'])
    expect(alive(pid)).toBe(true)
    expect(await waitForDeath(pid)).toBe(true)
  })

  it('stops a streaming turn when the user cancels and terminates the CLI', async () => {
    const { agent, dir } = await bootCodeBuddy('thinking')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'a long question' }], source: { kind: 'user' } }))
    await waitForEvent(agent, 'assistant/message')
    const pid = Number(await readFile(join(dir, 'child.pid'), 'utf8'))
    expect(alive(pid)).toBe(true)
    const started = Date.now()
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    const elapsed = Date.now() - started
    expect(turnEnds(agent)).toEqual(['aborted'])
    expect(elapsed).toBeLessThan(5000)
    expect(await waitForDeath(pid)).toBe(true)
  })

  it('lets a creator-mode CodeBuddy session discover and call plugin_manager once', async () => {
    const { agent, adapter, calls: pluginCalls } = await bootCodeBuddy('creator')
    agent.session.append('agent-preset/selected', { agentPreset: 'cordis' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'list plugins' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const text = texts(agent).join('\n')
    expect(text).toContain('tool-plugin-manager')
    expect(text).not.toContain('secret')
    const calls = agent.session.snapshotEvents().filter(event => event.type === 'tool/call')
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(calls.map(event => event.type === 'tool/call' ? event.data.name : '')).toEqual(['plugin_manager'])
    expect(results).toHaveLength(1)
    expect(pluginCalls.pluginLists).toBe(1)
    expect(adapter.requests).toHaveLength(0)
  })

  it('does not treat an unknown event as success or store its payload', async () => {
    const { agent } = await bootCodeBuddy('unknown')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const end = agent.session.snapshotEvents().find(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' ? end.data.reason : {}).toMatchObject({ kind: 'error', error: { code: 'UNKNOWN_PROTOCOL' } })
    expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain('secret-token')
    expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain('should-not-win')
  })

  it('reports a non-zero exit and redacts stderr', async () => {
    const { agent } = await bootCodeBuddy('fail')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const end = agent.session.snapshotEvents().find(event => event.type === 'turn/end')
    const reason = end?.type === 'turn/end' ? end.data.reason : undefined
    expect(reason?.kind).toBe('error')
    if (reason?.kind === 'error') {
      expect(reason.error.message).toContain('CLI_EXIT')
      expect(reason.error.message).toContain('[redacted]')
      expect(reason.error.message).not.toContain('abc123')
    }
  })
})

describe('DeepSeek sessions and profile shape', () => {
  it('keeps a non-codebuddy session on the default loop', async () => {
    const started = await harness({ enabled: false, probe: false })
    dirs.push(started)
    const handle = await started.ctx.agents.create({
      sessionId: SessionId('deepseek-1'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    expect(texts(handle.agent)).toEqual(['deepseek-ok'])
    expect(started.adapter.requests).toHaveLength(1)
    expect(started.ctx.tools.executable('plugin_manager')).toBeDefined()
    expect(started.ctx.llm.listProviders().map(provider => provider.id)).toContain('codebuddy')
    await expect(started.ctx.llm.listModels('codebuddy')).resolves.toEqual([
      {
        provider: 'codebuddy', id: 'cli-default', name: 'cli-default', inputModalities: ['text'],
        badge: { text: { en: 'New session', zh: '新会话' }, tone: 'warning' },
      },
    ])
  })
})

function turnEnds(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])
}

/** Resolve once the Session log contains the named event type. */
async function waitForEvent(agent: Agent, type: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (agent.session.snapshotEvents().some(event => event.type === type)) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for session event "${type}"`)
}

/**
 * Wait for a terminated process tree to stop being observable. Teardown runs
 * after the turn ends, so a stop is prompt for the caller while the provider
 * still walks its TERM-then-KILL ladder.
 */
async function waitForDeath(pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
