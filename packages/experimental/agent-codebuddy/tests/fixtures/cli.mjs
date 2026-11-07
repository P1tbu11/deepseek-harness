#!/usr/bin/env node
/**
 * Synthetic CodeBuddy stream-json peer. Not a recording of the enterprise CLI.
 * Scenario is CODEBUDDY_FIXTURE. Child pid for the hang scenario is written to
 * CODEBUDDY_CHILD_PID_FILE.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { appendFileSync, writeFileSync } from 'node:fs'

const scenario = process.env.CODEBUDDY_FIXTURE ?? 'chat'
if (process.env.CODEBUDDY_ARGV_LOG) appendFileSync(process.env.CODEBUDDY_ARGV_LOG, `${JSON.stringify(process.argv)}\n`)
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
const pending = []
let resume = ''
for (let index = 0; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--resume') resume = process.argv[index + 1] ?? ''
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function sessionId() {
  return resume || 'cli-sess-1'
}

async function nextLine() {
  if (pending.length > 0) return pending.shift()
  const next = await lines[Symbol.asyncIterator]().next()
  if (next.done) return undefined
  return JSON.parse(next.value)
}

const init = await nextLine()
const initRequest = init?.request ?? {}
if (scenario === 'creator' && !initRequest.sdkMcpServers?.includes('dsh')) {
  process.stderr.write('creator bridge was not offered\n')
  process.exit(2)
}
if (initRequest.systemPrompt !== undefined || initRequest.appendSystemPrompt !== undefined) {
  process.stderr.write('system prompt was forwarded\n')
  process.exit(2)
}
send({
  type: 'control_response',
  response: { subtype: 'success', request_id: init?.request_id ?? 'init', response: {} },
})
const user = await nextLine()
const prompt = user?.message?.content
if (typeof prompt !== 'string') {
  process.stderr.write('prompt was not a single text string\n')
  process.exit(2)
}

send({ type: 'system', subtype: 'init', session_id: sessionId(), tools: ['Bash'], model: 'cli-native', permissionMode: 'default' })

if (scenario === 'chat') {
  send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } } })
  send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } } })
  send({
    type: 'assistant',
    session_id: sessionId(),
    message: {
      content: [
        { type: 'text', text: '你好' },
        { type: 'thinking', thinking: 'look', signature: 'do-not-persist' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    },
  })
  send({
    type: 'user',
    session_id: sessionId(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi\n' }] },
  })
  send({
    type: 'assistant',
    session_id: sessionId(),
    message: { content: [{ type: 'text', text: 'done ```js\nconst x = 1\n```' }] },
  })
  send({ type: 'result', subtype: 'success', session_id: sessionId(), result: 'done ```js\nconst x = 1\n```', is_error: false })
  process.exit(0)
} else if (scenario === 'permission') {
  send({
    type: 'control_request',
    request_id: 'perm-1',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: prompt }, tool_use_id: 'toolu_perm' },
  })
  const reply = await nextLine()
  const decision = reply?.response?.response
  const allowed = decision?.behavior === 'allow'
  send({
    type: 'assistant',
    session_id: sessionId(),
    message: { content: [{ type: 'tool_use', id: 'toolu_perm', name: 'Bash', input: { command: prompt } }] },
  })
  send({
    type: 'user',
    session_id: sessionId(),
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_perm',
        is_error: !allowed,
        content: allowed ? 'allowed' : 'denied',
      }],
    },
  })
  send({ type: 'result', subtype: 'success', session_id: sessionId(), result: allowed ? 'allowed' : 'denied', is_error: false })
  process.exit(0)
} else if (scenario === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  if (process.env.CODEBUDDY_CHILD_PID_FILE) writeFileSync(process.env.CODEBUDDY_CHILD_PID_FILE, String(child.pid))
  send({
    type: 'control_request',
    request_id: 'perm-hang',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'sleep' }, tool_use_id: 'toolu_hang' },
  })
  const reply = await nextLine()
  if (reply?.request?.subtype === 'interrupt') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: reply.request_id, response: { ack: true } } })
  }
  await new Promise(() => {})
} else if (scenario === 'creator') {
  send({
    type: 'control_request',
    request_id: 'mcp-list',
    request: { subtype: 'mcp_message', server_name: 'dsh', message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } },
  })
  const listed = await nextLine()
  const tools = listed?.response?.response?.mcp_response?.result?.tools ?? []
  if (!tools.some(tool => tool.name === 'plugin_manager')) {
    process.stderr.write('plugin_manager was not discovered\n')
    process.exit(4)
  }
  send({
    type: 'control_request',
    request_id: 'mcp-call',
    request: {
      subtype: 'mcp_message',
      server_name: 'dsh',
      message: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'plugin_manager', arguments: { action: 'list_plugins' } } },
    },
  })
  const called = await nextLine()
  const text = called?.response?.response?.mcp_response?.result?.content?.[0]?.text ?? ''
  send({
    type: 'assistant',
    session_id: sessionId(),
    message: { content: [{ type: 'text', text }] },
  })
  send({ type: 'result', subtype: 'success', session_id: sessionId(), result: text, is_error: false })
  process.exit(0)
} else if (scenario === 'unknown') {
  send({ type: 'mystery', token: 'secret-token' })
  send({ type: 'result', subtype: 'success', session_id: sessionId(), result: 'should-not-win', is_error: false })
  process.exit(0)
} else if (scenario === 'fail') {
  process.stderr.write('boom api_key=abc123\n')
  process.exit(3)
} else {
  process.stderr.write(`unknown scenario ${scenario}\n`)
  process.exit(2)
}
