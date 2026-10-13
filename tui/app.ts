/**
 * The screen and what the user does on it.
 *
 * The app knows nothing about sockets or the harness: a backend receives what the user sends,
 * and the backend calls the methods below as the conversation happens. That split is what lets
 * every interaction here — typing, Enter, a drag that copies, the wheel, Esc, a double Ctrl+C —
 * be tested against a fake terminal and a fake backend.
 *
 * Layout, top to bottom: a header, the transcript, a divider, the status line, the input box,
 * and a hint line. Nothing frames the whole screen; the transcript gets every row it can.
 */
import { answerBlock, bannerBlock, noticeBlock, spacerBlock, toolBlock, userBlock, type AnswerBlock, type NoticeKind } from './blocks.js'
import type { AgentItem, JobItem, ViewLine } from './bridge.js'
import { formatTokens, panelCounts, panelRows, panelWindow, rowStatus, type PanelRow } from './panel.js'
import { AMBIGUITY_TARGET, readState, type InterviewState } from './interview.js'
import { QuestionFlow } from './question.js'
import { wrapPlain } from './render/text.js'
import type { QuestionAnswer, QuestionItem } from '../types/transport.js'
import { copy as systemCopy, type CopyMethod } from './render/clipboard.js'
import { Editor } from './render/editor.js'
import type { InputEvent, KeyEvent, MouseEvent } from './render/input.js'
import type { Screen } from './render/screen.js'
import { detectColorMode, sgr, theme, type ColorMode } from './render/style.js'
import { Terminal, type TerminalIO } from './render/terminal.js'
import { Transcript } from './render/transcript.js'
import { stringWidth } from './render/width.js'

export interface Backend {
  send(text: string): void
  cancel(): void
  /** A choice the bot offered (an approval button) was picked. */
  action(id: string): void
  /** Look at a subagent or a job (or back at the conversation); the gateway keeps it fresh. */
  view?(kind: 'main' | 'agent' | 'job', id?: string, owner?: string): void
  agentSend?(id: string, text: string): void
  agentInterrupt?(id: string): void
  jobKill?(id: string, owner: string): void
  /** The person's answers to a turn's questions, or null when they dismissed them. */
  answer?(id: string, answers: QuestionAnswer[] | null): void
}

export type View =
  | { kind: 'main' }
  | { kind: 'agent'; id: string; label: string; mode: string }
  | { kind: 'job'; id: string; owner: string; label: string }

export interface Choice {
  /** The message that offered it, so withdrawing the message withdraws the choice. */
  ts: string
  options: Array<{ id: string; label: string; style?: string }>
  index: number
}

export interface AppStatus {
  connected: boolean
  /** What the status line says while not connected. */
  link: string
  workspace: string
  session: string
  model: string
  preset: string
  running: boolean
  startedAt: number
  tokens: number
  contextPct: number | null
}

export interface Clock {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export interface AppOptions {
  io: TerminalIO
  env: Record<string, string | undefined>
  platform: string
  backend: Backend
  onExit(code: number): void
  clock?: Clock
  copy?: (text: string) => CopyMethod
  /** A typed line the app should not send (a /command): return true when it was handled. */
  intercept?: (text: string) => boolean
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const EDITOR_MAX_ROWS = 6
const TOAST_MS = 1500
/** A paste larger than this is cut: the core keeps a few thousand characters of a message anyway. */
const MAX_PASTE_CHARS = 200_000
const PANEL_MAX_ROWS = 6

export class App {
  readonly mode: ColorMode
  readonly transcript = new Transcript()
  readonly editor = new Editor()
  readonly terminal: Terminal
  readonly status: AppStatus = {
    connected: false, link: '연결 중…', workspace: '', session: '', model: '', preset: '',
    running: false, startedAt: 0, tokens: 0, contextPct: null,
  }
  private readonly o: AppOptions
  private readonly clock: Clock
  private readonly banner
  private answer: AnswerBlock | null = null
  private readonly posted = new Map<string, AnswerBlock>()
  /** The last answer block this turn streamed into: where the turn's reply belongs. */
  private turnBlock: AnswerBlock | null = null
  /** An open choice (an approval), shown above the input box. */
  choice: Choice | null = null
  /** The turn's subagents and background jobs, as the gateway last reported them. */
  private panel: { agents: AgentItem[]; jobs: JobItem[] } = { agents: [], jobs: [] }
  private showIdle = false
  private panelIndex = 0
  private panelTimer: unknown = null
  /** Where keys go: the input box, or the agent panel. */
  focus: 'editor' | 'panel' = 'editor'
  /** What the transcript pane shows: the conversation, or one subagent or job. */
  view: View = { kind: 'main' }
  /** The lines of the subagent or job being looked at. */
  private readonly side = new Transcript()
  /** Questions the turn is waiting on, answered in the panel above the input box. */
  question: QuestionFlow | null = null
  /** A deep interview in progress: its topic and the model's latest report on it. */
  interview: { topic: string; state: InterviewState | null } | null = null
  private toast: { text: string; until: number } | null = null
  private quitArmed = 0
  private spinTimer: unknown = null
  /** Turns the conversation has running or waiting: each sends typing on, then off. */
  private busy = 0
  private dragging = false
  /** Rows of the last frame, for mapping mouse coordinates. */
  private geometry = { transcriptTop: 1, transcriptHeight: 0, dividerRow: 0, editorTop: 0, choiceRow: -1, choiceSpans: [] as Array<{ from: number; to: number }>, panelTop: -1, panelFirst: 0, panelShown: 0, questionTop: -1, questionRowsAt: -1 }

