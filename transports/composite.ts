/**
 * Several transports as one: a deployment that serves Slack and a terminal at once.
 *
 * Two plugin rows were the obvious alternative and the wrong one: the tool policy is a
 * gateway-wide listener, so a second instance would gate every tool call twice and judge sessions
 * it does not own. One instance with one transport per platform keeps one policy, one queue and one
 * state file.
 *
 * A part that recognises a conversation as its own (`claims`) gets it; everything else goes to the
 * primary part. The core asks `forTarget` before using an optional capability — typing, deleting,
 * buttons, links — because those differ per platform, and a composite that answered for all of
 * them at once would hand Slack a typing indicator it does not have.
 */
import type { InboundMessage, Target } from '../types/transport.js'

interface Part {
  connect(handlers: unknown): Promise<void>
  post(target: Target, text: string, options?: unknown): Promise<unknown>
  fetchHistory(target: Target, options: unknown): Promise<unknown>
  fetchAttachments(message: InboundMessage, stamp: string): Promise<unknown>
  identity(): Promise<{ name: string; id: string; team?: string }>
  close(): Promise<boolean>
  claims?(target: Target): boolean
  ready?(): boolean
  hasSocket?(): boolean
  supportsButtons?: boolean
  [key: string]: any
}

export function createCompositeTransport(parts: Part[]) {
  if (parts.length === 0) throw new Error('a composite transport needs at least one part')
  const primary = parts.find((p) => typeof p.claims !== 'function') ?? parts[0]
  const connected = new Set<Part>()
  /** The primary failed to say who it is, and another part answered for it. */
  let primaryUnverified = false

  function forTarget(target: Target | null | undefined): Part {
    if (target != null) for (const p of parts) if (typeof p.claims === 'function' && p.claims(target)) return p
    return primary
  }

  return {
    forTarget,
    get supportsButtons() { return primary.supportsButtons === true },
    /**
     * The primary platform's identity — or, while it cannot say (Slack with a bad or missing token),
     * the next part's, so the core goes on to connect and the terminal comes up. The platform's own
     * failure is not hidden: `connect` asks it again before connecting it, and fails with its error.
     */
    async identity() {
      try {
        const me = await primary.identity()
        primaryUnverified = false
        return me
      } catch (e) {
        for (const part of parts) {
          if (part === primary) continue
          try { const me = await part.identity(); primaryUnverified = true; return me } catch { /* try the next */ }
        }
        throw e
      }
    },

    /** Whether the part that owns a conversation is connected; the core's restart recovery asks. */
    connectedFor: (target: Target) => connected.has(forTarget(target)),

    /**
     * Connect every part not yet connected — the claiming (local) parts first, so a terminal works
     * while the platform is still failing to authenticate. A failure is rethrown after the others
     * have had their turn; the core's retry then connects only what is still down.
     */
    async connect(handlers: unknown) {
      const order = [...parts.filter((p) => typeof p.claims === 'function'), ...parts.filter((p) => typeof p.claims !== 'function')]
      let failure: unknown = null
      for (const part of order) {
        if (connected.has(part)) continue
        try {
          // Who it is, first: Slack's connect opens Socket Mode with the app token and never checks the
          // bot token, so a bad one would connect and fail every reply, with its bot id never learned.
          if (part === primary && primaryUnverified) { await primary.identity(); primaryUnverified = false }
          await part.connect(handlers)
          connected.add(part)
        } catch (e) { failure ??= e }
      }
      if (failure !== null) throw failure
    },

    post: (target: Target, text: string, options?: unknown) => forTarget(target).post(target, text, options),
    fetchHistory: (target: Target, options: unknown) => forTarget(target).fetchHistory(target, options),
    fetchAttachments: (message: InboundMessage, stamp: string) => forTarget(message.target).fetchAttachments(message, stamp),

    /** Whether the primary platform can send; agent-initiated delivery and the probes ask this. */
    ready: () => (typeof primary.ready === 'function' ? primary.ready() : true),
    hasSocket: () => parts.some((p) => typeof p.hasSocket === 'function' && p.hasSocket()),
    authenticate: () => primary.authenticate?.(),
    historyRaw: (...args: unknown[]) => primary.historyRaw?.(...args),

    async close() {
      const closed = await Promise.all(parts.map((p) => p.close().catch(() => false)))
      connected.clear()
      return closed.some((c) => c === true)
    },
  }
}
