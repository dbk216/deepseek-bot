/**
 * The deployment's posture, checked against the *effective* composition.
 *
 * Three times now a profile edit has silently changed the safety posture: a block
 * deduplication deleted the sandbox row, and twice a new `- id: deepbot` row — whose
 * `config` replaces the whole config rather than merging — was written without restating
 * the settings it meant to keep. One of those turned the destructive-command gate off, and
 * the only reason it was noticed is that a scenario stopped blocking an `rm`.
 *
 * A profile is as much a part of this deployment as the code, so it gets a test. This reads
 * what the harness actually composes rather than what the file appears to say.
 *
 * Run: node test/profile.test.mjs [profile ...]   (default: agent agent-test)
 */
import { execFileSync } from 'node:child_process'

const DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const profiles = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['agent', 'agent-test']

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function dump(profile) {
  try {
    return execFileSync(DSH, [`--profile`, profile, '--dump-config'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    return `__ERROR__ ${String(e?.message ?? e)}`
  }
}

for (const profile of profiles) {
  console.log(`\n  ── ${profile}`)
  const text = dump(profile)
  check(`${profile}: the profile composes at all`, !text.startsWith('__ERROR__'), text.slice(0, 120))
  check(`${profile}: no validation errors in the dump`, !/ValidationError|Error: /.test(text))

  // The deepbot row's own settings.
  const row = text.slice(text.indexOf('name: deepbot'), text.indexOf('name: deepbot') + 2000)
  check(`${profile}: targetChannels is set`, /targetChannels:/.test(row), 'the plugin refuses to start without it')
  const patterns = (row.match(/approvalPatterns:[\s\S]*?(?=\n {6}\w|\n {2}\w|$)/) ?? [''])[0]
  const patternCount = (patterns.match(/^\s+- /gm) ?? []).length
  check(`${profile}: the destructive-command gate is on`, /approvalPatterns:/.test(row) && patternCount > 0,
    patternCount > 0 ? `${patternCount} patterns` : 'approvalPatterns is empty or missing — rm would run without asking')
  check(`${profile}: the gate still names deletion and privilege escalation`,
    /rm /.test(patterns) && /sudo/.test(patterns), patterns.replace(/\n/g, ' ').trim().slice(0, 80))
  check(`${profile}: tenant isolation is a deliberate choice`, true,
    /tenantIsolation: true/.test(row) ? 'ON for this profile' : 'off (shared home)')

  // Composition-level fences.
  const sandboxRow = text.slice(text.indexOf('- id: sandbox'), text.indexOf('- id: sandbox') + 400)
  check(`${profile}: commands run under the confined runner`, /confined-runner/.test(sandboxRow),
    /confined-runner/.test(sandboxRow) ? 'runner configured' : 'the sandbox row lost its runner — command reads are unconfined')
  check(`${profile}: the sandbox runner declares its failure signature`,
    /runnerFailureSignatures/.test(sandboxRow), 'a runner that fails silently is worse than none')
  const remotes = text.slice(text.indexOf('- id: api-remotes'), text.indexOf('- id: api-remotes') + 200)
  check(`${profile}: api-remotes is disabled so approvals reach the answerer`, /disabled: true/.test(remotes),
    'otherwise an approval request is held by a listener waiting for a browser')
  // The pair is the invariant, not either half. `ask` is the feature working — a request
  // reaches the conversation — but only while api-remotes is disabled; with the forwarder
  // composed it holds the request and the turn waits for a browser that never answers.
  // `never` is the safe fallback when the answerer cannot be reached, and it means
  // approvals do not happen. A profile may choose that; it may not choose ask without it.
  const ask = /defaultPreset: attended|approval: ask/.test(text)
  const never = /defaultPreset: unattended/.test(text)
  const remotesOff = /disabled: true/.test(text.slice(text.indexOf('- id: api-remotes'), text.indexOf('- id: api-remotes') + 200))
  check(`${profile}: the approval policy is consistent with what can answer it`,
    never || (ask && remotesOff),
    never ? 'never: approvals are refused rather than asked' : (ask && remotesOff ? 'ask, and the forwarder that would swallow it is disabled' : 'ask with api-remotes composed — a request would hang the turn'))
  check(`${profile}: read isolation is on by default`, !/readScope: false/.test(text), 'readScope defaults to true')
  check(`${profile}: the response language and reply mode are set`, /replyMode:/.test(row), '')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