  constructor(options: AppOptions) {
    this.o = options
    this.mode = detectColorMode(options.env)
    this.clock = options.clock ?? {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    }
    this.terminal = new Terminal({
      io: options.io,
      render: (screen) => this.render(screen),
      onEvent: (event) => this.onEvent(event),
      ...(options.clock ? { now: options.clock.now, setTimer: options.clock.setTimer, clearTimer: options.clock.clearTimer } : {}),
    })
    this.banner = bannerBlock(() => this.infoLine(), this.mode)
    this.transcript.push(this.banner)
  }

  start(): void {
    this.terminal.start()
  }

  stop(code = 0): void {
    this.stopSpinner()
    if (this.panelTimer !== null) { this.clock.clearTimer(this.panelTimer); this.panelTimer = null }
    this.terminal.restore()
    this.o.onExit(code)
  }

  // ── Called by the backend ───────────────────────────────────────────────

  setStatus(patch: Partial<AppStatus>): void {
    Object.assign(this.status, patch)
    if ('workspace' in patch || 'session' in patch || 'model' in patch) { this.banner.refresh(); this.transcript.touch() }
    this.terminal.requestRender()
  }

  turnStarted(): void {
    // A message queued behind a running turn also says "typing": count them, so the first turn's
    // end does not hide the second.
    if (this.busy++ === 0) {
      this.turnBlock = null
      this.status.running = true
      this.status.startedAt = this.clock.now()
      this.startSpinner()
    }
    this.terminal.requestRender()
  }

  /**
   * What the gateway says when this terminal (re)connects: how many turns are running or waiting
   * here, each of which will still send its typing-off.
   */
  setBusy(count: number): void {
    // A frame without the count (or a bad one) says nothing runs, never NaN turns.
    const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
    if (n === 0) { if (this.busy > 0) { this.busy = 1; this.turnEnded() } return }
    if (this.busy === 0) this.turnStarted()
    this.busy = n
  }

  /** Streamed answer text. The block is created on the first delta. */
  delta(text: string): void {
    if (this.answer === null) { this.answer = answerBlock(this.mode); this.transcript.push(this.answer); this.turnBlock = this.answer }
    this.answer.append(text)
    this.noteInterview(this.answer.text)
    this.transcript.touch()
    this.terminal.requestRender()
  }

  /** The current attempt failed and is being retried: drop what it streamed. */
  resetAttempt(): void {
    if (this.answer === null) return
    this.answer.reset()
    this.transcript.touch()
    this.terminal.requestRender()
  }

  tool(name: string, detail = ''): void {
    // A tool step closes the text streamed so far; the next delta starts a new answer block.
    this.closeAnswer()
    this.transcript.push(toolBlock(name, detail, this.mode))
    this.terminal.requestRender()
  }

  /** The turn's final text. Replaces the streamed text when there was any. */
  final(text: string): void {
    if (this.answer !== null) this.answer.finish(text)
    else if (text !== '') { const block = answerBlock(this.mode); block.finish(text); this.transcript.push(block) }
    this.answer = null
    this.transcript.touch()
    this.terminal.requestRender()
  }

  turnEnded(): void {
    this.closeAnswer()
    this.choice = null   // whatever it asked belonged to the turn
    this.busy = Math.max(0, this.busy - 1)
    if (this.busy === 0) {
      this.status.running = false
      this.stopSpinner()
    }
    this.terminal.requestRender()
  }

  notice(text: string, kind: NoticeKind = 'info'): void {
    this.transcript.push(noticeBlock(text, kind, this.mode))
    this.terminal.requestRender()
  }

  /**
   * A message the bot posted, by id. An edit (`replace`) rewrites it in place. The turn's reply
   * (`answer`) takes the place of the text this turn streamed, so it is never shown twice — and
   * nothing else may: an approval request mid-turn is a message of its own.
   */
  message(ts: string, text: string, replace: string | null, answer = false): void {
    this.noteInterview(text)
    const known = this.posted.get(replace ?? ts)
    const streamed = this.answer ?? this.turnBlock
    if (known !== undefined) {
      known.finish(text)
    } else if (answer && streamed !== null) {
      streamed.finish(text)
      this.remember(ts, streamed)
      this.answer = null
      this.turnBlock = null
    } else {
      const block = answerBlock(this.mode)
      block.finish(text)
      this.remember(ts, block)
      this.transcript.push(block)
    }
    this.transcript.touch()
    this.terminal.requestRender()
  }

  /** Begin a deep interview: the strip above the pane follows the model's reports from here. */
  startInterview(topic: string): void {
    this.interview = { topic, state: null }
    this.terminal.requestRender(true)
  }

  /** Send a message shown as `display` (a command's short form) rather than as its full text. */
  sendAs(display: string, text: string): void {
    this.transcript.push(userBlock(display, this.mode))
    this.transcript.push(spacerBlock())
    this.transcript.toBottom()
    this.o.backend.send(text)
  }

  private noteInterview(text: string): void {
    if (this.interview === null) return
    const state = readState(text)
    if (state !== null) this.interview.state = state
  }

