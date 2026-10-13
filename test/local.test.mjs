/**
 * The local transport (a unix socket the terminal UI connects to), the composite that serves it
 * beside Slack, and what the core does differently per conversation.
 *
 * The claims: only the owner can connect (0600), a frame in becomes the same InboundMessage any
 * platform produces, a reply that finds no terminal is kept for the next one, and putting a TUI
 * beside Slack changes nothing for Slack — its sessions are still `slack-…`, it still gets a
 * working message instead of typing, and it is still asked to approve in words, not buttons.
 *
 * Run: node test/local.test.mjs
 */
import './dist-fresh.mjs'   // fails loudly on a stale dist

import { connect } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Discovery files go under DSH_HOME; never the real one.
const DSH_HOME = mkdtempSync(join(tmpdir(), 'deepbot-dshhome-'))
process.env.DSH_HOME = DSH_HOME

const { apply } = await import('../dist/index.js')
const { createLocalTransport, LOCAL_CHANNEL } = await import('../dist/transports/local.js')
const { createCompositeTransport } = await import('../dist/transports/composite.js')
const { encode, FrameReader, PROTOCOL_VERSION } = await import('../dist/tui/protocol.js')
const { recallIndexPath } = await import('../dist/recallContext.js')
const { Connection } = await import('../dist/tui/client.js')
const { createFakeTransport } = await import('./fake-transport.mjs')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A terminal-side client: send frames, wait for the ones that match. */
function client(socketPath) {
  const frames = []
  const reader = new FrameReader()
  const socket = connect(socketPath)
  socket.setEncoding('utf8')
  socket.on('data', (d) => { for (const r of reader.push(d)) if (r.frame) frames.push(r.frame) })
  const opened = new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  return {
    frames,
    opened,
    send: (frame) => socket.write(encode(frame)),
    async waitFor(predicate, ms = 2000) {
      const until = Date.now() + ms
      while (Date.now() < until) {
        const hit = frames.find(predicate)
        if (hit) return hit
        await sleep(10)
      }
      return null
    },
    close: () => new Promise((r) => { socket.end(); socket.once('close', r); setTimeout(r, 200) }),
  }
}

function hostFor(stateDir, cfg = {}) {
  const logs = []
  return {
    logs,
    host: { cfg: { cancelWords: ['그만', 'stop'], usageWords: ['사용량'], tenantIsolation: false, ...cfg }, stateDir, log: (...p) => logs.push(p.join(' ')), sessionCwd: async () => '/home/agent', credential: async () => undefined, onHealth: () => {} },
  }
}

// ── 1. The local transport on its own ────────────────────────────────────────
{
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-local-'))
  const { host } = hostFor(stateDir)
  const local = createLocalTransport(host)
  const inbound = []
  const actions = []
  await local.connect({ onMessage: (m) => inbound.push(m), onAction: (a) => actions.push(a), onStatus: () => {} })
  const socketPath = join(stateDir, 'tui.sock')
  check('local: listens on <stateDir>/tui.sock', existsSync(socketPath) && local.hasSocket() && local.ready())
  check('local: the socket is owner-only (0600)', (statSync(socketPath).mode & 0o777) === 0o600, (statSync(socketPath).mode & 0o777).toString(8))
  const discovery = join(DSH_HOME, 'run', 'deepbot-tui', 'default.json')
  const found = existsSync(discovery) ? JSON.parse(readFileSync(discovery, 'utf8')) : null
  check('local: writes a discovery file naming the socket', found?.socket === socketPath && found?.pid === process.pid)

  const c = client(socketPath)
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION })
  const ready = await c.waitFor((f) => f.type === 'ready')
  check('hello: answered with ready and a new conversation id', ready !== null && /^[0-9a-f-]{36}$/.test(ready.conversation) && ready.workspace === '/home/agent', JSON.stringify(ready))
  const conv = ready?.conversation

  c.send({ type: 'message', text: '배포 일정 알려줘' })
  await sleep(50)
  const m = inbound[0]
  check('message: becomes an InboundMessage for the tui channel and this conversation', m?.target?.channel === LOCAL_CHANNEL && m?.target?.threadTs === conv && m?.text === '배포 일정 알려줘' && m?.addressed === true && Array.isArray(m?.files), JSON.stringify(m))
  c.send({ type: 'message', text: '두 번째' })
  await sleep(50)
  check('message: every message has its own event id', inbound.length === 2 && inbound[0].eventId !== inbound[1].eventId)

  c.send({ type: 'cancel' })
  await sleep(50)
  check('cancel: arrives as the first configured cancel word, the path every platform uses', inbound[2]?.text === '그만')

  const target = { channel: LOCAL_CHANNEL, threadTs: conv }
  const stop = local.startTyping(target)
  check('typing: on', (await c.waitFor((f) => f.type === 'typing' && f.on === true)) !== null)
  stop()
  check('typing: off when stopped', (await c.waitFor((f) => f.type === 'typing' && f.on === false)) !== null)

  const posted = await local.post(target, '답변입니다', { buttons: [{ id: 'approval:allow:k', label: '허용', style: 'primary' }] })
  const frame = await c.waitFor((f) => f.type === 'post' && f.text === '답변입니다')
  check('post: reaches the terminal with its buttons, and returns a message id', posted?.ts === frame?.ts && frame?.buttons?.[0]?.label === '허용', JSON.stringify(frame))
  await local.post(target, '고친 답변', { replace: posted.ts })
  const edited = await local.post(target, '한 번 더 고친 답변', { replace: posted.ts })
  check('post: a replacement names the message it replaces and keeps its id', (await c.waitFor((f) => f.type === 'post' && f.replace === posted.ts)) !== null && edited?.ts === posted.ts)
  check('remove: tells the terminal which message to drop', (await local.remove(target, posted.ts)) === true && (await c.waitFor((f) => f.type === 'remove' && f.ts === posted.ts)) !== null)

  // The core's buttons carry the request they were posted with: `#<8 hex>`, passed on as it is.
  c.send({ type: 'action', id: `approval:allow:tui:${conv}#0a1b2c3d` })
  await sleep(50)
  check('action: a button press reaches the core with its conversation and request', actions[0]?.id === `approval:allow:tui:${conv}#0a1b2c3d` && actions[0]?.target?.threadTs === conv)
  c.send({ type: 'action', id: 'approval:allow:C_SLACK:1.2#0a1b2c3d' })
  c.send({ type: 'action', id: 'approval:allow:tui:somebody-else#0a1b2c3d' })
  c.send({ type: 'action', id: `approval:allow:tui:${conv}#not-hex!` })
  await sleep(50)
  check('action: a button for another conversation (Slack\'s or another terminal\'s), or a malformed one, is refused', actions.length === 1 && c.frames.filter((f) => f.type === 'error' && f.code === 'not-offered').length === 3)

  const huge = await local.post(target, 'x'.repeat(1_100_000))
  check('post: a message too large for one frame becomes a stated error, not a dropped line', huge !== null && (await c.waitFor((f) => f.type === 'error' && f.code === 'too-large')) !== null)

  c.send({ type: 'hello', version: 999 })
  check('hello: a different protocol version is refused', (await c.waitFor((f) => f.type === 'error' && f.code === 'version')) !== null)

  // A reply that finds no terminal is kept and delivered when that conversation reconnects.
  await c.close()
  await sleep(50)
  await local.post(target, '자리 비운 사이 도착한 답변')
  const back = client(socketPath)
  await back.opened
  back.send({ type: 'hello', version: PROTOCOL_VERSION, conversation: conv })
  const missed = await back.waitFor((f) => f.type === 'post' && f.text === '자리 비운 사이 도착한 답변')
  check('reconnect: a reply that arrived while away is delivered after ready', missed !== null && back.frames.findIndex((f) => f.type === 'ready') < back.frames.indexOf(missed))

  const other = client(socketPath)
  await other.opened
  other.send({ type: 'hello', version: PROTOCOL_VERSION, tenant: 'acme' })
  check('tenant: refused when tenant isolation is off — no half-working option', (await other.waitFor((f) => f.type === 'error' && f.code === 'tenant-isolation-off')) !== null)

  const junk = client(socketPath)
  await junk.opened
  junk.send({ type: 'hello', version: PROTOCOL_VERSION })
  await junk.waitFor((f) => f.type === 'ready')
  junk.send({ type: 'message' })
  check('frames: a message without text is refused, not delivered', (await junk.waitFor((f) => f.type === 'error' && f.code === 'bad-frame')) !== null && inbound.length === 3)

  await back.close(); await other.close(); await junk.close()
  const closed = await local.close()
  check('close: reports it had a socket, removes it and the discovery file', closed === true && !existsSync(socketPath) && !existsSync(discovery))
  rmSync(stateDir, { recursive: true, force: true })
}

