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
const help = process.argv.includes('--help')
// The capability probe opens a session only to read its tool list; it is not a
// turn. `CODEBUDDY_PROBE_TOKEN` is set by that probe so the argv log keeps
// holding launches only.
const probe = process.env.CODEBUDDY_PROBE_TOKEN === '1'
// A `ctx.llm` caller takes the one-shot path: `-p`, no stream-json input, and a
// prompt on stdin instead of an `initialize` control frame.
const oneShot = process.argv.includes('-p') || process.argv.includes('--print')
if (!help && !probe && process.env.CODEBUDDY_ARGV_LOG) {
  appendFileSync(process.env.CODEBUDDY_ARGV_LOG, `${JSON.stringify(process.argv)}\n`)
}
// The one-shot path reads raw stdin, so the line reader below is created only
// for a driven session; two readers on one stream would split the input.
const lines = oneShot ? undefined : createInterface({ input: process.stdin, crlfDelay: Infinity })
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

// `<cli> --help` is the only place the CLI lists the models it accepts. Answer
// it the way the real binary does so discovery runs without a live CLI.
if (help) {
  process.stdout.write([
    'Usage: codebuddy|cbc [options] [command] [prompt]',
    '',
    'Options:',
    '  --model <model>                                  Model for the current session. Please provide the model ID. Currently supported: (claude-sonnet-5, gemini-3.1-pro, deepseek-v4.1-flash, echo)',
    '',
  ].join('\n'))
  process.exit(0)
}

// The one-shot path: the whole request arrives as plain text on stdin, and the
// answer is a stream-json transcript that ends with one `result` frame. It does
// not read `initialize`, because a `-p` call has no control channel.
if (oneShot) {
  let prompt = ''
  for await (const chunk of process.stdin) prompt += chunk.toString()
  const scenario = process.env.CODEBUDDY_ONESHOT ?? 'stream'
  const args = process.argv
  const flag = (name) => {
    const at = args.indexOf(name)
    return at < 0 ? undefined : args[at + 1]
  }
  if (scenario === 'stream') {
    send({
      type: 'system', subtype: 'init', session_id: 'oneshot-1',
      tools: flag('--strict-mcp-config') === undefined ? ['Bash', 'Read'] : [],
      model: flag('--model') ?? 'cli-native', permissionMode: 'default',
    })
    send({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } } })
    send({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } })
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } } })
    send({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    send({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } })
    for (const piece of ['answer', ' from ', 'prompt']) {
      send({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: piece } } })
    }
    send({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
    send({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 11, output_tokens: 3 } } })
    send({ type: 'assistant', session_id: 'oneshot-1', message: { content: [{ type: 'text', text: 'answer from prompt' }], usage: { input_tokens: 11, output_tokens: 3 } } })
    send({ type: 'system', subtype: 'usage_update', _meta: { 'codebuddy.ai/turnUsage': { total: { usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 2 } } } } })
    send({
      type: 'result', subtype: 'success', is_error: false, result: 'answer from prompt',
      uuid: 'oneshot-1', session_id: 'oneshot-1',
      usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 2 },
    })
    // A `-p` call keeps reading stdin until it closes; echoing the prompt proves
    // the fixture saw the assembled text rather than an `initialize` frame.
    if (prompt.includes('__fail__')) process.exit(9)
    process.exit(0)
  }
  if (scenario === 'whole') {
    // A build that does not stream deltas: one assistant message, then result.
    send({
      type: 'assistant', session_id: 'oneshot-1',
      message: { content: [{ type: 'text', text: 'whole answer' }], usage: { input_tokens: 5, output_tokens: 2 } },
    })
    send({ type: 'result', subtype: 'success', is_error: false, result: 'whole answer', usage: { input_tokens: 5, output_tokens: 2 } })
    process.exit(0)
  }
  if (scenario === 'error') {
    send({ type: 'result', subtype: 'error', is_error: true, result: 'boom api_key=abc123' })
    process.exit(0)
  }
  if (scenario === 'empty') {
    send({ type: 'result', subtype: 'success', is_error: false, result: '' })
    process.exit(0)
  }
  if (scenario === 'silent') {
    process.stderr.write('crashed before result\n')
    process.exit(4)
  }
  if (scenario === 'tool') {
    send({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } } })
    send({ type: 'result', subtype: 'success', is_error: false, result: 'x' })
    process.exit(0)
  }
  process.stderr.write(`unknown one-shot scenario ${scenario}\n`)
  process.exit(2)
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

