/** Provider id that selects the CodeBuddy driver at session create or resume. */
export const CODEBUDDY_PROVIDER = 'codebuddy'

/** Preset id for 创造模式. Only this preset attaches the DSH tool bridge. */
export const CREATOR_PRESET = 'cordis'

/** MCP server name advertised to the CLI for the creator-mode bridge. */
export const BRIDGE_SERVER = 'dsh'

/** Tool the creator-mode bridge exposes. Native CLI tools are not in this list. */
export const BRIDGE_TOOL = 'plugin_manager'

/**
 * Synthetic model id meaning "let the CLI pick".
 *
 * The provider advertises it first so a fresh session has an explicit choice
 * that round-trips to "pass no `--model`". The CLI then resolves the model from
 * its own settings, which is why selecting it must never send a real id.
 *
 * No CodeBuddy build lists this id, and discovery drops it if one ever does, so
 * a picker cannot end up with two entries carrying the same id.
 */
export const DEFAULT_MODEL_ID = 'default'
