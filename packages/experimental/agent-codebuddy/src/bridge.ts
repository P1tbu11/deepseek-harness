import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { BRIDGE_SERVER, BRIDGE_TOOL } from './constants.ts'

/** One JSON-RPC object inside a CLI `mcp_message` control request. */
export interface McpCall {
  readonly method: string
  readonly id?: string | number
  readonly params?: unknown
}

/** JSON-RPC result returned to the CLI, plus whether the DSH tool body ran. */
export interface BridgeResult {
  /** JSON-RPC result or error object sent back to the CLI. */
  readonly body: Record<string, unknown>
  /** True when the DSH tool body ran. */
  readonly executed: boolean
}

/**
 * Answer one creator-mode MCP request. `tools/call` runs the registered
 * `plugin_manager` tool once. Native CLI tools never reach this function.
 * @param ctx - host context that owns the tool registry.
 * @param agent - session agent, required by the tool's own approval path.
 * @param signal - cancellation for the tool body.
 * @param call - JSON-RPC request from the CLI.
 * @returns the JSON-RPC result and whether the tool body ran.
 */
export async function handleBridgeCall(
  ctx: Context,
  agent: Agent,
  signal: AbortSignal,
  call: McpCall,
): Promise<BridgeResult> {
  if (call.method === 'tools/list' || call.method === 'initialize') {
    const tool = ctx.tools.executable(BRIDGE_TOOL, agent)
    return {
      executed: false,
      body: call.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: BRIDGE_SERVER, version: '0' } }
        : {
          tools: tool === undefined ? [] : [{
            name: BRIDGE_TOOL,
            description: tool.description,
            inputSchema: { type: 'object' },
          }],
        },
    }
  }
  if (call.method !== 'tools/call') {
    return { executed: false, body: { error: { code: -32601, message: `unsupported mcp method "${call.method}"` } } }
  }
  const params = call.params !== null && typeof call.params === 'object' ? call.params as { name?: unknown; arguments?: unknown } : {}
  const name = typeof params.name === 'string' ? params.name : ''
  if (name !== BRIDGE_TOOL) {
    return { executed: false, body: { error: { code: -32602, message: `tool "${name}" is not bridged` } } }
  }
  const tool = ctx.tools.executable(BRIDGE_TOOL, agent)
  if (tool === undefined) {
    return { executed: false, body: { content: [{ type: 'text', text: 'plugin_manager is not registered in this session' }], isError: true } }
  }
  const exec = {
    name: BRIDGE_TOOL,
    arguments: params.arguments,
    signal,
    agent,
  } as ToolRunContext
  const value = await tool.execute(params.arguments, exec)
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return { executed: true, body: { content: [{ type: 'text', text }], isError: false } }
}
