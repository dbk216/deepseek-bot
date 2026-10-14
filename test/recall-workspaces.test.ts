/**
 * Recall per workspace: the home and each tenant get their own index, built from their own sessions.
 *
 * Memory belongs to a workspace (the home, or tenants/<name>), and every platform — Slack, a
 * terminal — is only a way into one. Recall reads the conversation's workspace's index, but the
 * indexer used to write only the home's, so a tenant's conversations kept their notes apart and
 * recalled nothing at all. Now one `index` run writes every workspace's index, each from the
 * sessions whose recorded cwd is that workspace — and nothing crosses between them. Every index
 * lives outside its workspace (recallIndexPath), where the agent cannot read it with its tools.
 *
 * Run: node test/recall-workspaces.test.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { recallIndexPath } from '../dist/recallContext.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const CLI = 'dist/recall/deepbot-recall.js'
const dir = mkdtempSync(join(tmpdir(), 'deepbot-recall-ws-'))
const dshHome = join(dir, 'dsh')
const home = join(dir, 'agent')
const acme = join(home, 'tenants', 'acme')
const globex = join(home, 'tenants', 'globex')
for (const d of [home, acme, globex]) mkdirSync(d, { recursive: true })

function session(id, cwd, userText) {
  const at = join(dshHome, 'sessions', 'bucket', id)
  mkdirSync(at, { recursive: true })
  const events = [
    { type: 'session', id, createdAt: 1, cwd },
    { type: 'user/message', seq: 1, time: 10, data: { content: [{ type: 'text', text: userText }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 11, data: { message: { content: [{ type: 'text', text: `answer in ${id}` }], source: { kind: 'model' } } } },
  ]
  writeFileSync(join(at, 'session.v4.jsonl.zstd'), Buffer.concat(events.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n')))))
}
session('tui-home', home, '홈에서 한 배포 일정 얘기')
session('slack-acme', acme, 'acme 계약 금액은 비밀')
session('tui-globex', globex, 'globex 예산 회의')
session('elsewhere', join(dir, 'unrelated'), '다른 프로젝트 얘기')

const run = (args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, DSH_HOME: dshHome, DEEPBOT_HOME: home } })
// Where the adapter reads a workspace's index: by its resolved path (the harness records that, and
// the indexer resolves the home). The sessions below keep the path as given — tmpdir is a link on
// macOS — so the indexer must also match a directory spelled another way.
const resolvedOr = (p) => { try { return realpathSync(p) } catch { return p } }
const indexOf = (workspace) => recallIndexPath(resolvedOr(workspace), dshHome)
const sessionsIn = (workspace) => {
  const file = indexOf(workspace)
  if (!existsSync(file)) return null
  return [...new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).sessionId))].sort().join(',')
}

// 1. One run, every workspace its own index.
run(['index', '--quiet'])
check('the home index holds only the home\'s sessions', sessionsIn(home) === 'tui-home', String(sessionsIn(home)))
check('a tenant gets its own index, with only its sessions', sessionsIn(acme) === 'slack-acme', String(sessionsIn(acme)))
check('and so does every other tenant', sessionsIn(globex) === 'tui-globex', String(sessionsIn(globex)))
check('a session from an unrelated directory is in none of them', ![home, acme, globex].some((w) => (sessionsIn(w) ?? '').includes('elsewhere')))
check('no index is written inside any workspace, where the agent could read it', [home, acme, globex].every((w) => !existsSync(join(w, 'memory', 'recall-index.jsonl'))))

// 1b. Names that differ only in what an id cannot spell (Korean, a space) are still two workspaces
// with two indexes.
{
  const pairs = [['영업', '개발'], ['team a', 'team-a']]
  for (const [a, b] of pairs) {
    mkdirSync(join(home, 'tenants', a), { recursive: true })
    mkdirSync(join(home, 'tenants', b), { recursive: true })
    session(`s-${a}`, join(home, 'tenants', a), `${a} 대화`)
    session(`s-${b}`, join(home, 'tenants', b), `${b} 대화`)
  }
  run(['index', '--quiet'])
  for (const [a, b] of pairs) {
    const ia = sessionsIn(join(home, 'tenants', a))
    const ib = sessionsIn(join(home, 'tenants', b))
    check(`'${a}' and '${b}' get an index each, with only their own sessions`, ia === `s-${a}` && ib === `s-${b}`, `${ia} / ${ib}`)
  }
  for (const name of ['영업', '개발', 'team a', 'team-a']) rmSync(join(home, 'tenants', name), { recursive: true, force: true })
}

// 2. Searching one workspace cannot find another's words.
const hits = (workspace, query) => run(['search', query, '--index', indexOf(workspace)])
check('acme cannot recall the home\'s conversation', /^0 match/m.test(hits(acme, '배포 일정')), hits(acme, '배포 일정').split('\n')[0])
check('the home cannot recall acme\'s', /^0 match/m.test(hits(home, '계약 금액')), hits(home, '계약 금액').split('\n')[0])
check('acme recalls its own', !/^0 match/m.test(hits(acme, '계약 금액')))

// 2b. A link the agent left among the tenants is not a tenant. Pointed inside the home, where the
// safe writer would allow the write, so only the lstat skip can keep it out.
{
  const inner = join(home, 'inner')
  mkdirSync(inner, { recursive: true })
  symlinkSync(inner, join(home, 'tenants', 'linked'))
  session('linked-1', join(home, 'tenants', 'linked'), 'linked 대화')
  run(['index', '--quiet'])
  check('a tenant that is a link is skipped, even when its target is inside the home', !existsSync(indexOf(join(home, 'tenants', 'linked'))) && !existsSync(indexOf(inner)))
  rmSync(join(home, 'tenants', 'linked'))
}

// 2c. A tenant whose index cannot be written does not stop the others.
{
  const broken = join(home, 'tenants', 'broken')
  mkdirSync(broken, { recursive: true })
  session('broken-1', broken, 'broken 대화')
  // A file where the index's directory should be: that tenant's write fails.
  mkdirSync(dirname(dirname(indexOf(broken))), { recursive: true })
  writeFileSync(dirname(indexOf(broken)), 'not a directory')
  rmSync(indexOf(acme), { force: true })
  let failed = false
  try { run(['index', '--quiet']) } catch { failed = true }
  check('one tenant that cannot be written does not stop the run, and the others are indexed', !failed && sessionsIn(acme) === 'slack-acme' && sessionsIn(globex) === 'tui-globex')
  rmSync(broken, { recursive: true, force: true })
  rmSync(dirname(indexOf(broken)), { force: true })
}

// 3. An explicit target is exactly that: no other workspace is written.
const initech = join(home, 'tenants', 'initech')
mkdirSync(initech, { recursive: true })
session('initech-1', initech, 'initech 일정')
const out = join(dir, 'only-home.jsonl')
run(['index', '--quiet', '--out', out, '--cwd', home])
check('--out/--cwd writes only the named index', existsSync(out) && !existsSync(indexOf(initech)))

rmSync(dir, { recursive: true, force: true })
const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
