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
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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

// The terminal: a new profile serves it beside the platform, and `dsh` goes on the PATH.
writeFileSync(profile, 'plugins:\n  - id: deepbot\n    platform: [\'discord\', \'local\']\n')
check('a profile that lists the terminal still reads back its platform', withHelpers(`profile_platform "${profile}"`).out === 'discord', withHelpers(`profile_platform "${profile}"`).out)
// `dsh gateway setup` adds platforms after the first: a rerun still asks for the first one's tokens.
writeFileSync(profile, 'plugins:\n  - id: deepbot\n    platform: [\'telegram\', \'local\', \'discord\']\n')
check('a profile with a platform added after the terminal reads back the first', withHelpers(`profile_platform "${profile}"`).out === 'telegram', withHelpers(`profile_platform "${profile}"`).out)

// The language a new profile starts in: the environment's, by the POSIX order, English otherwise.
const lang = (env) => withHelpers('env_language', { LC_ALL: '', LC_MESSAGES: '', LANG: '', ...env }).out
check('language: LANG ko_KR is Korean', lang({ LANG: 'ko_KR.UTF-8' }) === 'ko', lang({ LANG: 'ko_KR.UTF-8' }))
check('language: LC_ALL zh_CN wins over LANG', lang({ LC_ALL: 'zh_CN.UTF-8', LANG: 'ko_KR.UTF-8' }) === 'zh', lang({ LC_ALL: 'zh_CN.UTF-8', LANG: 'ko_KR.UTF-8' }))
check('language: C is skipped, not English', lang({ LC_ALL: 'C', LANG: 'zh_TW.UTF-8' }) === 'zh')
check('language: en_US, an unknown one, and none are English', lang({ LANG: 'en_US.UTF-8' }) === 'en' && lang({ LANG: 'fr_FR.UTF-8' }) === 'en' && lang({}) === 'en' && lang({ LANG: 'kok_IN' }) === 'en')
const template = readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8')
check('language: the template names it, for the installer to fill', /^    language: en$/m.test(template))
writeFileSync(join(dir, 'lang.yml'), template)
check('language: the installer writes the chosen one into the profile', withHelpers(`set_profile_language "${join(dir, 'lang.yml')}" zh`).code === 0
  && /^    language: zh$/m.test(readFileSync(join(dir, 'lang.yml'), 'utf8')) && !/^    language: en$/m.test(readFileSync(join(dir, 'lang.yml'), 'utf8')))
check('every channel already includes the terminal\'s', withHelpers(`with_terminal "['*']"`).out === "['*']", withHelpers(`with_terminal "['*']"`).out)
check('a list of channels gets the terminal\'s, tui', withHelpers(`with_terminal "['C01', 'C02']"`).out === "['C01', 'C02', 'tui']", withHelpers(`with_terminal "['C01', 'C02']"`).out)
const launcher = join(dir, '.local', 'bin', 'dsh')
const installed = withHelpers('install_terminal /opt/checkout')
check('dsh is written to ~/.local/bin and runs the checkout\'s build', installed.code === 0 && existsSync(launcher) && readFileSync(launcher, 'utf8').includes('exec node "/opt/checkout/dist/tui/main.js" "$@"') && (statSync(launcher).mode & 0o111) !== 0, installed.out)
check('a rerun replaces its own launcher', withHelpers('install_terminal /opt/other').code === 0 && readFileSync(launcher, 'utf8').includes('/opt/other/dist/tui/main.js'))
// The harness CLI is found on the PATH as dsh too; this project's launcher there must not be taken for it.
check('the harness CLI is not this project\'s dsh', withHelpers('harness_cli', { PATH: `${join(dir, '.local', 'bin')}:/usr/bin:/bin` }).out === '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh', withHelpers('harness_cli', { PATH: `${join(dir, '.local', 'bin')}:/usr/bin:/bin` }).out)
writeFileSync(launcher, '#!/bin/sh\necho the harness\n')
check('a dsh on the PATH that is not ours is the harness CLI', withHelpers('harness_cli', { PATH: `${join(dir, '.local', 'bin')}:/usr/bin:/bin` }).out === launcher)
const kept = withHelpers('install_terminal /opt/checkout')
check('a dsh that is not ours is left as it was, and said', kept.code !== 0 && readFileSync(launcher, 'utf8') === '#!/bin/sh\necho the harness\n' && kept.out.includes('not'), kept.out)
rmSync(join(dir, '.local'), { recursive: true, force: true })

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

// The services. A fresh account may have no ~/Library/LaunchAgents: every installer used to write its plist
// into it unmade, fail, and leave install.sh to say "done".
for (const installer of ['service/install-service.sh', 'service/install-health.sh', 'watch/install-watch.sh', 'recall/install-refresh.sh']) {
  const text = readFileSync(new URL(`../${installer}`, import.meta.url), 'utf8')
  const made = text.indexOf('mkdir -p "$(dirname "$PLIST")"')
  const written = text.indexOf('cat > "$PLIST"')
  check(`${installer}: makes the LaunchAgents directory before writing the plist`, made !== -1 && written !== -1 && made < written)
}
{
  const bin = join(dir, 'fake-installers')
  mkdirSync(bin, { recursive: true })
  const script = (name, body) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); return join(bin, name) }
  const failing = script('fails.sh', `echo "plist written"\necho "web UI token=abc123secret"\necho " The web UI is at http://127.0.0.1:19500 — its auth token is printed"\nexit 3`)
  const passing = script('passes.sh', 'echo fine')
  const run = (line) => withHelpers(`SERVICES_FAILED=0; ${line}; echo "failed=$SERVICES_FAILED"`)
  const shown = run(`service_install "gateway service" "${failing}" show`)
  check('services: a failing installer is said to have failed, and counted', shown.out.includes('gateway service: fails.sh failed') && shown.out.endsWith('failed=1'), shown.out)
  check('services: its output is shown, the line with a credential in it is not', shown.out.includes('plist written') && !shown.out.includes('abc123secret'), shown.out)
  check('services: a line that only mentions a token is kept, so the sentence is whole', shown.out.includes('its auth token is printed'), shown.out)
  const quiet = run(`service_install "watch runner" "${passing}"`)
  check('services: one that works is said to be installed, and not counted', quiet.out.includes('watch runner installed') && quiet.out.endsWith('failed=0') && !quiet.out.includes('fine'), quiet.out)
  const summary = withHelpers('SERVICES_FAILED=2; services_done')
  check('services: with any of them failed, the install ends in failure and says how many', summary.code !== 0 && summary.out.includes('2 service'), summary.out)
  check('services: with none failed, it ends well', withHelpers('SERVICES_FAILED=0; services_done').code === 0)
  check('services: install.sh stops at a failed service instead of saying done', /services_done \|\| return 1\n\nstep "done"/.test(readFileSync(INSTALL, 'utf8')))
}

rmSync(dir, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
