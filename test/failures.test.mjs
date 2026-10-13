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
import './scratch-dsh-home.mjs'   // the recall index must not land in the real ~/.dsh
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

/** `agents.create` behaviour: 'throw' (default), 'hang', or 'slow' (see below). */
function boot({ state = {}, config = {}, agent = 'throw' } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-fail-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {}, ...state }))
  const transport = createFakeTransport(config.fake ?? {})
  const logs = []
  const listeners = {}
  const created = []
  // 'slow': the create takes 100 ms, and the agent runs until it is cancelled. The delay is what puts
  // the turn's own timeout behind the job's, which is the order that let a timed-out turn release the
  // conversation while its agent still ran.
  const events = []
  let agentsMade = 0
  // Holds the preset step open, so a stop can arrive before the agent is even asked for.
  const resolveDelayMs = Number(config.resolveDelayMs ?? 0)
  async function slowAgent(options) {
    const n = ++agentsMade
    await sleep(100)
    events.push({ at: Date.now(), kind: 'created', n })
    let stop
    const stopped = new Promise((resolve) => { stop = resolve })
    return {
      agent: {
        session: { header: { id: options?.sessionId ?? `s${n}` }, seq: 0, eventAt: () => undefined },
        followup: () => {}, whenIdle: () => stopped,
        cancel: (reason) => { events.push({ at: Date.now(), kind: 'cancelled', n, reason }); stop() },
      },
      dispose: async () => { events.push({ at: Date.now(), kind: 'disposed', n }) },
    }
  }
  const stubs = {
    agents: {
      create: async (options) => {
        created.push(options)
        if (agent === 'hang') return await new Promise(() => {})       // never resolves
        if (agent === 'slow') return slowAgent(options)
        throw new Error('fake: agents.create is not implemented')
      },
      // A second turn in the conversation resumes the first one's session.
      resume: async (options) => { if (agent === 'slow') return slowAgent(options); throw new Error('fake: no agents') },
    },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    // Without this the turn fails before it reaches agents.create, so cancellation and
    // queueing were never exercised — the sweep was testing the missing service instead.
    agentPresets: {
      resolve: async () => { if (resolveDelayMs > 0) await sleep(resolveDelayMs); return { id: 'standard' } },
      acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }),
      mount: async () => {},
    },
  }
  const ctx = { get: (n) => stubs[n], effect: (fn) => fn(), on: (n, h) => { (listeners[n] ??= []).push(h); return () => {} }, logger: { info: (l) => logs.push(String(l)) } }
  apply(ctx, { targetChannels: ['C_ALLOWED'], stateDir, transportFactory: () => transport, progressAfterMs: 50, ...config })
  return {
    transport, logs, created, events,
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
  await sleep(1100)
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
  // The other conversation holds the only slot until its backstop (400 ms + 400 ms grace) lets go;
  // the checks run after that, so a withdrawn message that still ran would be counted. Checked at
  // 300 ms, as first written, nothing could have run yet either way.
  const t = boot({ agent: 'hang', config: { maxConcurrency: 1, runTimeoutMs: 400, targetChannels: ['*'] } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'elsewhere', target: { channel: 'C_OTHER', threadTs: 't0' } }))
  await sleep(150)
  t.transport.deliver(t.transport.message({ text: 'waits for a slot' }))
  await sleep(150)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(1400)
  const posts = t.transport.posted.map((p, i) => ({ ...p, ts: `ts-${i + 1}` }))
  const inThread = posts.filter((p) => p.target.channel === 'C_ALLOWED')
  const working = inThread.find((p) => p.replace === null && /작업 중/.test(p.text))
  const report = inThread[inThread.length - 1]
  check('the stop says it withdrew the waiting message', /중단/.test(report?.text ?? '') && !/없어/.test(report?.text ?? ''), report?.text)
  check('in place of the working message', working !== undefined && report?.replace === working.ts, JSON.stringify(inThread).slice(0, 160))
  check('and the waiting message never starts', t.created.length === 1, `${t.created.length} create(s)`)
  t.done()
}

// 3d. A turn that times out is stopped before the conversation's next message starts. The job's own
// timeout fired first (it starts before the agent exists, the turn's after), so the next turn began
// while the old agent still ran, and the old turn's timer — looking up the conversation's key —
// cancelled the new turn instead of its own.
{
  const t = boot({ agent: 'slow', config: { runTimeoutMs: 300 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'runs past its timeout' }))
  await sleep(20)
  t.transport.deliver(t.transport.message({ text: 'next' }))
  await sleep(1300)
  const firstCancel = t.events.find((e) => e.kind === 'cancelled' && e.n === 1)
  const secondCreate = t.events.find((e) => e.kind === 'created' && e.n === 2)
  check('the timed-out turn\'s own agent is cancelled', firstCancel !== undefined, JSON.stringify(t.events))
  check('and the next message starts only after that', firstCancel !== undefined && secondCreate !== undefined && secondCreate.at >= firstCancel.at,
    JSON.stringify(t.events.map((e) => `${e.kind}${e.n}`)))
  t.done()
}