  /** The turn asks the person something: open the question panel (a plan review shows the plan first). */
  ask(id: string, items: QuestionItem[]): void {
    for (const item of items) {
      if (item.intent?.kind === 'plan-review' && typeof item.detail === 'string') {
        this.transcript.push(noticeBlock('plan 검토 요청', 'warn', this.mode))
        const plan = answerBlock(this.mode)
        plan.finish(item.detail)
        this.transcript.push(plan)
      }
    }
    this.question = new QuestionFlow(id, items)
    this.transcript.toBottom()
    this.terminal.requestRender(true)
  }

  /** The question went away without us (the turn stopped, or it was answered elsewhere). */
  closeQuestion(id: string): void {
    if (this.question?.id !== id) return
    this.question = null
    this.notice('질문이 닫힘', 'info')
  }

  /** After each answer: record it, and send the batch when the last one is in. */
  private answered(): void {
    const q = this.question
    if (q === null) return
    const item = q.items[q.answers.length - 1]
    const answer = q.answers[q.answers.length - 1]
    if (item !== undefined && answer !== undefined) this.notice(`? ${item.question} → ${q.describe(answer)}`, 'info')
    if (q.done) {
      this.question = null
      this.o.backend.answer?.(q.id, q.answers)
    }
    this.terminal.requestRender(true)
  }

  /** A fresh screen for another conversation: the banner and nothing else. */
  clear(): void {
    this.interview = null
    // Another conversation: whatever was running belongs to the old one.
    this.busy = 0
    this.status.running = false
    this.stopSpinner()
    this.question = null
    this.closeAnswer()
    this.posted.clear()
    this.turnBlock = null
    this.choice = null
    this.transcript.clear()
    this.transcript.push(this.banner)
    this.terminal.requestRender(true)
  }

  /** Earlier messages of a resumed conversation, as they were said. */
  history(items: Array<{ role: 'user' | 'assistant'; text: string }>): void {
    if (items.length === 0) return
    this.notice(`이전 대화 · 최근 ${items.length}개 메시지`, 'info')
    for (const item of items) {
      if (item.role === 'user') { this.transcript.push(userBlock(item.text, this.mode)); this.transcript.push(spacerBlock()) }
      else { const block = answerBlock(this.mode); block.finish(item.text); this.transcript.push(block) }
    }
    this.notice('── 여기부터 이어서 ──', 'info')
    this.terminal.requestRender()
  }

  /** Buttons on a message: shown as a choice above the input box until picked or withdrawn. */
  offer(ts: string, options: Choice['options']): void {
    this.choice = options.length === 0 ? null : { ts, options, index: 0 }
    this.terminal.requestRender(true)
  }

  /** The bot withdrew a message — a working message the answer took the place of. */
  unpost(ts: string): void {
    if (this.choice?.ts === ts) this.choice = null
    const block = this.posted.get(ts)
    if (block === undefined) return
    this.posted.delete(ts)
    this.transcript.remove(block.id)
    this.terminal.requestRender()
  }

  /** Only recent messages are ever edited; older ids are forgotten so the map stays small. */
  private remember(ts: string, block: AnswerBlock): void {
    this.posted.set(ts, block)
    if (this.posted.size > 200) this.posted.delete(this.posted.keys().next().value as string)
  }

  // ── The agent panel and the views ───────────────────────────────────────

  /** The transcript on screen: the conversation, or the subagent or job being looked at. */
  private get pane(): Transcript {
    return this.view.kind === 'main' ? this.transcript : this.side
  }

  private rows(): PanelRow[] {
    return panelRows(this.panel.agents, this.panel.jobs, this.showIdle)
  }

  /** The gateway's latest picture of the turn's subagents and jobs. */
  setPanel(agents: AgentItem[], jobs: JobItem[]): void {
    this.panel = { agents, jobs }
    const rows = this.rows()
    if (rows.length === 0 && this.focus === 'panel') this.focus = 'editor'
    this.panelIndex = Math.max(0, Math.min(this.panelIndex, rows.length - 1))
    // Elapsed times move by themselves while anything runs.
    const busy = agents.some((a) => a.status === 'running') || jobs.some((j) => j.status === 'running')
    if (busy && this.panelTimer === null) {
      const tick = () => { this.panelTimer = null; if (this.rows().length === 0) return; this.terminal.requestRender(); this.panelTimer = this.clock.setTimer(tick, 1000) }
      this.panelTimer = this.clock.setTimer(tick, 1000)
    } else if (!busy && this.panelTimer !== null) {
      this.clock.clearTimer(this.panelTimer); this.panelTimer = null
    }
    this.terminal.requestRender()
  }

  /** A subagent's conversation, refreshed by the gateway while it is looked at. */
  agentLines(id: string, lines: ViewLine[]): void {
    if (this.view.kind !== 'agent' || this.view.id !== id) return
    this.side.clear()
    this.side.push(noticeBlock(`subagent · ${this.view.label} · ${this.view.mode}`, 'info', this.mode))
    for (const line of lines) {
      if (line.role === 'user') { this.side.push(userBlock(line.text, this.mode)); this.side.push(spacerBlock()) }
      else if (line.role === 'tool') this.side.push(toolBlock(line.text, '', this.mode))
      else { const block = answerBlock(this.mode); block.finish(line.text); this.side.push(block) }
    }
    this.terminal.requestRender()
  }

