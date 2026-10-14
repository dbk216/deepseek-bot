/**
 * The sandbox runner's profile generator.
 *
 * This is the security-critical part of read confinement, and it is testable without
 * running anything under it: the runner can print the profile it would apply, given
 * the policy arguments the harness passes. Checking the text is how the two ways this
 * can go wrong stay caught — allowing writes outside the workspace, or letting an
 * agent read another instance's data.
 *
 * Run: node test/confined-runner.test.ts
 */
import { execFileSync } from 'node:child_process'

// The runner this checks is macOS-specific: it implements the bwrap-shaped policy with
// Seatbelt, and there is nothing to assert on Linux. Say so and stop, rather than failing CI
// for a platform the deployment does not run on — it was the last red step on every push.
if (process.platform !== 'darwin') {
  console.log('  skipped: the confined runner is macOS-specific (Seatbelt); a Linux host would use a container profile')
  process.exit(0)
}
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const RUNNER = fileURLToPath(new URL('../service/confined-runner.sh', import.meta.url))
const HOME = process.env.HOME ?? ''

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** The policy arguments dsh-sandbox-local appends, as measured from its confine(). */
function profile(args) {
  return execFileSync(RUNNER, ['--print-profile', ...args], { encoding: 'utf8' })
}
const READ_ONLY = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
const WORKSPACE_WRITE = [...READ_ONLY, '--tmpfs', '/tmp', '--bind', `${HOME}/dsh-agent`, `${HOME}/dsh-agent`]

const ws = profile([...WORKSPACE_WRITE, '--', 'true'])
const ro = profile([...READ_ONLY, '--', 'true'])

