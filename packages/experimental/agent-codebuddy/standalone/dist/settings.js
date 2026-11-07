import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/**
 * Config service read by the CodeBuddy factory. Kept separate so the factory
 * can keep the default agent-loop config schema.
 */
export default class CodeBuddySettingsService extends Service {
    config;
    static inject = [];
    static Config = z.object({
        enabled: z.boolean().default(false),
        command: z.string().default(''),
        args: z.array(z.string()).default([]),
        probeTimeoutMs: z.number().min(1).default(1500),
        probe: z.boolean().default(true),
        model: z.string().default(''),
        models: z.array(z.string()).default([]),
        cliSettingsPath: z.string().default(''),
        modelsTimeoutMs: z.number().min(100).default(8000),
        stateDir: z.string().default(''),
        graceMs: z.number().min(1).default(3000),
    });
    /**
     * @param ctx - host context that publishes the service.
     * @param config - validated CLI settings.
     */
    constructor(ctx, config) {
        super(ctx, 'codebuddySettings');
        this.config = config;
    }
}
//# sourceMappingURL=settings.js.map