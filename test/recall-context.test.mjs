/**
 * The block injected when a message points at the past.
 *
 * The claim is that passages come back ranked and that the block asks for the *implication* rather
 * than handing over material — the user's objection to recall as a dump. Ranking is lexical: the
 * test does not claim synonyms, and one check asserts the block is honest about that.
 *
 * Run: node test/recall-context.test.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecallContext, recallIndexPath } from '../dist/recallContext.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'deepbot-recallctx-'))
const indexPath = join(dir, 'recall-index.jsonl')
const rows = [
  { ts: 1_700_000_000, role: 'user', sessionId: 'a', text: '배포 롤백 화요일' },
  { ts: 1_700_100_000, role: 'assistant', sessionId: 'a', text: '배포 롤백 수요일' },
  { ts: 1_700_200_000, role: 'user', sessionId: 'b', text: '점심은 김치찌개' },
]
writeFileSync(indexPath, [...rows.map((r) => JSON.stringify(r)), '{ not json'].join('\n'))
const ctx = createRecallContext({ indexPath })

// 1. Only when the message points at the past.
check('a message about the past triggers it', ctx.triggered('지난주에 배포 어떻게 하기로 했지?') === true)
check('an ordinary message does not', ctx.triggered('이거 요약해줘') === false)
check('an untriggered block is empty', ctx.block('이거 요약해줘') === '')

// 2. Ranked by shared words, and the irrelevant row is absent.
{
  const block = ctx.block('지난주에 배포 롤백 어떻게 하기로 했지?')
  check('the block is produced', block !== '', block.slice(0, 60))
  check('both relevant passages are shown', (block.match(/^- /gm) ?? []).length === 2, String((block.match(/^- /gm) ?? []).length))
  check('the irrelevant passage is not', !block.includes('김치찌개'))
  check('the newest of the equally-scored passages leads', block.indexOf('수요일') < block.indexOf('화요일'),
    block.split('\n').filter((l) => l.startsWith('- ')).join(' | ').slice(0, 90))
}

// 3. It asks for a step, and it is honest about being lexical.
{
  const block = ctx.block('지난주에 배포 어떻게 하기로 했지?')
  check('the block asks for the next step', /decide the next step/i.test(block) && /Do not summarise/i.test(block), block.split('\n').slice(-1)[0]?.slice(0, 80))
  check('and says it is lexical, not semantic', /not a semantic search/i.test(block))
  check('an unreadable index line does not lose the rest', block.includes('배포'))
}

// 4. A missing index, and a broken file, both cost nothing.
{
  const missing = createRecallContext({ indexPath: join(dir, 'nope.jsonl') })
  check('a missing index yields no block', missing.block('지난주 배포') === '')
  writeFileSync(join(dir, 'broken.jsonl'), '\u0000not json at all')
  const broken = createRecallContext({ indexPath: join(dir, 'broken.jsonl') })
  check('an unparseable index yields no block, not a throw', broken.block('지난주 배포') === '')
}

// 5. Only the conversation's own channel. Ranking used every row of the shared home, so a word in
// common was enough to put a DM into a public channel's answer. A row with no channel is left out
// when the turn has one; a turn with none (a scenario) still sees everything.
{
  const scoped = join(dir, 'scoped.jsonl')
  writeFileSync(scoped, [
    { ts: 1, role: 'user', sessionId: 'p', channel: 'C_PUBLIC', text: '지난번 배포 롤백 public-7a1' },
    { ts: 2, role: 'user', sessionId: 'd', channel: 'D_PRIVATE', text: '지난번 배포 롤백 private-3f9' },
    { ts: 3, role: 'user', sessionId: 'u', text: '지난번 배포 롤백 unknown-5c2' },
  ].map((r) => JSON.stringify(r)).join('\n'))
  const inPublic = createRecallContext({ indexPath: scoped, channel: 'C_PUBLIC' }).block('지난번 배포 롤백 어떻게 했지')
  check('a passage from this channel is shown', inPublic.includes('public-7a1'), inPublic.slice(0, 60))
  check('a passage from a DM is not', !inPublic.includes('private-3f9'))
  check('nor one whose channel is unknown', !inPublic.includes('unknown-5c2'))
  const inDm = createRecallContext({ indexPath: scoped, channel: 'D_PRIVATE' }).block('지난번 배포 롤백 어떻게 했지')
  check('the DM sees its own and not the channel\'s', inDm.includes('private-3f9') && !inDm.includes('public-7a1'))
  // A row the indexer could not place, from a session the adapter still maps to a conversation:
  // the mapping supplies the channel.
  const mapped = createRecallContext({ indexPath: scoped, channel: 'C_PUBLIC', sessionChannel: (id) => (id === 'u' ? 'C_PUBLIC' : null) })
    .block('지난번 배포 롤백 어떻게 했지')
  check('a mapped session supplies a missing channel', mapped.includes('unknown-5c2') && !mapped.includes('private-3f9'))
  // The adapter's mapping outranks the channel a row carries: the row's comes from text the agent can
  // influence (a forged block in a standing file), the mapping from the adapter alone. A DM session
  // whose rows claim the public channel stays out of it.
  const forged = createRecallContext({ indexPath: scoped, channel: 'D_PRIVATE', sessionChannel: (id) => (id === 'p' ? 'D_PRIVATE' : id === 'd' ? 'D_OTHER' : null) })
    .block('지난번 배포 롤백 어떻게 했지')
  check('the mapping outranks the channel a row claims', forged.includes('public-7a1') && !forged.includes('private-3f9'), forged.slice(0, 80))
  const anywhere = createRecallContext({ indexPath: scoped }).block('지난번 배포 롤백 어떻게 했지')
  check('without a channel nothing is filtered', ['public-7a1', 'private-3f9', 'unknown-5c2'].every((m) => anywhere.includes(m)))
}

// 6. Ranking that knows which words matter, and recall without a trigger word when the match is strong.
// It used to need a word like "지난번", so "did anyone say 테스트-1234?" found nothing; and every shared
// word counted the same, so two common words outranked one rare one.
{
  const ranked = join(dir, 'ranked.jsonl')
  const filler = Array.from({ length: 40 }, (_, i) => ({ ts: i + 1, role: 'user', sessionId: `f${i}`, text: `오늘 배포 회의 ${i}번째 메모` }))
  writeFileSync(ranked, [
    ...filler,
    { ts: 100, role: 'user', sessionId: 'rare', text: '테스트-1234 라고 적어둔 거 확인용' },
    { ts: 101, role: 'user', sessionId: 'common', text: '오늘 배포 회의는 짧게' },
    { ts: 102, role: 'user', sessionId: 'rollback', text: '롤백 창은 15분으로 정했어' },
    { ts: 103, role: 'user', sessionId: 'current', text: '테스트-1234 다시 말해볼게' },
  ].map((r) => JSON.stringify(r)).join('\n'))
  const ctx2 = createRecallContext({ indexPath: ranked, sessionId: 'current' })
  const strong = ctx2.block('누군가 테스트-1234 라고 말한 적 있어?')
  check('a strong match is recalled without a trigger word', strong.includes('테스트-1234 라고 적어둔'), strong.slice(0, 80) || '(empty)')
  check('the conversation being answered is not recalled to itself', !strong.includes('다시 말해볼게'))
  check('common words alone do not interrupt an ordinary message', ctx2.block('오늘 배포 회의 어떻게 돼?') === '')
  const weighted = ctx2.block('지난번에 오늘 배포 회의랑 테스트-1234 얘기')
  check('a rare word outranks common ones', weighted.indexOf('테스트-1234 라고') >= 0
    && (weighted.indexOf('오늘 배포 회의는') < 0 || weighted.indexOf('테스트-1234 라고') < weighted.indexOf('오늘 배포 회의는')), weighted.split('\n').slice(3, 5).join(' | '))
  check('a particle on the question does not hide the passage', ctx2.block('지난번 롤백을 어떻게 했지').includes('롤백 창은'))
}

// 7. The index lives outside the agent's home, where its tools and commands cannot read it.
{
  const path = recallIndexPath('/Users/someone/dsh-agent', '/Users/someone/.dsh')
  check('the index path is under the harness home, not the agent home', path.startsWith('/Users/someone/.dsh/recall/') && !path.startsWith('/Users/someone/dsh-agent'), path)
  check('and two homes get two indexes', recallIndexPath('/a/home-1', '/d') !== recallIndexPath('/a/home-2', '/d'))
  // Even homes whose names read alike once flattened: /a/b-c and /a/b/c both became "a-b-c", and so did
  // "dsh agent" and "dsh-agent" — one index for two homes, each recalling the other's conversations.
  check('homes that flatten alike still get two indexes', recallIndexPath('/a/b-c', '/d') !== recallIndexPath('/a/b/c', '/d')
    && recallIndexPath('/h/dsh agent', '/d') !== recallIndexPath('/h/dsh-agent', '/d'), recallIndexPath('/a/b-c', '/d'))
  check('and the same home always gets the same one', recallIndexPath('/a/b-c', '/d') === recallIndexPath('/a/b-c/', '/d'))
}

rmSync(dir, { recursive: true, force: true })
const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
