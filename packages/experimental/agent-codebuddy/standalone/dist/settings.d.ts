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
  /** Optional CLI `--model`. Empty follows the live selection or the CLI's own model. */
  readonly model: string
  /** Explicit model list for the picker. Empty discovers the ids the CLI advertises. */
  readonly models: readonly string[]
  /** Absolute path to the CLI's `settings.json`, read for its configured default model. */
  readonly cliSettingsPath: string
  /** Deadline for the `--help` discovery run. */
  readonly modelsTimeoutMs: number
  /** Directory for the CLI session map. Empty keeps the map in memory only. */
  readonly stateDir: string
  /** SIGTERM grace before the subprocess service escalates. */
  readonly graceMs: number
  /** Context window published for every model this route serves, in tokens. */
  readonly contextWindow: number
  /** Output tokens reserved out of that window when the compaction planner sizes a switch. */
  readonly maxOutputTokens: number
}
/**
 * Config service read by the CodeBuddy factory. Kept separate so the factory
 * can keep the default agent-loop config schema.
 */
export default class CodeBuddySettingsService extends Service {
  readonly config: CodeBuddySettings
  static inject: never[]
  static Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, 'defined'>
    command: z<string, string, 'defined'>
    args: z<string[], string[], 'defined'>
    probeTimeoutMs: z<number, number, 'defined'>
    probe: z<boolean, boolean, 'defined'>
    model: z<string, string, 'defined'>
    models: z<string[], string[], 'defined'>
    cliSettingsPath: z<string, string, 'defined'>
    modelsTimeoutMs: z<number, number, 'defined'>
    stateDir: z<string, string, 'defined'>
    graceMs: z<number, number, 'defined'>
    contextWindow: z<number, number, 'defined'>
    maxOutputTokens: z<number, number, 'defined'>
  }>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, 'defined'>
    command: z<string, string, 'defined'>
    args: z<string[], string[], 'defined'>
    probeTimeoutMs: z<number, number, 'defined'>
    probe: z<boolean, boolean, 'defined'>
    model: z<string, string, 'defined'>
    models: z<string[], string[], 'defined'>
    cliSettingsPath: z<string, string, 'defined'>
    modelsTimeoutMs: z<number, number, 'defined'>
    stateDir: z<string, string, 'defined'>
    graceMs: z<number, number, 'defined'>
    contextWindow: z<number, number, 'defined'>
    maxOutputTokens: z<number, number, 'defined'>
  }>>, 'plain'>
    /**
     * @param ctx - host context that publishes the service.
     * @param config - validated CLI settings.
     */
  constructor(ctx: Context, config: CodeBuddySettings)
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Deployment settings for the CodeBuddy CLI. */
    codebuddySettings: CodeBuddySettingsService
  }
}
//# sourceMappingURL=settings.d.ts.map
