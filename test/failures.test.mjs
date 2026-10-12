/**
 * Failure injection: what the conversation sees when things break.
 *
 * The other suites check that the working paths work. This checks the failing ones, because
 * silence is the failure mode that costs the most: a person asks something, nothing comes
 * back, and they cannot tell whether the bot is thinking, broken, or gone.
 *
 * The fake agent is off by default (`create` throws). Here it can also **hang** — a create
 * that never resolves holds a turn open, which is the only way to exercise cancellation and
 * queueing without a real model.
 *
 * Run: node test/failures.test.mjs
 */
import './dist-fresh.mjs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../dist/index.js'
import { createFakeTransport } from './fake-transport.mjs'
import { createSlackTransport } from '../dist/transports/slack.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** `agents.create` behaviour: 'throw' (default), 'hang', or a working stub. */
function boot({ state = {}, config = {}, agent = 'throw' } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-fail-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {}, ...state }))
  const transport = createFakeTransport(config.fake ?? {})
  const logs = []
  const listeners = {}
  const created = []
  const stubs = {
    agents: {
      create: async (options) => {
        created.push(options)
        if (agent === 'hang') return await new Promise(() => {})       // never resolves
        throw new Error('fake: agents.create is not implemented')
      },
      resume: async () => { throw new Error('fake: no agents') },
    },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    // Without this the turn fails before it reaches agents.create, so cancellation and
    // queueing were never exercised — the sweep was testing the missing service instead.
    agentPresets: {
      resolve: async () => ({ id: 'standard' }),
      acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }),
      mount: async () => {},
    },
  }
  const ctx = { get: (n) => stubs[n], effect: (fn) => fn(), on: (n, h) => { (listeners[n] ??= []).push(h); return () => {} }, logger: { info: (l) => logs.push(String(l)) } }
  apply(ctx, { targetChannels: ['C_ALLOWED'], stateDir, transportFactory: () => transport, progressAfterMs: 50, ...config })
  return {
    transport, logs, created,
    read: () => JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')),
    done: () => rmSync(stateDir, { recursive: true, force: true }),
  }
}

// 1. A failed turn tells the conversation. Silence would look like being ignored.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'do something' }))
  await sleep(400)
  const posted = t.transport.posted.map((p) => p.text).join('\n')
  check('a failed turn posts something to the conversation', posted !== '', JSON.stringify(posted.slice(0, 80)))
  check('and it says it failed', /실패|failed|error|Error/.test(posted), posted.slice(0, 90))
  check('the reason is in the log', t.logs.some((l) => /turn failed/.test(l)), t.logs.filter((l) => /failed/.test(l)).join(' | ').slice(0, 120))
  t.done()
}

// 2. Two messages in one conversation are both answered, not dropped.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'first' }))
  await sleep(40)
  t.transport.deliver(t.transport.message({ text: 'second' }))
  await sleep(600)
  check('both messages reach an agent', t.created.length === 2, `${t.created.length} create(s)`)
  check('and both are answered', t.transport.posted.filter((p) => /실패|failed/.test(p.text)).length >= 2,
    `${t.transport.posted.length} post(s)`)
  t.done()
}

// 3. While a turn is open, another message must not be lost.
//
// There is deliberately no per-conversation serialization here: the queue is a global FIFO
// bounded by `maxConcurrency`, and two turns in one conversation collide on the session,
// which the adopt path absorbs by retrying on "active write handle". What matters is that
// the second message is not dropped. A per-conversation queue would be tidier — that is a
// product gap, not a defect, and this check does not pretend otherwise.
{
  const t = boot({ agent: 'hang' })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'slow one' }))
  await sleep(250)
  t.transport.deliver(t.transport.message({ text: 'while you are busy' }))
  await sleep(400)
  check('a message during a turn is not dropped', t.created.length === 2, `${t.created.length} create(s) — the second is attempted, not ignored`)
  check('and nothing says it was ignored', !t.logs.some((l) => /ignored|dropped|refused the message/i.test(l)),
    t.logs.filter((l) => /accepted|ignored|dropped/.test(l)).join(' | ').slice(0, 120))
  t.done()
}

// 4. Stopping a turn that is open actually stops it, and says so.
{
  const t = boot({ agent: 'hang' })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'slow one' }))
  await sleep(300)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(300)
  check('a stop request is acknowledged', t.transport.posted.some((p) => /중단|멈|취소|stop/i.test(p.text)),
    JSON.stringify(t.transport.posted.map((p) => p.text.slice(0, 24))))
  t.done()
}

// 5. Stopping when nothing runs says so instead of being silent.
{
  const t = boot()
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(300)
  check('stopping nothing is answered', t.transport.posted.length > 0, JSON.stringify(t.transport.posted.map((p) => p.text.slice(0, 30))))
  check('and it starts no turn', t.created.length === 0, `${t.created.length} create(s)`)
  t.done()
}

// 6. A credential that is not there is named, not silently empty.
{
  const logs = []
  const t = createSlackTransport({
    cfg: { platform: 'slack', stateDir: '.', targetChannels: ['*'], botTokenRef: 'SLACK_BOT_TOKEN_MISSING', appTokenRef: 'SLACK_APP_TOKEN_MISSING' },
    log: (...p) => logs.push(p.join(' ')),
    sessionCwd: async () => process.cwd(),
    credential: async () => undefined,
    onHealth: () => {},
  })
  let message = ''
  try { await t.authenticate() } catch (e) { message = String(e?.message ?? e) }
  check('a missing credential is an error, not an empty token', message !== '', message)
  check('and the error names the reference', /SLACK_BOT_TOKEN_MISSING/.test(message), message)
  check('the transport is not ready', t.ready() === false)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
