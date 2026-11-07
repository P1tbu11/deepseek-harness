import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { CODEBUDDY_PROVIDER, DEFAULT_MODEL_ID } from './constants.ts'
import type CodeBuddySettingsService from './settings.ts'
import { discoverModels, type ModelCatalog } from './models.ts'

/**
 * Publish `codebuddy` on the existing provider catalog.
 * Session creation still chooses the CLI driver. This adapter does not run a model call.
 * @param ctx - context whose LLM registry the model picker reads.
 * @param settings - deployment settings carrying the CLI path and optional override.
 * @returns the disposer that removes the route.
 */
export function registerCodeBuddyCatalog(ctx: Context, settings: CodeBuddySettingsService): () => void {
  const adapter = new CodeBuddyCatalog(ctx, settings)
  const registered = ctx.llm.registerAdapter([CODEBUDDY_PROVIDER], adapter)
  const directory = ctx.llm.registerConfigurableProviders([{
    provider: CODEBUDDY_PROVIDER,
    displayName: 'CodeBuddy',
    settingsNs: 'agent-codebuddy-settings',
    settingsPath: [],
  }])
  return () => {
    directory()
    registered()
  }
}

/**
 * Catalog row for the CLI driver. `stream` fails closed so a DeepSeek loop
 * cannot impersonate the CLI.
 *
 * The advertised set is the synthetic {@link DEFAULT_MODEL_ID} entry followed by
 * what the CLI accepts: an explicit `models` list from settings when present,
 * otherwise the ids the CLI prints in its own `--model` help.
 *
 * The default entry comes first because a picker that has no saved selection
 * shows the first row, and a session that passes no `--model` is exactly what
 * selecting it means. Its description names the model the CLI will actually
 * run, read from the CLI's own settings file.
 */
class CodeBuddyCatalog extends LlmAdapter {
  constructor(
    private readonly ctx: Context,
    private readonly settings: CodeBuddySettingsService,
  ) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'CodeBuddy' }
  }

  override async listModels(provider: string): Promise<readonly {
    provider: string
    id: string
    name: string
    description?: string
    inputModalities: readonly ['text']
    badge?: { text: { en: string; zh: string }; tone: 'neutral' | 'info' | 'success' | 'warning' }
  }[]> {
    const catalog = await this.catalog()
    // Discovery drops `default` when the CLI happens to list it, so the
    // synthetic row below is the only carrier of that id.
    const real = catalog.models.filter(id => id !== DEFAULT_MODEL_ID)
    const configured = catalog.configured
    return [
      {
        provider,
        id: DEFAULT_MODEL_ID,
        name: 'Default',
        description: configured === ''
          ? 'Uses the model configured in the CodeBuddy CLI'
          : `Uses the CodeBuddy CLI's configured model: ${configured}`,
        inputModalities: ['text'] as const,
        badge: { text: { en: 'CLI default', zh: 'CLI 默认' }, tone: 'info' as const },
      },
      ...real.map(id => ({
        provider,
        id,
        name: id,
        ...id === configured
          ? { description: 'Currently the configured default in the CodeBuddy CLI' }
          : {},
        inputModalities: ['text'] as const,
      })),
    ]
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    throw new LlmError(
      'provider "codebuddy" is served by the CLI session driver; this adapter only advertises the route',
      'CODEBUDDY_DRIVER',
    )
  }

  /** Resolved catalog, honoring an explicit settings list over discovery. */
  private async catalog(): Promise<ModelCatalog> {
    const configured = this.settings.config.models
    if (configured.length > 0) {
      const fallback = this.settings.config.model
      return { models: configured, configured: fallback === '' ? configured[0] ?? '' : fallback }
    }
    return discoverModels(this.ctx, {
      command: this.settings.config.command,
      args: this.settings.config.args,
      settingsPath: this.settings.config.cliSettingsPath,
      timeoutMs: this.settings.config.modelsTimeoutMs,
    })
  }
}
