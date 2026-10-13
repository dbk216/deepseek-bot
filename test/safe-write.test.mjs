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
import { recallIndexPath } from '../dist/recallContext.js'

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

// 4. The recall indexer, as run after every turn and by launchd. Its index now lives under the harness
// home, where the agent cannot write; what is left of the old one in the agent's home is removed —
// a link there is removed as a link, and a memory directory linked elsewhere is not followed.
{
  const f = fixture()
  const dsh = join(f.base, 'dsh')
  mkdirSync(join(dsh, 'sessions'), { recursive: true })
  const index = () => execFileSync(process.execPath, ['dist/recall/deepbot-recall.js', 'index', '--quiet'],
    { encoding: 'utf8', env: { ...process.env, DSH_HOME: dsh, DEEPBOT_HOME: f.home }, stdio: 'pipe' })
  // The control: the indexer runs and writes its index where it should, outside the home.
  index()
  let wrote = false
  try { wrote = lstatSync(recallIndexPath(f.home, dsh)).isFile() } catch { /* not written */ }
  check('the indexer writes its index under the harness home', wrote, recallIndexPath(f.home, dsh))
  mkdirSync(join(f.home, 'memory'))
  writeFileSync(join(f.home, 'memory', 'recall-index.jsonl'), '{"text":"an old copy every tool could read"}\n')
  index()
  let oldGone = true
  try { lstatSync(join(f.home, 'memory', 'recall-index.jsonl')); oldGone = false } catch { /* removed */ }
  check('an old index in the agent home is removed', oldGone)
  symlinkSync(f.launcher, join(f.home, 'memory', 'recall-index.jsonl'))
  index()
  check('a link left at the old name is not followed', readFileSync(f.launcher, 'utf8') === '#!/bin/bash\necho original\n')
  // And removed: the indexer no longer writes there, so "not followed" alone could not fail.
  let linkGone = true
  try { lstatSync(join(f.home, 'memory', 'recall-index.jsonl')); linkGone = false } catch { /* removed */ }
  check('and the link itself is removed', linkGone)
  rmSync(join(f.home, 'memory'), { recursive: true, force: true })
  writeFileSync(join(f.outside, 'recall-index.jsonl'), 'outside, keep me\n')
  symlinkSync(f.outside, join(f.home, 'memory'))
  index()
  check('a memory directory linked elsewhere is not followed', readFileSync(join(f.outside, 'recall-index.jsonl'), 'utf8') === 'outside, keep me\n')
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