// ── 2. Restarting over a stale socket, and a path too long for the platform ───
{
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-local-'))
  writeFileSync(join(stateDir, 'tui.sock'), '')   // left behind by a crash
  const { host } = hostFor(stateDir)
  const local = createLocalTransport(host)
  await local.connect({ onMessage: () => {}, onStatus: () => {} })
  check('stale: a leftover socket file is replaced', local.hasSocket())
  check('connect: a second connect is a no-op', (await local.connect({ onMessage: () => {}, onStatus: () => {} }), local.hasSocket()))
  await local.close()

  const deep = join(stateDir, 'a'.repeat(60), 'b'.repeat(60))
  const { host: h2, logs } = hostFor(deep)
  const long = createLocalTransport(h2)
  await long.connect({ onMessage: () => {}, onStatus: () => {} })
  const where = JSON.parse(readFileSync(join(DSH_HOME, 'run', 'deepbot-tui', 'default.json'), 'utf8')).socket
  check('long path: falls back to a short per-user path and says so', long.hasSocket() && Buffer.byteLength(where) <= 103 && logs.some((l) => l.includes('too long')), where)
  await long.close()
  rmSync(stateDir, { recursive: true, force: true })
}

// ── 3. The composite routes by conversation ───────────────────────────────────
{
  const slack = createFakeTransport()
  const tui = createFakeTransport({ typing: true, remove: true, supportsButtons: true })
  tui.claims = (target) => target?.channel === LOCAL_CHANNEL
  tui.ready = () => true
  tui.hasSocket = () => true
  slack.ready = () => false
  slack.hasSocket = () => false
  const both = createCompositeTransport([slack, tui])
  check('composite: identity is the primary platform\'s', (await both.identity()).name === 'fakebot')
  check('composite: a tui target resolves to the local part', both.forTarget({ channel: LOCAL_CHANNEL, threadTs: 'c1' }) === tui)
  check('composite: anything else resolves to the primary part', both.forTarget({ channel: 'C1', threadTs: 't1' }) === slack)
  await both.post({ channel: LOCAL_CHANNEL, threadTs: 'c1' }, 'to tui')
  await both.post({ channel: 'C1', threadTs: 't1' }, 'to slack')
  check('composite: posts go to the part that owns the conversation', tui.posted[0]?.text === 'to tui' && slack.posted[0]?.text === 'to slack' && tui.posted.length === 1 && slack.posted.length === 1)
  check('composite: ready is the primary\'s, hasSocket is any part\'s', both.ready() === false && both.hasSocket() === true)

  // One part failing to connect does not stop the other; the retry connects only what failed.
  let attempts = 0
  const flaky = createFakeTransport()
  const real = flaky.connect
  flaky.connect = async (h) => { attempts++; if (attempts === 1) throw new Error('no token yet'); return real(h) }
  const local2 = createFakeTransport()
  let localConnects = 0
  const realLocal = local2.connect
  local2.connect = async (h) => { localConnects++; return realLocal(h) }
  local2.claims = (t) => t?.channel === LOCAL_CHANNEL
  const mixed = createCompositeTransport([flaky, local2])
  let threw = false
  try { await mixed.connect({ onMessage: () => {}, onStatus: () => {} }) } catch { threw = true }
  check('composite: a failing part is reported, the local part is up anyway', threw && localConnects === 1)
  await mixed.connect({ onMessage: () => {}, onStatus: () => {} })
  check('composite: the retry connects only the part that failed', attempts === 2 && localConnects === 1)

  // While the primary cannot say who it is (no token), the composite answers with the next part's.
  const deaf = createFakeTransport()
  deaf.identity = async () => { throw new Error('missing token') }
  const local3 = createFakeTransport()
  local3.claims = (t) => t?.channel === LOCAL_CHANNEL
  local3.identity = async () => ({ name: 'deepbot', id: 'local' })
  check('composite: identity falls back to the terminal while the platform cannot authenticate', (await createCompositeTransport([deaf, local3]).identity().catch(() => null))?.id === 'local')
}

{
  // What a process left unreported is reported by the next, once: a record kept in restartLost (the
  // process crashed before its recovery ran) is told, and the restart after that tells nothing again.
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-restartlost-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {},
    restartLost: { 'C_ALLOWED:t5': { channel: 'C_ALLOWED', threadTs: 't5', placeholder: 'ts-left', since: Date.now() - 5000 } } }))
  const boot = async () => {
    const fake = createFakeTransport()
    let unload = () => {}
    apply({ get: () => undefined, effect: (fn) => { unload = fn() }, on: () => () => {}, logger: { info: () => {} } },
      { targetChannels: ['C_ALLOWED'], stateDir, autoIndex: false, transportFactory: () => fake })
    await sleep(300)
    unload()
    await sleep(50)
    return fake.posted.filter((p) => p.target?.threadTs === 't5' && /끊겼어/.test(p.text))
  }
  const first = await boot()
  check('restart: a record the previous process kept unreported is reported', first.length === 1 && first[0].replace === 'ts-left', JSON.stringify(first))
  const second = await boot()
  check('restart: and the restart after that does not report it again', second.length === 0, JSON.stringify(second))
  rmSync(stateDir, { recursive: true, force: true })
}

