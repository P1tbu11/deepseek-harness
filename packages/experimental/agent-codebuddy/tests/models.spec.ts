/**
 * Model discovery reads the CLI's own `--help` text, so these tests pin the
 * parser against the exact sentence shape and the fallbacks a broken or
 * unusual CLI produces.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import {
  BUILTIN_MODELS, clearModelCache, discoverModels, parseSupportedModels, readConfiguredModel,
} from '../src/models.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(run => run()))
  clearModelCache()
})

describe('parseSupportedModels', () => {
  it('reads the parenthesized list the CLI prints for --model', () => {
    const help = [
      'Options:',
      '  --model <model>   Model for the current session. Please provide the model ID. Currently supported: (claude-sonnet-5, gemini-3.1-pro, deepseek-v4.1-flash)',
      '  --other <x>       Another option',
    ].join('\n')
    expect(parseSupportedModels(help)).toEqual(['claude-sonnet-5', 'gemini-3.1-pro', 'deepseek-v4.1-flash'])
  })

  it('trims whitespace and drops duplicates', () => {
    const help = 'Currently supported: ( a , b ,a,  c )'
    expect(parseSupportedModels(help)).toEqual(['a', 'b', 'c'])
  })

  it('drops the synthetic default id so the catalog owns that row', () => {
    const help = 'Currently supported: (default, claude-sonnet-5, echo)'
    expect(parseSupportedModels(help)).toEqual(['claude-sonnet-5', 'echo'])
  })

  it('returns nothing when the sentence or its parentheses are missing', () => {
    expect(parseSupportedModels('Options:\n  --model <model> Model id.')).toEqual([])
    expect(parseSupportedModels('Currently supported: claude-sonnet-5')).toEqual([])
    expect(parseSupportedModels('Currently supported: (claude-sonnet-5')).toEqual([])
  })

  it('ignores unrelated parentheses before the supported list', () => {
    const help = 'Usage: codebuddy (beta) --model <model> Currently supported: (a, b)'
    expect(parseSupportedModels(help)).toEqual(['a', 'b'])
  })
})

describe('readConfiguredModel', () => {
  it('reads the model the CLI keeps in its own settings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codebuddy-settings-'))
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
    const path = join(dir, 'settings.json')
    await writeFile(path, JSON.stringify({ model: 'minimax-m3-ioa', other: 1 }))
    await expect(readConfiguredModel(path)).resolves.toBe('minimax-m3-ioa')
  })

  it('treats a missing, malformed, or modelless file as no default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codebuddy-settings-'))
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
    await expect(readConfiguredModel(join(dir, 'absent.json'))).resolves.toBe('')
    const broken = join(dir, 'broken.json')
    await writeFile(broken, '{not json')
    await expect(readConfiguredModel(broken)).resolves.toBe('')
    const modelless = join(dir, 'plain.json')
    await writeFile(modelless, JSON.stringify({ theme: 'dark' }))
    await expect(readConfiguredModel(modelless)).resolves.toBe('')
  })
})

describe('discoverModels', () => {
  it('falls back to the built-in snapshot when the CLI cannot be spawned', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocess)
    cleanups.push(async () => { await ctx.fiber.dispose() })
    clearModelCache()
    const discovered = await discoverModels(ctx, {
      command: join(tmpdir(), 'definitely-not-a-codebuddy-binary'),
      args: [],
      settingsPath: '',
      timeoutMs: 2000,
    })
    expect(discovered.models).toEqual(BUILTIN_MODELS)
    expect(discovered.configured).toBe('')
  })

  it('reports the configured model separately from the advertised list', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocess)
    const dir = await mkdtemp(join(tmpdir(), 'codebuddy-settings-'))
    cleanups.push(async () => {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    })
    clearModelCache()
    const settingsPath = join(dir, 'settings.json')
    await writeFile(settingsPath, JSON.stringify({ model: 'echo' }))
    const discovered = await discoverModels(ctx, {
      command: join(tmpdir(), 'definitely-not-a-codebuddy-binary'),
      args: [],
      settingsPath,
      timeoutMs: 2000,
    })
    expect(discovered.configured).toBe('echo')
    expect(discovered.models.length).toBeGreaterThan(1)
  })
})
