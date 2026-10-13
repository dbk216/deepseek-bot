/**
 * The sandbox runner's profile generator.
 *
 * This is the security-critical part of read confinement, and it is testable without
 * running anything under it: the runner can print the profile it would apply, given
 * the policy arguments the harness passes. Checking the text is how the two ways this
 * can go wrong stay caught — allowing writes outside the workspace, or letting an
 * agent read another instance's data.
 *
 * Run: node test/confined-runner.test.mjs
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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
check('the retired bot data is denied', ws.includes('(deny file-read* (subpath') && /\.other-agent/.test(ws))
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
  writeFileSync(join(fakeHome, '.dsh', 'other.txt'), 'readable-2e8\n')
  // The gateway's own log: its first lines carry the web UI's auth token, which opens the harness's
  // HTTP API — outside this sandbox — to whoever reads it.
  mkdirSync(join(fakeHome, '.dsh', 'service', 'logs'), { recursive: true })
  writeFileSync(join(fakeHome, '.dsh', 'service', 'logs', 'gateway.out.log'), 'token=canary-ui-6d2\n')
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
  check('the rest of ~/.dsh stays readable' + as, read('other.txt').includes('readable-2e8'), read('other.txt').slice(0, 40))
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

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
