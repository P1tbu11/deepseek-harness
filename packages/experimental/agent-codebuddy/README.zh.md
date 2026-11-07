---
description: "实验性 profile 层：provider 为 codebuddy 的会话由本机 CodeBuddy CLI 驱动，其他 provider 仍走默认 agent loop。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-agent-codebuddy

[English](README.md) | 中文

## 概述

在已经叠了 `dsh-base` 的 profile 上选用这一层。它会禁用原来的 `agent-loop` 行并插入唯一的 factory。provider 为 `codebuddy` 的会话由已安装的 CodeBuddy CLI 驱动。其余 provider 仍使用 `AgentLoop`。创造模式仍由本驱动负责，并增加 `plugin_manager` 桥。

## 目录

- [使用此包](#use-this-package)
- [输出保真](#output-fidelity)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [协议依据](#protocol-basis)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

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

在已构建的检出中测试：

```sh
pnpm exec vitest run packages/experimental/agent-codebuddy/tests
```

`tests/fixtures/cli.mjs` 里的 fixture 是合成的。它不是企业 CLI 录制，通过也不等于原生模型或终端 TUI 一致。

<a id="output-fidelity"></a>
## 输出保真

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

CLI 的工作目录是宿主传入的会话目录。在 Web 配置里这就是所选工作区路径，会话因此能挂到该工作区。只有宿主没有传入目录时，才使用服务器进程的当前目录。

创造模式（`agentPreset: cordis`）额外挂一个名为 `dsh` 的进程内桥，只暴露已注册的 `plugin_manager`。fixture 经该桥调用这个工具一次，宿主记下这一次结果。宿主不会因为日志里的 `tool/call` 再执行一次。这条桥不是 CLI 的原生行为。其他 DSH 工具仍留在 DeepSeek 会话中，不会抄进 CLI 提示词。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 禁用 `agent-loop`，并插入 `agent-codebuddy-settings` 与 `agent-codebuddy`。设置服务拥有 `command`、`args`、`probe`、`probeTimeoutMs`、`model`、`stateDir` 和 `graceMs`。factory 继承 `AgentLoop`，并只调用一次 `setFactory`。`codebuddy` provider 以 stream-json 输入和输出启动配置的可执行文件。取消时终止进程组。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[实验性包](../README.zh.md) 与 [agent loop](../../core/agent-loop/README.zh.md)。

-----

<a id="protocol-basis"></a>
## 协议依据

fixture 是合成对端，只检查本插件实际发送和接受的子集。测试通过不表示某个 CodeBuddy CLI 构建发出过这些帧。

该子集引用的公开 CodeBuddy 文档：

- [Workflow stdio 协议](https://www.codebuddy.ai/docs/cli/workflow-stdio-protocol) 写明 `cbc` / `codebuddy` 的 stream-json 与 Claude Code 2.1.220 对齐。这句话不是 subtype 清单。该页规定 NDJSON、`control_request` 的 `initialize`（`hooks`、`capabilities`、`hasPrompt`）、`user` 消息和 `interrupt`。stdout 包括 `system`、`assistant`、`user`、`result` 和 `control_response`。
- [Headless 模式](https://www.codebuddy.ai/docs/cli/headless) 给出 `--input-format=stream-json`、`--output-format=stream-json` 和 `--verbose`，用于管道输入的用户消息。其中的长连接示例还有 `rewind` 与 `rewind_files`，本插件不发送。
- [MCP 首次运行状态](https://www.codebuddy.ai/docs/cli/mcp-first-run-status) 使用同样的 flag 且不带 `-p`，用户消息的 `content` 是文本块数组。本插件发送的是工作流示例里的字符串 `content`，不是那个块数组。
- 已发布的 [@tencent-ai/agent-sdk@0.3.244](https://cdn.jsdelivr.net/npm/@tencent-ai/agent-sdk@0.3.244/package.json)（`lib/version.js` 中的 `SDK_VERSION` 为 `0.3.28`）在 `lib/types.d.ts` 声明了 `ControlInitializeRequest`、`ControlPermissionRequest` 和 `ControlMcpMessageRequest`。`lib/_internal/query-controller.js` 发送的 `initialize` 带 `capabilities.askUserQuestion: true`，并且只在存在进程内服务时带 `sdkMcpServers`。权限回复是 `{ allowed: true, updatedInput, tool_use_id }` 或 `{ allowed: false, reason, tool_use_id }`。`lib/transport/process-transport.js` 用 `{ mcp_response }` 回答 `mcp_message`。本插件跟随这些字段，不发送 `systemPrompt`。该包在运行时从可执行文件解析 CLI 版本，这里没有公布最低 CLI semver。没有执行过 CodeBuddy CLI 二进制。

这里的 `interrupt` 省略了工作流示例中的 `session_id`。

-----

<a id="model-experience"></a>
## 模型体验

### 子请求

#### 模型看到什么

CodeBuddy CLI 看到用户文本以及它自己的默认提示词和工具。创造模式还会看到桥接的 `plugin_manager`。默认模式不会加入 DSH 系统提示词或 DSH 工具 schema。

#### Token 效果

Token 就是 CLI 报告的 `input_tokens` 和 `output_tokens`。这里不做估算。

#### KV Cache 效果

缓存复用由 CLI 自己决定。这个插件不改写 CLI 的提示词前缀。

### 父级调度与结果，间接

#### 模型看到什么

DeepSeek 会话不会收到 CodeBuddy 的记录。CodeBuddy 会话不会发起 DeepSeek 模型调用。

#### Token 效果

DeepSeek 路线上没有额外 Token。

#### KV Cache 效果

DeepSeek 路线保持不变。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 引擎在会话创建或恢复时决定。模型列表带有“新会话”标记。已经走 DeepSeek loop 的会话里选择 CodeBuddy，不会把这个会话换到 CLI。只有默认 provider 已是 `codebuddy` 时创建的会话才走 CLI。
- 含非文本块的用户消息会在 CLI 启动前被拒绝。
- `file-history-snapshot` 不会被还原成文件内容。只有工具结果文本或正常的 workspace-changes 回合快照里已经有差异时才会显示。
- 每个 DSH 回合启动一个 CLI 进程，下一回合使用 `--resume`。interrupt 的确认不算进程已退出。
- 没有做 Web 视觉验收。工具行使用现有的 `tool/call` 卡片。
- 通过的 fixture 按 `@tencent-ai/agent-sdk@0.3.244` 检查 stream-json 投影，以及一次 `plugin_manager` 发现和调用。它没有运行 CodeBuddy CLI 二进制、`install_bundle`、插件管理界面或热加载。审批仍然失败即拒绝，没有默认放行，也没有权限绕过。
- 投影不是无损复制。非文本用户输入会被拒绝。thinking 签名、被遮蔽的 thinking 和图片字节不会存储。`file-history-snapshot` 不会被重建成文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

插件不依赖 `@tencent-ai/agent-sdk`，因为那个包会带上 CLI 二进制。这里实现的是文档中的 stream-json 控制子集，并且只启动配置的可执行文件。

</details>
