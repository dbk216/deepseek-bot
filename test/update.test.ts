/**
 * `dsh update`: what it fetches, which installer it runs, and when it runs none.
 *
 * Real git, against an origin in a scratch directory; the "installer" is a stand-in that records which
 * version it is and what it was told, so nothing is built or installed. The installer's own steps (the
 * checkout moving forward, the record of a finished install) are install.test.ts's.
 *
 * Run: node test/update.test.ts
 */
import './dist-fresh.ts'   // fails loudly on a stale dist

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { update, processIO } = await import('../dist/service/update.js')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'deepbot-update-')))
// Git without the machine's own configuration (a signing key, another default branch).
writeFileSync(join(root, 'gitconfig'), '')
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
})
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
const mark = join(root, 'installed')
/** An installer that says which version it is and what it was given. */
const installer = (version) => `#!/bin/bash\nprintf '%s %s %s\\n' ${version} "$DEEPBOT_DIR" "$DEEPBOT_REF" >> "$MARK"\n`
const commit = (cwd, version) => { writeFileSync(join(cwd, 'install.sh'), installer(version)); git(cwd, 'add', 'install.sh'); git(cwd, 'commit', '-q', '-m', version) }

const origin = join(root, 'origin.git')
const work = join(root, 'work')
git(root, 'init', '-q', '--bare', '-b', 'master', origin)
git(root, 'init', '-q', '-b', 'master', work)
commit(work, 'v1')
git(work, 'push', '-q', origin, 'master')
const full = join(root, 'full')
git(root, 'clone', '-q', origin, full)
const shallow = join(root, 'shallow')
git(root, 'clone', '-q', '--depth', '1', `file://${origin}`, shallow)
// Two commits ahead, so a fetch that is not depth 1 is told apart in the shallow clone's history.
commit(work, 'v2a')
commit(work, 'v2')
git(work, 'push', '-q', origin, 'master')
const tip = git(work, 'rev-parse', 'HEAD')

function attempt(checkout, { home = join(root, 'home'), argv = [], platform = 'darwin' } = {}) {
  const out = [], err = [], installs = [], fetches = []
  rmSync(mark, { force: true })
  const code = update(argv, {
    checkout, home, env: { DSH_HOME: join(home, '.dsh') }, platform,
    run: (cmd, args) => {
      if (args.includes('fetch')) fetches.push(args)
      const r = spawnSync(cmd, args, { encoding: 'utf8' })
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    install: (script, env) => {
      installs.push(env)
      return spawnSync('/bin/bash', [script], { encoding: 'utf8', env: { ...process.env, MARK: mark, ...env } }).status ?? 1
    },
    out: (t) => out.push(t), err: (t) => err.push(t),
  })
  const ran = existsSync(mark) ? readFileSync(mark, 'utf8').trim() : ''
  return { code, out: out.join('\n'), err: err.join('\n'), installs, ran, fetches }
}
const record = (home, sha) => { mkdirSync(join(home, '.dsh', 'service'), { recursive: true }); writeFileSync(join(home, '.dsh', 'service', 'deepbot.commit'), `${sha}\n`) }

// The checkout is the one this build is in.
check('checkout: the build in dist/service finds the checkout two levels up', processIO().checkout === fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''), processIO().checkout)

// Arguments: help, and nothing else.
const help = attempt(full, { argv: ['--help'] })
check('help: --help says what it does, and runs nothing', help.code === 0 && /dsh update/.test(help.out) && help.ran === '' && help.installs.length === 0)
const extra = attempt(full, { argv: ['now'] })
check('arguments: anything else is refused, and nothing runs', extra.code === 2 && /no arguments/.test(extra.err) && extra.ran === '')

// Behind origin: the fetched commit's installer runs, told this checkout and its branch.
{
  const before = git(full, 'rev-parse', 'HEAD')
  const r = attempt(full)
  check('behind: the installer that runs is the fetched commit\'s, not the checkout\'s', r.code === 0 && r.ran === `v2 ${full} master`, JSON.stringify(r.ran))
  check('behind: it says from which commit to which', r.out.includes(`from ${before.slice(0, 7)} to ${tip.slice(0, 7)}`), r.out)
  check('behind: the checkout itself is moved by the installer, not here', git(full, 'rev-parse', 'HEAD') === before)
  // A shallow full clone would take the installer's shallow path, whose checkout -B resets local commits away.
  check('behind: a full clone is fetched as one, and stays full', git(full, 'rev-parse', '--is-shallow-repository') === 'false' && !r.fetches.flat().includes('--depth'), JSON.stringify(r.fetches))
}

