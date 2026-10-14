/**
 * The local transport (a unix socket the terminal UI connects to), the composite that serves it
 * beside Slack, and what the core does differently per conversation.
 *
 * The claims: only the owner can connect (0600), a frame in becomes the same InboundMessage any
 * platform produces, a reply that finds no terminal is kept for the next one, and putting a TUI
 * beside Slack changes nothing for Slack — its sessions are still `slack-…`, it still gets a
 * working message instead of typing, and it is still asked to approve in words, not buttons.
 *
 * Run: node test/local.test.ts
 */
import './dist-fresh.ts'   // fails loudly on a stale dist

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
const { toolCallBlock } = await import('../dist/tui/blocks.js')
const { createFakeTransport } = await import('./fake-transport.ts')

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
    return fake.posted.filter((p) => p.target?.threadTs === 't5' && /A restart cut off/.test(p.text))
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
        const gate = new Promise<void>((r) => { release = r })
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
  check('slack down: a terminal turn lost in the restart is still reported', (await lost.waitFor((f) => f.type === 'post' && /A restart cut off/.test(f.text))) !== null)
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
  const told = () => c.frames.some((f) => f.type === 'post' && /A restart cut off/.test(f.text))
  check('slack down: a failed retry does not report this process\'s running turn as lost', made === 1 && logs.filter((l) => /startup failed/.test(l)).length > failuresBefore && !told(), `${made} turn(s), ${logs.filter((l) => /startup failed/.test(l)).length - failuresBefore} more failure(s)`)
  check('slack down: and its record stays, for a real restart to report', stateNow().inflight?.[`tui:${ready.conversation}`] !== undefined, JSON.stringify(stateNow().inflight))
  authOk = true
  for (let i = 0; i < 500 && slackConnects === 0; i++) await sleep(10)
  check('slack down: once it can, Slack is connected by the retry', slackConnects === 1)
  await sleep(200)
  check('slack down: and then its lost turn is reported', slack.posted.some((p) => p.target?.threadTs === 't9' && /A restart cut off/.test(p.text)), JSON.stringify(slack.posted.map((p) => p.text.slice(0, 20))))
  check('slack down: the retry that connects does not report the running turn either', !told())
  release()
  if (up) await c.close()
  unload()
  await sleep(50)
  rmSync(stateDir, { recursive: true, force: true })
}

// ── 4. The core, serving Slack and a terminal side by side ────────────────────
function boot({ state = {}, config = {}, services = {} }: { state?: Record<string, unknown>; config?: Record<string, unknown>; services?: Record<string, unknown> } = {}) {
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
    ...services,
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
  const idSections = []
  await t.created[0]?.setup?.({ systemPrompt: { section: (s) => { idSections.push(s); return () => {} } } })
  check('identity: a terminal conversation is told it is in the terminal', /This conversation is in the terminal \(dsh\)/.test(String(idSections.find((s) => s.name === 'deepbot:identity')?.text ?? '')), String(idSections[0]?.text ?? '').split('\n')[1])
  check('core: the terminal gets typing, not a working message', typingOn !== null && !c.frames.some((f) => f.type === 'post' && /is working/.test(f.text)))
  check('core: the turn\'s reply reaches the terminal', (await c.waitFor((f) => f.type === 'post', 2000)) !== null)

  t.slack.deliver(t.slack.message({ text: 'ping', target: { channel: 'C_ALLOWED', threadTs: 't1' } }))
  await sleep(400)
  check('core: a Slack message still starts a slack-… session', t.created.length === 2 && /^slack-/.test(t.created[1]?.sessionId ?? ''), t.created[1]?.sessionId)
  check('core: Slack still gets a working message (it has no typing)', t.slack.posted.some((p) => p.target.channel === 'C_ALLOWED' && /is working/.test(p.text)), JSON.stringify(t.slack.posted.map((p) => p.text.slice(0, 30))))
  check('core: nothing for Slack went to the terminal, nothing for the terminal went to Slack', !c.frames.some((f) => f.type === 'post' && /ping/.test(f.text)) && t.slack.posted.every((p) => p.target.channel !== LOCAL_CHANNEL))
  void ready
  await c.close()
  await t.done()
}

