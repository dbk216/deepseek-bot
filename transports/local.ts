/**
 * The local transport: a unix socket the terminal UI connects to.
 *
 * It is a platform like the others — inbound frames become the same InboundMessage, and the core's
 * replies come back as frames — so a terminal conversation gets the persona, the memory of its
 * workspace, recall, approvals and the turn queue without any of it knowing a terminal exists.
 *
 * Only the owner can connect: the socket is created 0600 in the deployment's state directory (or a
 * per-user temporary directory when that path is too long for a socket). On Windows it is a named
 * pipe, whose default ACL lets only the owner, SYSTEM and administrators write; any user of the
 * machine may open it read-only, which gets nothing (nothing is sent before a hello), and such a
 * connection gives way to a terminal when the places are full. A reply that finds no terminal is
 * kept, within a bound, until its conversation reconnects.
 */
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect as dial, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createBridge, type Services } from '../tui/bridge.js'
import { t } from '../tui/strings.js'
import { discoveryDir, encode, FrameReader, MAX_FRAME_BYTES, NAME, PROTOCOL_VERSION, type ConversationItem, type ModelChoice, type ModelItem, type ServerFrame } from '../tui/protocol.js'
import type { ActionButton, ActionEvent, InboundMessage, PostedMessage, QuestionAnswer, QuestionItem, StreamFrame, Target, Transport, TransportStatus } from '../types/transport.js'

/** The channel every terminal conversation lives in; the conversation id is its thread. */
export const LOCAL_CHANNEL = 'tui'

/** macOS limits a socket path to 104 bytes including the terminator. */
const MAX_SOCKET_PATH = 103
/** Replies kept for a conversation with no terminal attached, and how many such conversations. */
const KEEP_PER_CONVERSATION = 20
const KEEP_CONVERSATIONS = 50
/** Terminals attached at once. */
const MAX_CLIENTS = 16
/** Panel refreshes: coalesced after events, and a slow heartbeat while something runs. */
const PANEL_DEBOUNCE_MS = 400
const PANEL_HEARTBEAT_MS = 3000
/** A terminal that stops reading is let go past this much unsent output, rather than buffered forever. */
const MAX_UNSENT_BYTES = 8 * 1024 * 1024

interface LocalHost {
  cfg: Record<string, any>
  log: (...parts: unknown[]) => void
  sessionCwd: () => Promise<string>
  stateDir: string
  /** The directory a conversation works in (its tenant's or the home); defaults to the home. */
  workspaceFor?: (key: string) => Promise<string>
  /** This platform's conversations, newest first, for /sessions. */
  listConversations?: (channel: string) => Promise<ConversationItem[]>
  /** DSH services, for the agent panel and the views (subagents, jobs, transcripts). */
  services?: Services
  /** The root session of a conversation, from its first turn on. */
  sessionFor?: (key: string) => string | null
  /** The model a conversation's next turn uses (with no key, the deployment's), for the terminal's welcome box and status line. */
  model?: (key?: string) => string
  /** A conversation's effort as it stands, without asking the provider (for `ready`). */
  effortOf?: (key: string) => string | null
  /** A conversation's model and effort, and the efforts that model takes. */
  modelChoice?: (key: string) => Promise<ModelChoice>
  /** Every model the registered providers advertise. */
  listModels?: () => Promise<ModelItem[]>
  /** The efforts a model takes ([] for none, or when they cannot be read), for the /model picker. */
  effortsFor?: (provider: string, model: string) => Promise<string[]>
  /**
   * Take back the conversation's waiting messages that carry these ids (others, and one already started,
   * stay). `announce` is told which, before their typing stops. How many were taken back.
   */
  withdraw?: (key: string, ids: string[], announce: (ids: string[]) => void) => number
  /** Step a conversation's effort through the ones its model takes; what was wrong, or null. */
  stepEffort?: (key: string, step: 1 | -1) => Promise<null | { code: 'no-efforts'; model: string }>
  /** Set (or with null, clear) a conversation's own model; what was wrong with it, or null. */
  setModel?: (key: string, choice: { provider: string; model: string; effort?: string | null } | null) => Promise<null | { code: 'unknown-model' } | { code: 'no-key'; ref: string } | { code: 'effort'; efforts: string[] }>
  /** The tenant a conversation is recorded in (null: the home), or undefined when none is recorded. */
  boundTenant?: (key: string) => string | null | undefined
  /** The tenant a conversation is in now: recorded, asked for, or configured. */
  tenantOf?: (key: string) => string | null
  /** How many turns a conversation has running or waiting (each will send a typing-off). */
  busy?: (key: string) => number
  /** Whether a name can be a tenant here; a configured one may be outside NAME (Korean, a space). */
  validTenant?: (name: string) => boolean
  /** A conversation's last messages, for a terminal that resumes it. */
  conversationHistory?: (channel: string, conversation: string) => Promise<Array<{ role: 'user' | 'assistant'; text: string }>>
}