{
  // The core with Slack failing to authenticate: the terminal comes up anyway.
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-slackdown-'))
  const slack = createFakeTransport()
  // A bad bot token: who it is fails, while connecting (Socket Mode, the app token) would succeed.
  let authOk = false
  let slackConnects = 0
  slack.identity = async () => { if (!authOk) throw new Error('invalid_auth'); return { name: 'fakebot', id: 'U_FAKE' } }
  slack.connect = async () => { slackConnects++ }
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {},
    inflight: {
      'tui:conv-lost': { channel: LOCAL_CHANNEL, threadTs: 'conv-lost', since: Date.now() - 5000 },
      'C_ALLOWED:t9': { channel: 'C_ALLOWED', threadTs: 't9', since: Date.now() - 5000 },
    } }))
  const logs = []
  // A terminal turn that runs until released: it must outlive a retry of the start.
  let release = () => {}
  let made = 0
  const stubs = {
    agents: {
      create: async (o) => {
        made++
        const gate = new Promise((r) => { release = r })
        return { agent: { id: o.sessionId, session: { id: o.sessionId, header: { id: o.sessionId }, seq: 0, eventAt: () => undefined }, followup: () => {}, whenIdle: () => gate, cancel: () => {} }, dispose: async () => {} }
      },
      resume: async () => { throw new Error('no') },
    },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agentPresets: { resolve: async (id) => ({ id }), acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }), mount: async () => {} },
  }
  let unload = () => {}
  apply({ get: (n) => stubs[n], effect: (fn) => { unload = fn() }, on: () => () => {}, logger: { info: (l) => logs.push(String(l)) } }, {
    targetChannels: ['*'], stateDir, autoIndex: false,
    transportFactory: (host) => createCompositeTransport([slack, createLocalTransport(host)]),
  })
  await sleep(300)
  const c = client(join(stateDir, 'tui.sock'))
  let up = true
  await c.opened.catch(() => { up = false })
  if (up) c.send({ type: 'hello', version: PROTOCOL_VERSION })
  check('slack down: the terminal still connects and is greeted', up && (await c.waitFor((f) => f.type === 'ready')) !== null)
  check('slack down: and the failure is still retried, not hidden', logs.some((l) => /startup failed .*invalid_auth/.test(l)), logs.filter((l) => /startup/.test(l)).join(' | ').slice(0, 160))
  check('slack down: Slack is not connected while it cannot say who it is', slackConnects === 0, `${slackConnects} connect(s)`)
  // A turn the restart lost in the terminal is reported there, while Slack is still down.
  const lost = client(join(stateDir, 'tui.sock'))
  await lost.opened
  lost.send({ type: 'hello', version: PROTOCOL_VERSION, conversation: 'conv-lost' })
  check('slack down: a terminal turn lost in the restart is still reported', (await lost.waitFor((f) => f.type === 'post' && /끊겼어/.test(f.text))) !== null)
  await lost.close()
  check('slack down: and, reported, its record is gone, so no retry reports it again', JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')).restartLost?.['tui:conv-lost'] === undefined)
  const stateNow = () => JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8'))
  check('slack down: and Slack\'s lost turn waits for Slack', stateNow().restartLost?.['C_ALLOWED:t9'] !== undefined, JSON.stringify(stateNow().restartLost))
  // A terminal turn running in this process is not "lost in a restart" when a retry of the start
  // runs the recovery again — neither a failed retry nor the one that finally connects Slack.
  const ready = await c.waitFor((f) => f.type === 'ready')
  c.send({ type: 'message', text: '오래 걸리는 일' })
  for (let i = 0; i < 200 && made === 0; i++) await sleep(10)
  const failuresBefore = logs.filter((l) => /startup failed/.test(l)).length
  for (let i = 0; i < 400 && logs.filter((l) => /startup failed/.test(l)).length === failuresBefore; i++) await sleep(10)
  await sleep(150)   // a notice the retry sent is on the socket by now
  const told = () => c.frames.some((f) => f.type === 'post' && /끊겼어/.test(f.text))
  check('slack down: a failed retry does not report this process\'s running turn as lost', made === 1 && logs.filter((l) => /startup failed/.test(l)).length > failuresBefore && !told(), `${made} turn(s), ${logs.filter((l) => /startup failed/.test(l)).length - failuresBefore} more failure(s)`)
  check('slack down: and its record stays, for a real restart to report', stateNow().inflight?.[`tui:${ready.conversation}`] !== undefined, JSON.stringify(stateNow().inflight))
  authOk = true
  for (let i = 0; i < 500 && slackConnects === 0; i++) await sleep(10)
  check('slack down: once it can, Slack is connected by the retry', slackConnects === 1)
  await sleep(200)
  check('slack down: and then its lost turn is reported', slack.posted.some((p) => p.target?.threadTs === 't9' && /끊겼어/.test(p.text)), JSON.stringify(slack.posted.map((p) => p.text.slice(0, 20))))
  check('slack down: the retry that connects does not report the running turn either', !told())
  release()
  if (up) await c.close()
  unload()
  await sleep(50)
  rmSync(stateDir, { recursive: true, force: true })
}

// ── 4. The core, serving Slack and a terminal side by side ────────────────────
function boot({ state = {}, config = {} } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-core-local-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {}, ...state }))
  const slack = createFakeTransport()
  let local = null
  const created = []
  const listeners = {}
  const logs = []
  const stubs = {
    agents: {
      create: async (options) => {
        created.push(options)
        return {
          agent: { session: { header: { id: options?.sessionId ?? 's1' }, seq: 0, eventAt: () => undefined }, followup: () => {}, whenIdle: async () => {}, cancel: () => {} },
          dispose: async () => {},
        }
      },
      resume: async () => { throw new Error('fake: agents.resume is not implemented') },
    },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agentPresets: { resolve: async (id) => ({ id }), acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }), mount: async () => {} },
    permissionPresets: { resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }), set: () => {}, defaultPreset: 'standard' },
  }
  const ctx = {
    get: (name) => stubs[name],
    effect: (fn) => fn(),
    on: (name, handler) => { (listeners[name] ??= []).push(handler); return () => {} },
    logger: { info: (l) => logs.push(String(l)) },
  }
  apply(ctx, {
    targetChannels: ['C_ALLOWED', LOCAL_CHANNEL],
    stateDir,
    progressAfterMs: 50,
    transportFactory: (host) => { local = createLocalTransport(host); return createCompositeTransport([slack, local]) },
    ...config,
  })
  const askApproval = (sessionId) => listeners['approval/request'][0]({ agent: { session: { header: { id: sessionId } } }, reason: 'rm -rf build' })
  return { slack, get local() { return local }, created, logs, stateDir, askApproval, done: async () => { await local?.close(); rmSync(stateDir, { recursive: true, force: true }) } }
}

{
  const t = boot()
  await sleep(100)
  const c = client(join(t.stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION })
  const ready = await c.waitFor((f) => f.type === 'ready')
  c.send({ type: 'message', text: '안녕' })
  const typingOn = await c.waitFor((f) => f.type === 'typing' && f.on === true)
  await sleep(300)
  check('core: a terminal message starts a session named tui-…', t.created.length === 1 && /^tui-[0-9a-f-]{36}$/.test(t.created[0]?.sessionId ?? ''), t.created[0]?.sessionId)
  check('core: the terminal gets typing, not a working message', typingOn !== null && !c.frames.some((f) => f.type === 'post' && /작업 중/.test(f.text)))
  check('core: the turn\'s reply reaches the terminal', (await c.waitFor((f) => f.type === 'post', 2000)) !== null)

  t.slack.deliver(t.slack.message({ text: 'ping', target: { channel: 'C_ALLOWED', threadTs: 't1' } }))
  await sleep(400)
  check('core: a Slack message still starts a slack-… session', t.created.length === 2 && /^slack-/.test(t.created[1]?.sessionId ?? ''), t.created[1]?.sessionId)
  check('core: Slack still gets a working message (it has no typing)', t.slack.posted.some((p) => p.target.channel === 'C_ALLOWED' && /작업 중/.test(p.text)), JSON.stringify(t.slack.posted.map((p) => p.text.slice(0, 30))))
  check('core: nothing for Slack went to the terminal, nothing for the terminal went to Slack', !c.frames.some((f) => f.type === 'post' && /ping/.test(f.text)) && t.slack.posted.every((p) => p.target.channel !== LOCAL_CHANNEL))
  void ready
  await c.close()
  await t.done()
}

