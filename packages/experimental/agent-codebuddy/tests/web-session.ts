/**
 * Web profile session API, run under plain Node so Loader and config-editor
 * share one app-boot module. Vitest path mapping would split that module and
 * make profile saves miss the root Include entry.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bootProductionProfile } from '../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const deliveredPatch = fileURLToPath(new URL('../profile.patch.yml', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url))

const home = await mkdtemp(join(tmpdir(), 'codebuddy-web-'))
const dir = await mkdtemp(join(tmpdir(), 'codebuddy-web-work-'))
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
  '',
].join('\n'))
process.env.DSH_HOME = home
process.env.DSH_TELEMETRY_DISABLED = '1'
delete process.env.DEEPSEEK_API_KEY
process.env.CODEBUDDY_FIXTURE = 'chat'
process.env.CODEBUDDY_ARGV_LOG = argvLog

const ctx = await bootProductionProfile({
  binName: 'codebuddy-web',
  profile: 'web',
  overlayPaths: [deliveredPatch, commandPatch],
  prepare: (host) => {
    host.provide('cmdlineArgs', { get: () => ['--host', '127.0.0.1', '--port', '39211', '--no-open'] })
    host.provide('appExit', () => {})
    host.provide('appReady', { onReady: (listener) => { listener(); return () => {} } })
  },
})

try {
  const created = await ctx.sessionController.create({ cwd: dir })
  const agent = ctx.agents.get(created.sessionId)
  assert.ok(agent)
  await prompt(agent, 'hello deepseek')
  assert.match(reason(agent), /no API key/)
  await assert.rejects(readFile(argvLog, 'utf8'))

  const selected = await ctx.sessionController.selectModel({
    sessionId: created.sessionId,
    provider: 'codebuddy',
    model: 'cli-default',
  })
  assert.equal(selected.selected.provider, 'codebuddy')
  assert.equal(selected.selected.model, 'cli-default')
  await ctx.agentDefaultModel.saveSelection({ provider: selected.selected.provider, model: selected.selected.model })
  assert.equal(ctx.agentDefaultModel.currentSelection().provider, 'codebuddy')
  await prompt(agent, 'still this session')
  assert.match(reason(agent), /previous request model is preserved/)
  await assert.rejects(readFile(argvLog, 'utf8'))

  const again = await ctx.sessionController.create({ cwd: dir })
  assert.notEqual(again.sessionId, created.sessionId)
  const next = ctx.agents.get(again.sessionId)
  assert.ok(next)
  await prompt(next, 'new session')
  assert.ok(texts(next).includes('你好'))
  const argv = await readFile(argvLog, 'utf8')
  assert.match(argv, /--input-format=stream-json/)
  assert.doesNotMatch(argv, /--system-prompt/)
  process.stdout.write('web-session: ok\n')
} finally {
  await ctx.fiber.dispose()
  await rm(home, { recursive: true, force: true })
  await rm(dir, { recursive: true, force: true })
}

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
