/**
 * Detection and removal of DeepSeek's inline tool-call markup.
 *
 * DeepSeek models usually ask for a tool through the structured `tool_use`
 * channel, which this plugin turns into a real tool call. Occasionally a model
 * instead writes that intent as literal text using its own inline syntax:
 *
 * ```
 * <｜｜DSML｜｜ calls>
 * <｜｜DSML｜｜ invoke name="bash">
 * <｜｜DSML｜｜ parameter name="command" string="true">ls -la</｜｜ parameter>
 * </｜｜ invoke>
 * </｜｜ calls>
 * ```
 *
 * The CLI forwards whatever the model produced, so a turn like that reaches the
 * Session as ordinary text and renders as markup in the chat. It is a model
 * behaviour, not a serialization fault: the same conversation is visible in
 * CodeBuddy's own traces before this plugin drives it, and such a turn ends with
 * `finish: stop` rather than `tool-calls`, proving no tool was requested
 * structurally.
 *
 * This module strips that markup so nothing unreadable reaches the transcript.
 * It is deliberately NOT a recovery path: turning the text back into an executed
 * tool call would guess at an intent the model never declared, and a model that
 * wrote markup once will be told the tool did not run. Stripping keeps the
 * conversation honest and the transcript clean.
 *
 * The markers use fullwidth vertical bars (U+FF5C) and an opaque id — `｜DSML｜`,
 * apparently an encoding of "deepseek" — so they cannot be matched by a simple
 * `<tag>` grammar. Closing tags are also frequently malformed, dropping the id
 * down to `</｜｜ parameter>`, so the patterns accept either shape.
 *
 * @module @deepseek-ai/dsh-agent-codebuddy/dsml
 */

/** Fullwidth vertical bar that delimits every inline marker. */
const BAR = '｜'

/**
 * One delimiter run: a `<`, one or two fullwidth bars around an optional short
 * id, then another bar run.
 *
 * A model writes `｜｜DSML｜｜` when it opens a tag and `｜｜` when it truncates the
 * closing one, so the id is optional. Matching a *run* of bars rather than
 * exactly two is what lets `<｜｜DSML｜｜ …>` and `</｜｜ …>` share one grammar.
 */
const OPEN = `<${BAR}+(?:[^${BAR}\\n>]{0,24})?${BAR}+\\s*`

/** The closing form, which drops the id: `</｜｜ tag>`. */
const CLOSE = `<\\/${BAR}+(?:[^${BAR}\\n>]{0,24})?${BAR}+\\s*`

/** A complete inline-call block, from its `calls` wrapper to its close. */
const CALL_BLOCK = new RegExp(`${OPEN}calls\\s*>[\\s\\S]*?${CLOSE}calls\\s*>`, 'g')

/**
 * A stray marker with its tag name, for a block whose wrapper is cut off.
 *
 * This catches the inner fragments (`parameter`, `invoke`) when the enclosing
 * `calls` element never arrived, which also happens on a truncated stream.
 */
const LOOSE_MARKER = new RegExp(
  `(?:${OPEN}|${CLOSE})(?:invoke|parameter|calls)\\b[^>]*>`,
  'g',
)

/** Whether `text` contains any inline tool-call markup. */
export function hasInlineToolCall(text: string): boolean {
  // A cheap guard: every form this module removes requires a fullwidth bar.
  if (!text.includes(BAR)) return false
  CALL_BLOCK.lastIndex = 0
  if (CALL_BLOCK.test(text)) return true
  LOOSE_MARKER.lastIndex = 0
  return LOOSE_MARKER.test(text)
}

/**
 * Remove inline tool-call markup from one text fragment.
 *
 * The visible prose around a marker is kept: a model that narrates and then
 * emits markup should still show the narration. Only the markup itself and the
 * blank lines it leaves behind are dropped, so the result reads as the sentence
 * the model meant to say.
 * @param text - one assistant text block, verbatim from the CLI.
 * @returns the text without markup, or the input unchanged when none is present.
 */
export function stripInlineToolCalls(text: string): string {
  if (!text.includes(BAR)) return text
  const stripped = text
    .replace(CALL_BLOCK, '')
    .replace(LOOSE_MARKER, '')
  if (stripped === text) return text
  // Collapse the blank lines a removed block leaves, and trim the empty edges a
  // markup-only message becomes.
  return stripped
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