{
  // Approvals: buttons where the conversation can show them, words where it cannot.
  const t = boot({ state: { sessions: { 'tui:conv-1': 'tui-aaaa', 'C_ALLOWED:t1': 'slack-bbbb' } } })
  await sleep(100)
  const c = client(join(t.stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION, conversation: 'conv-1' })
  await c.waitFor((f) => f.type === 'ready')
  const tuiAsk = t.askApproval('tui-aaaa')
  const tuiFrame = await c.waitFor((f) => f.type === 'post' && f.buttons?.length === 2)
  check('approval: the terminal is asked with buttons, for this request', tuiFrame !== null && /^approval:allow:tui:conv-1#[0-9a-f]{8}$/.test(tuiFrame.buttons[0].id), JSON.stringify(tuiFrame?.buttons))
  c.send({ type: 'action', id: tuiFrame.buttons[1].id })
  // Bounded: a press the gate refused leaves the request pending, which must fail here, not hang the suite.
  check('approval: pressing a button decides it', (await Promise.race([tuiAsk, sleep(2000).then(() => 'still pending')])) === 'rejected')
  const slackAsk = t.askApproval('slack-bbbb')
  await sleep(100)
  const slackPost = t.slack.posted.find((p) => /권한이 필요/.test(p.text))
  check('approval: a platform without buttons (this fake Slack) is asked in words', slackPost !== undefined && slackPost.buttons === null && /허용/.test(slackPost.text), JSON.stringify(t.slack.posted.map((p) => p.text.slice(0, 30))))
  t.slack.deliver(t.slack.message({ text: '거부', target: { channel: 'C_ALLOWED', threadTs: 't1' } }))
  await slackAsk
  await c.close()
  await t.done()
}

{
  // The live stream: the core forwards a running turn's text to the terminal, and nothing else.
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-stream-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {} }))
  const slack = createFakeTransport()
  let local = null
  const listeners = {}
  const agents = []
  let release = () => {}
  const stubs = {
    agents: {
      create: async (o) => {
        // whenIdle returns at once before the prompt, and holds the turn open after it until released.
        let prompted = false
        const events = []
        const gate = new Promise((r) => {
          // Releasing completes the turn in the log, the way the loop would: the reply is read from it.
          release = () => {
            events.push({ type: 'turn/start' })
            events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '첫 줄 둘째 줄' }] } } })
            events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
            r()
          }
        })
        const session = { id: o.sessionId, header: { id: o.sessionId }, get seq() { return events.length }, eventAt: (i) => events[i] }
        const agent = { id: o.sessionId, session, followup: () => { prompted = true }, whenIdle: () => (prompted ? gate : Promise.resolve()), cancel: () => {} }
        agents.push(agent)
        return { agent, dispose: async () => {} }
      },
      resume: async () => { throw new Error('no') },
    },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agentPresets: { resolve: async (id) => ({ id }), acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }), mount: async () => {} },
    permissionPresets: { resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }), set: () => {}, defaultPreset: 'standard' },
  }
  let unloadStream = () => {}
  apply({ get: (n) => stubs[n], effect: (fn) => { unloadStream = fn() }, on: (name, h) => { (listeners[name] ??= []).push(h); return () => {} }, logger: { info: () => {} } }, {
    targetChannels: ['C_ALLOWED', LOCAL_CHANNEL], stateDir, progressAfterMs: 50,
    transportFactory: (host) => { local = createLocalTransport(host); return createCompositeTransport([slack, local]) },
  })
  await sleep(100)
  const emit = (name, ...args) => { for (const h of listeners[name] ?? []) h(...args) }
  const c = client(join(stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION })
  await c.waitFor((f) => f.type === 'ready')
  c.send({ type: 'message', text: '스트림 해줘' })
  let agent = null
  for (let i = 0; i < 100 && agent === null; i++) { await sleep(10); agent = agents[0] ?? null }
  await sleep(50)
  const chunk = (text) => ({ type: 'chunk', attemptId: 'a1', revision: 0, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text } })
  emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'a1', revision: 0, turn: 1, step: 1 } })
  emit('agent/assistant-stream', { agent, frame: chunk('실패한 ') })
  emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'a1', revision: 0, index: 1, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 3 } } })
  emit('agent/assistant-stream', { agent, frame: chunk('첫 줄 ') })
  emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'a2', revision: 0, index: 1, time: 0, chunk: { type: 'reasoning-delta', index: 0, text: '생각' } } })
  emit('session/event', agent.session, { type: 'tool/call', data: { name: 'read_file' } })
  emit('agent/assistant-stream', { agent, frame: chunk('둘째 줄') })
  // Someone else's agent — a subagent, a web session — streaming at the same time.
  emit('agent/assistant-stream', { agent: { id: 'other-session' }, frame: chunk('남의 텍스트') })
  await sleep(80)
  const streamed = c.frames.filter((f) => f.type === 'stream')
  const kinds = streamed.map((f) => f.kind === 'text' ? f.text : `<${f.kind}${f.name ? ':' + f.name : ''}>`).join('|')
  check('stream: text deltas reach the terminal in order, with a reset for the failed attempt and the tool step', kinds === '실패한 |<reset>|첫 줄 |<tool:read_file>|둘째 줄', kinds)
  check('stream: reasoning is not shown as the answer, and another session\'s text is not shown at all', !kinds.includes('생각') && !kinds.includes('남의'))
  check('stream: a terminal turn posts no progress message (the steps are already on screen)', !c.frames.some((f) => f.type === 'post' && /작업 중/.test(f.text)))
  release()
  const reply = await c.waitFor((f) => f.type === 'post', 2000)
  check('stream: the turn\'s reply is marked as the answer', reply !== null && reply.answer === true && reply.text === '첫 줄 둘째 줄', JSON.stringify(reply))
  check('stream: Slack got none of it', slack.posted.length === 0)
  await c.close()
  unloadStream()
  await sleep(50)
  rmSync(stateDir, { recursive: true, force: true })
}

{
  // /sessions and /resume: listed from the core's state, titled and replayed from the recall index.
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-sessions-'))
  const home = mkdtempSync(join(tmpdir(), 'deepbot-home-'))
  const now = Date.now()
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({
    sessions: { 'tui:older': 'tui-s1', 'tui:newer': 'tui-s2', 'C_ALLOWED:t1': 'slack-s3' },
    touched: { 'tui:older': now - 3600_000, 'tui:newer': now - 60_000, 'C_ALLOWED:t1': now },
    // The stored shape (usage.ts ConversationTotals), every field present as the tracker writes it.
    usage: { conversations: {
      'tui:older': { turns: 4, uncached: 1200, cached: 3400, written: 0, output: 560, lastAt: now - 3600_000, lastSessionId: 'tui-s1' },
      'tui:newer': { turns: 1, uncached: 300, cached: 0, written: 0, output: 80, lastAt: now - 60_000, lastSessionId: 'tui-s2' },
    }, sessions: {} },
    seen: {}, standing: {}, history: {},
  }))
  const indexFile = recallIndexPath(home, DSH_HOME)   // where the indexer writes it: outside the home
  mkdirSync(dirname(indexFile), { recursive: true })
  const rows = [
    { sessionId: 'tui-s1', role: 'user', text: '배포 일정 정리해줘', ts: 1 },
    { sessionId: 'tui-s1', role: 'assistant', text: 'staging 먼저.', ts: 2 },
    { sessionId: 'slack-s3', role: 'user', text: '슬랙 대화', ts: 3 },
    { sessionId: 'tui-s2', role: 'user', text: '오늘 날씨\n어때', ts: 4 },
    { sessionId: 'tui-s1', role: 'user', text: '롤백 기준은?', ts: 5 },
  ]
  writeFileSync(indexFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const stubs = {
    agents: { create: async () => { throw new Error('no turns here') }, resume: async () => { throw new Error('no') } },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agentPresets: { resolve: async (id) => ({ id }), acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }), mount: async () => {} },
    permissionPresets: { resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }), set: () => {}, defaultPreset: 'standard' },
    fs: { resolve: async () => home, processPath: (p) => p },
  }
  let unload = () => {}
  apply({ get: (n) => stubs[n], effect: (fn) => { unload = fn() }, on: () => () => {}, logger: { info: () => {} } }, { platform: 'local', targetChannels: [LOCAL_CHANNEL], stateDir })
  await sleep(150)
  const c = client(join(stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION, conversation: 'older' })
  await c.waitFor((f) => f.type === 'ready')
  c.send({ type: 'sessions' })
  const listed = await c.waitFor((f) => f.type === 'sessions')
  const items = listed?.items ?? []
  check('sessions: only terminal conversations, newest first', items.map((i) => i.conversation).join(',') === 'newer,older', items.map((i) => i.conversation).join(','))
  check('sessions: titled with the first message the index recorded, whitespace folded', items[0]?.title === '오늘 날씨 어때' && items[1]?.title === '배포 일정 정리해줘', JSON.stringify(items.map((i) => i.title)))
  check('sessions: with turns and session ids from the state', items[1]?.turns === 4 && items[1]?.sessionId === 'tui-s1')
  c.send({ type: 'history' })
  const history = await c.waitFor((f) => f.type === 'history')
  check('history: the resumed conversation\'s own messages, in order, nobody else\'s', JSON.stringify(history?.items) === JSON.stringify([
    { role: 'user', text: '배포 일정 정리해줘' }, { role: 'assistant', text: 'staging 먼저.' }, { role: 'user', text: '롤백 기준은?' },
  ]), JSON.stringify(history?.items))
  c.send({ type: 'usage' })
  const usage = await c.waitFor((f) => f.type === 'post' && /이 대화: 4턴/.test(f.text))
  check('usage: answered by the core\'s usage summary, without a turn', usage !== null, JSON.stringify(c.frames.filter((f) => f.type === 'post').map((f) => f.text.slice(0, 40))))
  await c.close()
  unload()
  await sleep(50)
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

