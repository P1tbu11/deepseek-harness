---
description: "Experimental profile layer that drives codebuddy-provider sessions with a local CodeBuddy CLI and leaves every other provider on the default agent loop."
kind: "package-bundle"
---

# @deepseek-ai/dsh-agent-codebuddy

English | [中文](README.zh.md)

## Summary

Select this layer on a profile that already stacks `dsh-base`. It disables the stock `agent-loop` row and inserts one factory. Sessions whose provider is `codebuddy` are driven by an installed CodeBuddy CLI. Every other provider still uses `AgentLoop`. Creator mode stays on this driver and adds a `plugin_manager` bridge.

## Table of Contents

- [Use this package](#use-this-package)
- [Output fidelity](#output-fidelity)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Protocol basis](#protocol-basis)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add the package to the profile, then apply [`profile.patch.yml`](profile.patch.yml). Set `command` to the absolute path of the already installed `codebuddy` or `cbc` binary, and `stateDir` to a directory the host can write. Leave `enabled` false to keep the factory without spawning anything.

```yaml
- id: agent-codebuddy-settings
  config:
    enabled: true
    command: /absolute/path/to/codebuddy
    probe: false
    stateDir: /absolute/path/to/codebuddy-state
```

`probe: true` with an empty `command` stats a fixed list plus an absolute `CODEBUDDY_BIN`. It does not search `PATH`, download a binary, or change CLI login. A new session uses this driver only when its provider is `codebuddy` at create or resume. Later model-picker changes do not switch engines.

<a id="model-calls-without-a-session"></a>
## Model calls without a session

Two kinds of caller reach the `codebuddy` route. A DSH session is driven by the resident CLI process described above. Anything else arrives through `ctx.llm` with one assembled request and no session to continue — an auxiliary request from the agent loop, or a third-party plugin such as the media desk calling `prepareCall()` for its own prompts. Those take a one-shot `codebuddy -p` process instead, so the route answers every caller rather than only the ones that own a session.

That path streams. `--output-format stream-json` emits NDJSON, and `--include-partial-messages` adds token-level `stream_event` frames, which `src/chat.ts` maps to the same `StreamChunk` vocabulary every other adapter emits. A build that answers with only whole `assistant` messages still works: the translator rebuilds blocks from that message when no delta arrived for it.

A one-shot call carries no tools. `--tools ''` empties the built-in list where a build honors it, `--strict-mcp-config` keeps every MCP server out, and neither `--permission-mode` nor `-y` is passed, so the CLI's own gate refuses any tool the model attempts — the CLI documents headless tool use as requiring explicit pre-authorization. Every prompt is flattened to text turns for the same reason, and an image in the request becomes a placeholder rather than bytes, because no tool here could open a staged file. That projection is local to this path; the driver still sends images natively.

To roll back, remove the bundle or set the `agent-loop` row back to `disabled: false` and remove `agent-codebuddy`. Restart if the profile has no HMR.

Tests, from a built checkout:

```sh
pnpm exec vitest run packages/experimental/agent-codebuddy/tests
```

The fixture in `tests/fixtures/cli.mjs` is synthetic. It is not an enterprise CLI recording, and a passing run is not native model or terminal-TUI parity.

<a id="output-fidelity"></a>
## Output fidelity

| CLI stream | DSH session |
|---|---|
| assistant text and `thinking` text | one `assistant/message` per assistant message, in order |
| `text_delta` frames | live `agent/assistant-stream` only; not appended again when the full message arrives |
| `tool_use` / `tool_result` ids and raw arguments | `tool/call` and `tool/result` with the same id; DSH does not execute them |
| `usage.input_tokens` / `output_tokens` | `TokenUsage` when both numbers are present |
| thinking `signature`, redacted thinking, image bytes | not stored; a diagnostic code is logged |
| unknown `type` | turn ends `error` / `UNKNOWN_PROTOCOL`; the payload is not stored |
| second `result` | `DUPLICATE_RESULT`; its text is not appended |
| stderr | exit diagnostic, with bearer tokens, `sk-` keys, and `api_key` values redacted |
| terminal cell layout | not represented |

Default mode sends only the user's text. It does not pass `--system-prompt`, `--append-system-prompt`, `--tools`, or `--dangerously-skip-permissions`. `--setting-sources` is omitted so the CLI keeps its own login and settings. `--permission-mode` is always `bypassPermissions`: the driver answers a `can_use_tool` request with an allow and has no approval channel to consult, so a mode that asks would leave every gated tool denied and read to a user as a silently dropped turn. A `result` event ends that turn; the driver then stops the process. It does not wait for a resident CLI to exit by itself, and assistant text does not end the turn.

Because the CLI never asks, there is no approval card and no per-tool decision to store. A CLI build that sends `can_use_tool` anyway is answered with `allowed: true` carrying the request's own `updatedInput`, so an older or differently configured binary cannot stall a turn. The plugin neither forwards nor stores the CLI's `permission_suggestions` or `updatedPermissions`.

A stop ends the turn immediately, including while the model is streaming or a permission request is open. The driver races every CLI read against the turn signal instead of waiting for output, writes `turn/end` with the cancel cause the Agent passed, and starts the CLI's termination ladder without awaiting exit, so a CLI that ignores `SIGTERM` still cannot hold the turn open for the whole grace period. The provider keeps the process range and escalates to `SIGKILL`; only the turn boundary is prompt.

The CLI working directory is the session directory the host passed in. On the Web profile that is the selected workspace path, so the session can attach to that workspace. The server process directory is used only when the host omitted a directory.

Creator mode (`agentPreset: cordis`) adds an in-process bridge named `dsh` for the registered `plugin_manager` tool only. The fixture calls that tool once through the bridge, and the host records that one result. The host does not run the tool again from the logged `tool/call`. That bridge is not native CLI behavior. Other DSH tools stay on DeepSeek sessions and are not copied into the CLI prompt.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) disables `agent-loop` and inserts `agent-codebuddy-settings` plus `agent-codebuddy`. The settings service owns `command`, `args`, `probe`, `probeTimeoutMs`, `model`, `stateDir`, and `graceMs`. The factory subclasses `AgentLoop` and calls `setFactory` once. A `codebuddy` provider launches the configured executable with stream-json input and output. The process group is terminated on cancel.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Experimental packages](../README.md) and the [agent loop](../../core/agent-loop/README.md).

