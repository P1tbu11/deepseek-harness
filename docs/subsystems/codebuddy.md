# CodeBuddy CLI

English | [中文](codebuddy.zh.md)

The experimental [`dsh-agent-codebuddy`](../../packages/experimental/agent-codebuddy/README.md) bundle drives sessions whose provider is `codebuddy` with a local CodeBuddy CLI. `ctx.codebuddySettings` holds the executable path, probe switch, optional model, and session-map directory. The replacement factory reads those settings. Every other provider stays on `AgentLoop`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcodebuddysettings--codebuddysettingsservice"></a>

### `ctx.codebuddySettings` — `CodeBuddySettingsService`

Config service read by the CodeBuddy factory. Kept separate so the factory can keep the default agent-loop config schema.

Source: [`packages/experimental/agent-codebuddy/src/settings.ts`](../../packages/experimental/agent-codebuddy/src/settings.ts)
<!-- END GENERATED cordis-surface -->
