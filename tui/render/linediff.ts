/**
 * Lines removed and added between two texts, for an edit's card: the longest common subsequence
 * of lines, so a change in the middle of a file shows as that change. Common leading and trailing
 * lines are set aside first. What is left beyond LIMIT cells is not compared at all — the answer is
 * null, and the caller says so; guessing "all removed, all added" would show changes that never
 * happened.
 */
export interface DiffLine { op: ' ' | '-' | '+'; text: string }

const LIMIT = 250_000

export function lineDiff(a: readonly string[], b: readonly string[]): DiffLine[] | null {
  const keep = (text: string): DiffLine => ({ op: ' ', text })
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const x = a.slice(start, endA)
  const y = b.slice(start, endB)
  const out: DiffLine[] = a.slice(0, start).map(keep)
  if (x.length * y.length > LIMIT) return null
  {
    const n = x.length
    const m = y.length
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (x[i] === y[j]) { out.push(keep(x[i])); i++; j++ }
      else if (table[i + 1][j] >= table[i][j + 1]) out.push({ op: '-', text: x[i++] })
      else out.push({ op: '+', text: y[j++] })
    }
    while (i < n) out.push({ op: '-', text: x[i++] })
    while (j < m) out.push({ op: '+', text: y[j++] })
  }
  out.push(...a.slice(endA).map(keep))
  return out
}
