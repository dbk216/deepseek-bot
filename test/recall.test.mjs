/**
 * Recall candidate selection, pinned.
 *
 * `search` used to be one substring filter and a slice from the front — index order, which is
 * time order — so a passage that shared the query's words sat wherever it had been written and
 * an exact phrase was the only way to find anything. It ranks by shared words now.
 *
 * The synthetic index puts the exact-substring row **last**, so a test that passed on index order
 * cannot pass here. The claim is lexical: shared words rank higher. It does not claim synonyms —
 * the code cannot find them and the README says so.
 *
 * Run: node test/recall.test.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const CLI = 'dist/recall/deepbot-recall.js'   // the ported build; assertions below are unchanged
const dir = mkdtempSync(join(tmpdir(), 'deepbot-recall-'))
const index = join(dir, 'index.jsonl')
// The older row shares all three query words; the newest shares two. Score has to beat position
// for the older one to lead — which is the claim. A fixture where the leader is also the newest
// would pass on recency alone and prove nothing.
const rows = [
  { ts: 1_000, role: 'user', sessionId: 'old', text: '배포 일정 롤백 셋 다 정리했어' },          // 3 of 3
  { ts: 2_000, role: 'assistant', sessionId: 'mid', text: '배포 관련해서 확인할 것' },            // 1 of 3
  { ts: 3_000, role: 'user', sessionId: 'new', text: '배포' },                                    // 1 of 3, newer
  { ts: 4_000, role: 'user', sessionId: 'other', text: '회의는 취소됐어' },                       // 0
  { ts: 9_000, role: 'user', sessionId: 'exact', text: '배포 일정' },                             // 2 of 3, newest
]
writeFileSync(index, rows.map((r) => JSON.stringify(r)).join('\n'))

function search(query) {
  const out = execFileSync(process.execPath, [CLI, 'search', query, '--index', index], { encoding: 'utf8' })
  const count = Number((out.match(/^(\d+) match/gm) ?? ['0'])[0].split(' ')[0])
  const order = [...out.matchAll(/^\s+\[[^\]]+\]\s+\w+\s+\(([^)]+)\)/gm)].map((m) => m[1])
  return { out, count, order }
}

// 1. Ranking, not index order: the exact match is written last and must not lead.
{
  const r = search('배포 일정 롤백')
  check('the passage sharing the most words ranks first', r.order[0] === 'old', r.order.join(' → '))
  check('even though a newer one shares fewer', r.order[0] !== 'exact', `first: ${r.order[0]} (exact is the newest)`)
  check('every passage sharing a word is returned', r.order.length === 4, `${r.order.length}: ${r.order.join(', ')}`)
  check('a passage sharing nothing is excluded', !r.order.includes('other'))
}

// 2. Ties break by recency, so the newer of two equally relevant passages comes first.
{
  const r = search('배포 일정 롤백')
  const tied = r.order.filter((s) => s === 'mid' || s === 'new')
  check('ties are ordered newest first', tied.join(' → ') === 'new → mid', tied.join(' → '))
}

// 3. A single word still works, and reports its own count.
{
  const r = search('배포')
  check('a single word finds every passage containing it', r.order.length === 4, `${r.count} match(es), ${r.order.join(', ')}`)
  check('and nothing that lacks it', !r.order.includes('other'))
}

rmSync(dir, { recursive: true, force: true })
const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