  /** A job's output: the first read, then what was added. */
  jobOutput(id: string, text: string, append: boolean, status: string): void {
    if (this.view.kind !== 'job' || this.view.id !== id) return
    if (!append) { this.side.clear(); this.side.push(noticeBlock(`shell · ${this.view.id} · ${this.view.label}`, 'info', this.mode)) }
    if (text !== '') { const block = answerBlock(this.mode); block.finish(text.replace(/\n$/, '')); this.side.push(block) }
    if (status === 'removed') this.side.push(noticeBlock('정리됨 · 이 job을 만든 turn이 끝나면서 함께 정리됨', 'warn', this.mode))
    else if (status !== 'running' && status !== 'stopping') this.side.push(noticeBlock(`종료됨 · ${status}`, status === 'completed' ? 'ok' : 'warn', this.mode))
    this.terminal.requestRender()
  }

  private open(row: PanelRow): void {
    if (row.kind === 'main') { this.backToMain(); return }
    if (row.kind === 'idle') { this.showIdle = true; this.terminal.requestRender(true); return }
    if (row.kind === 'more') { this.panelIndex = Math.min(this.rows().length - 1, this.panelIndex + 1); this.terminal.requestRender(true); return }
    this.side.clear()
    if (row.kind === 'agent') {
      this.view = { kind: 'agent', id: row.agent.id, label: row.agent.label, mode: row.agent.mode }
      this.side.push(noticeBlock(`subagent · ${row.agent.label} · 불러오는 중`, 'info', this.mode))
      this.o.backend.view?.('agent', row.agent.id)
    } else {
      this.view = { kind: 'job', id: row.job.id, owner: row.job.owner, label: row.job.label }
      this.side.push(noticeBlock(`shell · ${row.job.id} · 불러오는 중`, 'info', this.mode))
      this.o.backend.view?.('job', row.job.id, row.job.owner)
    }
    this.focus = 'editor'
    this.terminal.requestRender(true)
  }

  private backToMain(): void {
    if (this.view.kind !== 'main') { this.view = { kind: 'main' }; this.o.backend.view?.('main') }
    this.side.clear()
    this.focus = 'editor'
    this.terminal.requestRender(true)
  }

  // ── Input ───────────────────────────────────────────────────────────────

  private onEvent(event: InputEvent): void {
    if (event.type === 'paste') {
      this.clearSelection()
      const text = event.text.length > MAX_PASTE_CHARS ? event.text.slice(0, MAX_PASTE_CHARS) : event.text
      if (text !== event.text) this.showToast(`붙여넣기가 커서 앞 ${MAX_PASTE_CHARS.toLocaleString('en-US')}자만 넣음`)
      this.editor.insert(text)
      this.terminal.requestRender(true)
      return
    }
    if (event.type === 'mouse') { this.onMouse(event); return }
    this.onKey(event)
  }

  private onKey(key: KeyEvent): void {
    const width = this.editorWidth()
    if (!(key.ctrl && key.name === 'char' && key.ch === 'c')) this.quitArmed = 0
    if (key.name !== 'escape') this.clearSelection()

    if (this.question !== null && this.onQuestionKey(key)) return
    if (this.focus === 'panel' && this.onPanelKey(key)) return
    if (key.ctrl && key.name === 'char') {
      switch (key.ch) {
        case 'c': return this.ctrlC()
        case 'x':
          if (this.view.kind === 'agent') { this.o.backend.agentInterrupt?.(this.view.id); this.showToast(`${this.view.label} 중단 요청`) }
          else if (this.view.kind === 'job') { this.o.backend.jobKill?.(this.view.id, this.view.owner); this.showToast(`${this.view.id} 종료 요청`) }
          return
        case 'd': if (this.editor.text === '') { this.stop(0); return } break
        case 'a': this.editor.home(); break
        case 'e': this.editor.end(); break
        case 'u': this.editor.killLine(); break
        case 'k': this.editor.killToEnd(); break
        case 'w': this.editor.killWord(); break
        case 'l': this.terminal.invalidate(); break
        case 'j': this.editor.insert('\n'); break
        default: return
      }
      this.terminal.requestRender(true)
      return
    }
    // With an open choice and nothing typed, the arrows and Enter answer it.
    if (this.choice !== null && this.editor.text === '' && ['left', 'right', 'tab', 'enter'].includes(key.name) && !key.alt) {
      const c = this.choice
      if (key.name === 'enter') this.pick(c.index)
      else c.index = (c.index + (key.name === 'left' || key.shift ? c.options.length - 1 : 1)) % c.options.length
      this.terminal.requestRender(true)
      return
    }
    switch (key.name) {
      case 'enter':
        if (key.alt || key.shift) this.editor.insert('\n')
        else this.submit()
        break
      case 'escape':
        if (this.pane.selection !== null) this.clearSelection()
        else if (this.view.kind !== 'main') this.backToMain()
        else if (this.status.running) this.o.backend.cancel()
        break
      case 'backspace': if (key.alt || key.ctrl) this.editor.killWord(); else this.editor.backspace(); break
      case 'delete': this.editor.del(); break
      case 'left': this.editor.left(); break
      case 'right': this.editor.right(); break
      case 'home': this.editor.home(); break
      case 'end': this.editor.end(); break
      case 'up': this.editor.up(width); break
      case 'down': this.editor.down(width); break
      case 'pageup': this.pane.scroll(-Math.max(1, this.geometry.transcriptHeight - 2)); break
      case 'pagedown': this.pane.scroll(Math.max(1, this.geometry.transcriptHeight - 2)); break
      case 'tab': if (this.rows().length > 0) this.focus = 'panel'; break
      case 'char': this.editor.insert(key.ch ?? ''); break
      default: return
    }
    // Typing is drawn on the keystroke, not on the next frame tick.
    this.terminal.requestRender(true)
  }

