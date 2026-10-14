/**
 * The languages the bot's own words come in: what the adapter posts on a platform (approvals,
 * stops, failures, the working message) and everything the terminal draws. The project itself —
 * code, docs, defaults — is English; a deployment picks its language with the `language` setting.
 * What the model writes is not decided here: that follows the persona and the person.
 */

export type Language = 'en' | 'ko' | 'zh'

export const LANGUAGES: readonly Language[] = ['en', 'ko', 'zh']

/**
 * A setting or a locale, as one of the three: `ko`, `ko-KR`, `ko_KR.UTF-8`, `Korean`, `zh`,
 * `zh_CN`, `zh-Hant`, `Chinese`, `en_US`… Anything else, or nothing, is English.
 */
export function languageOf(value: unknown): Language {
  if (typeof value !== 'string') return 'en'
  const v = value.trim().toLowerCase()
  if (/^(ko|kor|korean|한국어)(?:$|[-_.@])/.test(v)) return 'ko'
  if (/^(zh|chi|zho|chinese|中文)(?:$|[-_.@])/.test(v)) return 'zh'
  return 'en'
}

/**
 * The language of an environment, by the POSIX order: LC_ALL, then LC_MESSAGES, then LANG. The
 * first one set decides, even when it names a language this has no words for (then English).
 */
export function envLanguage(env: Record<string, string | undefined>): Language {
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const v = env[key]
    if (v !== undefined && v !== '' && v !== 'C' && v !== 'POSIX') return languageOf(v)
  }
  return 'en'
}
