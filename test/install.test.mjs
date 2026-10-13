/**
 * The one-line installer, in the parts that can be checked without installing anything.
 *
 * install.sh runs from `curl … | bash`: a download cut short must run nothing, and what a person types
 * at its prompts goes into a YAML profile through sed. Its helpers are top-level functions, and with
 * DEEPBOT_INSTALL_SOURCED=1 sourcing it defines them and does nothing else, so they are called here
 * directly. The rest — clone, build, launchd — is not run by this suite.
 *
 * Run: node test/install.test.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const INSTALL = fileURLToPath(new URL('../install.sh', import.meta.url))
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'deepbot-install-'))
// Files in the working directory, so an unquoted * would expand to them.
writeFileSync(join(dir, 'a-file'), '')
writeFileSync(join(dir, 'b-file'), '')
/** Source the installer and run one shell line with its helpers; returns { out, code }. */
function withHelpers(line, env = {}) {
  try {
    const out = execFileSync('/bin/bash', ['-c', `DEEPBOT_INSTALL_SOURCED=1 source "$1"; ${line}`, 'bash', INSTALL], {
      encoding: 'utf8', cwd: dir, env: { ...process.env, HOME: dir, ...env }, stdio: 'pipe',
    })
    return { out: out.trim(), code: 0 }
  } catch (e) {
    return { out: String(e.stdout ?? '').trim(), code: e.status ?? 1 }
  }
}

check('the script parses', (() => { try { execFileSync('/bin/bash', ['-n', INSTALL]); return true } catch { return false } })())
const lines = readFileSync(INSTALL, 'utf8').trimEnd().split('\n')
check('its last line is what starts it, so a download cut short runs nothing', /^\[ "\$\{DEEPBOT_INSTALL_SOURCED:-0\}" = 1 \] \|\| main "\$@"$/.test(lines.at(-1)), lines.at(-1))
const sourced = withHelpers('true')
check('sourced, it does nothing', sourced.code === 0 && sourced.out === '', JSON.stringify(sourced.out.slice(0, 60)))

// Channels: what a person types goes into the profile through sed.
check('* is every channel, not the files in the directory', withHelpers('channel_list "*"').out === "['*']", withHelpers('channel_list "*"').out)
check('ids separated by spaces or commas', withHelpers('channel_list "C01 C02,C03"').out === "['C01', 'C02', 'C03']", withHelpers('channel_list "C01 C02,C03"').out)
for (const bad of ['C01/../x', "C0'1", 'C0&1', 'C01 *', '']) {
  check(`refused: ${JSON.stringify(bad)}`, withHelpers(`channel_list ${JSON.stringify(bad)}`).code !== 0)
}

// A rerun keeps the profile, and must ask for the tokens of the platform it has.
const profile = join(dir, 'cordis.patch.yml')
writeFileSync(profile, 'plugins:\n  - id: deepbot\n    platform: telegram\n    targetChannels: [\'*\']\n')
check('the platform of an existing profile is read back', withHelpers(`profile_platform "${profile}"`).out === 'telegram', withHelpers(`profile_platform "${profile}"`).out)
check('and slack when the profile names none', withHelpers(`profile_platform "${join(dir, 'missing.yml')}"`).out === 'slack')

// The services read ~/.dsh; a harness home elsewhere would leave the tokens where nothing looks.
mkdirSync(join(dir, '.dsh'), { recursive: true })
check('the default harness home is accepted', withHelpers('check_dsh_home').code === 0)
check('so is DSH_HOME naming it', withHelpers('check_dsh_home', { DSH_HOME: join(dir, '.dsh') }).code === 0)
check('a DSH_HOME elsewhere is refused before anything is written', withHelpers('check_dsh_home', { DSH_HOME: join(dir, 'elsewhere') }).code !== 0)

rmSync(dir, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
