/**
 * The health probe also reads the daily scenario report.
 *
 * service/run-scenarios.sh writes its report and nothing else, so a failing scenario stayed in a file
 * until somebody opened it. The probe runs every five minutes anyway and can already alert; it now
 * alerts once per report that has failures. Run in dry-run mode against scratch files: nothing is sent.
 *
 * Run: node test/health.test.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROBE = fileURLToPath(new URL('../service/health-check.mjs', import.meta.url))
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'deepbot-health-'))
const env = {
  ...process.env,
  DEEPBOT_HEALTH_FILE: join(dir, 'health.json'),
  DEEPBOT_HEALTH_STATE: join(dir, 'probe.json'),
  DEEPBOT_SCENARIO_REPORT: join(dir, 'scenario-report.txt'),
  DEEPBOT_ALERT_TO: 'U_OPERATOR',
  SLACK_BOT_TOKEN: 'placeholder-for-dry-run',
}
writeFileSync(env.DEEPBOT_HEALTH_FILE, JSON.stringify({ connected: true, updatedAt: Date.now(), connectedAt: Date.now() }))
const probe = () => {
  try { return execFileSync(process.execPath, [PROBE, '--dry-run', '--no-rotate'], { encoding: 'utf8', env }) }
  catch (e) { return String(e.stdout ?? '') }
}
const report = (ran, failed, names = []) => writeFileSync(env.DEEPBOT_SCENARIO_REPORT, [
  `scenarios run ${ran}`, 'repo .', ...names.map((n) => `  FAIL  ${n} — 1/2 steps passed`), `  ${failed} scenario(s) failed`, '',
].join('\n'))

report('2026-10-13T00:00:00Z', 2, ['isolation', 'injection'])
let out = probe()
check('a report with failures raises an alert', /scenarios: dry-run: would alert U_OPERATOR/.test(out), out.trim().split('\n').slice(-2).join(' | '))
check('naming the scenarios that failed', /isolation, injection/.test(out), out.trim().split('\n').find((l) => /scenario/.test(l)) ?? '')
out = probe()
check('the same report alerts only once', !/scenarios: /.test(out), out.trim().split('\n').slice(-1)[0])
report('2026-10-14T00:00:00Z', 0)
out = probe()
check('a clean report raises nothing', !/scenarios: /.test(out))
report('2026-10-15T00:00:00Z', 1, ['recall'])
out = probe()
check('the next failing report alerts again', /scenarios: dry-run/.test(out) && /recall/.test(out))
check('the probe still reports health', /healthy/.test(out))
const state = JSON.parse(readFileSync(env.DEEPBOT_HEALTH_STATE, 'utf8'))
check('which report was alerted is remembered', state.scenarioReportAlerted === '2026-10-15T00:00:00Z', JSON.stringify(state))

rmSync(dir, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
