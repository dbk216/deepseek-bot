/**
 * Long-run resource behaviour: state that grows forever.
 *
 * The interesting failure is not a spike, it is a file that keeps growing — one entry per
 * thread ever seen, per standing digest, per usage total — for as long as a busy workspace
 * keeps talking. A gateway running for months would carry all of it in memory and rewrite it
 * on every turn.
 *
 * `state.seen` is pruned by age already. This asks whether the per-conversation maps are.
 *
 * Run: node test/resources.test.mjs
 */
import './dist-fresh.mjs'
import './scratch-dsh-home.mjs'   // the recall index must not land in the real ~/.dsh
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

function boot({ state, config = {} }) {
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-res-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify(state))
  const transport = createFakeTransport()
  const logs = []
  const listeners = {}
  const stubs = {
    agents: { create: async () => { throw new Error('fake: no agents') }, resume: async () => { throw new Error('fake: no agents') } },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'f', model: 'f' }) },
    agentPresets: { resolve: async () => ({ id: 'standard' }), acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }), mount: async () => {} },
  }
  apply({ get: (n) => stubs[n], effect: (f) => f(), on: (n, h) => { (listeners[n] ??= []).push(h); return () => {} }, logger: { info: (l) => logs.push(String(l)) } },
    { targetChannels: ['*'], stateDir, transportFactory: () => transport, progressAfterMs: 50, ...config })
  return {
    transport, logs,
    path: join(stateDir, 'sessions.json'),
    read: () => JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')),
    size: () => statSync(join(stateDir, 'sessions.json')).size,
    done: () => rmSync(stateDir, { recursive: true, force: true }),
  }
}

const DAY = 24 * 3600 * 1000
const OLD = Date.now() - 200 * DAY      // far beyond any retention window

// 1. Events dedupe state is pruned by age.
{
  const seen = {}
  for (let i = 0; i < 500; i++) seen[`old-${i}`] = OLD
  const t = boot({ state: { sessions: {}, seen, standing: {}, history: {} } })
  await sleep(80)
  t.transport.deliver(t.transport.message({ text: 'hello' }))
  await sleep(600)
  const after = t.read()
  check('old dedupe entries are pruned on write', Object.keys(after.seen ?? {}).length <= 2, `${Object.keys(after.seen ?? {}).length} left of 500`)
  t.done()
}

// 2. Conversations that have not been heard from in months do not live forever.
// One entry per thread, per standing digest, per history cursor and per usage total means a
// busy workspace accumulates all of it permanently, and rewrites it on every turn.
{
  const sessions = {}, standing = {}, history = {}, conversations = {}
  for (let i = 0; i < 400; i++) {
    const key = `C_OLD${i}:1000.${i}`
    sessions[key] = `slack-old-${i}`
    standing[key] = 'x'.repeat(200)
    history[key] = '1000.1'
    conversations[key] = { turns: 1, uncached: 10, cached: 0, written: 0, output: 1, lastAt: OLD }
  }
  const t = boot({ state: { sessions, seen: {}, standing, history, usage: { conversations, sessions: {} } } })
  await sleep(80)
  const before = Object.keys(t.read().sessions ?? {}).length
  t.transport.deliver(t.transport.message({ text: 'a fresh conversation', target: { channel: 'C_NEW', threadTs: 't1' } }))
  await sleep(600)
  const after = t.read()
  const left = Object.keys(after.sessions ?? {}).length
  check('stale conversations are pruned', left < before, `${left} conversation(s) left of ${before}`)
  check('their standing digests go with them', Object.keys(after.standing ?? {}).length < 400, `${Object.keys(after.standing ?? {}).length} left`)
  check('their usage totals go with them', Object.keys(after.usage?.conversations ?? {}).length < 400, `${Object.keys(after.usage?.conversations ?? {}).length} left`)
  // The fresh message's turn fails in this harness, so it never creates a session — what the
  // plugin records for it is the touch, and that is what has to survive.
  check('the fresh conversation is kept', typeof after.touched?.['C_NEW:t1'] === 'number',
    JSON.stringify(Object.keys(after.touched ?? {})))
  t.done()
}

// 3. A state file with months of history shrinks instead of being carried forever.
{
  // With timestamps, so there is evidence to act on: an entry with no timestamp is kept on
  // purpose, and a test that seeded none would be asking for state to be deleted on no
  // evidence at all.
  const sessions = {}
  const conversations = {}
  for (let i = 0; i < 2000; i++) {
    sessions[`C${i}:1.${i}`] = `slack-${i}`
    conversations[`C${i}:1.${i}`] = { turns: 1, uncached: 10, cached: 0, written: 0, output: 1, lastAt: OLD }
  }
  const t = boot({ state: { sessions, seen: {}, standing: {}, history: {}, usage: { conversations, sessions: {} } } })
  const before = t.size()
  await sleep(80)
  t.transport.deliver(t.transport.message({ text: 'hello' }))
  await sleep(600)
  check('the state file does not keep growing with historical conversations', t.size() < before * 0.5, `${before} → ${t.size()} bytes`)
  t.done()
}

// 4. Fifty turns do not leave the process holding on to them. Reported, with a generous bound:
// the point is to catch a leak of a whole agent per turn, not to measure allocator noise.
{
  const t = boot({ state: { sessions: {}, seen: {}, standing: {}, history: {} } })
  await sleep(80)
  global.gc?.()
  const before = process.memoryUsage().heapUsed
  for (let i = 0; i < 50; i++) {
    t.transport.deliver(t.transport.message({ text: `turn ${i}` }))
    await sleep(25)
  }
  await sleep(800)
  global.gc?.()
  const after = process.memoryUsage().heapUsed
  const growthMb = (after - before) / 1024 / 1024
  check('fifty turns do not grow the heap without bound', growthMb < 40, `${growthMb.toFixed(1)} MB over 50 turns`)
  check('and every turn was answered', t.transport.posted.length >= 50, `${t.transport.posted.length} post(s)`)
  t.done()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
