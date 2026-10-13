/**
 * What was typed, kept between runs: one JSON line per entry under the harness home, readable by
 * the owner only (it holds what the person asked). The last HISTORY_KEEP are read back; the file is
 * cut back to them once it holds twice as many, so it never grows without bound.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const HISTORY_KEEP = 500
/** One entry is kept up to this much: a pasted file is not something to search for later. */
const MAX_ENTRY_CHARS = 20_000

export function historyFile(env: Record<string, string | undefined> = process.env): string {
  const home = env.DSH_HOME?.trim()
  return join(home ? home : join(homedir(), '.dsh'), 'deepbot-tui', 'history.jsonl')
}

function read(file: string): string[] {
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch { return [] }
  const out: string[] = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    try { const entry = JSON.parse(line); if (typeof entry?.text === 'string' && entry.text !== '') out.push(entry.text) } catch { /* a torn line */ }
  }
  return out
}

export function loadHistory(file: string): string[] {
  return read(file).slice(-HISTORY_KEEP)
}

export function appendHistory(file: string, text: string): void {
  if (text.trim() === '') return
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    appendFileSync(file, `${JSON.stringify({ text: text.slice(0, MAX_ENTRY_CHARS) })}\n`, { mode: 0o600 })
    // The mode above applies only to a file being created: one that was there is made the owner's.
    chmodSync(file, 0o600)
    const entries = read(file)
    if (entries.length >= HISTORY_KEEP * 2) {
      // Written beside it and moved into place, so another terminal never reads a half-written file.
      const next = `${file}.${process.pid}.tmp`
      writeFileSync(next, entries.slice(-HISTORY_KEEP).map((t) => `${JSON.stringify({ text: t })}\n`).join(''), { mode: 0o600 })
      renameSync(next, file)
    }
  } catch { /* history is a convenience: never fail a message over it */ }
}
