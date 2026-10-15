/**
 * The wire between the terminal UI and the gateway: newline-delimited JSON over a unix socket.
 *
 * Shared by both ends so they cannot disagree about a field name. The first frame each way
 * carries the version; a mismatch is refused with an error frame rather than half-working.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ActionButton, QuestionAnswer, QuestionItem, StreamFrame } from '../types/transport.js'
import type { AgentItem, JobItem, Usage, ViewLine } from './bridge.js'

export const PROTOCOL_VERSION = 1

/** Conversation ids, tenant and gateway names: what may go into a conversation key and a file name. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** Where each gateway records its socket, one `<tuiName>.json` per gateway: `$DSH_HOME/run/deepbot-tui`. */
export function discoveryDir(env: Record<string, string | undefined> = process.env): string {
  const home = env.DSH_HOME?.trim()
  return join(home ? home : join(homedir(), '.dsh'), 'run', 'deepbot-tui')
}

/** A frame larger than this is refused: a line that never ends must not grow a buffer forever. */
export const MAX_FRAME_BYTES = 1024 * 1024

export type ClientFrame =
  | { type: 'hello'; version: number; conversation?: string; tenant?: string }
  | { type: 'message'; text: string }
  | { type: 'action'; id: string }
  | { type: 'cancel' }
  /** Take back the messages waiting behind the running turn, which goes on. */
  | { type: 'withdraw' }
  | { type: 'usage' }
  | { type: 'sessions' }
  | { type: 'history' }
  | { type: 'view'; kind: 'main' | 'agent' | 'job'; id?: string; owner?: string }
  | { type: 'agent.send'; id: string; text: string }
  | { type: 'agent.interrupt'; id: string }
  | { type: 'job.kill'; id: string; owner: string }
  | { type: 'answer'; id: string; answers: QuestionAnswer[] | null }
  | { type: 'models' }
  /** This conversation's model from its next turn on; `provider: null` goes back to the deployment's. */
  | { type: 'model'; provider: string | null; model?: string; effort?: string | null }
  /** shift+tab: this conversation's next effort (1) or previous one (-1), of those its model takes. */
  | { type: 'effort'; step: 1 | -1 }

export type ServerFrame =
  /** `stop` and `instant`: the words the core answers at once, without a turn (the stop words, and the usage word). */
  | { type: 'ready'; version: number; conversation: string; workspace: string; tenant: string | null; model: string; effort?: string | null; busy: number; stop?: string[]; instant?: string[] }
  | { type: 'models'; current: ModelChoice; items: ModelItem[] }
  /** What a conversation runs on now, to every terminal on it; `cause: 'effort'` when only the effort was stepped. */
  | { type: 'model'; current: ModelChoice; cause?: 'effort' }
  | { type: 'post'; ts: string; text: string; replace: string | null; buttons: ActionButton[]; answer: boolean }
  | ({ type: 'stream' } & StreamFrame)
  | { type: 'remove'; ts: string }
  | { type: 'typing'; on: boolean }
  | { type: 'sessions'; items: ConversationItem[] }
  | { type: 'history'; items: Array<{ role: 'user' | 'assistant'; text: string }> }
  | { type: 'panel'; agents: AgentItem[]; jobs: JobItem[]; usage: Usage }
  | { type: 'question'; id: string; questions: QuestionItem[] }
  | { type: 'question.close'; id: string }
  | { type: 'view'; kind: 'agent'; id: string; lines: ViewLine[] }
  | { type: 'view'; kind: 'job'; id: string; text: string; append: boolean; status: string }
  | { type: 'error'; code: string; message: string; hello?: boolean }

/** A model a provider advertises, as /model lists it, with the efforts it takes when they could be read. */
export interface ModelItem { provider: string; id: string; name: string; description?: string; efforts?: string[] }

/** What a conversation runs on, and the reasoning efforts that model takes ([] when none). */
export interface ModelChoice { provider: string; model: string; effort: string | null; efforts: string[] }

/** A terminal conversation, as /sessions lists it. */
export interface ConversationItem {
  conversation: string
  sessionId: string
  lastAt: number
  turns: number
  tenant: string | null
  title: string
}

export function encode(frame: ClientFrame | ServerFrame): string {
  return `${JSON.stringify(frame)}\n`
}

/**
 * Splits a byte stream into frames. Bad JSON or an oversized line is reported, not thrown, so one
 * broken frame does not take the connection down with it.
 */
export class FrameReader {
  private buffer = ''

  push(chunk: string): Array<{ frame?: Record<string, unknown>; error?: string }> {
    this.buffer += chunk
    const out: Array<{ frame?: Record<string, unknown>; error?: string }> = []
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim() === '') continue
      try {
        const value = JSON.parse(line)
        if (value === null || typeof value !== 'object' || typeof value.type !== 'string') out.push({ error: 'frame without a type' })
        else out.push({ frame: value })
      } catch {
        out.push({ error: 'frame is not JSON' })
      }
    }
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) {
      this.buffer = ''
      out.push({ error: `frame exceeds ${MAX_FRAME_BYTES} bytes` })
    }
    return out
  }
}
