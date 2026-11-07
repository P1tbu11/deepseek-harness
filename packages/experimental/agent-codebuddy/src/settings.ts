import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Deployment settings for the CodeBuddy CLI. DeepSeek sessions ignore them. */
export interface CodeBuddySettings {
  /** When false, a codebuddy provider fails instead of probing or spawning. */
  readonly enabled: boolean
  /** Absolute CLI path. Empty uses the fixed candidate list after `enabled`. */
  readonly command: string
  /** Extra arguments before the stream-json flags. */
  readonly args: readonly string[]
  /** Stat timeout for each candidate path. */
  readonly probeTimeoutMs: number
  /** When false, an empty command fails instead of probing. */
  readonly probe: boolean
  /** Optional CLI `--model`. Empty leaves the CLI's own model. */
  readonly model: string
  /** Directory for the CLI session map. Empty keeps the map in memory only. */
  readonly stateDir: string
  /** SIGTERM grace before the subprocess service escalates. */
  readonly graceMs: number
}

/**
 * Config service read by the CodeBuddy factory. Kept separate so the factory
 * can keep the default agent-loop config schema.
 */
export default class CodeBuddySettingsService extends Service {
  static inject = []

  static Config = z.object({
    enabled: z.boolean().default(false),
    command: z.string().default(''),
    args: z.array(z.string()).default([]),
    probeTimeoutMs: z.number().min(1).default(1500),
    probe: z.boolean().default(true),
    model: z.string().default(''),
    stateDir: z.string().default(''),
    graceMs: z.number().min(1).default(3000),
  })

  /**
   * @param ctx - host context that publishes the service.
   * @param config - validated CLI settings.
   */
  constructor(ctx: Context, public readonly config: CodeBuddySettings) {
    super(ctx, 'codebuddySettings')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Deployment settings for the CodeBuddy CLI. */
    codebuddySettings: CodeBuddySettingsService
  }
}
