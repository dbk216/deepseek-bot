/**
 * Input edges, driven through the core with the fake transport.
 *
 * The unit suites cover the paths that are meant to work; this covers the ones nobody meant.
 * Each check says what *should* happen, and a failure here is a finding rather than a
 * broken test — that is the point of the sweep. Nothing here touches a live workspace.
 *
 * Run: node test/edges.test.mjs
 */
import './dist-fresh.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../dist/index.js'
import { createFakeTransport } from './fake-transport.mjs'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function boot({ state = {}, config = {} } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-edges-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {}, ...state }))
  const transport = createFakeTransport(config.fake ?? {})
  const logs = []
  const listeners = {}
  const stubs = {
    agents: { create: async () => { throw new Error('fake: no agents') }, resume: async () => { throw new Error('fake: no agents') } },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
  }
  const ctx = { get: (n) => stubs[n], effect: (fn) => fn(), on: (n, h) => { (listeners[n] ??= []).push(h); return () => {} }, logger: { info: (l) => logs.push(String(l)) } }
  apply(ctx, { targetChannels: ['C_ALLOWED'], stateDir, transportFactory: () => transport, progressAfterMs: 50, ...config })
  return {
    transport, logs,
    read: () => JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')),
    done: () => rmSync(stateDir, { recursive: true, force: true }),
  }
}

// 1. Nothing to say means no turn.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: '' }))
  await sleep(200)
  check('an empty message starts no turn', t.transport.historyCalls.length === 0, `${t.transport.historyCalls.length}`)
  t.done()
}

// 2. Whitespace and zero-width characters are also nothing to say. A turn is an expensive
// way to answer " " — and a model asked about a blank message answers about nothing.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: '   ' }))
  await sleep(150)
  t.transport.deliver(t.transport.message({ text: '\u200b\u200b\u200b' }))
  await sleep(250)
  check('a whitespace-only message starts no turn', t.transport.historyCalls.length === 0, `${t.transport.historyCalls.length} turn(s)`)
  t.done()
}

// 3. A very large message is truncated, not refused and not passed whole.
{
  const t = boot({ config: { maxPromptChars: 4000 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'x'.repeat(100_000) }))
  await sleep(400)
  check('a 100 KB message still starts a turn', t.transport.historyCalls.length === 1, `${t.transport.historyCalls.length}`)
  check('and it is accepted rather than refused', t.logs.some((l) => /accepted channel=/.test(l)), 'the truncation itself is not observable from here — it happens where the prompt is built')
  t.done()
}

// 4. The same event twice is one message; two events with the same text are two.
{
  const t = boot()
  await sleep(60)
  const message = t.transport.message({ text: 'ping' })
  t.transport.deliver(message)
  await sleep(250)
  t.transport.deliver(message)                      // the same eventId
  await sleep(250)
  check('a duplicate event is ignored', t.transport.historyCalls.length === 1, `${t.transport.historyCalls.length} turn(s)`)
  t.transport.deliver(t.transport.message({ text: 'ping' }))   // a fresh event, same words
  await sleep(250)
  check('the same words in a new event are a new turn', t.transport.historyCalls.length === 2, `${t.transport.historyCalls.length}`)
  t.done()
}

// 5. Being addressed is what starts a turn, and unaddressed chatter must not.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'hello', addressed: false }))
  await sleep(250)
  check('an unaddressed message starts no turn', t.transport.historyCalls.length === 0, `${t.transport.historyCalls.length}`)
  t.done()
}

// 6. A message that is only an emoji is content, not whitespace.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: '👍🙂' }))
  await sleep(250)
  check('an emoji-only message is still a turn', t.transport.historyCalls.length === 1, `${t.transport.historyCalls.length}`)
  t.done()
}

// 7. Decision words survive ordinary punctuation, which is how people type them.
// Takes the route production takes: an approval has to exist for a decision to consume it,
// and the requester has to be the one answering.
{
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-edges-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: { 'C_ALLOWED:t1': 'slack-abc' }, seen: {}, standing: {}, history: {} }))
  const transport = createFakeTransport()
  const logs = []
  const listeners = {}
  const stubs = {
    agents: { create: async () => { throw new Error('fake: no agents') }, resume: async () => { throw new Error('fake: no agents') } },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
  }
  const ctx = { get: (n) => stubs[n], effect: (fn) => fn(), on: (n, h) => { (listeners[n] ??= []).push(h); return () => {} }, logger: { info: (l) => logs.push(String(l)) } }
  apply(ctx, { targetChannels: ['C_ALLOWED'], stateDir, transportFactory: () => transport, progressAfterMs: 50 })
  await sleep(80)

  transport.deliver(transport.message({ text: 'ping', user: 'U_OWNER' }))    // records the requester
  await sleep(250)
  const outcome = listeners['approval/request'][0]({ agent: { session: { header: { id: 'slack-abc' } } }, reason: 'edge case' })
  await sleep(150)
  const turnsBefore = transport.historyCalls.length
  transport.deliver(transport.message({ text: '허용!', user: 'U_OWNER' }))
  const settled = await Promise.race([outcome, sleep(300).then(() => 'pending')])
  check('허용! with punctuation is a decision, not a turn', settled === 'allowed-once', `outcome: ${settled}`)
  check('and it did not start a turn', transport.historyCalls.length === turnsBefore, `${transport.historyCalls.length - turnsBefore} new turn(s)`)
  rmSync(stateDir, { recursive: true, force: true })
}

// 8. A malformed message object does not throw out of the handler.
{
  const t = boot()
  await sleep(60)
  let threw = ''
  try {
    t.transport.deliver({ eventId: 'malformed-1', target: { channel: 'C_ALLOWED', threadTs: 't1' } })
  } catch (e) { threw = String(e?.message ?? e) }
  await sleep(250)
  check('a message with no text does not throw', threw === '', threw)
  check('and nothing is attempted', t.transport.historyCalls.length === 0, `${t.transport.historyCalls.length}`)
  t.done()
}

// 9. A scenario file that is not JSON is reported, not crashed into.
{
  const dir = mkdtempSync(join(tmpdir(), 'deepbot-scenario-'))
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{ this is not json')
  const run = spawnSync(process.execPath, ['test/run-scenario.mjs', broken, '--timeout', '30'], { encoding: 'utf8', cwd: process.cwd() })
  rmSync(dir, { recursive: true, force: true })
  check('a broken scenario file exits non-zero', run.status !== 0, `status ${run.status}`)
  check('and says what is wrong rather than hanging', /json|JSON|parse|not found|scenario/i.test(`${run.stdout}${run.stderr}`), `${run.stdout}${run.stderr}`.trim().split('\n').slice(-1)[0]?.slice(0, 100))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