{
  // The agent panel through the core: pushed on hello and again when something changes, views
  // followed, and the person's actions reaching the harness services.
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-panel-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: { 'tui:c1': 'root-s' }, touched: {}, seen: {}, standing: {}, history: {} }))
  const listeners = {}
  const calls = []
  let children = [{ id: 'kid', createdAt: 1, mode: 'continuable', label: 'research links' }]
  let kidStatus = 'running'
  let jobGone = false
  const stubs = {
    agents: { create: async () => { throw new Error('no turns') }, resume: async () => { throw new Error('no') }, get: (id) => (id === 'kid' ? { status: kidStatus, session: { id: 'kid' } } : undefined) },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agentPresets: { resolve: async (id) => ({ id }), acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }), mount: async () => {} },
    permissionPresets: { resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }), set: () => {}, defaultPreset: 'standard' },
    subagents: {
      listChildren: async (root) => { calls.push(['list', root]); return children },
      prompt: async (req) => { calls.push(['prompt', req.childSessionId, req.parentSessionId, req.content[0].text]); return { messageId: 'm' } },
      interruptByParent: async (child, parent) => { calls.push(['interrupt', child, parent]); return { accepted: true } },
    },
    // Timestamps are fixed, as the projections' are: a value that moved on every read would look like a change.
    sessionProjections: { snapshot: () => ({ values: { subagentTiming: kidStatus === 'running' ? { settledMs: 0, active: { since: 1_000, through: 2_000 } } : { settledMs: 5_000, lastTurnCompleted: true }, tokenUsage: { outputTokens: 1500 } } }) },
    sessionQuery: { observeSession: async () => ({ events: [{ type: 'user/message', data: { content: [{ type: 'text', text: '조사해' }] } }], [Symbol.dispose]: () => {} }) },
    jobs: { list: (owner) => (owner === 'root-s' && !jobGone ? [{ id: 'bash-1', owner: 'root-s', kind: 'bash', label: 'sleep 30', status: 'running', startedAt: 1_000, output: {} }] : []),
      readAt: () => { if (jobGone) throw new Error('unknown job bash-1'); return { chunks: [{ text: 'tick\n' }], next: 5 } }, get: () => ({ status: 'running' }), kill: (id, owner) => { calls.push(['kill', id, owner]); return 'requested' } },
  }
  let unload = () => {}
  apply({ get: (n) => stubs[n], effect: (fn) => { unload = fn() }, on: (name, h) => { (listeners[name] ??= []).push(h); return () => {} }, logger: { info: () => {} } }, { platform: 'local', targetChannels: [LOCAL_CHANNEL], stateDir })
  await sleep(150)
  const c = client(join(stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION, conversation: 'c1' })
  const panel = await c.waitFor((f) => f.type === 'panel', 3000)
  check('panel: pushed after hello, for the conversation\'s root session', panel !== null && calls.some((x) => x[0] === 'list' && x[1] === 'root-s'))
  check('panel: carries the conversation\'s usage, even when the harness reports none', panel?.usage?.tokens === 0 && panel.usage.contextPct === null, JSON.stringify(panel?.usage))
  check('panel: the child, running, with its tokens, and the root\'s job', panel?.agents?.[0]?.label === 'research links' && panel.agents[0].status === 'running' && panel.agents[0].tokens === 1500 && panel?.jobs?.[0]?.id === 'bash-1', JSON.stringify(panel))
  const before = c.frames.filter((f) => f.type === 'panel').length
  for (const h of listeners['agent/status'] ?? []) h({ agent: { id: 'kid' }, status: 'running' })
  await sleep(700)
  check('panel: an event with nothing changed sends nothing new', c.frames.filter((f) => f.type === 'panel').length === before)
  kidStatus = 'idle'
  for (const h of listeners['agent/status'] ?? []) h({ agent: { id: 'kid' }, status: 'idle' })
  const changed = await c.waitFor((f) => f.type === 'panel' && f.agents?.[0]?.status !== 'running', 3000)
  check('panel: a child finishing is pushed', changed !== null && changed.agents[0].status === 'done', JSON.stringify(changed?.agents?.[0]))
  c.send({ type: 'view', kind: 'agent', id: 'kid' })
  const view = await c.waitFor((f) => f.type === 'view' && f.kind === 'agent')
  check('view: the child\'s transcript comes back', view?.lines?.[0]?.text === '조사해')
  c.send({ type: 'view', kind: 'job', id: 'bash-1', owner: 'root-s' })
  check('job view: the output so far', (await c.waitFor((f) => f.type === 'view' && f.kind === 'job' && f.text === 'tick\n')) !== null)
  c.send({ type: 'job.kill', id: 'bash-1', owner: 'root-s' })
  c.send({ type: 'view', kind: 'agent', id: 'somebody-elses-child' })
  c.send({ type: 'job.kill', id: 'bash-9', owner: 'slack-session' })
  check('ids: only what this terminal\'s panel offered can be opened or stopped', (await c.waitFor((f) => f.type === 'error' && f.code === 'not-offered')) !== null
    && c.frames.filter((f) => f.type === 'error' && f.code === 'not-offered').length === 2)
  await sleep(100)
  jobGone = true   // the turn ended and its agent took the job with it
  for (const h of listeners['agent/status'] ?? []) h({ agent: { id: 'kid' }, status: 'idle' })
  check('job view: a job that disappears while running is reported once as removed', (await c.waitFor((f) => f.type === 'view' && f.kind === 'job' && f.status === 'removed', 3000)) !== null)
  c.send({ type: 'agent.send', id: 'kid', text: '더 짧게' })
  c.send({ type: 'agent.interrupt', id: 'kid' })
  await sleep(200)
  check('actions: message, interrupt and kill reach the services with the right ids', calls.some((x) => x[0] === 'prompt' && x[1] === 'kid' && x[2] === 'root-s' && x[3] === '더 짧게')
    && calls.some((x) => x[0] === 'interrupt' && x[1] === 'kid' && x[2] === 'root-s') && calls.some((x) => x[0] === 'kill' && x[1] === 'bash-1' && x[2] === 'root-s'), JSON.stringify(calls.filter((x) => x[0] !== 'list')))
  await c.close()
  unload()
  await sleep(50)
  rmSync(stateDir, { recursive: true, force: true })
}

