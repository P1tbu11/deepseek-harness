/**
 * Localized approval copy and operation detail for one CLI permission request.
 * The CLI's own input stays verbatim in every language.
 * @module @deepseek-ai/dsh-agent-codebuddy/approval-copy
 */

/** UI locales the approval card can be shown in. */
type ApprovalLocale = 'en' | 'zh' | 'ja' | 'es' | 'fr' | 'de' | 'ru' | 'pt'

/** One locale's sentence pair: with and without the CLI's operation detail. */
interface Copy {
  /** @param toolName - tool the CLI wants to use. @returns the sentence without a detail. */
  asks(toolName: string): string
  /** @param toolName - tool the CLI wants to use. @param detail - command, path, or pattern. @returns the sentence naming the operation. */
  withDetail(toolName: string, detail: string): string
}

const copies = {
  en: {
    asks: toolName => `CodeBuddy CLI asks to use ${toolName}`,
    withDetail: (toolName, detail) => `CodeBuddy CLI asks to use ${toolName}: ${detail}`,
  },
  zh: {
    asks: toolName => `CodeBuddy CLI 请求使用 ${toolName}`,
    withDetail: (toolName, detail) => `CodeBuddy CLI 请求使用 ${toolName}：${detail}`,
  },
  ja: {
    asks: toolName => `CodeBuddy CLI が ${toolName} の使用を求めています`,
    withDetail: (toolName, detail) => `CodeBuddy CLI が ${toolName} の使用を求めています：${detail}`,
  },
  es: {
    asks: toolName => `El CLI de CodeBuddy pide usar ${toolName}`,
    withDetail: (toolName, detail) => `El CLI de CodeBuddy pide usar ${toolName}: ${detail}`,
  },
  fr: {
    asks: toolName => `Le CLI CodeBuddy demande à utiliser ${toolName}`,
    withDetail: (toolName, detail) => `Le CLI CodeBuddy demande à utiliser ${toolName} : ${detail}`,
  },
  de: {
    asks: toolName => `Die CodeBuddy-CLI möchte ${toolName} verwenden`,
    withDetail: (toolName, detail) => `Die CodeBuddy-CLI möchte ${toolName} verwenden: ${detail}`,
  },
  ru: {
    asks: toolName => `CLI CodeBuddy запрашивает использование ${toolName}`,
    withDetail: (toolName, detail) => `CLI CodeBuddy запрашивает использование ${toolName}: ${detail}`,
  },
  pt: {
    asks: toolName => `A CLI do CodeBuddy pede para usar ${toolName}`,
    withDetail: (toolName, detail) => `A CLI do CodeBuddy pede para usar ${toolName}: ${detail}`,
  },
} satisfies Record<ApprovalLocale, Copy>

/** Input fields that name the operation a human has to judge; the first present field wins. */
const DETAIL_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url'] as const

/**
 * Pick the operation a human needs to read from the CLI's own tool input.
 * @param input - the `input` object of a `can_use_tool` request.
 * @returns the command, path, or pattern, or `undefined` when the input names none.
 */
export function permissionDetail(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const fields = input as Record<string, unknown>
  for (const key of DETAIL_FIELDS) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * Build the approval card's question text so the operation is visible before a
 * decision. Approving a tool name alone hides what will run.
 * @param toolName - tool the CLI wants to use.
 * @param detail - command, path, or pattern taken from the CLI's request.
 * @returns the sentence per supported UI locale, English included.
 */
export function approvalDisplayReason(
  toolName: string,
  detail: string | undefined,
): Record<ApprovalLocale, string> {
  const render = (copy: Copy): string => detail === undefined
    ? copy.asks(toolName)
    : copy.withDetail(toolName, detail)
  return {
    en: render(copies.en),
    zh: render(copies.zh),
    ja: render(copies.ja),
    es: render(copies.es),
    fr: render(copies.fr),
    de: render(copies.de),
    ru: render(copies.ru),
    pt: render(copies.pt),
  }
}

/**
 * Durable audit sentence for `approval/asked`. It names the tool only: CLI
 * input can carry credentials, and the audit pair outlives this turn in the
 * session log, while {@link approvalDisplayReason} stays presentation-only.
 * @param toolName - tool the CLI wants to use.
 * @returns the English sentence stored with the audit event.
 */
export function approvalAuditReason(toolName: string): string {
  return copies.en.asks(toolName)
}
