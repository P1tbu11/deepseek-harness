#!/usr/bin/env node
/**
 * Copy the parent package's build output into this standalone bundle.
 *
 * The parent package is workspace-only, so its `lib/` stays gitignored and its
 * manifest keeps `workspace:` ranges. This directory ships the same built files
 * under a tracked `dist/` with published versions in `package.json`.
 *
 * Run from the repository root after `pnpm --filter @deepseek-ai/dsh-agent-codebuddy run build`.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const parent = dirname(here)
const source = join(parent, 'lib')
const target = join(here, 'dist')

/** Build artifacts this bundle publishes, as `[from, to]` relative to `lib/`. */
const ARTIFACTS = [
  ['index.js', 'index.js'],
  ['types/settings.js', 'settings.js'],
  ['types/settings.d.ts', 'settings.d.ts'],
]

await mkdir(target, { recursive: true })
for (const [from, to] of ARTIFACTS) {
  await copyFile(join(source, from), join(target, to))
  process.stdout.write(`sync: ${from} -> dist/${to}\n`)
}

const manifest = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'))
const parentManifest = JSON.parse(await readFile(join(parent, 'package.json'), 'utf8'))
if (manifest.version !== parentManifest.version) {
  throw new Error(
    `standalone/package.json version ${manifest.version} does not match the parent ${parentManifest.version}; update it together`,
  )
}
const workspace = Object.entries(manifest.peerDependencies ?? {}).filter(([, range]) =>
  String(range).startsWith('workspace:'),
)
if (workspace.length > 0) {
  throw new Error(
    `standalone/package.json still declares workspace: peers: ${workspace.map(([name]) => name).join(', ')}`,
  )
}
process.stdout.write('sync: manifest versions and peer ranges verified\n')