// Up to date only when the checkout is at the tip and the last finished install was that commit.
{
  const home = join(root, 'home-current')
  git(full, 'merge', '-q', '--ff-only', 'FETCH_HEAD')
  const noRecord = attempt(full, { home })
  check('unrecorded: at the tip with no finished install recorded (an install older than the record), the installer runs', noRecord.code === 0 && noRecord.ran === `v2 ${full} master` && /no finished install of it is recorded/.test(noRecord.out), noRecord.out)
  record(home, 'f'.repeat(40))
  const oldRecord = attempt(full, { home })
  check('unfinished: a record of another commit is not this one finished, and is said so', oldRecord.ran === `v2 ${full} master` && /did not finish/.test(oldRecord.out), oldRecord.out)
  record(home, tip)
  const current = attempt(full, { home })
  check('current: at the tip and finished there, nothing runs', current.code === 0 && current.ran === '' && current.installs.length === 0 && /already up to date/.test(current.out), current.out)

  // A working copy ahead of origin is installed as it is: finished there, it is current.
  commit(full, 'v3-local')
  const ahead = attempt(full, { home })
  check('ahead: commits not yet on origin run their own installer', ahead.ran === `v3-local ${full} master`, ahead.ran)
  record(home, git(full, 'rev-parse', 'HEAD'))
  check('ahead: and once finished there, it is current', attempt(full, { home }).ran === '')
  git(full, 'reset', '-q', '--hard', tip)
}

// A shallow checkout (the installer's own) stays shallow.
{
  const r = attempt(shallow)
  check('shallow: the fetched installer runs', r.code === 0 && r.ran === `v2 ${shallow} master`, r.ran)
  check('shallow: it is still shallow, fetched at depth 1 (the tip only, not the two commits since)', git(shallow, 'rev-parse', '--is-shallow-repository') === 'true' && git(shallow, 'rev-list', '--count', 'FETCH_HEAD') === '1', git(shallow, 'rev-list', '--count', 'FETCH_HEAD'))
}

// A linked worktree (its .git is a file) is a checkout: the installer takes it as one too.
{
  const linked = join(root, 'linked')
  git(full, 'worktree', 'add', '-q', '-b', 'linked', linked, 'master')
  git(work, 'push', '-q', origin, 'master:linked')
  const r = attempt(linked)
  check('worktree: a linked worktree is updated like any checkout', r.code === 0 && r.ran === `v2 ${linked} linked`, `${r.ran} ${r.err}`)
  git(full, 'worktree', 'remove', '--force', linked)
}

// Refusals: nothing runs.
{
  const plain = join(root, 'plain')
  mkdirSync(plain)
  const notGit = attempt(plain)
  check('refused: a directory that is not a git checkout', notGit.code === 1 && /not a git checkout/.test(notGit.err) && notGit.ran === '', notGit.err)
  git(full, 'checkout', '-q', '--detach')
  const detached = attempt(full)
  check('refused: a checkout on no branch', detached.code === 1 && /not on a branch/.test(detached.err) && detached.ran === '', detached.err)
  git(full, 'checkout', '-q', 'master')
  git(full, 'remote', 'set-url', 'origin', join(root, 'gone.git'))
  const offline = attempt(full)
  check('refused: a fetch that fails is said', offline.code === 1 && /could not fetch master/.test(offline.err) && offline.ran === '', offline.err)
  git(full, 'remote', 'set-url', 'origin', origin)
}

// Before this command, `dsh update` booted a harness profile named update: whoever has one is not given a
// rebuild and a restart instead, and is told how to boot it.
{
  const home = join(root, 'home-profile')
  mkdirSync(join(home, '.dsh', 'profiles', 'update'), { recursive: true })
  const r = attempt(full, { home })
  check('profile: with a harness profile named update, nothing is fetched or run, and dsh --profile update is said', r.code === 1 && r.ran === '' && r.fetches.length === 0 && /dsh --profile update/.test(r.err), r.err)
}

// The installer is macOS-only: elsewhere nothing is fetched first.
{
  const r = attempt(full, { platform: 'linux' })
  check('platform: off macOS it says so, before fetching anything', r.code === 1 && r.fetches.length === 0 && r.ran === '' && /macOS-only/.test(r.err), r.err)
}

rmSync(root, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
