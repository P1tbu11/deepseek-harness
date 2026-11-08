import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CODEBUDDY_PROVIDER, DEFAULT_MODEL_ID } from './constants.ts'
import { streamOneShot } from './chat.ts'
import type CodeBuddySettingsService from './settings.ts'
import { discoverModels, type ModelCatalog } from './models.ts'

/**
 * Publish `codebuddy` on the existing provider catalog.
 *
 * Two callers share this route and they are not the same shape of call. A DSH
 * session is driven by the resident CLI in `driver.ts`, which owns the
 * conversation and its own tool loop. Everything else that calls a model —
 * the agent loop's auxiliary requests, and third-party plugins such as the
 * media desk — arrives here through `ctx.llm` with one assembled request and
 * no session to continue. Those get a one-shot `codebuddy -p` process, so the
 * route answers both.
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
 * Catalog row and one-shot model route for the CLI driver.
 *
 * Session creation still hands the turn to `driver.ts`, which drives a resident
 * CLI. `stream` here answers the other kind of caller — one that reaches a
 * model through `ctx.llm` without owning a session — with a single `codebuddy
 * -p` process. See `chat.ts` for that translation.
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

  /**
   * Resolve one exact model id for the call pipeline.
   *
   * The base implementation echoes the id, which would label a picker entry
   * `default` and leave the session-controller with nothing to validate against.
   * Answering from the same catalog `listModels` advertises keeps selection and
   * display consistent, and a request for an id the catalog does not offer fails
   * here instead of inside the CLI.
   * @param provider - the route this adapter registered.
   * @param model - exact model id a user selected.
   * @returns resolved identity plus the modalities the catalog declared.
   */
  override async resolveModel(provider: string, model: string): Promise<{
    provider: string
    id: string
    name: string
    description?: string
    inputModalities?: readonly ['text', ...'image'[]]
  }> {
    const catalog = await this.catalog()
    if (model === DEFAULT_MODEL_ID) {
      const configured = catalog.configured
      return {
        provider,
        id: model,
        name: 'Default',
        description: configured === ''
          ? 'Uses the model configured in the CodeBuddy CLI'
          : `Uses the CodeBuddy CLI's configured model: ${configured}`,
        inputModalities: ['text', 'image'],
      }
    }
    if (!catalog.models.includes(model)) {
      throw new LlmError(
        `CodeBuddy does not advertise model "${model}"`,
        'UNKNOWN_MODEL',
      )
    }
    return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
  }

  override async listModels(provider: string): Promise<readonly {
    provider: string
    id: string
    name: string
    description?: string
    inputModalities: readonly ['text', ...'image'[]]
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
        inputModalities: ['text', 'image'] as const,
        badge: { text: { en: 'CLI default', zh: 'CLI 默认' }, tone: 'info' as const },
      },
      ...real.map(id => ({
        provider,
        id,
        name: id,
        ...id === configured
          ? { description: 'Currently the configured default in the CodeBuddy CLI' }
          : {},
        // The driver sends images inline when the message carries them, so
        // every route it advertises accepts both.
        inputModalities: ['text', 'image'] as const,
      })),
    ]
  }

  /**
   * Answer one assembled request with a one-shot CLI process.
   *
   * A session on this provider is driven by `driver.ts` instead; this path
   * exists for callers that reach a model through `ctx.llm` without owning a
   * session, such as auxiliary requests and third-party plugins. Both are real
   * model calls, and the CLI streams either way, so the chunks here are the
   * same vocabulary every other adapter emits.
   * @param options - the fully assembled request.
   * @returns harness chunks, ending with exactly one terminal finish.
   */
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return streamOneShot(this.ctx, this.settings, options)
  }

  /** Resolved catalog, honoring an explicit settings list over discovery. */
  private async catalog(): Promise<ModelCatalog> {
    const configured = this.settings.config.models
    if (configured.length > 0) {
      const fallback = this.settings.config.model
      return {
        models: configured,
        configured: fallback === '' ? configured[0] ?? '' : fallback,
        // An explicit list is a deployment override, not a CLI capability
        // claim; keep naming the tool and let the turn fall back naturally.
        viewImage: true,
      }
    }
    return discoverModels(this.ctx, {
      command: this.settings.config.command,
      args: this.settings.config.args,
      settingsPath: this.settings.config.cliSettingsPath,
      timeoutMs: this.settings.config.modelsTimeoutMs,
    })
  }
}