// 3e. A stop ends the typing of the messages it withdraws at once — not when they would have reached
// a slot, which behind another conversation's turn could be minutes of "typing…" under "중단했어".
{
  const t = boot({ agent: 'hang', config: { maxConcurrency: 1, runTimeoutMs: 60000, targetChannels: ['*'], fake: { typing: true } } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'elsewhere', target: { channel: 'C_OTHER', threadTs: 't0' } }))
  await sleep(100)
  t.transport.deliver(t.transport.message({ text: 'waits for a slot' }))
  await sleep(100)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(100)
  const typing = t.transport.typing.find((entry) => entry.target.channel === 'C_ALLOWED')
  check('the withdrawn message stops typing at once', typing?.stopped === true, JSON.stringify(t.transport.typing))
  t.done()
}

// 3f. A stop while the agent is being created releases that agent. The early return sat before the
// try/finally, so the handle was never disposed, and the queue starts the next turn at once.
{
  const t = boot({ agent: 'slow', config: { runTimeoutMs: 5000 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'stopped while it is created' }))
  await sleep(50)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(400)
  check('a turn stopped during its create disposes the agent', t.events.some((e) => e.kind === 'disposed' && e.n === 1),
    JSON.stringify(t.events.map((e) => `${e.kind}${e.n}`)))
  t.done()
}

// 3g. A stop during the preset step reaches the turn. Registered after those awaits, the turn looked
// idle there: the stop answered "nothing is running" and the turn went ahead.
{
  const t = boot({ agent: 'slow', config: { runTimeoutMs: 5000, resolveDelayMs: 200 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'slow to prepare' }))
  await sleep(50)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(500)
  const said = t.transport.posted.map((p) => p.text)
  check('the stop finds the turn', !said.some((text) => /없어/.test(text)), JSON.stringify(said))
  check('and the turn creates no agent', t.created.length === 0, `${t.created.length} create(s)`)
  // Nor maps one: the id was never created, and a mapping made every later message in this thread
  // resume a session that does not exist.
  await sleep(100)
  check('and the conversation is not mapped to a session that was never made', t.read().sessions?.['C_ALLOWED:t1'] === undefined,
    String(t.read().sessions?.['C_ALLOWED:t1']))
  t.done()
}

// 3h. A stop while the agent is being created is reported once. It said "중단했어 — 시작 중이던 작업을
// 멈췄어" at once, and "중단했어." again when the turn came back.
{
  const t = boot({ agent: 'slow', config: { runTimeoutMs: 5000 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'stopped while it is created' }))
  await sleep(50)
  t.transport.deliver(t.transport.message({ text: '그만' }))
  await sleep(500)
  const reports = t.transport.posted.filter((p) => /중단/.test(p.text))
  check('a stop during preparation is reported once', reports.length === 1, JSON.stringify(t.transport.posted.map((p) => p.text.slice(0, 30))))
  check('in place of the working message', reports[0]?.replace !== null && reports[0]?.replace !== undefined, JSON.stringify(reports[0]))
  t.done()
}

// 3i. A turn in flight is written down, so a restart can say what it lost. Before, a restart dropped
// the turn without a word and left "작업 중" on screen.
{
  const t = boot({ agent: 'hang', config: { runTimeoutMs: 60000 } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'long one' }))
  await sleep(300)
  const record = t.read().inflight?.['C_ALLOWED:t1']
  check('a turn in flight is recorded in the state file', record?.channel === 'C_ALLOWED' && record?.threadTs === 't1', JSON.stringify(t.read().inflight))
  check('with its working message', typeof record?.placeholder === 'string', JSON.stringify(record))
  t.done()
}
{
  const t = boot({ state: { inflight: { 'C_ALLOWED:t1': { channel: 'C_ALLOWED', threadTs: 't1', placeholder: 'ts-old', since: Date.now() - 5000 } } } })
  await sleep(300)
  const notice = t.transport.posted.find((p) => /끊겼어/.test(p.text))
  check('after a restart the conversation is told its turn was lost', notice !== undefined, JSON.stringify(t.transport.posted.map((p) => p.text.slice(0, 30))))
  check('in place of the working message that was left behind', notice?.replace === 'ts-old', JSON.stringify(notice))
  check('and the record is cleared', Object.keys(t.read().inflight ?? {}).length === 0, JSON.stringify(t.read().inflight))
  t.done()
}
// A message that arrives while the notices are still going out is a new turn, and is tracked as one.
// Records were cleared one at a time between awaits: a new turn in a conversation not yet reached found
// the old record, skipped writing its own, and then lost the old one to the loop — untracked.
{
  const since = Date.now() - 5000
  const t = boot({ agent: 'hang', config: { runTimeoutMs: 60000, fake: { postDelayMs: 400 } }, state: { inflight: {
    'C_ALLOWED:t0': { channel: 'C_ALLOWED', threadTs: 't0', placeholder: 'ts-a', since },
    'C_ALLOWED:t1': { channel: 'C_ALLOWED', threadTs: 't1', placeholder: 'ts-b', since },
  } } })
  await sleep(60)
  t.transport.deliver(t.transport.message({ text: 'new one' }))
  await sleep(1500)
  const record = t.read().inflight?.['C_ALLOWED:t1']
  check('a turn begun during recovery is tracked', record !== undefined && Number(record.since) > since, JSON.stringify(t.read().inflight))
  check('and both lost turns were still reported', t.transport.posted.filter((p) => /끊겼어/.test(p.text)).length === 2)
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
