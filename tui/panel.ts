/**
 * The agent panel's rows: main, the turn's subagents, its background jobs.
 *
 * Pure, so the rules are tested without a screen: running agents first, idle ones folded into one
 * row past three, jobs after agents, and a window of at most `max` rows that keeps the selected
 * row in sight with "↓ N more" for the rest.
 */
import { t } from './strings.js'
import type { AgentItem, JobItem } from './bridge.js'

export type PanelRow =
  | { kind: 'main' }
  | { kind: 'agent'; agent: AgentItem }
  | { kind: 'idle'; count: number }
  | { kind: 'job'; job: JobItem }
  | { kind: 'more'; count: number }

const FOLD_IDLE_AFTER = 3

export function panelRows(agents: AgentItem[], jobs: JobItem[], showIdle: boolean): PanelRow[] {
  if (agents.length === 0 && jobs.length === 0) return []
  const running = agents.filter((a) => a.status === 'running')
  const rest = agents.filter((a) => a.status !== 'running')
  const rows: PanelRow[] = [{ kind: 'main' }, ...running.map((agent) => ({ kind: 'agent' as const, agent }))]
  if (rest.length > FOLD_IDLE_AFTER && !showIdle) rows.push({ kind: 'idle', count: rest.length })
  else rows.push(...rest.map((agent) => ({ kind: 'agent' as const, agent })))
  const live = (j: JobItem) => j.status === 'running' || j.status === 'stopping'
  rows.push(...[...jobs].sort((a, b) => Number(live(b)) - Number(live(a))).map((job) => ({ kind: 'job' as const, job })))
  return rows
}

/** At most `max` rows around `selected`; the last one says how many were left out. */
export function panelWindow(rows: PanelRow[], selected: number, max: number): { rows: PanelRow[]; first: number } {
  if (rows.length <= max) return { rows, first: 0 }
  const visible = max - 1
  const first = Math.max(0, Math.min(selected - visible + 1, rows.length - visible))
  const shown = rows.slice(first, first + visible)
  return { rows: [...shown, { kind: 'more', count: rows.length - first - visible }], first }
}

export function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`
}

/** The right-hand side of a row: what it is doing and what it has cost. */
export function rowStatus(row: PanelRow, now: number): string {
  if (row.kind === 'agent') {
    const a = row.agent
    const tokens = a.tokens > 0 ? ` · ${t().panelTokens(formatTokens(a.tokens))}` : ''
    if (a.status === 'running') return `${formatElapsed(a.settledMs + (a.since !== null ? now - a.since : 0))}${tokens}`
    return `${a.status}${tokens}`
  }
  if (row.kind === 'job') return row.job.status === 'running' && row.job.startedAt > 0 ? t().jobRunning(formatElapsed(now - row.job.startedAt)) : row.job.status
  return ''
}

/** Counts for the status line. */
export function panelCounts(agents: AgentItem[], jobs: JobItem[]): { shells: number; agents: number } {
  return {
    shells: jobs.filter((j) => j.status === 'running' || j.status === 'stopping').length,
    agents: agents.length,
  }
}
