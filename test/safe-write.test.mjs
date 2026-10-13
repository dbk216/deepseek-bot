/**
 * Writing into the agent's home from outside the sandbox.
 *
 * The plugin and the recall indexer run unconfined and write files into the agent's home, which the
 * agent can write too. Found by security review: a symlink the agent leaves at
 * memory/recall-index.jsonl, pointing at the gateway's launcher, made the indexer overwrite the
 * launcher — which launchd runs unconfined at the next start. An attachment's name is chosen by
 * whoever uploads it, so a symlinked attachments directory was the same thing with a chosen name.
 *
 * Each case plants the link the way the agent could, and checks the file it points at afterwards.
 *
 * Run: node test/safe-write.test.mjs
 */
import './dist-fresh.mjs'   // fails loudly on a stale dist

import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeInside } from '../dist/safeWrite.js'
import { writeAttachments } from '../dist/transports/attachments.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'safe-write-')))
  const home = join(base, 'home')
  const outside = join(base, 'outside')
  mkdirSync(home, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const launcher = join(outside, 'run-gateway.sh')
  writeFileSync(launcher, '#!/bin/bash\necho original\n')
  return { base, home, outside, launcher, done: () => rmSync(base, { recursive: true, force: true }) }
}

// 1. An ordinary write lands where it was asked to.
{
  const f = fixture()
  writeInside(f.home, join(f.home, 'memory', 'index.jsonl'), 'hello\n')
  check('a plain write creates the file and its directory', readFileSync(join(f.home, 'memory', 'index.jsonl'), 'utf8') === 'hello\n')
  writeInside(f.home, join(f.home, 'memory', 'index.jsonl'), 'again\n')
  check('and replaces it on the next write', readFileSync(join(f.home, 'memory', 'index.jsonl'), 'utf8') === 'again\n')
  f.done()
}

// 2. A link at the final name is replaced, not written through.
{
  const f = fixture()
  mkdirSync(join(f.home, 'memory'))
  symlinkSync(f.launcher, join(f.home, 'memory', 'index.jsonl'))
  writeInside(f.home, join(f.home, 'memory', 'index.jsonl'), '{"text":"$(touch pwned)"}\n')
  check('the file a link pointed at is untouched', readFileSync(f.launcher, 'utf8') === '#!/bin/bash\necho original\n')
  check('the link itself became a plain file', !lstatSync(join(f.home, 'memory', 'index.jsonl')).isSymbolicLink())
  f.done()
}

// 3. A directory that resolves outside the home is refused.
{
  const f = fixture()
  symlinkSync(f.outside, join(f.home, 'memory'))
  let refused = false
  try { writeInside(f.home, join(f.home, 'memory', 'run-gateway.sh'), 'replaced') } catch { refused = true }
  check('a write through a linked directory is refused', refused)
  check('and nothing outside changed', readFileSync(f.launcher, 'utf8') === '#!/bin/bash\necho original\n')
  f.done()
}

// 4. The recall indexer, as run after every turn and by launchd.
{
  const f = fixture()
  const dsh = join(f.base, 'dsh')
  mkdirSync(join(dsh, 'sessions'), { recursive: true })
  // The control: on an ordinary home the indexer writes its index. Without it, an indexer that died
  // early for any reason would pass the checks below.
  execFileSync(process.execPath, ['dist/recall/deepbot-recall.js', 'index', '--quiet'],
    { encoding: 'utf8', env: { ...process.env, DSH_HOME: dsh, DEEPBOT_HOME: f.home }, stdio: 'pipe' })
  let wrote = false
  try { wrote = lstatSync(join(f.home, 'memory', 'recall-index.jsonl')).isFile() } catch { /* not written */ }
  check('on an ordinary home the indexer writes its index', wrote)
  rmSync(join(f.home, 'memory'), { recursive: true, force: true })
  mkdirSync(join(f.home, 'memory'))
  symlinkSync(f.launcher, join(f.home, 'memory', 'recall-index.jsonl'))
  try {
    execFileSync(process.execPath, ['dist/recall/deepbot-recall.js', 'index', '--quiet'],
      { encoding: 'utf8', env: { ...process.env, DSH_HOME: dsh, DEEPBOT_HOME: f.home }, stdio: 'pipe' })
  } catch { /* a refusal is an acceptable outcome; the file below is what matters */ }
  check('the indexer does not write through a planted link', readFileSync(f.launcher, 'utf8') === '#!/bin/bash\necho original\n')
  rmSync(join(f.home, 'memory'), { recursive: true, force: true })
  symlinkSync(f.outside, join(f.home, 'memory'))
  try {
    execFileSync(process.execPath, ['dist/recall/deepbot-recall.js', 'index', '--quiet'],
      { encoding: 'utf8', env: { ...process.env, DSH_HOME: dsh, DEEPBOT_HOME: f.home }, stdio: 'pipe' })
  } catch { /* refused */ }
  let wroteOutside = true
  try { lstatSync(join(f.outside, 'recall-index.jsonl')) } catch { wroteOutside = false }
  check('nor into a linked memory directory', !wroteOutside)
  f.done()
}

// 5. Attachments: the name is the uploader's, so a linked directory would be a chosen-name write.
{
  const f = fixture()
  symlinkSync(f.outside, join(f.home, 'attachments'))
  const result = await writeAttachments([{
    name: 'run-gateway.sh', mimetype: 'text/plain', size: 8, fetchBytes: async () => Buffer.from('replaced'),
  }], { cwd: f.home, dir: join(f.home, 'attachments'), stamp: '1', maxBytes: 1024, inlineChars: 100 })
  let landed = false
  try { lstatSync(join(f.outside, '1-run-gateway.sh')); landed = true } catch { /* not written */ }
  check('an attachment is not written through a linked directory', !landed, result.text.split('\n')[1] ?? '')
  check('and the manifest says it failed', /failed/.test(result.text))
  f.done()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
