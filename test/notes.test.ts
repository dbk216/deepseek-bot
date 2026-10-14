/**
 * Note hygiene: when to ask for a tidy-up.
 *
 * The claim is narrow on purpose — it counts characters and repeated lines, and asks the model to do
 * the merging, because rewriting notes needs intent. A test that claimed it can summarise would be
 * describing something this code does not do.
 *
 * Run: node test/notes.test.ts
 */
import { analyzeNotes } from '../dist/notes.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// 1. A small, distinct file says nothing.
{
  const r = analyzeNotes('2026-10-08: 봇 런타임을 DSH로 옮겼다\n2026-10-12: 배포 롤백은 화요일')
  check('a small file needs no advice', r.advice === null, JSON.stringify(r.advice))
  check('and its size is reported', r.chars > 0 && r.lines === 2, `${r.chars}자 ${r.lines}줄`)
  check('with no duplicates', r.duplicates.length === 0)
}

// 2. Past the budget it asks, and says what it counted.
{
  const big = Array.from({ length: 60 }, (_, i) => `2026-10-${String((i % 28) + 1).padStart(2, '0')}: 항목 ${i} — ${'x'.repeat(120)}`).join('\n')
  const r = analyzeNotes(big, { budgetChars: 3000 })
  check('an over-budget file asks for a tidy-up', r.advice !== null, String(r.advice).slice(0, 60))
  check('the advice says how big it is and what the budget is', /characters, past the 3000 budget/.test(String(r.advice)), String(r.advice).split('\n')[0])
  check('and it asks for specific work', /Merge the repeated entries/.test(String(r.advice)))
  check('the size is not a guess', r.chars === big.trim().length, `${r.chars}`)
}

// 3. Repeats are noticed even when the file is small.
{
  const r = analyzeNotes('배포는 화요일\n점심은 김치찌개\n배포는  화요일')
  check('a repeated line is found', r.duplicates.length === 1, JSON.stringify(r.duplicates))
  check('whitespace differences do not hide a repeat', r.duplicates[0] === '배포는 화요일', JSON.stringify(r.duplicates))
  check('and it asks for a tidy-up even under budget', r.advice !== null && r.overBudget === false)
  check('naming the repeated line', /"배포는 화요일"/.test(String(r.advice)), String(r.advice).split('\n').slice(-1)[0])
}

// 4. Missing or blank notes are not a problem to report.
{
  check('a missing file says nothing', analyzeNotes(null).advice === null)
  check('an empty file says nothing', analyzeNotes('   \n\n').advice === null)
  check('and reports zero', analyzeNotes('').chars === 0 && analyzeNotes('').lines === 0)
}

const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
