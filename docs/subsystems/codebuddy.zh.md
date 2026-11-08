# CodeBuddy CLI

[English](codebuddy.md) | 中文

实验性 [`dsh-agent-codebuddy`](../../packages/experimental/agent-codebuddy/README.zh.md) bundle 用本机 CodeBuddy CLI 驱动 provider 为 `codebuddy` 的会话。`ctx.codebuddySettings` 保存可执行文件路径、探测开关、可选模型和会话映射目录。替换后的 factory 读取这些设置。其余 provider 仍走 `AgentLoop`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcodebuddysettings--codebuddysettingsservice"></a>

### `ctx.codebuddySettings` — `CodeBuddySettingsService`

Config service read by the CodeBuddy factory. Kept separate so the factory can keep the default agent-loop config schema.

Source: [`packages/experimental/agent-codebuddy/src/settings.ts`](../../packages/experimental/agent-codebuddy/src/settings.ts)
<!-- END GENERATED cordis-surface -->