  /** Keys while a question is open. Returns false for keys the input box should get instead. */
  private onQuestionKey(key: KeyEvent): boolean {
    const q = this.question!
    if (q.typing) {
      if (key.name === 'enter' && !key.alt && !key.shift) { q.submitCustom(this.editor.submit()); this.answered(); return true }
      if (key.name === 'escape') { q.typing = false; this.terminal.requestRender(true); return true }
      return false
    }
    if (key.ctrl) return false
    switch (key.name) {
      case 'up': q.move(-1); break
      case 'down': case 'tab': q.move(1); break
      case 'enter': if (q.choose() === 'answered') { this.answered(); return true } break
      case 'escape': q.skip(); this.answered(); return true
      case 'char':
        if (key.ch === ' ') { q.toggle(); break }
        // Typing answers in the person's own words.
        q.cursor = q.rows().length - 1
        q.typing = true
        return false
      default: return false
    }
    this.terminal.requestRender(true)
    return true
  }

  /** Keys while the panel has focus. Returns false for keys the input box should get instead. */
  private onPanelKey(key: KeyEvent): boolean {
    const rows = this.rows()
    if (key.name === 'up' || key.name === 'down') {
      this.panelIndex = Math.max(0, Math.min(rows.length - 1, this.panelIndex + (key.name === 'up' ? -1 : 1)))
    } else if (key.name === 'enter') {
      const row = rows[this.panelIndex]
      if (row !== undefined) this.open(row)
    } else if (key.name === 'escape' || key.name === 'tab') {
      this.focus = 'editor'
    } else {
      // Typing goes back to the input box, with the key.
      this.focus = 'editor'
      return false
    }
    this.terminal.requestRender(true)
    return true
  }

  private submit(): void {
    const text = this.editor.text
    if (text.trim() === '') return
    this.editor.submit()
    if (this.o.intercept?.(text.trim()) === true) return
    if (this.view.kind === 'agent') {
      if (this.view.mode !== 'continuable') { this.showToast('이 subagent는 one-shot이라 메시지를 받을 수 없음'); return }
      this.o.backend.agentSend?.(this.view.id, text)
      this.showToast(`→ ${this.view.label}에게 보냄`)
      return
    }
    if (this.view.kind === 'job') { this.showToast('셸에는 입력할 수 없음 — esc로 main으로'); return }
    this.transcript.push(userBlock(text, this.mode))
    this.transcript.push(spacerBlock())   // one blank line between a question and what answers it
    this.transcript.toBottom()
    this.o.backend.send(text)
  }

  private pick(index: number): void {
    const option = this.choice?.options[index]
    if (option === undefined) return
    this.choice = null
    this.o.backend.action(option.id)
  }

  private ctrlC(): void {
    if (this.editor.text !== '') { this.editor.set(''); this.quitArmed = 0; this.terminal.requestRender(true); return }
    if (this.status.running) { this.o.backend.cancel(); return }
    const now = this.clock.now()
    if (this.quitArmed !== 0 && now - this.quitArmed < TOAST_MS) { this.stop(0); return }
    this.quitArmed = now
    this.showToast('Ctrl+C를 한 번 더 누르면 종료')
  }

