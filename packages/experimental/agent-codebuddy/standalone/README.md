# Standalone CodeBuddy bundle

This directory holds a self-contained, installable copy of the
[CodeBuddy driver](../README.md) for the case where the bundle must be installed
from a Git repository or an archive instead of the monorepo workspace.

The parent package is workspace-only: its dependencies use the `workspace:`
protocol, which a profile outside this repository cannot resolve, and its build
output lives in a gitignored `lib/`. This directory fixes both:

- `package.json` names published versions instead of `workspace:` ranges.
- `dist/` holds the built artifacts and is tracked by Git.

## Why the versions are pinned

`driver.ts` imports `AgentModel` from `@deepseek-ai/dsh-agent`, and that export
exists only from `0.2.2-rc.1`. An older Harness (`0.2.1-rc.5`, the current
`latest` tag) fails at import with:

```
SyntaxError: The requested module '@deepseek-ai/dsh-agent' does not export 'AgentModel'
```

`engines.dsh` therefore states `^0.2.2-rc.1`, and every peer dependency is pinned
to that same version because these packages are released together.

## Name

This directory publishes as `@p1tbu11/dsh-agent-codebuddy`, not under the
project's own `@deepseek-ai/` scope. The parent workspace package keeps
`@deepseek-ai/dsh-agent-codebuddy` for the official release; a redistributable
copy must not claim a name its maintainer cannot publish.

## Install

From npm, once published:

```sh
dsh plugin --profile <profile> add "@p1tbu11/dsh-agent-codebuddy"
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
`@deepseek-ai/` scope; this directory publishes as `@p1tbu11/dsh-agent-codebuddy`
instead, so the two never collide in the registry.

`sync.mjs` copies `lib/index.js` and the `settings` entry into `dist/`.
