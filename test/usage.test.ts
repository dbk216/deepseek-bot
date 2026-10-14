/**
 * Token accounting, with no agent and no platform.
 *
 * The projection reports cumulative totals for a session, so the interesting rules are all
 * about deltas: only growth is added, a session that resets does not subtract, and a restart
 * does not lose the running total. The summary's honesty rule is tested too — it must say
 * tokens and say why it cannot say money.
 *
 * Run: node test/usage.test.ts
 */
import { createUsageTracker, emptyUsageStore } from '../dist/usage.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function tracker() {
  const store = emptyUsageStore()
  let clock = 1000
  const t = createUsageTracker({ store, now: () => (clock += 1) })
  return { t, store }
}

// 1. Cumulative snapshots become deltas.
{
  const { t } = tracker()
  t.record('C1:t1', 's1', { uncachedInputTokens: 1000, cacheReadTokens: 0, outputTokens: 50 })
  t.record('C1:t1', 's1', { uncachedInputTokens: 1200, cacheReadTokens: 3000, outputTokens: 80 })
  const totals = t.totalsFor('C1:t1')
  check('two turns are counted', totals?.turns === 2, String(totals?.turns))
  check('uncached adds only the growth', totals?.uncached === 1200, String(totals?.uncached))
  check('cache reads are counted', totals?.cached === 3000, String(totals?.cached))
  check('output adds only the growth', totals?.output === 80, String(totals?.output))
}

// 2. A session that resets does not subtract.
{
  const { t } = tracker()
  t.record('k', 's1', { uncachedInputTokens: 5000, outputTokens: 200 })
  t.record('k', 's1', { uncachedInputTokens: 400, outputTokens: 20 })
  const totals = t.totalsFor('k')
  check('a smaller total is treated as a new baseline', totals?.uncached === 5400, String(totals?.uncached))
  check('and never goes negative', (totals?.output ?? -1) >= 0, String(totals?.output))
}

// 3. Conversations are separate, and the total sums them.
{
  const { t } = tracker()
  t.record('a', 's1', { uncachedInputTokens: 100, cacheReadTokens: 100, outputTokens: 10 })
  t.record('b', 's2', { uncachedInputTokens: 200, cacheReadTokens: 0, outputTokens: 20 })
  check('one conversation holds only its own turns', t.totalsFor('a')?.uncached === 100)
  const all = t.overall()
  check('the overall total sums conversations', all.conversations === 2 && all.uncached === 300 && all.output === 30, JSON.stringify(all))
}

// 4. Restarting keeps the totals: the store is the state file.
{
  const { t, store } = tracker()
  t.record('a', 's1', { uncachedInputTokens: 1000, outputTokens: 10 })
  const revived = createUsageTracker({ store })       // as if the process restarted
  check('totals survive a restart', revived.totalsFor('a')?.uncached === 1000)
  revived.record('a', 's1', { uncachedInputTokens: 1500, outputTokens: 25 })
  check('and the next turn adds only its growth', revived.totalsFor('a')?.uncached === 1500, String(revived.totalsFor('a')?.uncached))
  check('even though the snapshot is cumulative', revived.totalsFor('a')?.output === 25, String(revived.totalsFor('a')?.output))
}

// 5. The summary reports tokens, the cache share, and refuses to invent money.
{
  const { t } = tracker()
  t.record('a', 's1', { uncachedInputTokens: 3000, cacheReadTokens: 7000, outputTokens: 500 })
  const text = t.summary('a')
  check('the summary names the conversation', /이 대화: 1턴/.test(text), text.split('\n')[0])
  check('it reports input and the cache share', /입력 10,000 \(캐시 70%\)/.test(text), text.split('\n')[0])
  check('it reports output', /출력 500/.test(text), text.split('\n')[0])
  check('it says why there is no price', /단가|금액/.test(text) && /토큰만/.test(text), text.split('\n').slice(-1)[0])
  check('a single conversation is not double-reported', !/전체/.test(text))
}

// 6. With several conversations the summary adds the overall line.
{
  const { t } = tracker()
  t.record('a', 's1', { uncachedInputTokens: 100, outputTokens: 1 })
  t.record('b', 's2', { uncachedInputTokens: 200, outputTokens: 2 })
  const text = t.summary('a')
  check('the overall line appears with a conversation count', /전체 \(2개 대화\)/.test(text), text.split('\n')[1])
}

// 7. A conversation with no turns says zero rather than failing.
{
  const { t } = tracker()
  const text = t.summary('never-used')
  check('an unused conversation reports zero', /0턴/.test(text), text.split('\n')[0])
}

// 8. A missing or empty snapshot records nothing.
{
  const { t } = tracker()
  t.record('a', 's1', null)
  t.record('a', 's1', undefined)
  check('a snapshot that never arrived adds no turn', t.totalsFor('a') === null)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
