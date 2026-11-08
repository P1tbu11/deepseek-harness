# Standalone CodeBuddy bundle

This directory holds a self-contained, installable copy of the
[CodeBuddy driver](../README.md) for the case where the bundle must be installed
from a Git repository or an archive instead of the monorepo workspace.

The parent package is workspace-only: its dependencies use the `workspace:`
protocol, which a profile outside this repository cannot resolve, and its build
output lives in a gitignored `lib/`. This directory fixes both:

- `package.json` names published versions instead of `workspace:` ranges.
- `dist/` holds the built artifacts and is tracked by Git.

## What it does

The plugin replaces the stock agent factory for one provider. Sessions on
`codebuddy` are driven by a locally installed CodeBuddy CLI; every other
provider keeps the default loop.

- **Real streaming.** The CLI's partial-message frames reach the client as
  tokens arrive, per content block, instead of appearing as one finished block.
- **Seamless provider switching.** A live Session can switch between a
  CodeBuddy model and a native DeepSeek model and back. Both paths read and write
  the same Session log, so the conversation continues uninterrupted; the switched
  turn is taken natively through `ctx.llm` rather than forwarded to the CLI.
- **Model ids stay provider-scoped.** Selecting a model owned by another provider
  never leaks its id to the CLI, which would ask the gateway for a model it has
  never heard of. The turn is routed natively instead.
- **Token accounting.** Usage is reported with the cache counters intact and with
  the prompt total split into uncached and cached parts, so the context gauge and
  cache hit rate are correct rather than doubled.
- **Inline markup is stripped.** A model occasionally writes its tool intent as
  text using DeepSeek's inline syntax rather than the structured channel; that
  markup is removed before the message is recorded.

## Requirements

All three are required; the plugin cannot start without them.

- **Node** `^22.19.0 || >=24.0.0`.
- **DSH** `^0.2.2-rc.1`. An older Harness fails on load, because `driver.ts`
  imports `AgentModel` from `@deepseek-ai/dsh-agent` and that export first
  appears in `0.2.2-rc.1`. Note that npm's `latest` tag currently points at
  `0.1.0-rc.6`; install the `next` line or newer, not `latest`.
- **A local CodeBuddy CLI**, installed and signed in. Point `command` at its
  absolute path and leave `probe: false` unless you want the plugin to look it up.

## Why the peer range starts at 0.2.2-rc.1

`driver.ts` imports `AgentModel` from `@deepseek-ai/dsh-agent`, and that export
exists only from `0.2.2-rc.1`. An older Harness fails at import with:

```
SyntaxError: The requested module '@deepseek-ai/dsh-agent' does not export 'AgentModel'
```

`engines.dsh` states `^0.2.2-rc.1`, and every peer dependency names the same
floor with a caret range: these packages are released together, so a newer
candidate within the same line is compatible, while an older one is not.

## Configuration

`profile.patch.yml` shows the full set. Two keys are worth calling out:

- `contextWindow` — the window published for every model this route serves, in
  tokens. Defaults to `1000000`, matching what the CLI reports in its own
  `modelUsage`. Switching a live Session onto this route prices the existing
  history against it, so a model reported with no window fails the switch
  outright. Lower it when the CLI is pointed at a smaller backend.
- `maxOutputTokens` — the completion budget reserved out of that window when the
  planner sizes a switch. Defaults to `128000`, again matching the CLI.

## Name

This directory publishes as `@hughxzhang/dsh-agent-codebuddy`, not under the
project's own `@deepseek-ai/` scope. The parent workspace package keeps
`@deepseek-ai/dsh-agent-codebuddy` for the official release; a redistributable
copy must not claim a name its maintainer cannot publish.

## Install

From npm. The package currently carries both `next` and `latest`, the latter set
by npm when the name was first claimed, so a bare install also resolves. Pin the
tag or the exact version anyway: a deployment that must not drift onto a later
prerelease should not depend on where `latest` happens to point.

```sh
dsh plugin --profile <profile> add "@hughxzhang/dsh-agent-codebuddy@next"
```

Pin the exact version instead when a deployment must be reproducible:

```sh
dsh plugin --profile <profile> add "@hughxzhang/dsh-agent-codebuddy@0.2.2-rc.2"
```

From a Git repository, with the package directory inside it:

```sh
dsh plugin --profile <profile> add "git+https://github.com/<owner>/<repo>.git#<commit>&path:/<dir>"
```

A git-hosted install also needs one build approval, which `pnpm` blocks until
the profile names the exact key it prints:

```yaml
# <DSH_HOME>/profiles/<profile>/pnpm-workspace.yaml
allowBuilds:
  '<the key pnpm printed>': true
```

From a local checkout:

```sh
dsh plugin --profile <profile> add "file:$PWD"
```

Then apply `profile.patch.yml`, which turns the bundle on:

```sh
dsh <profile> --patch /path/to/profile.patch.yml
```

`cordis.patch.yml` is the layer this bundle declares in `dsh.bundle.patch`. It
disables `agent-loop` and inserts the settings service plus the factory, with
CodeBuddy left off until a later patch sets `enabled`.

## Rebuild

`dist/` is produced from the parent package. From the repository root:

```sh
pnpm run build:lib
pnpm --filter @deepseek-ai/dsh-agent-codebuddy run build
node packages/experimental/agent-codebuddy/standalone/sync.mjs
```

The `pnpm --filter` name is the **parent** workspace package, which keeps the
`@deepseek-ai/` scope; this directory publishes as `@hughxzhang/dsh-agent-codebuddy`
instead, so the two never collide in the registry.

`sync.mjs` copies `lib/index.js` and the `settings` entry into `dist/`.