-----

<a id="protocol-basis"></a>
## Protocol basis

The fixture is a synthetic peer. It checks the subset this plugin sends and accepts. A passing fixture does not show that a particular CodeBuddy CLI build emitted those frames.

Public CodeBuddy documents used for that subset:

- [Workflow stdio protocol](https://www.codebuddy.ai/docs/cli/workflow-stdio-protocol) says `cbc` / `codebuddy` stream-json aligns with Claude Code 2.1.220. That sentence is not a subtype list. The page specifies NDJSON, `control_request` `initialize` (`hooks`, `capabilities`, `hasPrompt`), a `user` message, and `interrupt`. Stdout includes `system`, `assistant`, `user`, `result`, and `control_response`.
- [Headless mode](https://www.codebuddy.ai/docs/cli/headless) shows `--input-format=stream-json`, `--output-format=stream-json`, and `--verbose` for a piped user message. Its long-lived control examples add `rewind` and `rewind_files`, which this plugin does not send.
- [MCP first-run status](https://www.codebuddy.ai/docs/cli/mcp-first-run-status) shows the same flags without `-p`, and a user message whose `content` is a text block array. This plugin sends the string `content` from the workflow example, not that block array.
- Published package [@tencent-ai/agent-sdk@0.3.244](https://cdn.jsdelivr.net/npm/@tencent-ai/agent-sdk@0.3.244/package.json) (`lib/version.js` reports `SDK_VERSION` `0.3.28`) types `ControlInitializeRequest`, `ControlPermissionRequest`, and `ControlMcpMessageRequest` in `lib/types.d.ts`. `lib/_internal/query-controller.js` sends `initialize` with `capabilities.askUserQuestion: true` and `sdkMcpServers` only when an in-process server exists. Its permission reply is `{ allowed: true, updatedInput, tool_use_id }` or `{ allowed: false, reason, tool_use_id }`. `lib/transport/process-transport.js` answers `mcp_message` with `{ mcp_response }`. This plugin follows those fields. It does not send `systemPrompt`. The package resolves a CLI version from the executable at runtime and does not publish a minimum CLI semver here. No CodeBuddy CLI binary was executed.

`interrupt` here omits the `session_id` the workflow example includes.

-----

<a id="model-experience"></a>
## Model Experience

### Child request

#### What the model sees

The CodeBuddy CLI sees the user's text and its own default prompt and tools. Creator mode also sees the bridged `plugin_manager` tool. No DSH system prompt or DSH tool schema is added in the default mode.

#### Token effect

Tokens are whatever the CLI reports as `input_tokens` and `output_tokens`. Nothing is estimated.

#### KV Cache effect

Cache reuse is the CLI's. This plugin does not rewrite the CLI prompt prefix.

### Parent scheduling and results, indirectly

#### What the model sees

A DeepSeek session does not receive the CodeBuddy transcript. A CodeBuddy session does not make a DeepSeek model call.

#### Token effect

None on the DeepSeek route.

#### KV Cache effect

The DeepSeek route is unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The engine is chosen when the session is created or resumed. The model list shows a “New session” badge. Choosing CodeBuddy in the picker of a session that already uses the DeepSeek loop does not move that session onto the CLI. A session created while the default provider is `codebuddy` uses the CLI.
- User messages that contain non-text blocks are refused before the CLI starts.
- File bodies are not reconstructed from `file-history-snapshot`. A diff appears only when the tool result text or a normal workspace-changes turn snapshot already has it.
- `query()` is one CLI process per DSH turn. The next turn passes `--resume`. Interrupt acknowledgement is not treated as exit.
- Visual Web acceptance was not run. Tool rows use the existing `tool/call` cards.
- A passing fixture checks the stream-json projection and one `plugin_manager` discovery plus call against `@tencent-ai/agent-sdk@0.3.244`. It does not run a CodeBuddy CLI binary, `install_bundle`, the plugin-manager UI, or hot reload. Permissions bypass the CLI's own gate; the fixture drives a `can_use_tool` request anyway to prove the driver answers it with an allow rather than consulting an approval channel.
- The projection is not a lossless copy. Non-text user input is refused. Thinking signatures, redacted thinking, and image bytes are not stored. `file-history-snapshot` is not rebuilt into files.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The plugin does not depend on `@tencent-ai/agent-sdk`, because that package ships a CLI binary. It speaks the documented stream-json control subset and spawns only the configured executable.

</details>