{
  // /model: the providers' models, listed; one chosen for this conversation runs its next turn, with its effort.
  const llm = {
    listProviders: () => [{ id: 'deepseek-official' }, { id: 'opengateway' }],
    listModels: async (provider) => provider === 'deepseek-official'
      ? [{ provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }]
      : [{ provider, id: 'deepseek/deepseek-v4.1-flash-ultrafast', name: 'Ultrafast' }],
    resolveModelInfo: async (provider, model) => (model === 'deepseek/deepseek-v4.1-flash-ultrafast' ? { reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }], defaultEffort: 'low' } } : {}),
  }
  const t = boot({ services: { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) } } })
  await sleep(100)
  const c = client(join(t.stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION })
  const ready = await c.waitFor((f) => f.type === 'ready')
  check('model: ready names the deployment\'s model, with no effort', ready?.model === 'deepseek-v4-flash' && ready?.effort === null, JSON.stringify(ready))
  c.send({ type: 'models' })
  const listed = await c.waitFor((f) => f.type === 'models')
  check('model: every provider\'s models are listed, the current one named', listed?.items?.length === 2 && listed.current.provider === 'deepseek-official' && listed.current.model === 'deepseek-v4-flash', JSON.stringify(listed))
  c.send({ type: 'model', provider: 'opengateway', model: 'deepseek/deepseek-v4.1-flash-ultrafast', effort: 'high' })
  const chosen = await c.waitFor((f) => f.type === 'model')
  check('model: a listed model is taken for this conversation, with an effort it supports', chosen?.current?.provider === 'opengateway' && chosen.current.model === 'deepseek/deepseek-v4.1-flash-ultrafast' && chosen.current.effort === 'high' && chosen.current.efforts.join() === 'high,low', JSON.stringify(chosen))
  const stored = JSON.parse(readFileSync(join(t.stateDir, 'sessions.json'), 'utf8'))
  const entry = stored.models?.[`tui:${ready.conversation}`]
  check('model: kept for this conversation in the state file, with when it was chosen', entry?.provider === 'opengateway' && entry.model === 'deepseek/deepseek-v4.1-flash-ultrafast' && entry.reasoningEffort === 'high' && entry.at > 0, JSON.stringify(entry))
  check('model: choosing is not activity: the conversation does not move up /sessions', stored.touched?.[`tui:${ready.conversation}`] === undefined)
  c.send({ type: 'message', text: 'hi' })
  for (let i = 0; i < 100 && t.created.length === 0; i++) await sleep(10)
  check('model: the next turn runs on it, effort included', JSON.stringify(t.created[0]?.agentOptions) === JSON.stringify({ provider: 'opengateway', model: 'deepseek/deepseek-v4.1-flash-ultrafast', reasoningEffort: 'high' }), JSON.stringify(t.created[0]?.agentOptions))
  c.send({ type: 'model', provider: 'opengateway', model: 'not-a-model' })
  const unknown = await c.waitFor((f) => f.type === 'error' && f.code === 'model')
  check('model: one the providers do not list is refused, and said', unknown !== null && /not-a-model/.test(unknown.message), JSON.stringify(unknown))
  c.send({ type: 'model', provider: 'opengateway', model: 'deepseek/deepseek-v4.1-flash-ultrafast', effort: 'max' })
  const effort = await c.waitFor((f) => f.type === 'error' && f.code === 'model' && /max/.test(f.message))
  check('model: an effort the model does not take is refused, with the ones it does', effort !== null && /high, low/.test(effort.message), JSON.stringify(effort))
  // Chosen with no effort: the model's own default, said and stored, so what runs is what is shown.
  c.send({ type: 'model', provider: 'opengateway', model: 'deepseek/deepseek-v4.1-flash-ultrafast' })
  const bare = await c.waitFor((f) => f.type === 'model' && f.current.effort === 'low')
  check('model: chosen without an effort, it takes the model\'s default effort, explicitly', bare !== null && JSON.parse(readFileSync(join(t.stateDir, 'sessions.json'), 'utf8')).models?.[`tui:${ready.conversation}`]?.reasoningEffort === 'low', JSON.stringify(bare))
  c.send({ type: 'model', provider: null })
  const back = await c.waitFor((f) => f.type === 'model' && f.current.provider === 'deepseek-official')
  check('model: default goes back to the deployment\'s', back !== null && back.current.model === 'deepseek-v4-flash')
  check('model: and cleared again', JSON.parse(readFileSync(join(t.stateDir, 'sessions.json'), 'utf8')).models?.[`tui:${ready.conversation}`] === undefined)
  await c.close()
  await t.done()
}

