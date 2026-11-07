/** Provider id that selects the CodeBuddy driver at session create or resume. */
export const CODEBUDDY_PROVIDER = 'codebuddy'

/** Preset id for 创造模式. Only this preset attaches the DSH tool bridge. */
export const CREATOR_PRESET = 'cordis'

/** MCP server name advertised to the CLI for the creator-mode bridge. */
export const BRIDGE_SERVER = 'dsh'

/** Tool the creator-mode bridge exposes. Native CLI tools are not in this list. */
export const BRIDGE_TOOL = 'plugin_manager'

/** Display model recorded when the CLI keeps its own model selection. */
export const CLI_DEFAULT_MODEL = 'cli-default'