{
  // Questions and approvals during a conversation's first turn, through the core.
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-questions-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {} }))
  const listeners = {}
  const agents = []
  let release = () => {}
  const stubs = {
    agents: {
      create: async (o) => {
        let prompted = false
        const gate = new Promise((r) => { release = r })
        const agent = { id: o.sessionId, session: { id: o.sessionId, header: { id: o.sessionId }, seq: 0, eventAt: () => undefined },
          followup: () => { prompted = true }, whenIdle: () => (prompted ? gate : Promise.resolve()), cancel: () => {} }
        agents.push(agent)
        return { agent, dispose: async () => {} }
      },
      resume: async () => { throw new Error('no') },
    },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agentPresets: { resolve: async (id) => ({ id }), acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }), mount: async () => {} },
    permissionPresets: { resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }), set: () => {}, defaultPreset: 'standard' },
  }
  let unload = () => {}
  const options = {}
  apply({ get: (n) => stubs[n], effect: (fn) => { unload = fn() }, on: (name, h, opts) => { (listeners[name] ??= []).push(h); options[name] = opts; return () => {} }, logger: { info: () => {} } },
    { platform: 'local', targetChannels: [LOCAL_CHANNEL], stateDir, progressAfterMs: 50 })
  await sleep(150)
  const c = client(join(stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION })
  const ready = await c.waitFor((f) => f.type === 'ready')
  c.send({ type: 'message', text: '배포 준비해줘' })
  let agent = null
  for (let i = 0; i < 100 && agent === null; i++) { await sleep(10); agent = agents[0] ?? null }
  await sleep(50)
  check('questions: the answerer is registered first in the waterfall (prepend)', listeners['user-questions/request']?.length === 1 && options['user-questions/request']?.prepend === true)
  const ask = (request) => {
    let nexted = false
    const result = listeners['user-questions/request'][0](request, () => { nexted = true; return 'next-answer' })
    return { result: Promise.resolve(result), nexted: () => nexted }
  }
  const questions = [
    { id: 'env', question: '배포 대상은?', options: [{ label: 'staging' }, { label: 'production', description: '실서비스' }], multiSelect: false },
    { id: 'checks', question: '검사는?', options: [{ label: 'unit' }, { label: 'e2e' }], multiSelect: true, extra: 'dropped' },
  ]
  const asked = ask({ agent, questions })
  const frame = await c.waitFor((f) => f.type === 'question')
  check('questions: a first-turn question reaches the terminal, normalised', frame !== null && frame.questions.length === 2 && frame.questions[1].multiSelect === true && frame.questions[0].options[1].description === '실서비스' && !('extra' in frame.questions[1]), JSON.stringify(frame?.questions))
  c.send({ type: 'answer', id: frame.id, answers: [{ id: 'env', selected: ['canary'] }, { id: 'checks', selected: [] }] })
  check('questions: an answer naming a label the question does not have is refused', (await c.waitFor((f) => f.type === 'error' && f.code === 'bad-frame')) !== null)
  c.send({ type: 'answer', id: frame.id, answers: [{ id: 'env', selected: [], custom: 'canary' }, { id: 'checks', selected: ['unit', 'e2e'] }] })
  const answered = await asked.result
  check('questions: the answers go back to the harness as the listener\'s result', JSON.stringify(answered) === JSON.stringify({ answers: [{ id: 'env', selected: [], custom: 'canary' }, { id: 'checks', selected: ['unit', 'e2e'] }] }), JSON.stringify(answered))
  check('questions: and the terminal is told the question closed', (await c.waitFor((f) => f.type === 'question.close' && f.id === frame.id)) !== null)

  const other = ask({ agent: { id: 'somebody-elses-session' }, questions })
  check('questions: a session that is not this adapter\'s turn is passed on', (await other.result) === 'next-answer' && other.nexted())

  const dismissed = ask({ agent, questions: [questions[0]] })
  const second = await c.waitFor((f) => f.type === 'question' && f.id !== frame.id)
  c.send({ type: 'answer', id: second.id, answers: null })
  let code = null
  try { await dismissed.result } catch (e) { code = e?.code }
  check('questions: dismissed in the terminal, the harness hears ASK_CANCELLED', code === 'ASK_CANCELLED')

  const controller = new AbortController()
  const aborted = ask({ agent, questions: [questions[0]], signal: controller.signal })
  const third = await c.waitFor((f) => f.type === 'question' && f.id !== frame.id && f.id !== second.id)
  controller.abort()
  let abortCode = null
  try { await aborted.result } catch (e) { abortCode = e?.code }
  check('questions: a stopped turn closes its question in the terminal', abortCode === 'ASK_CANCELLED' && (await c.waitFor((f) => f.type === 'question.close' && f.id === third.id)) !== null)

  // The approval in a first turn: mapped through the live origin instead of failing closed.
  const approval = listeners['approval/request'][0]({ agent: { session: { header: { id: agent.id } } }, reason: 'rm -rf build' })
  const buttons = await c.waitFor((f) => f.type === 'post' && f.buttons?.length === 2)
  check('approval: a first-turn approval reaches the terminal with buttons, not a silent refusal', buttons !== null && buttons.buttons[0].id.startsWith(`approval:allow:tui:${ready.conversation}#`))
  c.send({ type: 'action', id: buttons.buttons[0].id })
  check('approval: and the button decides it', (await Promise.race([approval, sleep(2000).then(() => 'still pending')])) === 'allowed-once')

  await c.close()
  const noTerminal = ask({ agent, questions })
  check('questions: with no terminal attached, the question is passed on rather than left waiting', (await noTerminal.result) === 'next-answer')
  release()
  await sleep(100)
  unload()
  await sleep(50)
  rmSync(stateDir, { recursive: true, force: true })
}

{
  // With no working indicator, turns send no typing: a terminal connecting mid-turn is told none run,
  // or its spinner would wait for a typing-off that never comes.
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-noindicator-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {} }))
  let release = () => {}
  let made = 0
  const stubs = {
    agents: {
      create: async (o) => {
        made++
        const gate = new Promise((r) => { release = r })
        return { agent: { id: o.sessionId, session: { id: o.sessionId, header: { id: o.sessionId }, seq: 0, eventAt: () => undefined }, followup: () => {}, whenIdle: () => gate, cancel: () => {} }, dispose: async () => {} }
      },
      resume: async () => { throw new Error('no') },
    },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agentPresets: { resolve: async (id) => ({ id }), acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }), mount: async () => {} },
  }
  let unload = () => {}
  apply({ get: (n) => stubs[n], effect: (fn) => { unload = fn() }, on: () => () => {}, logger: { info: () => {} } },
    { platform: 'local', targetChannels: [LOCAL_CHANNEL], stateDir, workingIndicator: false, autoIndex: false })
  await sleep(150)
  const a = client(join(stateDir, 'tui.sock'))
  await a.opened
  a.send({ type: 'hello', version: PROTOCOL_VERSION })
  const ready = await a.waitFor((f) => f.type === 'ready')
  a.send({ type: 'message', text: '느린 일' })
  for (let i = 0; i < 100 && made === 0; i++) await sleep(10)
  const b = client(join(stateDir, 'tui.sock'))
  await b.opened
  b.send({ type: 'hello', version: PROTOCOL_VERSION, conversation: ready.conversation })
  const midTurn = await b.waitFor((f) => f.type === 'ready')
  check('running: with no working indicator, a terminal connecting mid-turn is told none run', made === 1 && midTurn?.busy === 0, JSON.stringify(midTurn))
  release()
  await a.close(); await b.close()
  unload()
  await sleep(50)
  rmSync(stateDir, { recursive: true, force: true })
}