// The tool inventory a real build publishes here is what the capability probe
// reads, so it lists the tools these scenarios actually use. A build without
// ViewImage is exercised by the driver's own unit tests instead.
send({ type: 'system', subtype: 'init', session_id: sessionId(), tools: ['Bash', 'Read', 'ViewImage'], model: 'cli-native', permissionMode: 'default' })

// A probe stops after reading this line; answering the prompt would start a turn.
if (probe) {
  await new Promise(() => {})
}

if (scenario === 'chat') {
  send({ type: 'stream_event', event: { index: 0, type: 'content_block_start', content_block: { type: 'text', text: '' } } })
  send({ type: 'stream_event', event: { index: 0, type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } } })
  send({ type: 'stream_event', event: { index: 0, type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } } })
  send({ type: 'stream_event', event: { index: 0, type: 'content_block_stop' } })
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
  const allowed = decision?.allowed === true && decision?.behavior === undefined && decision?.tool_use_id === 'toolu_perm'
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
} else if (scenario === 'persist' || scenario === 'persist-error' || scenario === 'persist-approval') {
  if (process.env.CODEBUDDY_CHILD_PID_FILE) writeFileSync(process.env.CODEBUDDY_CHILD_PID_FILE, String(process.pid))
  if (scenario === 'persist-approval') {
    send({
      type: 'control_request',
      request_id: 'perm-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: prompt }, tool_use_id: 'toolu_perm' },
    })
    const reply = await nextLine()
    const decision = reply?.response?.response
    const allowed = decision?.allowed === true && decision?.behavior === undefined && decision?.tool_use_id === 'toolu_perm'
    send({
      type: 'assistant',
      session_id: sessionId(),
      message: { content: [{ type: 'text', text: allowed ? 'allowed' : 'denied' }] },
    })
  } else {
    send({
      type: 'assistant',
      session_id: sessionId(),
      message: { content: [{ type: 'text', text: 'persisted' }] },
    })
  }
  const failed = scenario === 'persist-error'
  send({
    type: 'result',
    subtype: failed ? 'error' : 'success',
    session_id: sessionId(),
    result: failed ? 'persisted-error' : 'persisted',
    is_error: failed,
  })
  await new Promise(() => {})
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
} else if (scenario === 'thinking') {
  // Model is mid-stream with no further output: silence, then no result. The
  // peer also ignores `interrupt`, so only process termination ends it.
  if (process.env.CODEBUDDY_CHILD_PID_FILE) writeFileSync(process.env.CODEBUDDY_CHILD_PID_FILE, String(process.pid))
  send({
    type: 'assistant',
    session_id: sessionId(),
    message: { content: [{ type: 'thinking', thinking: 'pondering a long answer' }] },
  })
  send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '思考' } } })
  for (;;) {
    const line = await nextLine()
    if (line === undefined) break
    if (line?.request?.subtype === 'interrupt') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: line.request_id, response: { ack: true } } })
    }
  }
  await new Promise(() => {})
} else if (scenario === 'stubborn') {
  // Streaming, no result, and ignores SIGTERM so teardown must escalate after
  // graceMs. A user stop must still end the turn without waiting for that.
  if (process.env.CODEBUDDY_CHILD_PID_FILE) writeFileSync(process.env.CODEBUDDY_CHILD_PID_FILE, String(process.pid))
  process.on('SIGTERM', () => {})
  send({
    type: 'assistant',
    session_id: sessionId(),
    message: { content: [{ type: 'thinking', thinking: 'stubborn stream' }] },
  })
  send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '思考' } } })
  for (;;) {
    const line = await nextLine()
    if (line === undefined) break
    if (line?.request?.subtype === 'interrupt') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: line.request_id, response: { ack: true } } })
    }
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
