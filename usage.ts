/**
 * Token accounting per conversation, and what it is honest to report.
 *
 * The harness exposes tokens through the `tokenUsage` session projection — the complete
 * durable log's `uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens` and
 * `outputTokens`. Those totals grow for the life of a session, so this stores the last
 * snapshot per session and adds only the difference to the conversation's running total.
 * That makes the numbers survive a restart and keeps them per conversation rather than per
 * process.
 *
 * What it deliberately does not report is money. The pi-ai adapter says so itself: "The
 * harness never reads pi-ai's cost metadata — replay.ts zeroes it and no consumer reports
 * spend". A price table invented here would be a number nobody could check, so the summary
 * says tokens and says why.
 */
import { messages, type Messages } from './messages.js'

export interface TokenSnapshot {
  uncachedInputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
}

export interface ConversationTotals {
  /** The newest session this conversation ran in, so older snapshots can be dropped. */
  lastSessionId?: string
  turns: number
  uncached: number
  cached: number
  written: number
  output: number
  lastAt: number
}

/** The persisted shape: conversation totals plus the last snapshot seen per session. */
export interface UsageStore {
  conversations: Record<string, ConversationTotals>
  sessions: Record<string, TokenSnapshot>
}

export function emptyUsageStore(): UsageStore {
  return { conversations: {}, sessions: {} }
}

export interface UsageOptions {
  store: UsageStore
  now?: () => number
}

const fields = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const

export function createUsageTracker(options: UsageOptions) {
  const store = options.store
  const now = options.now ?? (() => Date.now())

  function number(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }

  return {
    /**
     * Record one turn's snapshot. The projection's numbers are cumulative for the session,
     * so only the growth is added. A session whose totals went *down* — compaction, or a
     * different log — is treated as a fresh baseline rather than a negative delta.
     */
    record(key: string, sessionId: string, snapshot: TokenSnapshot | null | undefined, turns = 1): void {
      if (snapshot === null || snapshot === undefined) return
      const previous = store.sessions[sessionId]
      const current: TokenSnapshot = {}
      for (const field of fields) current[field] = number(snapshot[field])
      const totals = store.conversations[key] ?? { turns: 0, uncached: 0, cached: 0, written: 0, output: 0, lastAt: 0 }
      const delta = (field: typeof fields[number]): number => {
        const next = number(current[field])
        const before = number(previous?.[field])
        return next >= before ? next - before : next
      }
      totals.turns += turns
      totals.uncached += delta('uncachedInputTokens')
      totals.cached += delta('cacheReadTokens')
      totals.written += delta('cacheWriteTokens')
      totals.output += delta('outputTokens')
      totals.lastAt = now()
      totals.lastSessionId = sessionId
      store.conversations[key] = totals
      store.sessions[sessionId] = current
    },

    totalsFor(key: string): ConversationTotals | null {
      return store.conversations[key] ?? null
    },

    /** Every conversation, summed. */
    overall(): { turns: number; uncached: number; cached: number; written: number; output: number; conversations: number } {
      const sum = { turns: 0, uncached: 0, cached: 0, written: 0, output: 0, conversations: 0 }
      for (const totals of Object.values(store.conversations)) {
        sum.turns += totals.turns
        sum.uncached += totals.uncached
        sum.cached += totals.cached
        sum.written += totals.written
        sum.output += totals.output
        sum.conversations++
      }
      return sum
    },

    /**
     * The reply. Cache-read is a share of input, because that is the number worth seeing:
     * it is what a stable prompt prefix buys.
     */
    summary(key: string, say: Messages = messages('en')): string {
      const mine = this.totalsFor(key)
      const all = this.overall()
      const line = (label: string, t: { turns: number; uncached: number; cached: number; output: number }): string => {
        const input = t.uncached + t.cached
        const share = input > 0 ? Math.round((t.cached / input) * 100) : 0
        return say.usageLine(label, t.turns, input.toLocaleString('en-US'), share, t.output.toLocaleString('en-US'))
      }
      const lines = [line(say.usageThis, mine ?? { turns: 0, uncached: 0, cached: 0, output: 0 })]
      if (all.conversations > 1) lines.push(line(say.usageAll(all.conversations), all))
      lines.push(say.usageNoPrice)
      return lines.join('\n')
    },
  }
}