{
  // Tenants: a conversation stays in the workspace it started in — across a restart, and against a
  // terminal that asks for another. Also: a turn's running state reaches a terminal that connects
  // mid-turn, and a question nobody answered ends with its turn.
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-tenants-'))
  const home = mkdtempSync(join(tmpdir(), 'deepbot-tenant-home-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {} }))
  let release = () => {}
  const listeners = {}
  const created = []
  const stubs = {
    agents: {
      create: async (o) => {
        created.push(o)
        let prompted = false
        const gate = new Promise((r) => { release = r })
        const agent = { id: o.sessionId, session: { id: o.sessionId, header: { id: o.sessionId }, seq: 0, eventAt: () => undefined },
          followup: () => { prompted = true }, whenIdle: () => (prompted ? gate : Promise.resolve()), cancel: () => {} }
        return { agent, dispose: async () => {} }
      },
      resume: async () => { throw new Error('no') },
    },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
    agentPresets: { resolve: async (id) => ({ id }), acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }), mount: async () => {} },
    permissionPresets: { resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }), set: () => {}, defaultPreset: 'standard' },
    fs: { resolve: async () => home, processPath: (p) => p },
  }
  const boot = () => {
    let unload = () => {}
    apply({ get: (n) => stubs[n], effect: (fn) => { unload = fn() }, on: (name, h) => { (listeners[name] ??= []).push(h); return () => {} }, logger: { info: () => {} } },
      { platform: 'local', targetChannels: [LOCAL_CHANNEL], stateDir, tenantIsolation: true })
    return () => unload()
  }
  let unload = boot()
  await sleep(150)
  const a = client(join(stateDir, 'tui.sock'))
  await a.opened
  a.send({ type: 'hello', version: PROTOCOL_VERSION, tenant: 'acme' })
  const acmeReady = await a.waitFor((f) => f.type === 'ready')
  check('tenant: the first hello may choose a tenant', acmeReady?.tenant === 'acme' && acmeReady.workspace.endsWith('/tenants/acme') && acmeReady.model === 'fake-model', JSON.stringify(acmeReady))
  const acme = acmeReady.conversation
  a.send({ type: 'message', text: 'acme 일' })
  for (let i = 0; i < 100 && created.length === 0; i++) await sleep(10)
  const b = client(join(stateDir, 'tui.sock'))
  await b.opened
  b.send({ type: 'hello', version: PROTOCOL_VERSION, conversation: acme })
  const midTurn = await b.waitFor((f) => f.type === 'ready')
  check('running: a terminal connecting mid-turn is told a turn is running', midTurn?.busy === 1, JSON.stringify(midTurn))
  const pending = listeners['user-questions/request'][0]({ agent: { id: created[0].sessionId }, questions: [{ id: 'q', question: '?', options: [{ label: 'a' }] }] }, () => 'next')
  await a.waitFor((f) => f.type === 'question')
  release()
  let ended = null
  try { await pending } catch (e) { ended = e?.code }
  check('questions: one nobody answered ends with its turn instead of waiting forever', ended === 'ASK_CANCELLED')
  await sleep(700)   // the state file is written 500 ms after the last change
  const state = JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8'))
  check('tenant: the choice is recorded with the conversation', state.tenantOf?.[`tui:${acme}`] === 'acme', JSON.stringify(state.tenantOf))
  await a.close(); await b.close()

  // Restart the gateway: the transport's memory is gone, the record is not.
  unload()
  await sleep(100)
  unload = boot()
  await sleep(150)
  const c = client(join(stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION, conversation: acme })
  const resumed = await c.waitFor((f) => f.type === 'ready')
  check('tenant: after a restart, a plain resume is back in its tenant', resumed?.tenant === 'acme' && resumed.workspace.endsWith('/tenants/acme') && resumed.busy === 0, JSON.stringify(resumed))
  c.send({ type: 'hello', version: PROTOCOL_VERSION, conversation: acme, tenant: 'globex' })
  const moved = await c.waitFor((f) => f.type === 'error' && f.code === 'tenant-mismatch')
  check('tenant: asking to move it to another tenant is refused, marked as the answer to that hello', moved?.hello === true, JSON.stringify(moved))

  // A tenant chosen by one terminal, not yet recorded, is not erased by another's plain hello.
  const d = client(join(stateDir, 'tui.sock'))
  await d.opened
  d.send({ type: 'hello', version: PROTOCOL_VERSION, tenant: 'globex' })
  const chosen = await d.waitFor((f) => f.type === 'ready')
  const e2 = client(join(stateDir, 'tui.sock'))
  await e2.opened
  e2.send({ type: 'hello', version: PROTOCOL_VERSION, conversation: chosen.conversation })
  const joined = await e2.waitFor((f) => f.type === 'ready')
  check('tenant: a second terminal joining an unrecorded conversation keeps the tenant the first one chose', joined?.tenant === 'globex', JSON.stringify(joined))
  await d.close(); await e2.close()

  c.send({ type: 'hello', version: PROTOCOL_VERSION })
  const homeReady = await c.waitFor((f) => f.type === 'ready' && f.conversation !== acme)
  c.send({ type: 'message', text: 'home 일' })
  await sleep(200)
  release()
  await sleep(150)
  c.send({ type: 'hello', version: PROTOCOL_VERSION, conversation: homeReady.conversation, tenant: 'acme' })
  check('tenant: a home conversation cannot be resumed into a tenant', (await c.waitFor((f) => f.type === 'error' && f.code === 'tenant-mismatch' && /home/.test(f.message))) !== null)
  for (const bad of ['.', '..', 'a/b']) c.send({ type: 'hello', version: PROTOCOL_VERSION, tenant: bad })
  await sleep(150)
  check('tenant: ".", ".." and a path are refused', c.frames.filter((f) => f.type === 'error' && f.code === 'bad-frame' && f.hello === true).length === 3)
  await c.close()
  unload()
  await sleep(50)
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

{
  // Recall comes from the conversation's own workspace: a tenant's terminal turn must not be handed
  // the home's terminal conversations (they share the channel 'tui'), and must get its own.
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-recall-ws-'))
  const home = mkdtempSync(join(tmpdir(), 'deepbot-recall-home-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {} }))
  const write = (workspace, rows) => {
    const file = recallIndexPath(workspace, DSH_HOME)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  write(home, [{ sessionId: 'tui-home-1', role: 'user', channel: 'tui', ts: 1, text: '홈 비밀 배포 일정 메모' }])
  write(join(home, 'tenants', 'acme'), [{ sessionId: 'tui-acme-1', role: 'user', channel: 'tui', ts: 2, text: 'acme 계약 배포 일정 메모' }])
  const prompts = []
  const stubs = {
    agents: {
      create: async (o) => ({
        agent: { id: o.sessionId, session: { id: o.sessionId, header: { id: o.sessionId }, seq: 0, eventAt: () => undefined },
          followup: (m) => prompts.push((m?.content ?? []).map((b) => b?.text ?? '').join('')), whenIdle: async () => {}, cancel: () => {} },
        dispose: async () => {},
      }),
      resume: async () => { throw new Error('no') },
    },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agentPresets: { resolve: async (id) => ({ id }), acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }), mount: async () => {} },
    permissionPresets: { resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }), set: () => {}, defaultPreset: 'standard' },
    fs: { resolve: async () => home, processPath: (p) => p },
  }
  let unload = () => {}
  apply({ get: (n) => stubs[n], effect: (fn) => { unload = fn() }, on: () => () => {}, logger: { info: () => {} } },
    { platform: 'local', targetChannels: [LOCAL_CHANNEL], stateDir, tenantIsolation: true, autoIndex: false })
  await sleep(150)
  const c = client(join(stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION, tenant: 'acme' })
  await c.waitFor((f) => f.type === 'ready')
  c.send({ type: 'message', text: '지난번 배포 일정 메모 기억나?' })
  for (let i = 0; i < 100 && prompts.length === 0; i++) await sleep(10)
  const prompt = prompts[0] ?? ''
  check('recall: a tenant terminal turn is not handed the home\'s terminal conversations', prompt !== '' && !prompt.includes('홈 비밀'), prompt.slice(0, 120))
  check('recall: it gets its own workspace\'s', prompt.includes('acme 계약'))
  await c.close()
  unload()
  await sleep(50)
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

