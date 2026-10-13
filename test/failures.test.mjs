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

// 3. While a turn is open, another message in the same conversation waits for it.
//
// This used to assert the opposite on purpose: no per-conversation serialization, two turns
// colliding on one session, the adopt path absorbing it by retrying on "active write handle".
// In practice the second turn waited out three retries and answered "Execution failed", and in a
// new thread it created a second session and the mapping kept whichever finished last. Now the
// second message queues behind the first and runs when it ends; other conversations are not held.
{
  const t = boot({ agent: 'hang', config: { runTimeoutMs: 500 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'slow one' }))
  await sleep(150)
  t.transport.deliver(t.transport.message({ text: 'while you are busy' }))
  await sleep(150)
  check('a second message waits while the first turn is open', t.created.length === 1, `${t.created.length} create(s)`)
  await sleep(900)
  check('and runs once the first turn has ended', t.created.length === 2, `${t.created.length} create(s)`)
  check('nothing says it was ignored', !t.logs.some((l) => /ignored|dropped|refused the message/i.test(l)),
    t.logs.filter((l) => /accepted|ignored|dropped/.test(l)).join(' | ').slice(0, 120))
  t.done()
}

// 3b. A stop withdraws what is waiting as well as what is running. Without it the bot said it had
// stopped and then started on the next message in the queue.
{
  const t = boot({ agent: 'hang', config: { runTimeoutMs: 500 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'slow one' }))
  await sleep(150)
  t.transport.deliver(t.transport.message({ text: 'queued behind it' }))
  await sleep(50)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(1200)
  check('a waiting message is withdrawn by a stop, not run afterwards', t.created.length === 1, `${t.created.length} create(s)`)
  t.done()
}

// 3c. A stop for a message that has not started says it stopped it — not "nothing is running" while
// "작업 중" is on screen — and the report takes the working message's place.
{
  const t = boot({ agent: 'hang', config: { maxConcurrency: 1, runTimeoutMs: 60000, targetChannels: ['*'] } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'elsewhere', target: { channel: 'C_OTHER', threadTs: 't0' } }))
  await sleep(150)
  t.transport.deliver(t.transport.message({ text: 'waits for a slot' }))
  await sleep(150)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(300)
  const posts = t.transport.posted.map((p, i) => ({ ...p, ts: `ts-${i + 1}` }))
  const inThread = posts.filter((p) => p.target.channel === 'C_ALLOWED')
  const working = inThread.find((p) => p.replace === null && /작업 중/.test(p.text))
  const report = inThread[inThread.length - 1]
  check('the stop says it withdrew the waiting message', /중단/.test(report?.text ?? '') && !/없어/.test(report?.text ?? ''), report?.text)
  check('in place of the working message', working !== undefined && report?.replace === working.ts, JSON.stringify(inThread).slice(0, 160))
  check('and the waiting message never starts', t.created.length === 1, `${t.created.length} create(s)`)
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
