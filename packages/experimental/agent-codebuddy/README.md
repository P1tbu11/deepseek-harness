---
description: "Experimental factory plugin that drives codebuddy-provider sessions with a local CodeBuddy CLI and leaves every other provider on the default agent loop."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-codebuddy

English | [中文](README.zh.md)

## Summary

Select this bundle on a profile that already stacks `dsh-base`. The bundle disables the stock `agent-loop` row and inserts one factory. Sessions whose provider is `codebuddy` are driven by an installed CodeBuddy CLI. Every other provider, including DeepSeek and the cordis creator preset, still uses `AgentLoop`.

The plugin does not depend on `@tencent-ai/agent-sdk`. That package ships a CLI binary. This plugin speaks the SDK's documented stream-json control subset and spawns only the executable you configure.

## Table of Contents

- [Use this package](#use-this-package)
- [Output fidelity](#output-fidelity)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Model Experience](#model-experience)

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

Default mode sends only the user's text. It does not pass `--system-prompt`, `--append-system-prompt`, `--tools`, or `--dangerously-skip-permissions`. `--setting-sources` is omitted so the CLI keeps its own login and settings. `--permission-mode` is `default`. `can_use_tool` calls `ctx.approval.request` and fails closed when approval is absent. There is no default allow.

Creator mode (`agentPreset: cordis`) adds an in-process bridge named `dsh` for the registered `plugin_manager` tool only. The tool body runs once, then the result is recorded. That is not native CLI behavior. Other DSH tools stay on DeepSeek sessions and are not copied into the CLI prompt.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The engine is chosen when the session is created or resumed. Changing the model picker afterward does not move a live session between drivers.
- User messages that contain non-text blocks are refused before the CLI starts.
- File bodies are not reconstructed from `file-history-snapshot`. A diff appears only when the tool result text or a normal workspace-changes turn snapshot already has it.
- `query()` is one CLI process per DSH turn. The next turn passes `--resume`. Interrupt acknowledgement is not treated as exit.
- Visual Web acceptance was not run in the cloud environment. Tool rows use the existing `tool/call` cards.

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
