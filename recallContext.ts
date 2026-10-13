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
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Where a home's recall index lives: under the harness's home, outside the agent's. In the agent's
 * home the agent could read every channel's history with its own tools — the channel filter below
 * only governs what is injected — and an unconfined indexer wrote where the agent could plant links.
 * The sandbox runner and the tools' read scope both deny this directory.
 */
export function recallIndexPath(home: string, dshHome: string = process.env.DSH_HOME ?? join(homedir(), '.dsh')): string {
  const full = resolve(home)
  // The flattened path is for a person reading the directory; the hash keeps apart homes that flatten
  // alike (/a/b-c and /a/b/c, "dsh agent" and "dsh-agent"), which shared one index.
  const id = `${full.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}-${createHash('sha256').update(full).digest('hex').slice(0, 8)}`
  return join(dshHome, 'recall', id, 'recall-index.jsonl')
}

export interface RecallRow {
  ts?: number
  role?: string
  sessionId?: string
  /** The channel the session belonged to, as the indexer read it from the adapter's block. */
  channel?: string
  text?: string
}

export interface RecallOptions {
  /** The JSONL index, `recallIndexPath(home)`. */
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
  /** The session being answered: its own turns are already in its context. */
  sessionId?: string | null
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

// Korean particles, longest first. A query word carries its particle ("롤백을") and a passage may not
// ("롤백"), so the query side is stripped; matching is by substring, so the passage side need not be.
const PARTICLES = ['으로부터', '에서부터', '이라고', '에게서', '한테서', '라고', '으로', '에서', '에게', '한테', '까지',
  '부터', '처럼', '보다', '이나', '이랑', '하고', '은', '는', '이', '가', '을', '를', '에', '의', '로', '와', '과', '도', '만', '랑']

/** A query word without its trailing particle, when what is left is still a word. */
export function stem(word: string): string {
  if (!/[가-힣]$/u.test(word)) return word
  for (const particle of PARTICLES) {
    if (word.endsWith(particle) && word.length - particle.length >= 2) return word.slice(0, -particle.length)
  }
  return word
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
        const query = [...new Set(words(prompt).map(stem))]
        if (query.length === 0) return ''
        const channel = options.channel ?? null
        const own = options.sessionId ?? null
        const rows = load()
          .filter((row) => channel === null
            // The adapter's mapping first: a row's own channel was read from text, the mapping was not.
            || ((row.sessionId !== undefined ? options.sessionChannel?.(row.sessionId) : null) ?? row.channel ?? null) === channel)
          .filter((row) => own === null || row.sessionId !== own)
        if (rows.length === 0) return ''
        const texts = rows.map((row) => String(row.text).toLowerCase())
        // Inverse document frequency: a word in every passage says nothing about which one is meant.
        const df = new Map(query.map((w) => [w, texts.reduce((n, text) => n + (text.includes(w) ? 1 : 0), 0)]))
        const idf = (w: string) => Math.log(1 + rows.length / Math.max(1, df.get(w) ?? 0))
        // A word few passages share; two of them in one passage is very likely the same subject.
        const rare = Math.max(2, Math.ceil(rows.length * 0.02))
        const ranked = rows
          .map((row, i) => {
            const matched = query.filter((w) => texts[i].includes(w))
            return { row, score: matched.reduce((n, w) => n + idf(w), 0), distinctive: matched.filter((w) => (df.get(w) ?? 0) <= rare).length }
          })
          .filter((hit) => hit.score > 0)
          .sort((a, b) => b.score - a.score || Number(b.row.ts ?? 0) - Number(a.row.ts ?? 0))
          .slice(0, topN)
        if (ranked.length === 0) return ''
        // Unprompted — no word pointing at the past — only a strong match is worth the interruption.
        // It used to need a trigger word, so "did anyone say X?" found nothing.
        if (!this.triggered(prompt) && ranked[0].distinctive < 2) return ''

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
