import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
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

async function harness(config: Record<string, unknown>) {
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
    // The CodeBuddy driver answers the CLI's own permission requests and never
    // reaches this channel. DSH tools the bridge exposes do consult it, so keep
    // the answer permissive; tests that assert the CLI path record any request
    // here and fail if the driver ever starts asking.
    return Promise.resolve('allowed-once')
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

async function bootCodeBuddy(scenario: string, onFrame?: (frame: AssistantStreamFrame) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'codebuddy-run-'))
  process.env.CODEBUDDY_FIXTURE = scenario
  process.env.CODEBUDDY_ARGV_LOG = join(dir, 'argv.log')
  process.env.CODEBUDDY_CHILD_PID_FILE = join(dir, 'child.pid')
  const started = await harness(codebuddyConfig(dir))
  dirs.push({ stop: async () => { await started.stop(); await rm(dir, { recursive: true, force: true }) } })
  const handle = await started.ctx.agents.create({
    sessionId: SessionId(`cb-${scenario}`),
    agentOptions: { provider: 'codebuddy', model: 'default' },
    meta: { cwd: dir, agentPreset: scenario === 'creator' ? 'cordis' : 'standard' },
  })
  if (onFrame !== undefined) {
    started.ctx.on('agent/assistant-stream', ({ frame }) => { onFrame(frame) }, { global: true })
  }
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
      agentOptions: { provider: 'codebuddy', model: 'default' },
      meta: { cwd: dir },
    })
    created.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await created.agent.whenIdle()
    await first.ctx.fiber.dispose()
    const second = await harness(codebuddyConfig(dir))
    dirs.push(first, second, { stop: async () => rm(dir, { recursive: true, force: true }) })
    const resumed = await second.ctx.agents.resume({
      resumeSessionId: SessionId('cb-resume'),
      agentOptions: { provider: 'codebuddy', model: 'default' },
    })
    resumed.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await resumed.agent.whenIdle()
    const argv = (await readFile(join(dir, 'argv.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(argv.at(-1)).toContain('cli-sess-1')
  })

  it('answers the CLI permission request with an allow, never an ask', async () => {
    // `bypassPermissions` normally stops the CLI from asking. This drives the
    // request anyway: the driver must allow it outright, because it has no
    // approval channel to consult and denying is what silently swallowed turns.
    const { agent, approvals } = await bootCodeBuddy('permission')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'echo hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' ? result.data.message.content : []).toEqual([
      { type: 'text', text: 'allowed' },
    ])
    const end = agent.session.snapshotEvents().find(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' ? end.data.reason.kind : '').toBe('completed')
    // No approval surfaced to the user, so the run cannot depend on one.
    expect(approvals).toHaveLength(0)
  })

  it('launches the CLI with bypassPermissions in every turn', async () => {
    const { agent, dir } = await bootCodeBuddy('chat')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const argv = (await readFile(join(dir, 'argv.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(argv.length).toBeGreaterThanOrEqual(2)
    for (const line of argv) {
      const at = line.indexOf('--permission-mode')
      expect(at).toBeGreaterThanOrEqual(0)
      expect(line[at + 1]).toBe('bypassPermissions')
      expect(line).not.toContain('default')
    }
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

  it('kills the fixture and its child when the CLI stays silent after an allow', async () => {
    const { agent, dir } = await bootCodeBuddy('hang')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'sleep' }], source: { kind: 'user' } }))
    await new Promise(resolve => setTimeout(resolve, 300))
    const pid = Number(await readFile(join(dir, 'child.pid'), 'utf8'))
    expect(pid).toBeGreaterThan(0)
    const started = Date.now()
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    // A stop while the CLI is still running must end the turn immediately,
    // whatever it is waiting on, rather than block until the process exits.
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
    // This profile names no CLI path, so discovery cannot run and the catalog
    // falls back to the built-in snapshot. The synthetic default leads either way.
    const models = await started.ctx.llm.listModels('codebuddy')
    expect(models.length).toBeGreaterThan(1)
    expect(models[0]).toMatchObject({
      provider: 'codebuddy', id: 'default', name: 'Default', inputModalities: ['text', 'image'],
    })
  })

  it('resolves every advertised model so a picker selection can commit', async () => {
    const { ctx } = await bootCodeBuddy('chat')
    const models = await ctx.llm.listModels('codebuddy')
    expect(models.length).toBeGreaterThan(1)
    for (const model of models) {
      // The session controller validates a click with exactly this pair before
      // recording it, so a failure here is the "请选择模型" symptom.
      await expect(ctx.llm.resolveCallConfig({ provider: 'codebuddy', model: model.id }))
        .resolves.toMatchObject({ provider: 'codebuddy', model: model.id })
      await expect(ctx.llm.resolveModelInfo('codebuddy', model.id))
        .resolves.toMatchObject({ provider: 'codebuddy', id: model.id })
    }
  })

  it('labels the synthetic default from the catalog rather than echoing the id', async () => {
    const { ctx } = await bootCodeBuddy('chat')
    const info = await ctx.llm.resolveModelInfo('codebuddy', 'default')
    expect(info).toMatchObject({ provider: 'codebuddy', id: 'default', name: 'Default', inputModalities: ['text', 'image'] })
    expect(info.description).toContain('CodeBuddy CLI')
  })

  it('rejects a model id the catalog does not advertise', async () => {
    const { ctx } = await bootCodeBuddy('chat')
    await expect(ctx.llm.resolveModelInfo('codebuddy', 'not-a-real-model'))
      .rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
  })

  it('appends the claimed inbox message so the client retires its own row', async () => {    const { agent } = await bootCodeBuddy('chat')
    const sent = createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    agent.followup(sent)
    await agent.whenIdle()
    const appended = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
    // One row: the claimed message itself. Rebuilding it would mint a new id,
    // and the Chat client hides inbox rows by the id it claimed, so a copy
    // would render alongside the pending row until the turn closed.
    expect(appended).toHaveLength(1)
    // `user/message` carries the message itself as its data.
    const row = appended[0]
    expect(row?.type === 'user/message' ? row.data.id : undefined).toBe(sent.id)
  })

  it('brackets every step so the client can retire its transient rows', async () => {
    const { agent } = await bootCodeBuddy('chat')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    for (const event of events) {
      if (event.type !== 'assistant/message') continue
      const { turn, step } = event.data
      const started = events.findIndex(candidate =>
        candidate.type === 'step/start' && candidate.data.turn === turn && candidate.data.step === step)
      const ended = events.findIndex(candidate =>
        candidate.type === 'step/end' && candidate.data.turn === turn && candidate.data.step === step)
      // The chat client keeps an assistant message's transient stream rows until
      // the Step owning it ends; without a close, both copies stay on screen.
      expect(started).toBeGreaterThanOrEqual(0)
      expect(ended).toBeGreaterThan(started)
    }
  })

  it('closes the open step when a turn is stopped mid-stream', async () => {
    const { agent } = await bootCodeBuddy('stubborn')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await new Promise(resolve => setTimeout(resolve, 300))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const opened = events.filter(event => event.type === 'step/start').length
    const closed = events.filter(event => event.type === 'step/end').length
    // Every opened step is closed even though the CLI never produced a result.
    expect(opened).toBeGreaterThan(0)
    expect(closed).toBe(opened)
  })

  it('streams the CLI deltas to the client as dense, ordered revision frames', async () => {
    const frames: AssistantStreamFrame[] = []
    const { agent } = await bootCodeBuddy('chat', (frame) => { frames.push(frame) })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(frames.length).toBeGreaterThan(0)
    // The client rejects a skipped revision as a lost carrier, so a stream that
    // numbered every frame the same would never reach the browser at all.
    expect(frames.map(frame => frame.revision)).toEqual(frames.map((_, index) => index + 1))
    // A chunk's position is dense from zero within its attempt.
    const chunks = frames.filter(frame => frame.type === 'chunk')
    expect(chunks.map(frame => frame.index)).toEqual(chunks.map((_, index) => index))
    // The streamed text is what the CLI sent, in the CLI's own block order.
    const streamed = chunks.flatMap(frame => frame.type === 'chunk' && frame.chunk.type === 'text-delta' ? [frame.chunk] : [])
    expect(streamed.map(chunk => chunk.text).join('')).toBe('你好')
    // Nothing may arrive before the step it belongs to exists: a transient
    // chunk ahead of its `step/start` is an update with a missing start.
    const events = agent.session.snapshotEvents()
    const firstStepStart = events.findIndex(event => event.type === 'step/start')
    expect(firstStepStart).toBeGreaterThanOrEqual(0)
    expect(frames.every(frame => frame.type === 'start' ? frame.step >= 1 : true)).toBe(true)
  })

  it('keeps the assistant stream alive across turns and steps', async () => {
    const frames: AssistantStreamFrame[] = []
    const { agent } = await bootCodeBuddy('chat', (frame) => { frames.push(frame) })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const firstTurn = frames.length
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    // One dense numbering for the whole Agent, not a fresh count per turn: the
    // Host keeps a single stream per live Session.
    expect(frames.map(frame => frame.revision)).toEqual(frames.map((_, index) => index + 1))
    expect(firstTurn).toBeGreaterThan(0)
    expect(frames.length).toBeGreaterThan(firstTurn)
    // Each attempt ends after its own chunks, so no attempt is left open.
    const starts = frames.filter(frame => frame.type === 'start').length
    const ends = frames.filter(frame => frame.type === 'end').length
    expect(ends).toBe(starts)
  })

  it('omits --model when the synthetic default is selected', async () => {
    const { agent, dir } = await bootCodeBuddy('chat')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const argv = (await readFile(join(dir, 'argv.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    // No --model flag at all, so the CLI resolves its own configured model.
    // `default` can still appear inside the fixture's path, so the flag is what
    // proves omission rather than the absence of the word.
    expect(argv[0]?.indexOf('--model')).toBe(-1)
  })

  it('passes --model with the chosen id for a real model', async () => {
    const { agent, dir, ctx } = await bootCodeBuddy('chat')
    agent.model.select({ provider: 'codebuddy', model: 'gemini-3.1-pro' })
    expect(agent.model.current()).toMatchObject({ provider: 'codebuddy', model: 'gemini-3.1-pro' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const argv = (await readFile(join(dir, 'argv.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(argv[0]).toContain('--model')
    expect(argv[0]).toContain('gemini-3.1-pro')
    expect(ctx).toBeDefined()
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