{
  // shift+tab: the next effort the conversation's model takes, worked out by the gateway, and every terminal on
  // the conversation told. A /model switch used to reach only the terminal that made it.
  let resolves = 0
  const llm = {
    listProviders: () => [{ id: 'og' }, { id: 'plain' }],
    listModels: async (p) => p === 'og' ? [{ provider: p, id: 'm', name: 'M' }] : [{ provider: p, id: 'n', name: 'N' }],
    resolveModelInfo: async (p) => { resolves++; return p === 'og' ? { reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } } : {} },
  }
  const t = boot({ services: { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'og', model: 'm', reasoningEffort: 'low' }) } } })
  await sleep(100)
  const a = client(join(t.stateDir, 'tui.sock'))
  await a.opened
  a.send({ type: 'hello', version: PROTOCOL_VERSION })
  const ready = await a.waitFor((f) => f.type === 'ready')
  const b = client(join(t.stateDir, 'tui.sock'))
  await b.opened
  b.send({ type: 'hello', version: PROTOCOL_VERSION, conversation: ready.conversation })
  await b.waitFor((f) => f.type === 'ready')
  a.send({ type: 'models' })
  const listed = await a.waitFor((f) => f.type === 'models')
  const efforts = Object.fromEntries((listed?.items ?? []).map((i) => [`${i.provider}/${i.id}`, (i.efforts ?? []).join()]))
  check('models: each listed model carries the efforts it takes', efforts['og/m'] === 'off,low,high' && efforts['plain/n'] === '', JSON.stringify(listed?.items))
  // Read once: /model again asks the provider only about the model the conversation is on.
  const asked = resolves
  a.frames.length = 0
  a.send({ type: 'models' })
  await a.waitFor((f) => f.type === 'models')
  check('models: a listed model\'s efforts are read once, not on every /model', resolves - asked <= 1, `${resolves - asked} more`)
  a.send({ type: 'effort', step: 1 })
  const stepped = await a.waitFor((f) => f.type === 'model')
  check('effort: a step moves to the next effort the model takes, marked as an effort change', stepped?.current?.effort === 'high' && stepped.cause === 'effort', JSON.stringify(stepped))
  const told = await b.waitFor((f) => f.type === 'model')
  check('effort: the other terminal on the conversation is told too', told?.current?.effort === 'high', JSON.stringify(told))
  check('effort: kept for the conversation', JSON.parse(readFileSync(join(t.stateDir, 'sessions.json'), 'utf8')).models?.[`tui:${ready.conversation}`]?.reasoningEffort === 'high')
  a.send({ type: 'effort', step: 1 })
  a.send({ type: 'effort', step: 1 })
  await sleep(300)
  const steps = a.frames.filter((f) => f.type === 'model').map((f) => f.current.effort)
  check('effort: steps sent together are answered one after another, each with its own effort, and wrap around', steps.join() === 'high,off,low', steps.join())
  b.send({ type: 'model', provider: 'plain', model: 'n' })
  const switched = await a.waitFor((f) => f.type === 'model' && f.current.provider === 'plain')
  check('model: a switch made in one terminal reaches the other, not as an effort change', switched !== null && switched.cause === undefined, JSON.stringify(switched))
  a.send({ type: 'effort', step: 1 })
  const none = await a.waitFor((f) => f.type === 'error' && f.code === 'effort')
  check('effort: a model that takes none says so', none !== null && /plain\/n/.test(none.message), JSON.stringify(none))
  a.send({ type: 'effort', step: 7 })
  const bad = await a.waitFor((f) => f.type === 'error' && f.code === 'bad-frame')
  check('effort: a step other than 1 or -1 is refused', bad !== null)
  a.send({ type: 'no-such-frame' })
  const unknown = await a.waitFor((f) => f.type === 'error' && f.code === 'unknown-frame')
  check('protocol: an unknown frame type is refused with its own code, which a terminal can explain', unknown !== null && /no-such-frame/.test(unknown.message), JSON.stringify(unknown))
  await a.close()
  await b.close()
  await t.done()
}

