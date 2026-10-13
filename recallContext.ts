/**
 * What the past implies, not just what it said.
 *
 * Recall used to end where a search ends: the agent ran the index CLI with bash and read raw
 * passages, so a question about last week produced a dump and left the model to be clever about
 * it. This ranks passages in-process — the same word-overlap ranking `recall/deepbot-recall.mjs`
 * uses, which `test/recall.test.mjs` pins — and asks for the implication instead of the passages.
 *
 * The implication is written by the model, not guessed here: only a model reads intent. What this
 * decides is which few passages are worth showing.
 *
 * Range and cost. Ranking is lexical, so a question whose words do not appear in a passage will
 * not find it; the block says so rather than implying semantic search. It is injected into the
 * *dynamic* part of the prompt and never into the standing block, whose digest gates it for prompt
 * cache safety — a per-turn block there would invalidate the cache on every turn.
 */
import { existsSync, readFileSync } from 'node:fs'

export interface RecallRow {
  ts?: number
  role?: string
  sessionId?: string
  /** The channel the session belonged to, as the indexer read it from the adapter's block. */
  channel?: string
  text?: string
}

export interface RecallOptions {
  /** The JSONL index, usually `<home>/memory/recall-index.jsonl`. */
  indexPath: string
  /** How many passages to show. */
  topN?: number
  /** Character budget for the whole block. */
  maxChars?: number
  /** Only look when the message points at the past; empty means always. */
  triggerWords?: readonly string[]
  /**
   * Only passages from this channel. Ranking used every row in the home, so a word in common was
   * enough to put a DM into a public channel's answer. A row with no channel is left out too. Null
   * or absent means no restriction: a turn with no conversation, such as a scenario.
   */
  channel?: string | null
  /** The channel of a session the adapter still maps, for a row the indexer could not place. */
  sessionChannel?: (sessionId: string) => string | null
  now?: () => number
}

export const DEFAULT_TRIGGER_WORDS = [
  '지난', '저번', '전에', '아까', '그때', '이전', '예전', '어제', '지난번', '기억',
  'last', 'earlier', 'before', 'previous', 'remember', 'recall', 'again',
]

/** Words worth matching on: one-character particles match everything. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^0-9a-z가-힣]+/u)
    .filter((w) => w.length > 1)
}

export function createRecallContext(options: RecallOptions) {
  const topN = options.topN ?? 4
  const maxChars = options.maxChars ?? 1200
  const triggers = options.triggerWords ?? DEFAULT_TRIGGER_WORDS

  function load(): RecallRow[] {
    if (!existsSync(options.indexPath)) return []
    const rows: RecallRow[] = []
    for (const line of readFileSync(options.indexPath, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const row = JSON.parse(line) as RecallRow
        if (typeof row.text === 'string' && row.text.trim() !== '') rows.push(row)
      } catch { /* one unreadable line is not a reason to lose the rest */ }
    }
    return rows
  }

  function format(ts: unknown): string {
    const n = Number(ts)
    if (!Number.isFinite(n) || n <= 0) return ''
    const date = new Date(n < 1e12 ? n * 1000 : n)
    return Number.isNaN(date.getTime()) ? '' : `${date.toISOString().slice(0, 10)} `
  }

  return {
    /** True when the message points at the past, or when no trigger words are configured. */
    triggered(prompt: string): boolean {
      if (triggers.length === 0) return true
      const lower = prompt.toLowerCase()
      return triggers.some((word) => lower.includes(word.toLowerCase()))
    },

    /**
     * The block to inject, or '' when there is nothing to say. Never throws: a recall that fails
     * must not cost a turn.
     */
    block(prompt: string): string {
      try {
        if (!this.triggered(prompt)) return ''
        const query = words(prompt)
        if (query.length === 0) return ''
        const channel = options.channel ?? null
        const ranked = load()
          .filter((row) => channel === null
            || (row.channel ?? (row.sessionId !== undefined ? options.sessionChannel?.(row.sessionId) : null) ?? null) === channel)
          .map((row) => {
            const text = String(row.text).toLowerCase()
            return { row, score: query.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0) }
          })
          .filter((hit) => hit.score > 0)
          .sort((a, b) => b.score - a.score || Number(b.row.ts ?? 0) - Number(a.row.ts ?? 0))
          .slice(0, topN)
        if (ranked.length === 0) return ''

        const lines = ranked.map(({ row }) => {
          const text = String(row.text).replace(/\s+/g, ' ').trim().slice(0, 240)
          return `- ${format(row.ts)}${row.role ?? 'unknown'}: ${text}`
        })
        const body = [
          '[earlier conversations, and what they imply]',
          'Passages from past sessions that share words with this message — matched lexically, so',
          'this is not a semantic search and may miss a differently-worded question.',
          ...lines,
          'Use them to decide the next step, and say the step. Do not summarise the passages back.',
        ].join('\n')
        return body.length > maxChars ? `${body.slice(0, maxChars)}\n…` : body
      } catch {
        return ''
      }
    },
  }
}