  private onMouse(m: MouseEvent): void {
    const { transcriptTop, transcriptHeight, dividerRow } = this.geometry
    const inTranscript = m.y >= transcriptTop && m.y < transcriptTop + transcriptHeight
    const pane = this.pane
    if (m.action === 'wheel') { pane.scroll(m.button * 3); this.terminal.requestRender(); return }
    if (m.button !== 0) return
    if (m.action === 'down') {
      if (m.y === dividerRow && pane.unseen > 0) { pane.toBottom(); this.terminal.requestRender(true); return }
      const { questionRowsAt } = this.geometry
      if (this.question !== null && questionRowsAt >= 0 && m.y >= questionRowsAt && m.y < questionRowsAt + this.question.rows().length) {
        const q = this.question
        q.cursor = m.y - questionRowsAt
        const row = q.rows()[q.cursor]
        if (row.kind === 'custom') q.typing = true
        else if (q.current?.multiSelect) q.toggle()
        else if (q.choose() === 'answered') this.answered()
        this.terminal.requestRender(true)
        return
      }
      const { panelTop, panelFirst, panelShown } = this.geometry
      if (panelTop >= 0 && m.y >= panelTop && m.y < panelTop + panelShown) {
        const rows = this.rows()
        const shownRows = panelWindow(rows, this.panelIndex, PANEL_MAX_ROWS).rows
        const row = shownRows[m.y - panelTop]
        if (row !== undefined) {
          if (row.kind !== 'more') this.panelIndex = panelFirst + (m.y - panelTop)
          this.open(row)
        }
        return
      }
      if (m.y === this.geometry.choiceRow) {
        const hit = this.geometry.choiceSpans.findIndex((span) => m.x >= span.from && m.x < span.to)
        if (hit !== -1) { this.pick(hit); this.terminal.requestRender(true) }
        return
      }
      if (!inTranscript) { this.clearSelection(); return }
      const line = pane.lineAt(m.y - transcriptTop) ?? Math.max(0, pane.size - 1)
      pane.beginSelection({ line, col: m.x })
      this.dragging = true
      this.terminal.requestRender(true)
      return
    }
    if (m.action === 'drag' && this.dragging) {
      // Dragging past the edge scrolls, so a selection can be longer than the screen.
      if (m.y < transcriptTop) pane.scroll(-1)
      else if (m.y >= transcriptTop + transcriptHeight) pane.scroll(1)
      const row = Math.max(0, Math.min(transcriptHeight - 1, m.y - transcriptTop))
      const line = pane.lineAt(row) ?? Math.max(0, pane.size - 1)
      pane.extendSelection({ line, col: m.x })
      this.terminal.requestRender(true)
      return
    }
    if (m.action === 'up' && this.dragging) {
      this.dragging = false
      const text = pane.selectedText()
      if (text === '') { this.clearSelection(); return }
      const method = (this.o.copy ?? ((t: string) => systemCopy(t, { env: this.o.env, platform: this.o.platform, write: (d) => this.o.io.write(d) })))(text)
      this.showToast(`복사됨 · ${[...text].length}자${method === 'osc52' ? ' (OSC 52)' : ''}`)
    }
  }