{
  // A conversation moved to another model is told, on the turn that runs on it: the harness's own notice of a
  // switch belongs to its model selection, which this adapter cannot use, and the model went on believing the
  // turns above were its own.
  const llm = {
    listProviders: () => [{ id: 'og' }, { id: 'ds' }],
    listModels: async (p) => p === 'og' ? [{ provider: p, id: 'm1', name: 'M1' }] : [{ provider: p, id: 'm2', name: 'M2' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }),
  }
  // Turns after the first resume the session: an agent that can be resumed, and keeps what it was told.
  // A turn answers, as the harness records one; one whose message says FAILTURN ends as a refused model call
  // does: no answer, a turn/end with an error reason, and whenIdle returning normally.
  const told = []
  const agent = (o) => {
    const events = []
    const session = { header: { id: o?.sessionId ?? o?.resumeSessionId ?? 's1' }, get seq() { return events.length }, eventAt: (i) => events[i] }
    return { agent: { session,
      followup: (m) => {
        const text = (m?.content ?? []).map((b) => b?.text ?? '').join('')
        told.push(text)
        events.push({ type: 'turn/start' })
        if (/FAILTURN/.test(text)) events.push({ type: 'turn/end', data: { reason: { kind: 'error', message: 'fake: the provider refused' } } })
        else { events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '응' }] } } }); events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } }) }
      },
      whenIdle: async () => {}, cancel: () => {} }, dispose: async () => {} }
  }
  const agents = { create: async (o) => agent(o), resume: async (o) => agent(o) }
  // A route recorded for this conversation with no session behind it yet (a first turn that died): no line.
  const t = boot({ state: { routes: { 'tui:conv-note': 'zz/old' } }, services: { llm, agents, agentDefaultModel: { currentSelection: () => ({ provider: 'og', model: 'm1' }) } } })
  await sleep(100)
  const c = client(join(t.stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION, conversation: 'conv-note' })
  await c.waitFor((f) => f.type === 'ready')
  // The prompt that carries this message, or '' when none came: the checks below cannot pass on an older one.
  const turn = async (text) => { c.send({ type: 'message', text }); for (let i = 0; i < 400 && !told.some((p) => p.includes(text)); i++) await sleep(10); await sleep(80); return told.find((p) => p.includes(text)) ?? '' }
  const switchTo = async (provider, model) => { const n = c.frames.filter((f) => f.type === 'model').length; c.send({ type: 'model', provider, model }); for (let i = 0; i < 100 && c.frames.filter((f) => f.type === 'model').length === n; i++) await sleep(10) }
  const first = await turn('하나')
  check('model note: none on a conversation\'s first turn, even with a route recorded and no session', first.includes('하나') && !first.includes('[model changed'), first.slice(0, 80))
  const same = await turn('둘')
  check('model note: none while the model stays', same.includes('둘') && !same.includes('[model changed'))
  await switchTo('ds', 'm2')
  const moved = await turn('셋')
  check('model note: the turn after a switch names both, before the [user message] marker', /\[model changed\][^\n]*og\/m1[^\n]*ds\/m2/.test(moved) && moved.indexOf('[model changed]') < moved.lastIndexOf('[user message]'), moved.split('\n').find((l) => l.includes('model changed')) ?? '(none)')
  const after = await turn('넷')
  check('model note: once, not on every turn after', after.includes('넷') && !after.includes('[model changed'))
  c.send({ type: 'effort', step: 1 })
  await c.waitFor((f) => f.type === 'model' && f.cause === 'effort')
  const stepped = await turn('다섯')
  check('model note: an effort step is not a change of model', stepped.includes('다섯') && !stepped.includes('[model changed'))
  // A turn on another route that dies answered nothing: going back, the line does not name it.
  await switchTo('og', 'm1')
  await turn('FAILTURN 여섯')
  await sleep(300)
  await switchTo('ds', 'm2')
  const back = await turn('일곱')
  check('model note: a route whose turn died is not named as having answered', back.includes('일곱') && !/answered by og\/m1/.test(back), back.split('\n').find((l) => l.includes('model changed')) ?? '(none)')
  await c.close()
  await t.done()
}

{
  // The words the core answers without a turn reach the terminal, so it does not queue them behind one.
  const t = boot({ config: { cancelWords: ['그만', 'stop'], usageWords: ['사용량'], approveWords: ['허용'], denyWords: ['거부'] } })
  await sleep(100)
  const c = client(join(t.stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION })
  const ready = await c.waitFor((f) => f.type === 'ready')
  check('instant: ready names the words answered without a turn, and an approval\'s', JSON.stringify(ready?.instant) === JSON.stringify(['그만', 'stop', '사용량']) && JSON.stringify(ready?.approval) === JSON.stringify(['허용', '거부']), JSON.stringify([ready?.instant, ready?.approval]))
  await c.close()
  await t.done()
}

{
  // Chosen with no effort, on the route it already runs on, by a model that declares efforts but no default
  // (the live OpenGateway route): it keeps the effort it runs with, instead of storing none while the
  // harness goes on reusing it and the terminal says "the model's default".
  const llm = { listProviders: () => [{ id: 'og' }], listModels: async (p) => [{ provider: p, id: 'm', name: 'M' }], resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }) }
  const t = boot({ services: { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'og', model: 'm', reasoningEffort: 'high' }) } } })
  await sleep(100)
  const c = client(join(t.stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION })
  const ready = await c.waitFor((f) => f.type === 'ready')
  c.send({ type: 'model', provider: 'og', model: 'm' })
  const kept = await c.waitFor((f) => f.type === 'model')
  check('model: on the same route with no effort named, it keeps the effort it runs with', kept?.current?.effort === 'high' && JSON.parse(readFileSync(join(t.stateDir, 'sessions.json'), 'utf8')).models?.[`tui:${ready.conversation}`]?.reasoningEffort === 'high', JSON.stringify(kept?.current))
  await c.close()
  await t.done()
}

