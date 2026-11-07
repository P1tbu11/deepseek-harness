import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentOptions, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentLoop, { type Config as LoopConfig } from '@deepseek-ai/dsh-agent-loop'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { readBindings, writeBindings, type CliBinding } from './bindings.ts'
import { CLI_DEFAULT_MODEL, CODEBUDDY_PROVIDER, CREATOR_PRESET } from './constants.ts'
import { CodeBuddyAgent } from './driver.ts'
import { resolveCliPath } from './probe.ts'
import type CodeBuddySettingsService from './settings.ts'

/**
 * Startup configuration for the replacement factory.
 * CLI path and probe settings live on `codebuddySettings`, not on this type.
 * The fields match the stock agent-loop schema so a profile can still declare startup agents.
 */
export interface CodeBuddyFactoryConfig extends LoopConfig {}

/**
 * Agent factory that keeps the default loop for every provider except `codebuddy`.
 * The profile disables the stock `agent-loop` row and inserts this service, so
 * `setFactory` runs once.
 */
export default class CodeBuddyLoop extends AgentLoop {
  static override inject = [...AgentLoop.inject, 'subprocess', 'codebuddySettings']

  /** Plain holder so a traced createAgent call still sees the injected services. */
  private readonly locals: { ctx: Context }
  private bindings = new Map<string, CliBinding>()

  constructor(ctx: Context, config: CodeBuddyFactoryConfig) {
    super(ctx, config)
    this.locals = { ctx }
  }

  private get settings(): CodeBuddySettingsService['config'] {
    return this.locals.ctx.codebuddySettings.config
  }

  override async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    if (providerOf(options.agentOptions) !== CODEBUDDY_PROVIDER) return super.createAgent(ownerCtx, options)
    return this.openCodeBuddy(options.sessionId, options.agentOptions ?? {}, options.meta?.agentPreset, false)
  }

  override async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    await this.ensureBindings()
    if (!this.bindings.has(options.resumeSessionId) && providerOf(options.agentOptions) !== CODEBUDDY_PROVIDER) {
      return super.resume(ownerCtx, options)
    }
    return this.openCodeBuddy(options.resumeSessionId, options.agentOptions ?? {}, undefined, true)
  }

  private async openCodeBuddy(
    sessionId: SessionId,
    agentOptions: AgentOptions,
    preset: string | undefined,
    resume: boolean,
  ): Promise<AgentHandle> {
    if (!this.settings.enabled) throw new Error('codebuddy driver is disabled; set enabled: true on the plugin')
    await this.ensureBindings()
    const command = await resolveCliPath({
      command: this.settings.command,
      probe: this.settings.probe,
      timeoutMs: this.settings.probeTimeoutMs,
    })
    const host = this.locals.ctx
    const remembered = this.bindings.get(sessionId)
    const existing = resume ? host.sessions.get(sessionId) : undefined
    const session = existing ?? host.sessions.prepare(sessionId, { meta: { cwd: process.cwd() } })
    if (existing === undefined) {
      host.sessions.enter(session)
      host.sessions.announce(session)
    }
    const agent = new CodeBuddyAgent(host, session, {
      ...agentOptions,
      provider: CODEBUDDY_PROVIDER,
      model: this.settings.model || agentOptions.model || CLI_DEFAULT_MODEL,
    }, preset ?? (remembered?.creator ? CREATOR_PRESET : undefined), remembered, {
      command,
      args: this.settings.args,
      model: this.settings.model,
      graceMs: this.settings.graceMs,
      remember: async (id, binding) => {
        this.bindings.set(id, binding)
        await writeBindings(this.settings.stateDir, this.bindings)
      },
    })
    const dispose = host.agents.register(agent)
    return {
      agent,
      dispose: async () => {
        agent.cancel({ kind: 'disposed' })
        await agent.whenIdle()
        await dispose?.()
      },
    }
  }

  private async ensureBindings(): Promise<void> {
    if (this.bindings.size > 0 || this.settings.stateDir === '') return
    this.bindings = await readBindings(this.settings.stateDir)
  }
}

function providerOf(options: AgentOptions | undefined): string | undefined {
  const provider = options?.provider
  return typeof provider === 'string' && provider.length > 0 ? provider : undefined
}

export { CODEBUDDY_PROVIDER, CREATOR_PRESET } from './constants.ts'
export { launchArgs, initializeRequest } from './protocol.ts'
