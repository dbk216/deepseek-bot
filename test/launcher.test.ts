/**
 * The gateway launcher (service/run-gateway.sh): what the harness process it starts is given.
 *
 * Run in a scratch home with a fake `dsh` that reports its environment, so nothing real starts.
 *
 * Run: node test/launcher.test.ts
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LAUNCHER = fileURLToPath(new URL('../service/run-gateway.sh', import.meta.url))

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'deepbot-launcher-'))
const home = join(dir, 'home')
mkdirSync(home, { recursive: true })
const seen = join(dir, 'seen')
const fake = join(dir, 'dsh')
writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "\${DSH_AGENTS_HOME:-unset}" "$PWD" "$@" > '${seen}'\n`)
chmodSync(fake, 0o755)

// The operator's own agent skills: what the harness would scan at ~/.agents/skills.
mkdirSync(join(home, '.agents', 'skills', 'operator-skill'), { recursive: true })
writeFileSync(join(home, '.agents', 'skills', 'operator-skill', 'SKILL.md'), '---\nname: operator-skill\n---\n')

function launch(env = {}) {
  execFileSync('/bin/bash', [LAUNCHER], {
    encoding: 'utf8', stdio: 'pipe',
    env: { PATH: process.env.PATH, HOME: home, DSH_BIN: fake, DEEPBOT_HOME: join(home, 'dsh-agent'), DEEPBOT_READ_PROFILE: join(dir, 'none.sb'), ...env },
  })
  return readFileSync(seen, 'utf8').split('\n')
}

// 1. The harness gets an agents home of the bot's own, empty, under its harness home.
{
  const [agentsHome, cwd] = launch()
  check('skills: the harness is pointed away from ~/.agents, to the bot\'s own agents home under ~/.dsh', agentsHome === join(home, '.dsh', 'deepbot', 'agents-home'), agentsHome)
  check('skills: that directory exists, and holds no skills', existsSync(agentsHome) && readdirSync(agentsHome).length === 0)
  check('skills: the gateway still runs in the agent home', cwd.endsWith('/dsh-agent'), cwd)
}

// 2. An operator who has DSH_AGENTS_HOME set in their own shell does not hand it to the bot.
{
  const [agentsHome] = launch({ DSH_AGENTS_HOME: join(home, '.agents') })
  check('skills: an inherited DSH_AGENTS_HOME is replaced, not passed on', agentsHome === join(home, '.dsh', 'deepbot', 'agents-home'), agentsHome)
}

rmSync(dir, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