export interface LocalTransport extends Transport {
  readonly sessionPrefix: string
  claims(target: Target): boolean
  /** The tenant a terminal asked for, or null. Consulted by the core's tenant mapping. */
  tenantFor(target: Target): string | null
  ready(): boolean
  hasSocket(): boolean
  startTyping(target: Target): () => void
  remove(target: Target, ts: string): Promise<boolean>
  stream(target: Target, frame: StreamFrame): void
  turnEnded(target: Target): void
  ask(target: Target, questions: QuestionItem[], signal?: AbortSignal): Promise<QuestionAnswer[] | null | undefined>
}

interface Client {
  socket: Socket
  conversation: string | null
  /** What the terminal is looking at besides the conversation, kept fresh while it looks. */
  view: { kind: 'agent'; id: string; last: string } | { kind: 'job'; id: string; owner: string; cursor: number; status: string } | null
  /** The last panel sent, so an unchanged one is not sent again. */
  panel: string
  /** What that panel offered: the only subagents and jobs this terminal may open or act on. */
  offered: { agents: Set<string>; jobs: Map<string, string> }
  /** Whether it has sent anything. A terminal says hello at once; a read-only opener never can. */
  spoke: boolean
}

export function createLocalTransport(host: LocalHost): LocalTransport {
  const { cfg, log } = host
  // What this says to the terminal is English, as the terminal is, whatever the deployment's language.
  const say = t().gateway
  const name = typeof cfg.tuiName === 'string' && NAME.test(cfg.tuiName) ? cfg.tuiName : 'default'
  const discoveryFile = join(discoveryDir(), `${name}.json`)
  let server: Server | null = null
  let socketPath: string | null = null
  let handlers: { onMessage: (m: InboundMessage) => void; onAction?: (a: ActionEvent) => void } | null = null
  const clients = new Set<Client>()
  const tenants = new Map<string, string>()
  const kept = new Map<string, ServerFrame[]>()
  let seq = 0
  /** Questions waiting for the person, by id; re-sent to a terminal that reconnects. */
  const questions = new Map<string, { conversation: string; items: QuestionItem[]; finish: (answers: QuestionAnswer[] | null) => void }>()
  const bridge = host.services !== undefined ? createBridge(host.services, log, say) : null
  let unwatch: (() => void) | null = null
  let panelTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const rootOf = (client: Client) => (client.conversation === null ? null : host.sessionFor?.(`${LOCAL_CHANNEL}:${client.conversation}`) ?? null)

  /** Look again soon: several events in a burst cost one refresh. */
  function schedulePanels(): void {
    if (bridge === null || panelTimer !== null) return
    panelTimer = setTimeout(() => { panelTimer = null; void refreshPanels() }, PANEL_DEBOUNCE_MS)
    panelTimer.unref?.()
  }

  async function refreshPanels(): Promise<void> {
    if (bridge === null) return
    let busy = false
    for (const client of clients) {
      const root = rootOf(client)
      if (root === null) continue
      try {
        const panel = await bridge.panel(root)
        busy ||= panel.agents.some((a) => a.status === 'running') || panel.jobs.some((j) => j.status === 'running' || j.status === 'stopping')
        const encoded = JSON.stringify(panel)
        client.offered = { agents: new Set(panel.agents.map((a) => a.id)), jobs: new Map(panel.jobs.map((j) => [j.id, j.owner])) }
        if (encoded !== client.panel) { client.panel = encoded; send(client, { type: 'panel', ...panel }) }
        await refreshView(client)
      } catch (e) { log(`local: panel refresh failed: ${String((e as Error)?.message ?? e)}`) }
    }
    // The heartbeat runs only while something is running: elapsed time and tokens move then.
    if (busy && heartbeat === null) { heartbeat = setInterval(schedulePanels, PANEL_HEARTBEAT_MS); heartbeat.unref?.() }
    if (!busy && heartbeat !== null) { clearInterval(heartbeat); heartbeat = null }
  }

  async function refreshView(client: Client): Promise<void> {
    const view = client.view
    if (bridge === null || view === null) return
    if (view.kind === 'agent') {
      const lines = await bridge.transcript(view.id)
      const encoded = JSON.stringify(lines)
      if (encoded !== view.last) { view.last = encoded; send(client, { type: 'view', kind: 'agent', id: view.id, lines }) }
    } else {
      const out = bridge.jobOutput(view.owner, view.id, view.cursor)
      // Gone while it was running: its owning agent was released (this adapter releases it when the
      // turn ends) and took the job with it. Say so once, rather than leave the output looking live.
      if (out === null) {
        if (view.status === 'running' || view.status === 'stopping') {
          view.status = 'removed'
          send(client, { type: 'view', kind: 'job', id: view.id, text: '', append: true, status: 'removed' })
        }
        return
      }
      // New output, the first look, or a change of state (a job that finished with nothing more to say).
      if (out.text !== '' || view.cursor === 0 || out.status !== view.status) {
        send(client, { type: 'view', kind: 'job', id: view.id, text: out.text, append: view.cursor !== 0, status: out.status })
        view.cursor = out.next
        view.status = out.status
      }
    }
  }

  const stamp = () => {
    const now = Date.now()
    seq = (seq + 1) % 1000
    return `${Math.floor(now / 1000)}.${String(now % 1000).padStart(3, '0')}${String(seq).padStart(3, '0')}`
  }

  function send(client: Client, frame: ServerFrame): void {
    if (client.socket.destroyed) return
    let line = encode(frame)
    // The terminal refuses a line over MAX_FRAME_BYTES; say what was too big rather than send it.
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) line = encode({ type: 'error', code: 'too-large', message: say.frameTooLarge(frame.type) })
    client.socket.write(line)
    if (client.socket.writableLength > MAX_UNSENT_BYTES) {
      log(`local: a terminal stopped reading (${client.socket.writableLength} bytes unsent); disconnecting it`)
      client.socket.destroy()
    }
  }

  /** `work` over `items`, at most `limit` at once, the results in their order. */
  async function inBatches<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) { const i = next++; out[i] = await work(items[i]) }
    }))
    return out
  }

  const words = (list: unknown): string[] => (Array.isArray(list) ? list.filter((w): w is string => typeof w === 'string' && w.trim() !== '') : [])

  /** To every terminal on the conversation now, and nothing kept for later. */
  function toConversation(conversation: string, frame: ServerFrame): void {
    for (const c of clients) if (c.conversation === conversation) send(c, frame)
  }

  /**
   * A conversation's model and effort changes, one after another, so each answer says what its own change
   * left: two shift+tabs sent together were otherwise both answered with the second one's effort.
   */
  const modelChanges = new Map<string, Promise<void>>()
  function oneAtATime(conversation: string, work: () => Promise<void>): Promise<void> {
    const run = (modelChanges.get(conversation) ?? Promise.resolve()).then(work)
    const settled = run.catch(() => {})
    modelChanges.set(conversation, settled)
    void settled.then(() => { if (modelChanges.get(conversation) === settled) modelChanges.delete(conversation) })
    return run
  }

  /** Deliver to every terminal on the conversation; keep it when there is none (live frames are not kept). */
  function deliver(conversation: string, frame: ServerFrame): void {
    let reached = false
    for (const client of clients) if (client.conversation === conversation) { send(client, frame); reached = true }
    // Live frames are not kept; open questions are re-sent on hello instead.
    if (reached || frame.type === 'typing' || frame.type === 'stream' || frame.type === 'question' || frame.type === 'question.close') return
    const queue = kept.get(conversation) ?? []
    kept.delete(conversation)                       // re-insert: Map order is the eviction order
    queue.push(frame)
    if (queue.length > KEEP_PER_CONVERSATION) queue.splice(0, queue.length - KEEP_PER_CONVERSATION)
    kept.set(conversation, queue)
    while (kept.size > KEEP_CONVERSATIONS) kept.delete(kept.keys().next().value as string)
  }

  function refuse(client: Client, code: string, message: string, hello = false): void {
    send(client, { type: 'error', code, message, ...(hello ? { hello: true } : {}) })
  }

  async function onFrame(client: Client, frame: Record<string, unknown>): Promise<void> {
    switch (frame.type) {
      case 'hello': {
        // Every refusal here is marked as answering the hello, so the terminal can keep its old conversation.
        if (frame.version !== PROTOCOL_VERSION) return refuse(client, 'version', `protocol ${String(frame.version)} is not ${PROTOCOL_VERSION}`, true)
        const asked = typeof frame.conversation === 'string' ? frame.conversation : null
        if (asked !== null && !NAME.test(asked)) return refuse(client, 'bad-frame', 'a conversation id is 1-80 of [A-Za-z0-9._-], starting with a letter or digit', true)
        // NFC, as configured names are written: macOS hands a typed name back decomposed, and the same
        // directory under two spellings would be refused as another tenant and never indexed.
        const tenant = typeof frame.tenant === 'string' ? frame.tenant.normalize('NFC') : null
        if (tenant !== null) {
          // A tenant is a separate workspace; without isolation there is no such thing to join.
          if (cfg.tenantIsolation !== true) return refuse(client, 'tenant-isolation-off', say.tenantOff, true)
          if (!(host.validTenant?.(tenant) ?? NAME.test(tenant))) return refuse(client, 'bad-frame', say.badTenant, true)
        }
        const conversation = asked ?? randomUUID()
        // A conversation stays in the workspace it started in. A different tenant is refused; asking for
        // none (a plain --resume) gets the recorded one.
        const bound = host.boundTenant?.(`${LOCAL_CHANNEL}:${conversation}`)
        if (bound !== undefined && tenant !== null && tenant !== bound) {
          return refuse(client, 'tenant-mismatch', say.tenantMismatch(bound), true)
        }
        // Not recorded yet: a tenant asked for now, or one another terminal already chose for it.
        const effective = bound !== undefined ? bound : tenant ?? tenants.get(conversation) ?? null
        if (effective !== null) tenants.set(conversation, effective)
        client.conversation = conversation
        const workspace = await (host.workspaceFor?.(`${LOCAL_CHANNEL}:${conversation}`) ?? host.sessionCwd()).catch(() => '')
        send(client, {
          type: 'ready', version: PROTOCOL_VERSION, conversation, workspace,
          tenant: host.tenantOf?.(`${LOCAL_CHANNEL}:${conversation}`) ?? effective, model: host.model?.(`${LOCAL_CHANNEL}:${conversation}`) ?? '',
          effort: host.effortOf?.(`${LOCAL_CHANNEL}:${conversation}`) ?? null,
          busy: host.busy?.(`${LOCAL_CHANNEL}:${conversation}`) ?? 0,
          // So the terminal does not queue them behind a running turn: the core answers them at once, whatever
          // it is doing. (An approval's yes or no only while one is asked, which the terminal cannot know.)
          stop: words(cfg.cancelWords),
          instant: words(cfg.usageWords),
        })
        const missed = kept.get(conversation)
        if (missed !== undefined) { kept.delete(conversation); for (const f of missed) send(client, f) }
        client.panel = ''
        client.offered = { agents: new Set(), jobs: new Map() }
        client.view = null
        schedulePanels()
        for (const [id, q] of questions) if (q.conversation === conversation) send(client, { type: 'question', id, questions: q.items })
        return
      }
      case 'answer': {
        const pending = typeof frame.id === 'string' ? questions.get(frame.id) : undefined
        if (pending === undefined || pending.conversation !== client.conversation) return refuse(client, 'question-closed', say.questionClosed)
        if (frame.answers === null) { pending.finish(null); return }
        const answers = validAnswers(pending.items, frame.answers)
        if (answers === null) return refuse(client, 'bad-frame', 'one answer per question, with labels from its options')
        pending.finish(answers)
        return
      }
      case 'view': {
        // Only what this terminal's own panel offered: not another conversation's child or job.
        if (frame.kind === 'agent' && typeof frame.id === 'string' && client.offered.agents.has(frame.id)) client.view = { kind: 'agent', id: frame.id, last: '' }
        else if (frame.kind === 'job' && typeof frame.id === 'string' && client.offered.jobs.get(frame.id) === frame.owner) client.view = { kind: 'job', id: frame.id, owner: frame.owner as string, cursor: 0, status: '' }
        else if (frame.kind === 'main') client.view = null
        else return refuse(client, 'not-offered', say.notInPanel)
        await refreshView(client)
        return
      }
      case 'agent.send':
      case 'agent.interrupt': {
        const root = rootOf(client)
        if (bridge === null || root === null || typeof frame.id !== 'string' || !client.offered.agents.has(frame.id)) return refuse(client, 'agent-unavailable', say.notSubagent)
        if (frame.type === 'agent.interrupt') { await bridge.interrupt(root, frame.id); schedulePanels(); return }
        if (typeof frame.text !== 'string' || frame.text === '') return refuse(client, 'bad-frame', say.needsText)
        const error = await bridge.send(root, frame.id, frame.text)
        if (error !== null) return refuse(client, 'agent-send', error)
        schedulePanels()
        return
      }
      case 'job.kill': {
        if (bridge === null || typeof frame.id !== 'string' || typeof frame.owner !== 'string' || client.offered.jobs.get(frame.id) !== frame.owner) return refuse(client, 'not-offered', say.notJob)
        bridge.killJob(frame.owner, frame.id)
        schedulePanels()
        return
      }
      case 'message':
      case 'cancel':
      case 'usage': {
        if (client.conversation === null) return refuse(client, 'no-hello', 'say hello first')
        // Stopping and asking what it cost are words the core already answers on every platform.
        const words = frame.type === 'cancel' ? cfg.cancelWords : frame.type === 'usage' ? cfg.usageWords : null
        const text = words === null ? frame.text : (Array.isArray(words) ? words[0] : undefined)
        if (typeof text !== 'string' || text === '') {
          return refuse(client, words === null ? 'bad-frame' : `${frame.type}-unsupported`, words === null ? say.needsText : `no ${frame.type} word is configured`)
        }
        // The terminal's own id for the message, so ↑ can take it back while it waits.
        const given: unknown = frame.type === 'message' ? frame.id : undefined
        if (given !== undefined && (typeof given !== 'string' || !/^[\w-]{1,64}$/.test(given))) return refuse(client, 'bad-frame', say.badMessageId)
        const id = typeof given === 'string' ? given : undefined
        handlers?.onMessage({
          eventId: `local-${randomUUID()}`,
          target: { channel: LOCAL_CHANNEL, threadTs: client.conversation },
          ts: stamp(),
          text,
          user: 'local',
          addressed: true,
          files: [],
          raw: frame,
          ...(id !== undefined ? { clientId: id } : {}),
        })
        return
      }
      case 'models': {
        if (client.conversation === null) return refuse(client, 'no-hello', 'say hello first')
        const asked = client.conversation
        const key = `${LOCAL_CHANNEL}:${asked}`
        const listed = await (host.listModels?.() ?? Promise.resolve([])).catch(() => [])
        // Each with the efforts it takes, four read at a time; one that cannot be read has none to step.
        const { effortsFor } = host
        const items = effortsFor === undefined ? listed : await inBatches(listed, 4, async (item) => ({ ...item, efforts: await effortsFor(item.provider, item.id).catch(() => []) }))
        const current = await host.modelChoice?.(key).catch(() => null)
        // An answer for a conversation the terminal has since left is not sent: it would land on the new one.
        if (client.conversation !== asked) return
        if (items.length === 0 || current == null) return refuse(client, 'models-unavailable', say.noModels)
        send(client, { type: 'models', current, items })
        return
      }
      case 'model': {
        if (client.conversation === null) return refuse(client, 'no-hello', 'say hello first')
        const asked = client.conversation
        const key = `${LOCAL_CHANNEL}:${asked}`
        const { setModel, modelChoice } = host
        if (setModel === undefined || modelChoice === undefined) return refuse(client, 'models-unavailable', say.noModels)
        const clear = frame.provider === null
        if (!clear && (typeof frame.provider !== 'string' || typeof frame.model !== 'string' || (frame.effort != null && typeof frame.effort !== 'string'))) return refuse(client, 'bad-frame', 'a model is a provider and a model id')
        const wanted = clear ? null : { provider: frame.provider as string, model: frame.model as string, effort: typeof frame.effort === 'string' ? frame.effort : null }
        return oneAtATime(asked, async () => {
          let problem: Awaited<ReturnType<typeof setModel>>
          try { problem = await setModel(key, wanted) } catch (e) { if (client.conversation === asked) refuse(client, 'model', String((e as Error)?.message ?? e).slice(0, 200)); return }
          if (problem !== null && wanted !== null) {
            const named = `${wanted.provider}/${wanted.model}`
            if (client.conversation === asked) refuse(client, 'model', problem.code === 'unknown-model' ? say.unknownModel(named) : problem.code === 'no-key' ? say.noModelKey(wanted.provider, problem.ref) : say.noSuchEffort(named, String(wanted.effort), problem.efforts))
            return
          }
          // The choice holds for the conversation that made it: every terminal still on it is told, and
          // one that has left is not (it would land on the conversation it is on now).
          toConversation(asked, { type: 'model', current: await modelChoice(key) })
        })
      }
      case 'effort': {
        if (client.conversation === null) return refuse(client, 'no-hello', 'say hello first')
        if (frame.step !== 1 && frame.step !== -1) return refuse(client, 'bad-frame', 'an effort step is 1 or -1')
        const asked = client.conversation
        const key = `${LOCAL_CHANNEL}:${asked}`
        const { stepEffort, modelChoice } = host
        if (stepEffort === undefined || modelChoice === undefined) return refuse(client, 'models-unavailable', say.noModels)
        const step = frame.step
        return oneAtATime(asked, async () => {
          let problem: Awaited<ReturnType<typeof stepEffort>>
          try { problem = await stepEffort(key, step) } catch (e) { if (client.conversation === asked) refuse(client, 'effort', String((e as Error)?.message ?? e).slice(0, 200)); return }
          if (problem !== null) { if (client.conversation === asked) refuse(client, 'effort', say.noEfforts(problem.model)); return }
          toConversation(asked, { type: 'model', current: await modelChoice(key), cause: 'effort' })
        })
      }
      case 'withdraw': {
        if (client.conversation === null) return refuse(client, 'no-hello', 'say hello first')
        const ids = frame.ids
        if (!Array.isArray(ids) || ids.length > 200 || !ids.every((id) => typeof id === 'string')) return refuse(client, 'bad-frame', say.idsNeeded)
        const conversation = client.conversation
        // Every terminal on the conversation is told, so each counts those ends apart and takes back its own.
        const announce = (withdrawn: string[]) => toConversation(conversation, { type: 'withdrawn', ids: withdrawn })
        if (host.withdraw === undefined) announce([])
        else host.withdraw(`${LOCAL_CHANNEL}:${conversation}`, ids, announce)
        return
      }
      case 'sessions': {
        const items = await (host.listConversations?.(LOCAL_CHANNEL) ?? Promise.resolve([])).catch(() => [])
        send(client, { type: 'sessions', items })
        return
      }
      case 'history': {
        if (client.conversation === null) return refuse(client, 'no-hello', 'say hello first')
        const items = await (host.conversationHistory?.(LOCAL_CHANNEL, client.conversation) ?? Promise.resolve([])).catch(() => [])
        send(client, { type: 'history', items })
        return
      }
      case 'action': {
        if (client.conversation === null) return refuse(client, 'no-hello', 'say hello first')
        // A button of this conversation's own messages: an approval for its own key, nothing else.
        // The core's buttons carry the request they were posted with (#<8 hex>); the conversation is what is checked here.
        const own = new RegExp(`^approval:(allow|deny):${LOCAL_CHANNEL}:${client.conversation.replace(/[.]/g, '\\.')}(#[0-9a-f]{8})?$`)
        if (typeof frame.id !== 'string' || !own.test(frame.id)) return refuse(client, 'not-offered', say.notButton)
        handlers?.onAction?.({ id: frame.id, target: { channel: LOCAL_CHANNEL, threadTs: client.conversation }, user: 'local' })
        return
      }
      default:
        // Its own code: a terminal newer than this gateway can say so, instead of showing this line.
        return refuse(client, 'unknown-frame', `unknown frame type ${String(frame.type)}`)
    }
  }

  /** Exactly one answer per question; picked labels must be the question's own options. */
  function validAnswers(items: QuestionItem[], raw: unknown): QuestionAnswer[] | null {
    if (!Array.isArray(raw) || raw.length !== items.length) return null
    const out: QuestionAnswer[] = []
    for (const item of items) {
      const a = raw.find((x) => x?.id === item.id)
      if (a === undefined || !Array.isArray(a.selected)) return null
      const labels = new Set(item.options.map((o) => o.label))
      if (a.selected.some((l: unknown) => typeof l !== 'string' || !labels.has(l))) return null
      if (!item.multiSelect && a.selected.length > 1) return null
      out.push({ id: item.id, selected: a.selected, ...(typeof a.custom === 'string' && a.custom !== '' ? { custom: a.custom } : {}) })
    }
    return out
  }

  function attach(socket: Socket): void {
    if (clients.size >= MAX_CLIENTS) {
      // Full: the oldest connection that has sent nothing gives way. On Windows any user may open
      // the pipe read-only and never speak, and enough of those would otherwise keep the owner out.
      const silent = [...clients].find((c) => !c.spoke)
      if (silent === undefined) { socket.end(encode({ type: 'error', code: 'busy', message: say.tooManyTerminals })); return }
      clients.delete(silent)
      silent.socket.destroy()
    }
    const client: Client = { socket, conversation: null, view: null, panel: '', offered: { agents: new Set(), jobs: new Map() }, spoke: false }
    const reader = new FrameReader()
    clients.add(client)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      client.spoke = true
      for (const r of reader.push(chunk)) {
        if (r.error !== undefined) refuse(client, 'bad-frame', r.error)
        else onFrame(client, r.frame!).catch((e) => log(`local: frame failed: ${String((e as Error)?.message ?? e)}`))
      }
    })
    const drop = () => {
      clients.delete(client)
      // A choice nobody holds and no message recorded is forgotten, so the map does not grow.
      const conversation = client.conversation
      if (conversation !== null && ![...clients].some((c) => c.conversation === conversation)
        && host.boundTenant?.(`${LOCAL_CHANNEL}:${conversation}`) === undefined) tenants.delete(conversation)
    }
    socket.on('close', drop)
    socket.on('error', (e) => { log(`local: terminal connection error: ${e.message}`); drop() })
  }

  /** Where to listen: the state directory, or a short per-user path when that is too long. */
  function chooseSocketPath(): string {
    const wanted = typeof cfg.tuiSocket === 'string' && cfg.tuiSocket !== '' ? cfg.tuiSocket : join(host.stateDir, 'tui.sock')
    // Windows listens only on named pipes (a file path is EACCES), in a namespace every user of the
    // machine shares. A name worked out from the path could be taken first, and a terminal
    // reconnecting to it would talk to whoever holds it, so the name is new at every start; the
    // terminal finds it through the discovery file. A configured pipe name is used as it is.
    if (process.platform === 'win32') {
      if (wanted.toLowerCase().startsWith('\\\\.\\pipe\\')) return wanted
      const pipe = `\\\\.\\pipe\\deepbot-tui-${randomUUID()}`
      if (typeof cfg.tuiSocket === 'string' && cfg.tuiSocket !== '') log(`local: tuiSocket ${wanted} is not a named pipe, which is all Windows listens on; using ${pipe}`)
      return pipe
    }
    if (Buffer.byteLength(wanted) <= MAX_SOCKET_PATH) return wanted
    // Shorter, and still the owner's own: beside the discovery files. A shared temporary directory
    // (Linux's /tmp) would let another user take a predictable name first.
    const hash = createHash('sha1').update(wanted).digest('hex').slice(0, 12)
    const short = [join(discoveryDir(), `${hash}.sock`), join(tmpdir(), `deepbot-tui-${hash}.sock`)].find((p) => Buffer.byteLength(p) <= MAX_SOCKET_PATH) ?? join(tmpdir(), `dbt-${hash}.sock`)
    log(`local: socket path ${wanted} is too long for a unix socket (${Buffer.byteLength(wanted)} bytes); using ${short}`)
    return short
  }

  /** A socket file that answers belongs to a live process; one that does not is left over from a crash. */
  function clearStale(path: string): Promise<void> {
    if (!existsSync(path)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const probe = dial(path)
      probe.once('connect', () => { probe.destroy(); reject(new Error(`${path} is in use by another process`)) })
      probe.once('error', () => { try { unlinkSync(path) } catch { /* gone already */ } resolve() })
    })
  }

  async function identity() {
    return { name: 'deepbot', id: 'local' }
  }

  return {
    sessionPrefix: 'tui',
    supportsButtons: true,

    claims: (target) => target?.channel === LOCAL_CHANNEL,
    tenantFor: (target) => (target?.threadTs ? tenants.get(target.threadTs) ?? null : null),
    ready: () => server !== null,
    hasSocket: () => server !== null,
    identity,

    async connect(h: { onMessage: (m: InboundMessage) => void; onStatus?: (s: TransportStatus) => void; onAction?: (a: ActionEvent) => void }) {
      handlers = h
      if (server !== null) return
      const path = chooseSocketPath()
      const pipe = process.platform === 'win32'
      if (!pipe) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      await clearStale(path)
      const s = createServer(attach)
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject)
        s.listen(path, () => { s.off('error', reject); resolve() })
      })
      // A pipe has no mode (chmod is EBUSY); its default ACL is what keeps others from writing to it.
      if (!pipe) chmodSync(path, 0o600)
      s.on('error', (e) => log(`local: server error: ${e.message}`))
      server = s
      socketPath = path
      if (bridge !== null && unwatch === null) unwatch = bridge.watch(schedulePanels)
      try {
        mkdirSync(dirname(discoveryFile), { recursive: true, mode: 0o700 })
        writeFileSync(discoveryFile, JSON.stringify({ socket: path, pid: process.pid, name, startedAt: Date.now(), version: PROTOCOL_VERSION }), { mode: 0o600 })
      } catch (e) { log(`local: discovery file not written: ${String((e as Error)?.message ?? e)}`) }
      h.onStatus?.({ connected: true, detail: `local socket ${path}` })
      log(`local: listening on ${path} (name ${name})`)
    },

    async post(target: Target, text: string, options: { replace?: string | null; buttons?: ActionButton[]; answer?: boolean } = {}): Promise<PostedMessage | null> {
      if (target.threadTs === null) return null
      // An edit keeps the message's id, as a Slack edit does: the core goes on editing by it.
      const ts = options.replace ?? stamp()
      deliver(target.threadTs, { type: 'post', ts, text, replace: options.replace ?? null, buttons: options.buttons ?? [], answer: options.answer === true })
      return { channel: LOCAL_CHANNEL, ts }
    },

    startTyping(target: Target) {
      const conversation = target.threadTs
      if (conversation === null) return () => {}
      deliver(conversation, { type: 'typing', on: true })
      let stopped = false
      return () => { if (!stopped) { stopped = true; deliver(conversation, { type: 'typing', on: false }) } }
    },

    ask(target: Target, items: QuestionItem[], signal?: AbortSignal) {
      const conversation = target.threadTs
      if (conversation === null || ![...clients].some((c) => c.conversation === conversation)) return Promise.resolve(undefined)
      const id = `q-${randomUUID()}`
      return new Promise<QuestionAnswer[] | null>((resolve) => {
        let done = false
        const finish = (answers: QuestionAnswer[] | null) => {
          if (done) return
          done = true
          questions.delete(id)
          deliver(conversation, { type: 'question.close', id })
          resolve(answers)
        }
        questions.set(id, { conversation, items, finish })
        // The turn was stopped or timed out: the question goes away with it.
        if (signal?.aborted) { finish(null); return }
        signal?.addEventListener('abort', () => finish(null), { once: true })
        deliver(conversation, { type: 'question', id, questions: items })
      })
    },

    turnEnded(target: Target) {
      for (const q of [...questions.values()]) if (q.conversation === target.threadTs) q.finish(null)
    },

    stream(target: Target, frame: StreamFrame) {
      if (target.threadTs !== null) deliver(target.threadTs, { type: 'stream', ...frame })
    },

    async remove(target: Target, ts: string) {
      if (target.threadTs === null) return false
      deliver(target.threadTs, { type: 'remove', ts })
      return true
    },

    // The conversation is the session: there is no platform history the agent has not seen.
    async fetchHistory() { return { text: '', lastTs: null } },
    async fetchAttachments() { return { text: '' } },

    async close() {
      if (server === null) return false
      const s = server
      server = null
      unwatch?.(); unwatch = null
      if (panelTimer !== null) { clearTimeout(panelTimer); panelTimer = null }
      if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null }
      for (const client of clients) client.socket.destroy()
      clients.clear()
      await new Promise<void>((resolve) => s.close(() => resolve()))
      if (socketPath !== null) { try { unlinkSync(socketPath) } catch { /* already gone */ } }
      try {
        const recorded = JSON.parse(readFileSync(discoveryFile, 'utf8'))
        if (recorded?.pid === process.pid && recorded?.socket === socketPath) unlinkSync(discoveryFile)
      } catch { /* none, or another process's */ }
      socketPath = null
      return true
    },
  }
}
