/**
 * The workspace's files, for @ completion. The terminal runs on the gateway's machine (the socket
 * is local), so it reads the workspace directory itself — names only, never contents.
 *
 * Bounded: a few levels deep, a few thousand entries and a time budget, without dependency, build
 * and VCS folders, and not through links; the listing is kept for a few seconds so typing stays
 * fast. It is synchronous, which the budget is there to make tolerable.
 */
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.omc', '.cache', '__pycache__', '.venv', '.next', '.dsh'])
const MAX_ENTRIES = 5000
const MAX_DEPTH = 6
/** A directory with more entries than this is listed in part, so one folder cannot fill the listing. */
const MAX_PER_DIRECTORY = 2000
const TTL_MS = 10_000
/** The scan runs on a keystroke: past this it returns what it has, breadth first, so the top levels are there. */
const BUDGET_MS = 150

function scan(root: string, now: () => number): string[] {
  const out: string[] = []
  const started = now()
  const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: '', depth: 0 }]
  while (queue.length > 0 && out.length < MAX_ENTRIES) {
    const { dir, rel, depth } = queue.shift()!
    if (depth > 0 && now() - started > BUDGET_MS) break
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    // Sorted before the cut, so which part of a huge directory is listed does not depend on the disk's order.
    entries.sort((a, b) => a.name.localeCompare(b.name))
    if (entries.length > MAX_PER_DIRECTORY) entries.length = MAX_PER_DIRECTORY
    for (const entry of entries) {
      if (out.length >= MAX_ENTRIES) break
      if (entry.isSymbolicLink()) continue
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue
        out.push(`${path}/`)
        if (depth + 1 < MAX_DEPTH) queue.push({ dir: join(dir, entry.name), rel: path, depth: depth + 1 })
      } else if (entry.isFile()) out.push(path)
    }
  }
  return out
}

/** A finder that lists `root`'s files matching a query, best first: a name that starts with it, then shorter paths. */
export function fileFinder(now: () => number = () => Date.now()): (root: string, query: string, limit?: number) => string[] {
  let cache: { root: string; at: number; paths: string[] } | null = null
  return (root, query, limit = 8) => {
    if (root === '') return []
    if (cache === null || cache.root !== root || now() - cache.at > TTL_MS) cache = { root, at: now(), paths: scan(root, now) }
    const q = query.toLowerCase()
    const rank = (path: string) => {
      const name = basename(path).toLowerCase()
      return name.startsWith(q) ? 0 : path.toLowerCase().startsWith(q) ? 1 : 2
    }
    return cache.paths
      .filter((path) => path.toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))
      .slice(0, limit)
  }
}
