---
description: "实验性工厂插件：provider 为 codebuddy 的会话由本机 CodeBuddy CLI 驱动，其他 provider 仍走默认 agent loop。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-codebuddy

[English](README.md) | 中文

## Summary

在已经叠了 `dsh-base` 的 profile 上选用这个 bundle。它会禁用原来的 `agent-loop` 行并插入唯一的 factory。provider 为 `codebuddy` 的会话由已安装的 CodeBuddy CLI 驱动。包括 DeepSeek 和 cordis 创造模式在内的其他 provider 仍使用 `AgentLoop`。

插件不依赖 `@tencent-ai/agent-sdk`，因为那个包会带上 CLI 二进制。这里实现的是 SDK 文档中的 stream-json 控制子集，并且只启动你配置的可执行文件。

## Table of Contents

- [Use this package](#use-this-package)
- [Output fidelity](#output-fidelity)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Model Experience](#model-experience)

-----

<a id="use-this-package"></a>
## Use this package

把包加进 profile，再套用 [`profile.patch.yml`](profile.patch.yml)。`command` 填已经安装的 `codebuddy` 或 `cbc` 绝对路径，`stateDir` 填宿主可写目录。`enabled` 为 false 时 factory 在，但不会启动 CLI。

```yaml
- id: agent-codebuddy-settings
  config:
    enabled: true
    command: /absolute/path/to/codebuddy
    probe: false
    stateDir: /absolute/path/to/codebuddy-state
```

`probe: true` 且 `command` 为空时，只对固定路径和绝对的 `CODEBUDDY_BIN` 做带超时的 stat。不搜索 `PATH`，不下载二进制，也不改 CLI 登录。只有创建或恢复时 provider 已是 `codebuddy` 的会话走这个驱动。之后在模型选择器里改选不会切换引擎。

回退：移除 bundle，或把 `agent-loop` 的 `disabled` 改回 false 并删除 `agent-codebuddy`。profile 没有 HMR 时需要重启。

在已构建的检出中运行：

```sh
pnpm exec vitest run packages/experimental/agent-codebuddy/tests
```

`tests/fixtures/cli.mjs` 是合成夹具，不是企业 CLI 录制。测试通过不等于原生模型行为或终端 TUI 已逐字还原。

<a id="output-fidelity"></a>
## Output fidelity

| CLI 流 | DSH 会话 |
|---|---|
| assistant 文本和 `thinking` 文本 | 每条 assistant 消息对应一条 `assistant/message`，顺序保留 |
| `text_delta` | 只进入实时 `agent/assistant-stream`；完整消息到达后不重复写入 |
| `tool_use` / `tool_result` 的 id 和原始参数 | `tool/call` 与 `tool/result`，DSH 不再执行 |
| `usage.input_tokens` / `output_tokens` | 两个数字都存在时写入 `TokenUsage` |
| thinking 签名、被遮蔽的 thinking、图片字节 | 不存储，只打诊断码 |
| 未知 `type` | 回合以 `error` / `UNKNOWN_PROTOCOL` 结束，不存载荷 |
| 第二条 `result` | `DUPLICATE_RESULT`，不追加其文本 |
| stderr | 写入退出诊断，并遮盖 bearer、`sk-` 和 `api_key` |
| 终端字符格排版 | 不表示 |

默认模式只发送用户文本。不传 `--system-prompt`、`--append-system-prompt`、`--tools` 或 `--dangerously-skip-permissions`。不传 `--setting-sources`，以便 CLI 继续用自己的登录和设置。`--permission-mode` 为 `default`。`can_use_tool` 调用 `ctx.approval.request`，没有审批服务时拒绝。没有默认放行。

创造模式（`agentPreset: cordis`）额外挂一个名为 `dsh` 的进程内桥，只暴露已注册的 `plugin_manager`。工具体执行一次，再记入会话。这不是 CLI 的原生行为。其他 DSH 工具仍留在 DeepSeek 会话中，不会抄进 CLI 提示词。

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- 引擎在会话创建或恢复时决定。之后改模型选择器不会把活会话换到另一个驱动。
- 含非文本块的用户消息会在 CLI 启动前被拒绝。
- `file-history-snapshot` 不会被还原成文件内容。只有工具结果文本或正常的 workspace-changes 回合快照里已经有差异时才会显示。
- 每个 DSH 回合启动一个 CLI 进程，下一回合使用 `--resume`。interrupt 的确认不算进程已退出。
- 云端环境没有做 Web 视觉验收。工具行使用现有的 `tool/call` 卡片。

<a id="model-experience"></a>
## Model Experience

### Child request

#### What the model sees

CodeBuddy CLI 看到用户文本以及它自己的默认提示词和工具。创造模式还会看到桥接的 `plugin_manager`。默认模式不会加入 DSH 系统提示词或 DSH 工具 schema。

#### Token effect

用量就是 CLI 报告的 `input_tokens` 和 `output_tokens`。插件不做估算。

#### KV Cache effect

缓存复用由 CLI 自己决定。插件不改写 CLI 的提示词前缀。

### Parent scheduling and results, indirectly

#### What the model sees

DeepSeek 会话不会收到 CodeBuddy 记录。CodeBuddy 会话不会发起 DeepSeek 模型调用。

#### Token effect

DeepSeek 路线上没有额外用量。

#### KV Cache effect

DeepSeek 路线保持原样。