{
  // A configured default tenant applies to a terminal that asks for none — a Korean name included —
  // and is what gets recorded.
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-default-tenant-'))
  const home = mkdtempSync(join(tmpdir(), 'deepbot-default-home-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {} }))
  const created = []
  const stubs = {
    agents: { create: async (o) => { created.push(o); return { agent: { id: o.sessionId, session: { id: o.sessionId, header: { id: o.sessionId }, seq: 0, eventAt: () => undefined }, followup: () => {}, whenIdle: async () => {}, cancel: () => {} }, dispose: async () => {} } }, resume: async () => { throw new Error('no') } },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agentPresets: { resolve: async (id) => ({ id }), acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }), mount: async () => {} },
    permissionPresets: { resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }), set: () => {}, defaultPreset: 'standard' },
    fs: { resolve: async () => home, processPath: (p) => p },
  }
  let unload = () => {}
  apply({ get: (n) => stubs[n], effect: (fn) => { unload = fn() }, on: () => () => {}, logger: { info: () => {} } },
    { platform: 'local', targetChannels: [LOCAL_CHANNEL], stateDir, tenantIsolation: true, tenantDefault: '한국어 팀', autoIndex: false })
  await sleep(150)
  const c = client(join(stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION })
  const ready = await c.waitFor((f) => f.type === 'ready')
  check('default tenant: a terminal that asks for none is in the configured default, Korean name and all', ready?.tenant === '한국어 팀' && ready.workspace.endsWith('/tenants/한국어 팀'), JSON.stringify(ready))
  c.send({ type: 'message', text: '안녕' })
  for (let i = 0; i < 100 && created.length === 0; i++) await sleep(10)
  check('default tenant: its turn runs there', String(created[0]?.meta?.cwd ?? '').endsWith('/tenants/한국어 팀'), String(created[0]?.meta?.cwd))
  await sleep(700)
  check('default tenant: and that is what is recorded for the conversation', JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')).tenantOf?.[`tui:${ready.conversation}`] === '한국어 팀')
  await c.close()
  // A terminal sends back the tenant the gateway named: a reconnect and /new must be let in with it.
  const frames = []
  const conn = new Connection({ socketPath: join(stateDir, 'tui.sock'), conversation: ready.conversation, onFrame: (f) => frames.push(f), onState: () => {} })
  conn.start()
  const readies = async (n) => { for (let i = 0; i < 200 && frames.filter((f) => f.type === 'ready').length < n; i++) await sleep(10); return frames.filter((f) => f.type === 'ready').length >= n }
  await readies(1)
  conn.socket.destroy()   // the socket drops; the reconnect resends tenant '한국어 팀'
  check('default tenant: a terminal reconnecting with the configured name it was given is let back in', await readies(2) && conn.tenant === '한국어 팀', JSON.stringify(frames.filter((f) => f.type === 'error')))
  conn.switchTo(null, conn.tenant)   // /new
  check('default tenant: and /new in it is too', await readies(3) && !frames.some((f) => f.type === 'error'), JSON.stringify(frames.filter((f) => f.type === 'error')))
  conn.close()
  // A name that is a path is no tenant: 'x/../y' would be another tenant's workspace under a second name.
  const d = client(join(stateDir, 'tui.sock'))
  await d.opened
  d.send({ type: 'hello', version: PROTOCOL_VERSION, tenant: 'x/../acme' })
  const pathRefusal = await d.waitFor((f) => f.type === 'error' || f.type === 'ready')
  check('tenant: a name that is a path is refused as a bad name', pathRefusal?.type === 'error' && pathRefusal.code === 'bad-frame' && pathRefusal.hello === true, JSON.stringify(pathRefusal))
  // A directory name is at most 255 bytes (a hundred Korean characters are 300), and has no control
  // character; a decomposed spelling (as macOS types it) is the same tenant as the configured one.
  for (const bad of ['가'.repeat(100), 'a\x01b']) {
    d.frames.length = 0
    d.send({ type: 'hello', version: PROTOCOL_VERSION, tenant: bad })
    const r = await d.waitFor((f) => f.type === 'error' || f.type === 'ready')
    check(`tenant: ${bad.length > 10 ? 'a name over 255 bytes' : 'a name with a control character'} is refused`, r?.type === 'error' && r.code === 'bad-frame', JSON.stringify(r))
  }
  d.frames.length = 0
  d.send({ type: 'hello', version: PROTOCOL_VERSION, conversation: ready.conversation, tenant: '한국어 팀'.normalize('NFD') })
  const nfd = await d.waitFor((f) => f.type === 'error' || f.type === 'ready')
  check('tenant: a decomposed spelling of the configured name is the same tenant', nfd?.type === 'ready' && nfd.tenant === '한국어 팀', JSON.stringify(nfd))
  await d.close()
  unload()
  await sleep(50)
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

{
  // Slack and a terminal at once: the core's per-platform calls reach the conversation's own
  // platform. A restart raises and lowers the indicator a lost turn left up, and a stop while the
  // agent is created replaces the working message through the platform, once.
  const combined = async (fakeOptions, state, run) => {
    const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-composite-core-'))
    writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {}, ...state }))
    const slack = createFakeTransport(fakeOptions)
    const stubs = {
      agents: {
        // Created slowly, so a stop arrives while it is being made (and is reported then).
        create: async (o) => {
          await sleep(100)
          let stop
          const stopped = new Promise((r) => { stop = r })
          return { agent: { session: { header: { id: o.sessionId }, seq: 0, eventAt: () => undefined }, followup: () => {}, whenIdle: () => stopped, cancel: () => stop() }, dispose: async () => {} }
        },
        resume: async () => { throw new Error('no') },
      },
      sessions: { flush: async () => {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
      agentPresets: { resolve: async () => ({ id: 'standard' }), acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }), mount: async () => {} },
    }
    let unload = () => {}
    apply({ get: (n) => stubs[n], effect: (fn) => { unload = fn() }, on: () => () => {}, logger: { info: () => {} } }, {
      targetChannels: ['C_ALLOWED'], stateDir, runTimeoutMs: 5000, progressAfterMs: 50,
      transportFactory: (host) => createCompositeTransport([slack, createLocalTransport(host)]),
    })
    await sleep(300)
    await run(slack)
    unload()
    await sleep(50)
    rmSync(stateDir, { recursive: true, force: true })
  }
  await combined({ typing: true }, { inflight: { 'C_ALLOWED:t0': { channel: 'C_ALLOWED', threadTs: 't0', placeholder: 'ts-old', since: Date.now() - 5000 } } }, async (slack) => {
    check('composite core: a restart lowers the platform indicator the lost turn left up', slack.typing.some((e) => e.target?.threadTs === 't0' && e.stopped === true), JSON.stringify(slack.typing))
  })
  // No indicator here, so the message puts up a working message at once.
  await combined({ remove: true }, {}, async (slack) => {
    slack.deliver(slack.message({ text: 'stopped while it is created' }))
    await sleep(50)
    slack.deliver(slack.message({ text: '그만' }))
    await sleep(500)
    const reports = slack.posted.filter((p) => /중단/.test(p.text))
    check('composite core: a stop while the agent is created is reported once', reports.length === 1, JSON.stringify(slack.posted.map((p) => [p.text.slice(0, 30), p.replace])))
    check('composite core: and the working message is removed through the platform', slack.removed.some((r) => r.target?.threadTs === 't1'), JSON.stringify(slack.removed))
  })
}

{
  // A terminal-only deployment: no Slack at all.
  const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-tui-only-'))
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ sessions: {}, seen: {}, standing: {}, history: {} }))
  const created = []
  const stubs = {
    agents: { create: async (o) => { created.push(o); return { agent: { session: { header: { id: o.sessionId }, seq: 0, eventAt: () => undefined }, followup: () => {}, whenIdle: async () => {}, cancel: () => {} }, dispose: async () => {} } }, resume: async () => { throw new Error('no') } },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agentPresets: { resolve: async (id) => ({ id }), acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }), mount: async () => {} },
    permissionPresets: { resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }), set: () => {}, defaultPreset: 'standard' },
  }
  let unload = () => {}
  apply({ get: (n) => stubs[n], effect: (fn) => { unload = fn() }, on: () => () => {}, logger: { info: () => {} } }, { platform: 'local', targetChannels: [LOCAL_CHANNEL], stateDir, progressAfterMs: 50 })
  await sleep(150)
  const c = client(join(stateDir, 'tui.sock'))
  let connected = true
  await c.opened.catch(() => { connected = false })
  check('tui-only: platform "local" boots without any Slack credentials', connected)
  if (connected) {
    c.send({ type: 'hello', version: PROTOCOL_VERSION })
    await c.waitFor((f) => f.type === 'ready')
    c.send({ type: 'message', text: '혼자 쓰는 터미널' })
    await sleep(300)
    check('tui-only: a message starts a tui-… session', /^tui-/.test(created[0]?.sessionId ?? ''))
    await c.close()
  }
  unload()
  await sleep(50)
  check('tui-only: unloading the plugin removes the socket', !existsSync(join(stateDir, 'tui.sock')))
  rmSync(stateDir, { recursive: true, force: true })
}

rmSync(DSH_HOME, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
