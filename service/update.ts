/**
 * `dsh update`: bring this install up to date. It is the install line run again, from the source
 * checkout this dsh runs from: the installer it runs is the one in the commit just fetched, so an update
 * takes that version's steps, not this one's. The installer keeps the agent home and profile the service
 * was installed with, every file edited, and every key the harness already has.
 *
 * It runs nothing when the checkout's branch is where the last finished install left it. An update that
 * stopped part way (a failed build, a service that did not start) left no record, so the next one runs
 * the installer again.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { constants, homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface UpdateIO {
  /** The source checkout this dsh was built in. */
  checkout: string
  home: string
  env: Record<string, string | undefined>
  platform: string
  /** A command whose output is read, in the checkout. */
  run: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string }
  /** Run an installer script on this terminal, with these variables added; its exit status. */
  install: (script: string, env: Record<string, string>) => number
  out: (text: string) => void
  err: (text: string) => void
}

const HELP = `dsh update — update deepseek-bot to the latest version of its branch

Fetches the branch the source checkout is on, then runs that commit's installer: it builds, keeps the
agent home, the profile, every file you edited and every key the harness already has, and reinstalls
the services, restarting the bot. Nothing runs when the last finished install is already the latest.

Local changes, or commits that are not on origin's branch while origin has moved on, stop it: the
installer says which. A working copy ahead of origin is installed as it is.
`

export function update(argv: string[], io: UpdateIO): number {
  if (argv.includes('-h') || argv.includes('--help')) { io.out(HELP); return 0 }
  if (argv.length > 0) { io.err(`dsh update takes no arguments (got: ${argv.join(' ')})`); return 2 }
  if (io.platform !== 'darwin') { io.err('the installer it runs is macOS-only: update this checkout by hand (git pull, pnpm run build)'); return 1 }
  // Before this command existed, `dsh update` booted a harness profile named update. Whoever has one
  // meant that: it is not replaced by a rebuild and a restart.
  const dsh = io.env.DSH_HOME || join(io.home, '.dsh')
  // The harness counts a directory under profiles/ as a profile when it holds a package.json.
  if (existsSync(join(dsh, 'profiles', 'update', 'package.json'))) {
    io.err(`a harness profile named update exists, so this does not run: boot it with dsh --profile update; to update deepseek-bot, run the install line again with DEEPBOT_DIR=${io.checkout} (README)`)
    return 1
  }
  const git = (...args: string[]) => io.run('git', ['-C', io.checkout, ...args])
  // A linked worktree's .git is a file: the installer takes either.
  if (!existsSync(join(io.checkout, '.git'))) {
    io.err(`${io.checkout} is not a git checkout, so there is nothing to update from: install again with the line in the README`)
    return 1
  }
  const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD')
  if (branch.status !== 0) { io.err(`${io.checkout} is not on a branch: check one out, then update again`); return 1 }
  const ref = branch.stdout.trim()
  const shallow = git('rev-parse', '--is-shallow-repository').stdout.trim() === 'true'
  io.out(`fetching ${ref} into ${io.checkout}`)
  const fetched = git('fetch', '--quiet', ...(shallow ? ['--depth', '1'] : []), 'origin', ref)
  if (fetched.status !== 0) { io.err(`could not fetch ${ref}: ${(fetched.stderr || fetched.stdout).trim()}`); return 1 }
  const tip = git('rev-parse', 'FETCH_HEAD').stdout.trim()
  const head = git('rev-parse', 'HEAD').stdout.trim()
  // A full clone ahead of origin is already past the tip: it is installed as it is. The installer resets
  // its own shallow clone to the tip, so there the tip is what runs.
  const target = !shallow && head !== tip && git('merge-base', '--is-ancestor', tip, head).status === 0 ? head : tip
  let finished = ''
  try { finished = readFileSync(join(dsh, 'service', 'deepbot.commit'), 'utf8').trim() } catch { /* none yet */ }
  if (head === target && finished === target) { io.out(`already up to date: ${ref} at ${target.slice(0, 7)}`); return 0 }
  const script = git('show', `${target}:install.sh`)
  if (script.status !== 0 || script.stdout === '') { io.err(`${ref} at ${target.slice(0, 7)} has no install.sh: ${script.stderr.trim()}`); return 1 }
  io.out(head !== target
    ? `updating ${ref} from ${head.slice(0, 7)} to ${target.slice(0, 7)}, with that commit's installer`
    : finished === ''
      ? `${ref} is at ${target.slice(0, 7)}, and no finished install of it is recorded: running its installer`
      : `${ref} is at ${target.slice(0, 7)}, but its last install did not finish: running the installer again`)
  const dir = mkdtempSync(join(tmpdir(), 'deepbot-update-'))
  const path = join(dir, 'install.sh')
  writeFileSync(path, script.stdout, { mode: 0o700 })
  try {
    return io.install(path, { DEEPBOT_DIR: io.checkout, DEEPBOT_REF: ref })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function processIO(): UpdateIO {
  return {
    // dist/service/update.js: the checkout is two levels up.
    checkout: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
    home: homedir(),
    env: process.env,
    platform: process.platform,
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8' })
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error?.message ?? '') }
    },
    install: (script, env) => {
      // As under `curl … | bash`, stdin is not the terminal: its questions read /dev/tty, and nothing it
      // runs (pnpm) takes a terminal on stdin for a place to prompt.
      const r = spawnSync('/bin/bash', [script], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...env } })
      if (r.error) { process.stderr.write(`dsh update: ${r.error.message}\n`); return 127 }
      return r.signal ? 128 + (constants.signals[r.signal] ?? 0) : (r.status ?? 1)
    },
    out: (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
    err: (text) => process.stderr.write(`dsh update: ${text}\n`),
  }
}
