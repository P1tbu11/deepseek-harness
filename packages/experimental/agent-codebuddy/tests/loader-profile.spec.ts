/**
 * Boots the shipped headless profile through the real Loader and applies the delivered
 * `profile.patch.yml`. A second overlay retargets the CLI path at the synthetic fixture
 * and disables the one-shot runner so startup does not spend a model call.
 * Session creation uses `agents.create` with the default-model getters the headless
 * runner and the web session controller both pass through.
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bootProductionProfile } from '../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const deliveredPatch = fileURLToPath(new URL('../profile.patch.yml', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url))
const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async (home) => {
    await rm(home, { recursive: true, force: true })
  }))
  delete process.env.CODEBUDDY_FIXTURE
  delete process.env.CODEBUDDY_ARGV_LOG
})

it('loads the delivered profile patch through the shipped headless Loader', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codebuddy-profile-'))
  homes.push(home)
  const dir = await mkdtemp(join(tmpdir(), 'codebuddy-work-'))
  homes.push(dir)
  const commandPatch = join(dir, 'command.patch.yml')
  const argvLog = join(dir, 'argv.log')
  await writeFile(commandPatch, [
    '- id: agent-codebuddy-settings',
    '  config:',
    '    enabled: true',
    `    command: ${JSON.stringify(process.execPath)}`,
    '    args:',
    `      - ${JSON.stringify(fixture)}`,
    '    probe: false',
    "    model: ''",
    `    stateDir: ${JSON.stringify(dir)}`,
    '- id: headless-runner',
    '  disabled: true',
    '',
  ].join('\n'))
  process.env.DSH_HOME = home
  process.env.DSH_TELEMETRY_DISABLED = '1'
  delete process.env.DEEPSEEK_API_KEY
  process.env.CODEBUDDY_FIXTURE = 'chat'
  process.env.CODEBUDDY_ARGV_LOG = argvLog
  const ctx = await bootProductionProfile({
    binName: 'codebuddy-loader',
    profile: 'headless',
    overlayPaths: [deliveredPatch, commandPatch],
    prepare: (host) => {
      host.provide('cmdlineArgs', { get: () => [] })
      host.provide('appExit', () => {})
      host.provide('appReady', { onReady: (listener) => { listener(); return () => {} } })
    },
  })
  homes.push(home)
  try {
    const entries = [...ctx.loader.entries()]
    const stock = entries.filter(entry => entry.options.id === 'agent-loop')
    const custom = entries.filter(entry => entry.options.id === 'agent-codebuddy')
    expect(stock.map(entry => entry.options.disabled)).toEqual([true])
    expect(custom).toHaveLength(1)
    expect(custom[0]?.options.disabled).not.toBe(true)
    expect(ctx.codebuddySettings.config).toMatchObject({
      enabled: true,
      command: process.execPath,
      probe: false,
      model: '',
      stateDir: dir,
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(expect.arrayContaining(['deepseek-official', 'codebuddy']))
    await expect(ctx.llm.listModels('codebuddy')).resolves.toEqual([
      {
        provider: 'codebuddy', id: 'cli-default', name: 'cli-default', inputModalities: ['text'],
        badge: { text: { en: 'New session', zh: '新会话' }, tone: 'warning' },
      },
    ])

    const selection = () => ctx.agentDefaultModel.currentSelection()
    expect(selection()).toMatchObject({ provider: 'deepseek-official' })
    const deepseek = await ctx.agents.create({
      sessionId: SessionId('deepseek-loader'),
      agentOptions: {
        get provider() { return selection().provider },
        get model() { return selection().model },
      },
      meta: { cwd: dir },
    })
    await prompt(deepseek.agent, 'hello deepseek')
    expect(reason(deepseek.agent)).toMatch(/no API key|system\.node/)
    await expect(readFile(argvLog, 'utf8')).rejects.toThrow()

    const codebuddyModel = (await ctx.llm.listModels('codebuddy'))[0]
    expect(codebuddyModel?.id).toBe('cli-default')
    const codebuddy = await ctx.agents.create({
      sessionId: SessionId('codebuddy-loader'),
      agentOptions: { provider: 'codebuddy', model: codebuddyModel!.id },
      meta: { cwd: dir },
    })
    expect(codebuddy.agent.id).not.toBe(deepseek.agent.id)
    const codebuddyAgent = codebuddy.agent
    await prompt(codebuddyAgent!, 'first')
    expect(texts(codebuddyAgent!)).toContain('你好')
    const argv = await readFile(argvLog, 'utf8')
    expect(argv).toContain('--input-format=stream-json')
    expect(argv).not.toContain('--system-prompt')
    expect(argv).not.toContain('--tools')
  } finally {
    await ctx.fiber.dispose()
  }
}, 180_000)

it('runs the web sessionController path in plain Node', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./web-session.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    encoding: 'utf8',
    timeout: 120_000,
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('web-session: ok')
}, 120_000)

async function prompt(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function texts(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap((event) => {
    if (event.type !== 'assistant/message') return []
    return event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
  })
}

function reason(agent: Agent): string {
  const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
  if (end?.type !== 'turn/end') return ''
  return end.data.reason.kind === 'error' ? end.data.reason.error.message : end.data.reason.kind
}