{
  // A /model choice in a conversation that never ran a turn goes once it is older than the retention.
  const old = Date.now() - 400 * 24 * 3600 * 1000
  const t = boot({ state: { models: { 'tui:never-used': { provider: 'p', model: 'm', at: old } } } })
  await sleep(100)
  const c = client(join(t.stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION })
  await c.waitFor((f) => f.type === 'ready')
  c.send({ type: 'message', text: 'hi' })
  for (let i = 0; i < 100 && t.created.length === 0; i++) await sleep(10)
  await sleep(300)
  check('model: an old choice with no conversation behind it is pruned', JSON.parse(readFileSync(join(t.stateDir, 'sessions.json'), 'utf8')).models?.['tui:never-used'] === undefined)
  await c.close()
  await t.done()
}

{
  // A /model answer belongs to the conversation that asked: switched away before it came, it is not sent
  // (it used to land on the new conversation, after its ready, and say it ran on the old one's model).
  const slow = {
    listProviders: () => [{ id: 'p' }],
    listModels: async (p) => { await sleep(150); return [{ provider: p, id: 'm2', name: 'M2' }] },
    resolveModelInfo: async () => ({}),
  }
  const t = boot({ services: { llm: slow, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm1' }) } } })
  await sleep(100)
  const c = client(join(t.stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION })
  const first = await c.waitFor((f) => f.type === 'ready')
  c.send({ type: 'model', provider: 'p', model: 'm2' })
  c.send({ type: 'hello', version: PROTOCOL_VERSION, conversation: 'conv-b' })
  await c.waitFor((f) => f.type === 'ready' && f.conversation === 'conv-b')
  await sleep(400)
  const after = c.frames.slice(c.frames.findIndex((f) => f.type === 'ready' && f.conversation === 'conv-b'))
  check('model: an answer for the conversation switched away from is not sent to the new one', !after.some((f) => f.type === 'model'), JSON.stringify(after.map((f) => f.type)))
  check('model: the choice still holds for the conversation that asked', JSON.parse(readFileSync(join(t.stateDir, 'sessions.json'), 'utf8')).models?.[`tui:${first.conversation}`]?.model === 'm2')
  await c.close()
  await t.done()
}

{
  // The deployment's reasoning effort reaches the turn: it used to be read and dropped.
  const efforts = { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }] } }
  const llm = { listProviders: () => [{ id: 'og' }], listModels: async (p) => [{ provider: p, id: 'deepseek/deepseek-v4.1-flash-ultrafast', name: 'Ultrafast' }], resolveModelInfo: async () => efforts }
  const t = boot({ services: { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'og', model: 'deepseek/deepseek-v4.1-flash-ultrafast', reasoningEffort: 'medium' }) } } })
  await sleep(100)
  const c = client(join(t.stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION })
  await c.waitFor((f) => f.type === 'ready')
  c.send({ type: 'message', text: 'hi' })
  for (let i = 0; i < 100 && t.created.length === 0; i++) await sleep(10)
  check('effort: the deployment\'s reasoning effort is passed with its model', JSON.stringify(t.created[0]?.agentOptions) === JSON.stringify({ provider: 'og', model: 'deepseek/deepseek-v4.1-flash-ultrafast', reasoningEffort: 'medium' }), JSON.stringify(t.created[0]?.agentOptions))
  await c.close()
  await t.done()
}

