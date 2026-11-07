import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { CLI_DEFAULT_MODEL, CODEBUDDY_PROVIDER } from './constants.ts'
import type CodeBuddySettingsService from './settings.ts'

/**
 * Publish `codebuddy` on the existing provider catalog.
 * Session creation still chooses the CLI driver. This adapter does not run a model call.
 * @param ctx - host context whose LLM registry the model picker reads.
 * @returns the disposer that removes the route.
 */
export function registerCodeBuddyCatalog(ctx: Context): () => void {
  const adapter = new CodeBuddyCatalog(ctx.codebuddySettings)
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

/** Catalog row for the CLI driver. `stream` fails closed so a DeepSeek loop cannot impersonate the CLI. */
class CodeBuddyCatalog extends LlmAdapter {
  constructor(private readonly settings: CodeBuddySettingsService) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'CodeBuddy' }
  }

  override listModels(provider: string): Promise<readonly { provider: string; id: string; name: string; inputModalities: readonly ['text'] }[]> {
    const configured = this.settings.config.model
    const id = configured === '' ? CLI_DEFAULT_MODEL : configured
    return Promise.resolve([{
      provider,
      id,
      name: id,
      inputModalities: ['text'],
      badge: { text: { en: 'New session', zh: '新会话' }, tone: 'warning' },
    }])
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    throw new LlmError(
      'provider "codebuddy" is served by the CLI session driver; this adapter only advertises the route',
      'CODEBUDDY_DRIVER',
    )
  }
}
