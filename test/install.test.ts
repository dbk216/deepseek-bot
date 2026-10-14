/**
 * The one-line installer, in the parts that can be checked without installing anything.
 *
 * install.sh runs from `curl … | bash`: a download cut short must run nothing, and what a person types
 * at its prompts goes into a YAML profile through sed. Its helpers are top-level functions, and with
 * DEEPBOT_INSTALL_SOURCED=1 sourcing it defines them and does nothing else, so they are called here
 * directly. The rest — clone, build, launchd — is not run by this suite.
 *
 * Run: node test/install.test.ts
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

// The health probe and the watch runner are compiled. Their installers copy the build under the names the
// plists, install.sh and the docs run, and refuse while there is no build: a copy of nothing, or of a
// stale file, is a probe that does not match the checkout. Each installer is sourced from a copy of the
// repository's layout, so "no build" is real and the copy lands in scratch directories.
const script = readFileSync(INSTALL, 'utf8')
const build = script.indexOf('npm run --silent build')
check('install.sh builds before the installers copy from the build',
  build !== -1 && build < script.indexOf('/service/install-health.sh"') && build < script.indexOf('/watch/install-watch.sh"'))
const repo = join(dir, 'repo')
for (const file of ['service/install-health.sh', 'service/rotate-logs.sh', 'service/confined-runner.sh', 'watch/install-watch.sh']) {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(repo, file))
}
for (const [installer, built, copy, source] of [
  ['service/install-health.sh', 'dist/service/health-check.js', 'health-check.mjs', 'service/health-check.ts'],
  ['watch/install-watch.sh', 'dist/watch/watch.js', 'watch.mjs', 'watch/watch.ts'],
]) {
  // Sourced, an installer must stop before its first launchctl; one that would not is never sourced here.
  const text = readFileSync(join(repo, installer), 'utf8')
  const guard = text.search(/^if \[ "\$\{DEEPBOT_INSTALL_SOURCED:-0\}" = 1 \]; then return 0; fi$/m)
  check(`${installer}: sourced, it stops before installing anything`, guard !== -1 && guard < text.indexOf('launchctl '))
  if (guard === -1 || guard > text.indexOf('launchctl ')) continue
  const runtime = join(dir, `runtime-${copy}`)
  const copyStep = () => {
    try {
      const out = execFileSync('/bin/bash', ['-c', 'DEEPBOT_INSTALL_SOURCED=1 source "$1" && copy_runtime', 'bash', join(repo, installer)], {
        encoding: 'utf8', cwd: dir, stdio: 'pipe',
        env: { ...process.env, HOME: dir, DEEPBOT_RUNTIME_DIR: runtime, DEEPBOT_HOME: join(dir, 'agent') },
      })
      return { out: out.trim(), code: 0 }
    } catch (e) {
      return { out: String(e.stdout ?? '').trim(), code: e.status ?? 1 }
    }
  }
  const missing = copyStep()
  check(`${installer}: without a build it refuses and says to build`, missing.code !== 0 && missing.out.includes('build first: pnpm run build'), missing.out)
  check(`${installer}: and writes nothing`, !existsSync(runtime))
  // The source, older than the build that is about to be written.
  writeFileSync(join(repo, source), `// ${source}\n`)
  utimesSync(join(repo, source), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  mkdirSync(dirname(join(repo, built)), { recursive: true })
  writeFileSync(join(repo, built), `// compiled ${built}\n`)
  const copied = copyStep()
  check(`${installer}: it copies ${built} to ${copy}`, copied.code === 0 && existsSync(join(runtime, copy)) && readFileSync(join(runtime, copy), 'utf8') === `// compiled ${built}\n`, copied.out.split('\n')[0])
  // An edit to the source after the last build: the copy would deploy what the source no longer says.
  writeFileSync(join(repo, source), `// ${source}, edited\n`)
  utimesSync(join(repo, source), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
  writeFileSync(join(runtime, copy), 'the copy already deployed\n')
  const stale = copyStep()
  check(`${installer}: a build older than ${source} is refused, and the deployed copy is left as it was`, stale.code !== 0 && stale.out.includes('older than') && stale.out.includes('pnpm run build') && readFileSync(join(runtime, copy), 'utf8') === 'the copy already deployed\n', stale.out)
}

rmSync(dir, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