{
  // A deployment effort its model does not take is left out, not sent: the harness refuses a call with one
  // (UNSUPPORTED_REASONING_EFFORT), and every turn would fail — the template's own by-hand route did this.
  const llm = { listProviders: () => [{ id: 'gw' }], listModels: async (p) => [{ provider: p, id: 'vendor/model-name', name: 'Model' }], resolveModelInfo: async () => ({}) }
  const t = boot({ services: { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'gw', model: 'vendor/model-name', reasoningEffort: 'medium' }) } } })
  await sleep(100)
  const c = client(join(t.stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION })
  await c.waitFor((f) => f.type === 'ready')
  c.send({ type: 'message', text: 'hi' })
  for (let i = 0; i < 100 && t.created.length === 0; i++) await sleep(10)
  check('effort: one the model does not take is not sent', JSON.stringify(t.created[0]?.agentOptions) === JSON.stringify({ provider: 'gw', model: 'vendor/model-name' }), JSON.stringify(t.created[0]?.agentOptions))
  check('effort: and that is logged', t.logs.some((l) => /vendor\/model-name takes no reasoning effort "medium"/.test(l)), t.logs.filter((l) => /effort/.test(l)).join(' | ').slice(0, 160))
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
  const slackPost = t.slack.posted.find((p) => /need permission/.test(p.text))
  check('approval: a platform without buttons (this fake Slack) is asked in words', slackPost !== undefined && slackPost.buttons === null && /\*allow\*/.test(slackPost.text), JSON.stringify(t.slack.posted.map((p) => p.text.slice(0, 30))))
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
        const gate = new Promise<void>((r) => {
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
      get: (id) => agents.find((a) => a.id === id),
    },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agentPresets: { resolve: async (id) => ({ id }), acquireScope: () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }), mount: async () => {} },
    permissionPresets: { resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }), set: () => {}, defaultPreset: 'standard' },
    // The harness's tool registry: an editor that presents its call as a diff; bash has no presenter here.
    // Tools are registered in the agent's scope, as the harness does it: the global view has none.
    tools: { get: (name, scope) => (name === 'str_replace_editor' && scope !== undefined && scope === agents[0]
      ? { presentCall: (args) => ({ card: 'diff', title: `str_replace ${args.path}`, diffs: [{ path: args.path, oldText: args.old_str, newText: args.new_str }] }) }
      : name === 'later' ? { presentCall: () => Promise.reject(new Error('not yet')) }
        : undefined) },
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
  check('stream: text deltas reach the terminal in order, with a reset for the failed attempt, the thinking and the tool step', kinds === '실패한 |<reset>|첫 줄 |<thinking>|<tool:read_file>|둘째 줄', kinds)
  check('stream: reasoning is not shown as the answer, and another session\'s text is not shown at all', !kinds.includes('생각') && !kinds.includes('남의'))
  check('stream: reasoning arrives as thinking, apart from the answer', streamed.find((f) => f.kind === 'thinking')?.text === '생각')
  // A tool call: the tool's own presentation (an edit's diff), else its first argument; then its result.
  emit('session/event', agent.session, { type: 'tool/call', data: { name: 'str_replace_editor', callId: 'c1',
    arguments: JSON.stringify({ command: 'str_replace', path: '/w/a.ts', old_str: 'old line', new_str: 'new line' }) } })
  emit('session/event', agent.session, { type: 'tool/call', data: { name: 'bash', callId: 'c2', arguments: JSON.stringify({ command: 'ls -la' }) } })
  emit('session/event', agent.session, { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'edited' }], isError: false } } })
  emit('session/event', agent.session, { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'x'.repeat(10000) }], isError: true } } })
  await sleep(80)
  const tools = c.frames.filter((f) => f.type === 'stream' && (f.kind === 'tool' || f.kind === 'tool.result'))
  const edit = tools.find((f) => f.callId === 'c1' && f.kind === 'tool')
  check('tools: an edit shows the tool\'s own title and its diff', edit?.title === 'str_replace /w/a.ts' && edit.diff?.[0]?.old === 'old line' && edit.diff[0].new === 'new line', JSON.stringify(edit))
  check('tools: a tool without a presenter shows its first argument', tools.find((f) => f.callId === 'c2' && f.kind === 'tool')?.title === 'ls -la')
  const results = tools.filter((f) => f.kind === 'tool.result')
  check('tools: each result names its call, with whether it failed', results.length === 2 && results[0].callId === 'c1' && results[0].ok === true && results[0].text === 'edited' && results[1].ok === false, JSON.stringify(results.map((r) => ({ ...r, text: r.text.slice(0, 20) }))))
  check('tools: a long result is cut before it reaches the terminal', results[1].text.length <= 4001)
  // An edit too large to send whole is cut at a line and marked; a presenter that answers later or
  // throws falls back to the first argument; another session's calls (a subagent's) are not shown here.
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
  emit('session/event', agent.session, { type: 'tool/call', data: { name: 'str_replace_editor', callId: 'c3',
    arguments: JSON.stringify({ command: 'str_replace', path: '/w/big.ts', old_str: big, new_str: big.replace(/line/g, 'LINE') }) } })
  emit('session/event', agent.session, { type: 'tool/call', data: { name: 'str_replace_editor', callId: 'c3b',
    arguments: JSON.stringify({ command: 'str_replace', path: '/w/big.ts', old_str: big, new_str: `top\n${big}` }) } })
  emit('session/event', agent.session, { type: 'tool/call', data: { name: 'later', callId: 'c4', arguments: JSON.stringify({ path: '/w/x' }) } })
  emit('session/event', { id: 'child-session', header: { id: 'child-session' } }, { type: 'tool/call', data: { name: 'bash', callId: 'c5', arguments: JSON.stringify({ command: 'child only' }) } })
  await sleep(80)
  const later = c.frames.filter((f) => f.type === 'stream' && f.kind === 'tool')
  const cut = later.find((f) => f.callId === 'c3')?.diff?.[0]
  check('tools: a large edit is cut to few enough lines to compare', cut?.old.split('\n').length <= 400 && cut.new.split('\n').length <= 400, `${cut?.old.split('\n').length} / ${cut?.new.split('\n').length}`)
  const top = later.find((f) => f.callId === 'c3b')?.diff?.[0]
  check('tools: a line put on top of a large file is sent as that line, whole and unmarked', top?.old === null && top.new === 'top' && top.oldCut === undefined && top.newCut === undefined, JSON.stringify(top))
  check('tools: a large edit is cut at a line boundary and marked as cut', cut?.oldCut === true && cut?.newCut === true && cut.old.length <= 8000 && /^line \d+$/.test(cut.old.split('\n').at(-1)) && /^LINE \d+$/.test(cut.new.split('\n').at(-1)), JSON.stringify({ oldCut: cut?.oldCut, newCut: cut?.newCut, oldEnd: cut?.old?.slice(-20), newEnd: cut?.new?.slice(-20) }))
  // Which side was cut is said per side; a text of exactly the line limit that ends in a newline is whole.
  const exact = `${Array.from({ length: 400 }, (_, i) => `o${i}`).join('\n')}\n`
  emit('session/event', agent.session, { type: 'tool/call', data: { name: 'str_replace_editor', callId: 'c6',
    arguments: JSON.stringify({ command: 'str_replace', path: '/w/e.ts', old_str: exact, new_str: `${Array.from({ length: 600 }, (_, i) => `n${i}`).join('\n')}\n` }) } })
  await sleep(80)
  const sides = c.frames.find((f) => f.type === 'stream' && f.kind === 'tool' && f.callId === 'c6')?.diff?.[0]
  check('tools: only the side that was cut is marked', sides !== undefined && sides.oldCut === undefined && sides.newCut === true, JSON.stringify({ oldCut: sides?.oldCut, newCut: sides?.newCut }))
  // An edit is sent as the part that changed: the lines both whole texts share, first and last, are
  // set aside in the core, which has the whole texts. So a cut never makes text that is still in the
  // file look removed — the fixtures end in a newline and share blank lines and braces on purpose.
  const drawn = (frame) => toolCallBlock(frame, { expanded: true }, 'none').lines(200).map((l) => l.spans.map((sp) => sp.text).join(''))
  const added = Array.from({ length: 260 }, (_, i) => (i % 5 === 4 ? '' : i % 5 === 3 ? '}' : `const v${i} = ${i}`)).join('\n')
  const stays = Array.from({ length: 120 }, (_, i) => (i % 4 === 3 ? '}' : `keep${i}()`)).join('\n')
  const gone = Array.from({ length: 450 }, (_, i) => (i % 4 === 3 ? '}' : `gone${i}()`)).join('\n')
  const sendEdit = (callId, old_str, new_str) => emit('session/event', agent.session, { type: 'tool/call', data: { name: 'str_replace_editor', callId, arguments: JSON.stringify({ command: 'str_replace', path: '/w/app.ts', old_str, new_str }) } })
  sendEdit('c7', 'export default App\n', `${added}\nexport default App\n`)
  sendEdit('c8', `${stays}\n`, `${gone}\n${stays}\n`)
  sendEdit('c9', `${gone}\n${stays}\n`, `${stays}\n`)
  await sleep(80)
  const sent = (id) => c.frames.find((f) => f.type === 'stream' && f.kind === 'tool' && f.callId === id)
  const above = sent('c7')
  check('tools: lines put above a file\'s last line are sent without that line', above?.diff?.[0]?.old === null && !above.diff[0].new.includes('export default App'), JSON.stringify({ old: above?.diff?.[0]?.old, newEnd: above?.diff?.[0]?.new?.slice(-30) }))
  check('tools: and the card shows no removal', above !== undefined && !drawn(above).some((row) => /^\s+- /.test(row)) && drawn(above).some((row) => row.includes('+ const v0 = 0')), JSON.stringify(above === undefined ? [] : drawn(above).filter((row) => /^\s+- /.test(row)).slice(0, 3)))
  const grown = sent('c8')
  check('tools: 450 lines above 120 that stay show additions only, cut and marked', grown?.diff?.[0]?.old === null && grown.diff[0].newCut === true && !drawn(grown).some((row) => /^\s+- /.test(row)) && drawn(grown).some((row) => row.includes('+ gone0()')), JSON.stringify(grown === undefined ? [] : drawn(grown).filter((row) => /^\s+- /.test(row)).slice(0, 3)))
  const shrunk = sent('c9')
  check('tools: 450 lines deleted above 120 that stay show removals only', shrunk?.diff?.[0]?.new === null && shrunk.diff[0].oldCut === true && !drawn(shrunk).some((row) => /^\s+\+ /.test(row)) && drawn(shrunk).some((row) => row.includes('- gone0()')), JSON.stringify(shrunk === undefined ? [] : drawn(shrunk).filter((row) => /^\s+\+ /.test(row)).slice(0, 3)))
  // One side cut, the other whole and not empty: the comparison is made against a cut text, so a
  // blank line or a brace can be paired with the wrong one and a kept line fall between. Only a line
  // whose text is nowhere on the whole side is certain.
  const rows450 = Array.from({ length: 450 }, (_, i) => `row${i}()`).join('\n')
  sendEdit('c11', `head()\n}\n\nconst x = load()\n${rows450}\n}\n\ntail_old()\n`, 'head()\nconst x = load()\n}\n\ntail_new()\n')
  sendEdit('c12', 'head()\nconst x = load()\n}\n\ntail_old()\n', `head()\n}\n\nconst x = load()\n${rows450}\n}\n\ntail_new()\n`)
  // A single line as long as the budget is whole; and a change of the final newline alone is a change.
  sendEdit('c13', `${'a'.repeat(8000)}\nsame\n`, 'b\nsame\n')
  sendEdit('c14', 'a\nb', 'a\nb\n')
  await sleep(80)
  const oldCutCard = sent('c11')
  check('tools: with the old side cut, a kept line is not shown removed', oldCutCard?.diff?.[0]?.oldCut === true && oldCutCard.diff[0].newCut === undefined && !drawn(oldCutCard).some((row) => row.includes('- const x = load()')) && drawn(oldCutCard).some((row) => row.includes('- row0()')), JSON.stringify(oldCutCard === undefined ? [] : drawn(oldCutCard).slice(0, 5)))
  const newCutCard = sent('c12')
  check('tools: with the new side cut, a kept line is not shown added', newCutCard?.diff?.[0]?.newCut === true && newCutCard.diff[0].oldCut === undefined && !drawn(newCutCard).some((row) => row.includes('+ const x = load()')) && drawn(newCutCard).some((row) => row.includes('+ row0()')), JSON.stringify(newCutCard === undefined ? [] : drawn(newCutCard).slice(0, 5)))
  const longLine = sent('c13')?.diff?.[0]
  check('tools: one line exactly as long as the budget is sent whole, not marked cut', longLine?.old?.length === 8000 && longLine.oldCut === undefined && longLine.new === 'b', JSON.stringify({ old: longLine?.old?.length, oldCut: longLine?.oldCut, new: longLine?.new }))
  const eol = sent('c14')
  check('tools: a change of the final newline alone still shows a row', eol !== undefined && drawn(eol).length > 1, JSON.stringify(eol?.diff))
  // Found in review: when the final newlines differ alongside a real change, no blank line that never
  // existed is drawn removed or added.
  sendEdit('c15', 'a\n', 'a\nb')
  sendEdit('c16', 'x\ny\n', 'x\nz')
  await sleep(80)
  const blankRow = (frame) => drawn(frame).some((row) => /^\s+[-+]\s*$/.test(row))
  check('tools: a line added where the final newline went shows that line only', sent('c15') !== undefined && drawn(sent('c15')).some((row) => row.includes('+ b')) && !blankRow(sent('c15')), JSON.stringify(sent('c15') === undefined ? [] : drawn(sent('c15'))))
  check('tools: a line replaced where the final newline went shows the two lines only', sent('c16') !== undefined && drawn(sent('c16')).some((row) => row.includes('- y')) && drawn(sent('c16')).some((row) => row.includes('+ z')) && !blankRow(sent('c16')), JSON.stringify(sent('c16') === undefined ? [] : drawn(sent('c16'))))
  check('tools: a presenter that answers with a promise is not waited for: the first argument is the title', later.find((f) => f.callId === 'c4')?.title === '/w/x')
  check('tools: another session\'s tool call is not shown in this conversation', !later.some((f) => f.callId === 'c5'))
  check('stream: a terminal turn posts no progress message (the steps are already on screen)', !c.frames.some((f) => f.type === 'post' && /is working/.test(f.text)))
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
  const usage = await c.waitFor((f) => f.type === 'post' && /This conversation: 4 turns/.test(f.text))
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
        const gate = new Promise<void>((r) => { release = r })
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
        const gate = new Promise<void>((r) => { release = r })
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
        const gate = new Promise<void>((r) => { release = r })
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
    { platform: 'local', targetChannels: [LOCAL_CHANNEL], stateDir, tenantIsolation: true, tenantDefault: '한국어 팀', autoIndex: false, language: 'ko' })
  await sleep(150)
  const c = client(join(stateDir, 'tui.sock'))
  await c.opened
  c.send({ type: 'hello', version: PROTOCOL_VERSION })
  const ready = await c.waitFor((f) => f.type === 'ready')
  check('default tenant: a terminal that asks for none is in the configured default, Korean name and all', ready?.tenant === '한국어 팀' && ready.workspace.endsWith('/tenants/한국어 팀'), JSON.stringify(ready))
  check('language: ready names the deployment\'s language, for the terminal to speak', ready?.language === 'ko', String(ready?.language))
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
    const reports = slack.posted.filter((p) => /Stopped/.test(p.text))
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