check('the profile is a valid Seatbelt version line', ws.startsWith('(version 1)'))
check('writes are denied by default', /\(deny file-write\*\)/.test(ws))
check('workspace-write allows the workspace root', ws.includes(`(allow file-write* (subpath "${HOME}/dsh-agent"))`))
check('workspace-write allows temp', /\(allow file-write\* \(subpath "\/tmp"\)/.test(ws))
check('read-only does not allow the workspace', !/allow file-write\* \(subpath/.test(ro.split('read confinement')[0]), 'no write grant before the read rules')
check('read-only still allows the null sink', /\(allow file-write\* \(literal "\/dev\/null"\)/.test(ro))
check('other agent homes are denied reads', /\(deny file-read\* \(subpath "[^"]*dsh-agent-test[^"]*"\)\)/.test(ws) || /deny file-read\*/.test(ws), ws.split('\n').filter((l) => l.includes('file-read')).join(' | '))
check("the instance's own root is not denied a read", !/\(deny file-read\* \(subpath "\$\{?HOME/.test(ws) && !ws.includes(`(deny file-read* (subpath "${HOME}/dsh-agent"))`))
{
  // A deployment's own extra paths — a retired bot's data on the machine this was written on.
  const extraDir = mkdtempSync(join(tmpdir(), 'retired-bot-'))
  const withExtra = execFileSync(RUNNER, ['--print-profile', ...WORKSPACE_WRITE, '--', 'true'], { encoding: 'utf8', env: { ...process.env, DEEPBOT_DENY_READ: `/nonexistent:${extraDir}` } })
  check('DEEPBOT_DENY_READ adds its paths to the denied reads', withExtra.includes(`(deny file-read* (subpath "${extraDir}"))`) && !withExtra.includes('/nonexistent'))
  rmSync(extraDir, { recursive: true, force: true })
}
check('a missing separator is refused rather than guessed', (() => {
  try { execFileSync(RUNNER, READ_ONLY, { encoding: 'utf8', stdio: 'pipe' }); return false }
  catch (e) { return e.status === 64 }
})(), 'exit 64')

// The deployment's credentials. Nothing a command does needs them, and a command's output reaches
// Slack — as a reply, or as a watch alert — where nothing redacts a token (the log does, the reply
// does not). Checked by behaviour, not only by profile text: a fake home with a fake .env, and a
// `cat` inside the runner that must fail without printing it.
//
// Twice: under the temp directory as named (a symlink, /var → /private/var) and resolved. The first
// version passed only the symlinked case — on a resolved path, as live, a shell `[ … ] && printf`
// made the profile fail and the runner refused every command. "Readable" below is what catches that.
for (const resolved of [false, true]) {
  const made = mkdtempSync(join(tmpdir(), 'runner-home-'))
  const fakeHome = resolved ? realpathSync(made) : made
  mkdirSync(join(fakeHome, '.dsh'), { recursive: true })
  writeFileSync(join(fakeHome, '.dsh', '.env'), 'SLACK_BOT_TOKEN=canary-env-5d1\n')
  writeFileSync(join(fakeHome, '.dsh', '.credentials.yaml'), 'refs: { x: canary-cred-9b7 }\n')
  writeFileSync(join(fakeHome, '.dsh', '.credentials.yaml.bak-20261008'), 'canary-bak-3c4\n')
  writeFileSync(join(fakeHome, 'outside.txt'), 'readable-2e8\n')
  // The gateway's own log: its first lines carry the web UI's auth token, which opens the harness's
  // HTTP API — outside this sandbox — to whoever reads it.
  mkdirSync(join(fakeHome, '.dsh', 'service', 'logs'), { recursive: true })
  // Every profile's session logs, the agent's own and everybody else's.
  mkdirSync(join(fakeHome, '.dsh', 'sessions', 'bucket', 's1'), { recursive: true })
  // The recall index: every channel's history, handed out by the adapter one channel at a time.
  mkdirSync(join(fakeHome, '.dsh', 'recall', 'home'), { recursive: true })
  writeFileSync(join(fakeHome, '.dsh', 'recall', 'home', 'recall-index.jsonl'), 'canary-recall-77b\n')
  writeFileSync(join(fakeHome, '.dsh', 'sessions', 'bucket', 's1', 'session.v4.jsonl.zstd'), 'canary-session-a41\n')
  writeFileSync(join(fakeHome, '.dsh', 'service', 'logs', 'gateway.out.log'), 'token=canary-ui-6d2\n')
  // The gateway profiles: the operator's settings, which the agent is told it can neither read nor change.
  mkdirSync(join(fakeHome, '.dsh', 'profiles', 'agent'), { recursive: true })
  writeFileSync(join(fakeHome, '.dsh', 'profiles', 'agent', 'cordis.patch.yml'), 'canary-profile-8e1\n')
  // And everything else the harness keeps there, and whatever it adds next: its session index (every
  // conversation's text, with the WAL that holds the newest), the adapter's state and log, the harness's
  // storages (reminders, a session cache), attachments, the terminal's input history, the watch list.
  // These were readable: the runner denied a list of names, and the list was a step behind the harness.
  const privateFiles = {
    'agent-session-index.db': 'canary-index-1a2', 'agent-session-index.db-wal': 'canary-wal-2b3', 'agent-session-index.db-shm': 'canary-shm-3c4',
    'slack-state/sessions.json': 'canary-state-4d5', 'slack-state/deepbot.log': 'canary-log-5e6',
    'storages/workspace.json': 'canary-ws-6f7', 'storages/schedule.json': 'canary-sched-7a8', 'storages/session_projcache/p': 'canary-proj-8b9',
    'attachments/v1/a.png': 'canary-attach-9c0', 'deepbot-tui/history.jsonl': 'canary-hist-0d1', 'watches.json': 'canary-watch-1e2',
    'added-later.db': 'canary-later-2f3',
  }
  for (const [file, canary] of Object.entries(privateFiles)) {
    mkdirSync(dirname(join(fakeHome, '.dsh', file)), { recursive: true })
    writeFileSync(join(fakeHome, '.dsh', file), `${canary}\n`)
  }
  // The harness's runtimes stay readable: the office skill runs its node from there.
  mkdirSync(join(fakeHome, '.dsh', 'dsh-runtimes', 'rt', 'bin'), { recursive: true })
  writeFileSync(join(fakeHome, '.dsh', 'dsh-runtimes', 'rt', 'bin', 'tool'), 'runtime-3a4\n')
  const env = { ...process.env, HOME: fakeHome }
  const text = execFileSync(RUNNER, ['--print-profile', ...READ_ONLY, '--', 'true'], { encoding: 'utf8', env })
  const as = resolved ? ' (resolved home)' : ' (home under a symlink)'
  check('the profile denies the credential files' + as, text.includes(`(deny file-read* (literal "${fakeHome}/.dsh/.env"))`)
    && text.includes(`(deny file-read* (literal "${fakeHome}/.dsh/.credentials.yaml"))`), text.split('\n').filter((l) => l.includes('.dsh')).join(' | '))
  const read = (file) => {
    try { return execFileSync(RUNNER, [...READ_ONLY, '--', '/bin/cat', join(fakeHome, '.dsh', file)], { encoding: 'utf8', env, stdio: 'pipe' }) }
    catch (e) { return `exit ${e.status}: ${String(e.stdout ?? '')}` }
  }
  check('a command cannot read .env' + as, !read('.env').includes('canary-env-5d1'))
  check('nor .credentials.yaml' + as, !read('.credentials.yaml').includes('canary-cred-9b7'))
  check('nor a backup of it' + as, !read('.credentials.yaml.bak-20261008').includes('canary-bak-3c4'))
  check('nor the gateway\'s log, which carries the web UI token' + as, !read(join('service', 'logs', 'gateway.out.log')).includes('canary-ui-6d2'))
  check('nor the recall index' + as, !read(join('recall', 'home', 'recall-index.jsonl')).includes('canary-recall-77b'))
  check('nor the session store' + as, !read(join('sessions', 'bucket', 's1', 'session.v4.jsonl.zstd')).includes('canary-session-a41'))
  check('nor a gateway profile' + as, !read(join('profiles', 'agent', 'cordis.patch.yml')).includes('canary-profile-8e1'))
  for (const [file, canary] of Object.entries(privateFiles)) check(`nor ${file}` + as, !read(file).includes(canary), read(file).slice(0, 40))
  check('the harness runtimes stay readable' + as, read(join('dsh-runtimes', 'rt', 'bin', 'tool')).includes('runtime-3a4'), read(join('dsh-runtimes', 'rt', 'bin', 'tool')).slice(0, 40))
  // A hard link is another path to the same file, which a path rule would not cover. It cannot be made
  // from the workspace — not because the credentials are denied, but because Seatbelt refuses a link
  // whose source is outside the writable paths at all: a readable file outside is refused the same way
  // (the control below). So the protection does not rest on the read deny, and this says so.
  const ws = join(fakeHome, 'ws')
  mkdirSync(ws, { recursive: true })
  const link = (from, to) => {
    try { execFileSync(RUNNER, ['--ro-bind', '/', '/', '--die-with-parent', '--tmpfs', '/tmp', '--bind', ws, ws, '--', '/bin/ln', from, to], { env, stdio: 'pipe' }) }
    catch { /* refused */ }
    return existsSync(to)
  }
  check('a hard link to the credentials cannot be made' + as, !link(join(fakeHome, '.dsh', '.env'), join(ws, 'copy')))
  check('nor to any file outside the writable paths — the reason it holds' + as, !link(join(fakeHome, 'outside.txt'), join(ws, 'other')))
  writeFileSync(join(ws, 'mine.txt'), 'x')
  check('while one inside them can be, so ln itself works' + as, link(join(ws, 'mine.txt'), join(ws, 'mine-link')))
  // The workspace is written by its resolved name: under a symlinked directory every write used to be
  // refused, and the .env rule matched nothing. Both rules hold for both names now.
  const write = (name) => {
    try { execFileSync(RUNNER, ['--ro-bind', '/', '/', '--die-with-parent', '--tmpfs', '/tmp', '--bind', ws, ws, '--', '/bin/sh', '-c', `echo x > '${join(ws, name)}'`], { env, stdio: 'pipe' }) }
    catch { /* refused */ }
    return existsSync(join(ws, name))
  }
  check('the workspace is writable' + as, write('notes.md'))
  check('except its .env' + as, !write('.env') && !write('.env.local'))
  // A harness home somewhere else (DSH_HOME): its session store and recall index are as private.
  const alt = join(fakeHome, 'alt-dsh')
  mkdirSync(join(alt, 'recall', 'home'), { recursive: true })
  mkdirSync(join(alt, 'sessions', 'b'), { recursive: true })
  writeFileSync(join(alt, 'recall', 'home', 'recall-index.jsonl'), 'canary-alt-recall-5e0\n')
  writeFileSync(join(alt, 'sessions', 'b', 's.zstd'), 'canary-alt-session-6f1\n')
  writeFileSync(join(alt, 'agent-session-index.db'), 'canary-alt-index-7a2\n')
  const readAlt = (file) => {
    try { return execFileSync(RUNNER, [...READ_ONLY, '--', '/bin/cat', join(alt, file)], { encoding: 'utf8', env: { ...env, DSH_HOME: alt }, stdio: 'pipe' }) }
    catch (e) { return `exit ${e.status}` }
  }
  check('nor a DSH_HOME\'s recall index' + as, !readAlt(join('recall', 'home', 'recall-index.jsonl')).includes('canary-alt-recall-5e0'))
  check('nor its session store' + as, !readAlt(join('sessions', 'b', 's.zstd')).includes('canary-alt-session-6f1'))
  check('nor anything else in it' + as, !readAlt('agent-session-index.db').includes('canary-alt-index-7a2'))
  // The control: the runner itself works, and what is outside the harness home is readable.
  const outside = (() => { try { return execFileSync(RUNNER, [...READ_ONLY, '--', '/bin/cat', join(fakeHome, 'outside.txt')], { encoding: 'utf8', env, stdio: 'pipe' }) } catch (e) { return `exit ${e.status}` } })()
  check('a file outside the harness home stays readable' + as, outside.includes('readable-2e8'), outside.slice(0, 40))
  // An agent home someone put inside the harness home is its own, and stays usable.
  const inner = join(fakeHome, '.dsh', 'inner-home')
  mkdirSync(inner, { recursive: true })
  writeFileSync(join(inner, 'note.md'), 'inner-4b5\n')
  const innerRead = (() => { try { return execFileSync(RUNNER, ['--ro-bind', '/', '/', '--die-with-parent', '--bind', inner, inner, '--', '/bin/cat', join(inner, 'note.md')], { encoding: 'utf8', env, stdio: 'pipe' }) } catch (e) { return `exit ${e.status}` } })()
  check('a workspace inside the harness home stays readable' + as, innerRead.includes('inner-4b5'), innerRead.slice(0, 40))
  rmSync(made, { recursive: true, force: true })
}

// The profile reaches sandbox-exec inline. It used to be written to a file in TMPDIR — a directory
// confined commands may write — and read back by path, so one running command could rewrite the
// profile another invocation was about to apply. A command inside the runner lists TMPDIR: the
// file used to be there for exactly as long as the command ran.
{
  const tmp = mkdtempSync(join(tmpdir(), 'runner-tmp-'))
  const listed = execFileSync(RUNNER, [...READ_ONLY, '--', '/bin/ls', '-a', tmp], { encoding: 'utf8', env: { ...process.env, TMPDIR: tmp } })
  check('no profile file exists while a command runs', !/deepbot-confine/.test(listed), listed.replace(/\n/g, ' ').trim())
  rmSync(tmp, { recursive: true, force: true })
}

// The user's ssh-agent. launchd hands its socket to the gateway, and a confined command could use
// every key in it — measured on this machine: `ssh-add -l` inside the runner listed the keys. Only
// checked where an agent with keys is reachable from outside the runner.
{
  const profileText = profile([...READ_ONLY, '--', 'true'])
  // Every agent socket, not only launchd's: 1Password's, gpg-agent's, docker's. DNS resolution goes
  // through mDNSResponder's socket, so that one stays open — without it nothing resolves a host.
  check('the profile refuses unix-socket connections', /\(deny network-outbound \(remote unix-socket\)\)/.test(profileText), profileText.split('\n').filter((l) => /unix-socket/.test(l)).join(' | '))
  check('except the resolver\'s, so names still resolve', /allow network-outbound \(remote unix-socket \(path-literal "\/private\/var\/run\/mDNSResponder"\)\)/.test(profileText))
  let outside = false
  try { execFileSync('/usr/bin/ssh-add', ['-l'], { stdio: 'pipe' }); outside = true } catch { /* no agent, or no keys */ }
  if (outside) {
    let inside = true
    try { execFileSync(RUNNER, [...READ_ONLY, '--', '/usr/bin/ssh-add', '-l'], { stdio: 'pipe' }) } catch { inside = false }
    check('a command inside the runner cannot reach the ssh-agent', !inside)
  }
}

// The workspace's own .env cannot be written: the harness's credential chain reads <cwd>/.env before
// the deployment's, and the gateway's cwd is this workspace.
{
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'runner-ws-')))
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--die-with-parent', '--tmpfs', '/tmp', '--bind', ws, ws]
  const run = (cmd) => { try { execFileSync(RUNNER, [...args, '--', '/bin/sh', '-c', cmd], { stdio: 'pipe' }); return true } catch { return false } }
  run(`touch ${ws}/.env`)
  run(`echo X=1 > ${ws}/.env.local`)
  run(`touch ${ws}/notes.md`)
  check('a command cannot create the workspace .env', !existsSync(join(ws, '.env')))
  check('nor a .env variant', !existsSync(join(ws, '.env.local')))
  check('and can still write anything else there', existsSync(join(ws, 'notes.md')))
  rmSync(ws, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