  private clearSelection(): void {
    if (this.pane.selection === null) return
    this.pane.selection = null
    this.dragging = false
    this.terminal.requestRender()
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  private editorWidth(): number {
    return Math.max(4, this.o.io.columns() - 6)
  }

  private render(screen: Screen): void {
    const { cols, rows } = screen
    const s = (style) => sgr(style, this.mode)
    const editor = this.editor.layout(this.editorWidth())
    const editorRows = Math.min(EDITOR_MAX_ROWS, editor.rows.length)
    const choiceRows = this.choice === null || this.question !== null ? 0 : 1
    const questionLines = this.question === null ? [] : this.questionLines(cols)
    const stripRows = this.interview !== null && this.view.kind === 'main' ? 3 : 0
    const allRows = this.rows()
    const panel = panelWindow(allRows, this.panelIndex, PANEL_MAX_ROWS)
    const panelShown = panel.rows.length
    const bottom = 1 /* divider */ + 1 /* status */ + panelShown + choiceRows + questionLines.length + editorRows + 2 /* box */ + 1 /* hint */
    const transcriptTop = 1 + stripRows
    const transcriptHeight = Math.max(1, rows - transcriptTop - bottom)
    if (stripRows > 0) this.drawInterview(screen, 1, cols)
    const dividerRow = transcriptTop + transcriptHeight
    const statusRow = dividerRow + 1
    const panelTop = panelShown === 0 ? -1 : statusRow + 1
    const choiceRow = choiceRows === 0 ? -1 : statusRow + 1 + panelShown
    const questionTop = questionLines.length === 0 ? -1 : statusRow + 1 + panelShown + choiceRows
    const editorTop = statusRow + 1 + panelShown + choiceRows + questionLines.length
    let questionRowsAt = -1
    questionLines.forEach((line, i) => {
      if (line.optionRow && questionRowsAt === -1) questionRowsAt = questionTop + i
      screen.put(1, questionTop + i, line.text, line.style)
    })
    const choiceSpans: Array<{ from: number; to: number }> = []
    if (choiceRows > 0 && this.choice !== null) {
      let x = screen.put(1, choiceRow, '⚠ ', s(theme.warn))
      this.choice.options.forEach((option, i) => {
        const label = ` ${option.label} `
        const selected = i === this.choice!.index
        const style = selected ? s({ ...(option.style === 'danger' ? theme.danger : theme.accent), inverse: true, bold: true }) : s(theme.muted)
        const from = x
        x = screen.put(x, choiceRow, label, style)
        choiceSpans.push({ from, to: x })
        x = screen.put(x, choiceRow, '  ')
      })
      screen.put(x + 2, choiceRow, '←→ 선택 · ↵ 확정 · 클릭', s(theme.dim))
    }
    this.geometry = { transcriptTop, transcriptHeight, dividerRow, editorTop, choiceRow, choiceSpans, panelTop, panelFirst: panel.first, panelShown, questionTop, questionRowsAt }
    if (panelTop >= 0) this.drawPanel(screen, panelTop, panel.rows, panel.first)

    // Header, with where the pane is looking.
    let hx = screen.put(1, 0, 'deepbot', s(theme.brand))
    if (this.view.kind !== 'main') hx = screen.put(hx, 0, ` · main › ${this.view.kind === 'agent' ? this.view.label : this.view.id}`, s(theme.accent))
    const right = [this.status.session && `${this.status.session.slice(0, 12)}…`, this.status.workspace].filter(Boolean).join(' · ')
    if (right !== '') screen.put(Math.max(hx + 2, cols - 1 - stringWidth(right)), 0, right, s(theme.muted))

    // The pane, with the selection drawn inverted.
    const pane = this.pane
    const visible = pane.visible(cols, transcriptHeight)
    visible.forEach((line, r) => {
      const y = transcriptTop + r
      let x = 0
      for (const span of line.spans) x = screen.put(x, y, span.text, span.style, cols, span.link)
      if (pane.selection !== null) {
        const index = pane.top + r
        for (let c = 0; c < cols; c++) {
          if (!pane.isSelected(index, c)) continue
          const i = y * cols + c
          const cell = screen.cells[i]
          screen.cells[i] = { ...cell, style: cell.style === '' ? '\x1b[0;7m' : `${cell.style}\x1b[7m` }
        }
      }
    })

    // Divider, with the "new lines below" marker when scrolled away.
    screen.put(0, dividerRow, '─'.repeat(cols), s(theme.border))
    if (pane.unseen > 0) {
      const tag = ` ↓ 새 줄 ${pane.unseen} `
      screen.put(Math.max(0, cols - stringWidth(tag) - 2), dividerRow, tag, s(theme.accent))
    }

    // Status line.
    this.drawStatus(screen, statusRow)

    // Input box.
    const inner = cols - 4
    screen.put(0, editorTop, `╭${'─'.repeat(Math.max(0, cols - 2))}╮`, s(theme.border))
    const first = Math.max(0, editor.cursor.y - editorRows + 1)
    for (let r = 0; r < editorRows; r++) {
      const y = editorTop + 1 + r
      screen.put(0, y, '│', s(theme.border))
      screen.put(cols - 1, y, '│', s(theme.border))
      if (first + r === 0) screen.put(2, y, '› ', s(theme.accent))
      screen.put(4, y, editor.rows[first + r] ?? '', '', 2 + inner)
    }
    screen.put(0, editorTop + 1 + editorRows, `╰${'─'.repeat(Math.max(0, cols - 2))}╯`, s(theme.border))
    screen.cursor = this.focus === 'editor' ? { x: 4 + editor.cursor.x, y: editorTop + 1 + (editor.cursor.y - first) } : null

    // Hint line: what the keys do here.
    const hint = this.question?.typing ? '직접 입력 후 ↵ · esc 선택지로'
      : this.question !== null ? `↑↓ 이동${this.question.current?.multiSelect ? ' · space 선택' : ''} · ↵ 확정 · esc 건너뛰기 · 글자를 치면 직접 입력`
      : this.focus === 'panel' ? '↑↓ 이동 · ↵ 열기 · esc 입력창으로'
      : this.view.kind === 'agent' ? `↵ ${this.view.label}에게 보내기 · ctrl+x 중단 · esc main으로`
        : this.view.kind === 'job' ? 'ctrl+x 종료 · 휠 스크롤 · esc main으로'
          : this.status.running ? 'esc 중단 · 휠 스크롤 · 드래그 복사'
            : `↵ 전송 · alt+↵ 줄바꿈 · 드래그 복사${allRows.length > 0 ? ' · tab 패널' : ''} · /help · ctrl+c 종료`
    screen.put(1, editorTop + 2 + editorRows, hint, s(theme.dim))
  }

  /** The question panel: what is asked, then one row per option and "직접 입력…". */
  private questionLines(cols: number): Array<{ text: string; style: string; optionRow: boolean }> {
    const q = this.question
    const current = q?.current
    if (q === null || current === undefined) return []
    const s = (style) => sgr(style, this.mode)
    const out: Array<{ text: string; style: string; optionRow: boolean }> = []
    const where = q.items.length > 1 ? ` (${q.index + 1}/${q.items.length})` : ''
    const kind = current.intent?.kind === 'plan-review' ? 'plan 검토' : current.header ?? '질문'
    out.push({ text: `? ${kind}${where}`, style: s({ ...theme.warn, bold: true }), optionRow: false })
    for (const line of wrapPlain(current.question, Math.max(10, cols - 6)).slice(0, 3)) out.push({ text: `  ${line}`, style: s(theme.text), optionRow: false })
    q.rows().forEach((row, i) => {
      const at = i === q.cursor
      const box = current.multiSelect && row.kind === 'option' ? (row.checked ? '[x] ' : '[ ] ') : ''
      const desc = row.description ? ` — ${row.description}` : ''
      const text = `${at ? '❯' : ' '} ${box}${row.label}${desc}`
      out.push({ text, style: at ? s({ ...theme.accent, bold: true }) : row.kind === 'custom' ? s(theme.muted) : s(theme.text), optionRow: true })
    })
    return out
  }

  /** The deep interview's strip: round, each dimension's clarity, the ambiguity left. */
  private drawInterview(screen: Screen, y: number, cols: number): void {
    const s = (style) => sgr(style, this.mode)
    const iv = this.interview!
    const st = iv.state
    let x = screen.put(1, y, `딥인터뷰 · ${iv.topic}`, s({ ...theme.accent, bold: true }))
    if (st !== null && st.round > 0) x = screen.put(x, y, ` · round ${st.round}`, s(theme.muted))
    const right = st === null ? '첫 질문 준비 중'
      : st.done ? `완료${st.spec ? ` · spec: ${st.spec}` : ''}`
        : `모호도 ${st.ambiguity}% → 목표 ${AMBIGUITY_TARGET}% 이하`
    screen.put(Math.max(x + 2, cols - 1 - stringWidth(right)), y, right, st?.done ? s(theme.ok) : s(theme.muted))
    let gx = 1
    for (const [name, value] of Object.entries(st?.scores ?? {})) {
      const filled = Math.round(value / 10)
      const piece = `${name} ${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)} ${value}%   `
      if (gx + stringWidth(piece) > cols - 1) break
      gx = screen.put(gx, y + 1, piece, value >= 80 ? s(theme.ok) : value >= 50 ? s(theme.accent) : s(theme.warn))
    }
    screen.put(1, y + 2, '명확도는 모델의 자기 평가 — 측정값이 아님', s(theme.dim))
  }

  private drawPanel(screen: Screen, top: number, rows: PanelRow[], first: number): void {
    const s = (style) => sgr(style, this.mode)
    const now = this.clock.now()
    const labelWidth = Math.max(12, Math.min(32, Math.floor(screen.cols * 0.35)))
    rows.forEach((row, i) => {
      const y = top + i
      const index = first + i
      const focused = this.focus === 'panel' && index === this.panelIndex && row.kind !== 'more'
      const current = (row.kind === 'main' && this.view.kind === 'main')
        || (row.kind === 'agent' && this.view.kind === 'agent' && this.view.id === row.agent.id)
        || (row.kind === 'job' && this.view.kind === 'job' && this.view.id === row.job.id)
      const lead = focused ? '❯ ' : row.kind === 'more' ? '' : current ? '● ' : row.kind === 'job' ? '◆ ' : '○ '
      const label = row.kind === 'main' ? 'main'
        : row.kind === 'agent' ? row.agent.label
          : row.kind === 'job' ? `${row.job.id}  ${row.job.label}`
            : row.kind === 'idle' ? `${row.count} idle agents`
              : `↓ ${row.count} more`
      const labelStyle = focused ? s({ ...theme.accent, bold: true }) : current ? s({ bold: true }) : row.kind === 'agent' && row.agent.status === 'running' ? s(theme.text) : s(theme.muted)
      let x = screen.put(1, y, lead, focused ? s(theme.accent) : s(theme.muted))
      x = screen.put(x, y, label, labelStyle, Math.min(screen.cols - 2, 3 + labelWidth))
      const status = rowStatus(row, now)
      if (status !== '') screen.put(Math.max(x + 2, screen.cols - 1 - stringWidth(status)), y, status, row.kind === 'agent' && row.agent.status === 'running' ? s(theme.accent) : s(theme.muted))
    })
  }

  private drawStatus(screen: Screen, y: number): void {
    const s = (style) => sgr(style, this.mode)
    const now = this.clock.now()
    if (this.toast !== null && now >= this.toast.until) this.toast = null
    let x = 1
    if (!this.status.connected) {
      x = screen.put(x, y, `○ ${this.status.link}`, s(theme.warn))
    } else {
      x = screen.put(x, y, `▸▸ ${this.status.preset || 'ask'}`, s(theme.accent))
      const counts = panelCounts(this.panel.agents, this.panel.jobs)
      if (counts.shells > 0) x = screen.put(x, y, ` · ${counts.shells} shell${counts.shells > 1 ? 's' : ''}`, s(theme.muted))
      if (counts.agents > 0) x = screen.put(x, y, ` · ← ${counts.agents} agent${counts.agents > 1 ? 's' : ''}`, s(theme.muted))
    }
    if (this.toast !== null) x = screen.put(x, y, `  ${this.toast.text}`, s(theme.ok))

    const parts: string[] = []
    if (this.status.running) {
      const frame = SPINNER[Math.floor(now / 80) % SPINNER.length]
      parts.push(`${frame} ${((now - this.status.startedAt) / 1000).toFixed(1)}s`)
    }
    if (this.status.contextPct !== null) {
      const filled = Math.round(Math.max(0, Math.min(100, this.status.contextPct)) / 12.5)
      parts.push(`ctx ${'▰'.repeat(filled)}${'▱'.repeat(8 - filled)} ${Math.round(this.status.contextPct)}%`)
    }
    if (this.status.tokens > 0) parts.push(`${formatTokens(this.status.tokens)} tok`)
    const right = parts.join(' · ')
    if (right !== '') screen.put(Math.max(x + 2, screen.cols - 1 - stringWidth(right)), y, right, s(theme.status))
  }

  private infoLine(): string {
    return [this.status.model, this.status.workspace, this.status.session && `session ${this.status.session}`].filter(Boolean).join(' · ')
  }

  private showToast(text: string): void {
    this.toast = { text, until: this.clock.now() + TOAST_MS }
    this.terminal.requestRender(true)
    this.clock.setTimer(() => this.terminal.requestRender(), TOAST_MS + 10)
  }

  private closeAnswer(): void {
    if (this.answer === null) return
    this.answer.finish()
    this.answer = null
    this.transcript.touch()
  }

  private startSpinner(): void {
    if (this.spinTimer !== null) return
    const tick = () => {
      this.spinTimer = null
      if (!this.status.running) return
      this.terminal.requestRender()
      this.spinTimer = this.clock.setTimer(tick, 80)
    }
    this.spinTimer = this.clock.setTimer(tick, 80)
  }

  private stopSpinner(): void {
    if (this.spinTimer !== null) { this.clock.clearTimer(this.spinTimer); this.spinTimer = null }
  }
}
