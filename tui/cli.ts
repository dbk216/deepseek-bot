/**
 * The command line and the frame-to-screen mapping of deepbot-tui, apart from the entry point so
 * the tests can import them without starting a terminal.
 */
import type { App } from './app.js'
import { NAME, type ClientFrame, type ConversationItem, type ServerFrame } from './protocol.js'
import { interviewPrompt } from './interview.js'
import type { CommandInfo } from './complete.js'
import { stringWidth } from './render/width.js'

export interface Args { name?: string; socket?: string; tenant?: string; resume?: string; help: boolean }

export function parseArgs(argv: string[]): Args | { error: string } {
  const args: Args = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '-h' || flag === '--help') { args.help = true; continue }
    const value = argv[i + 1]
    const key = ({ '--name': 'name', '--socket': 'socket', '--tenant': 'tenant', '--resume': 'resume' } as const)[flag]
    if (key === undefined) return { error: `알 수 없는 옵션: ${flag}` }
    if (value === undefined || value.startsWith('--')) return { error: `${flag}에 값이 필요함` }
    args[key] = value
    i++
  }
  return args
}

export const USAGE = `deepbot-tui — 터미널에서 deepbot과 대화

  deepbot-tui [--name <gateway>] [--socket <path>] [--tenant <name>] [--resume <conversation>]

  --name     연결할 gateway 이름 (deepbot 설정의 tuiName, 기본 default)
  --socket   gateway socket 경로를 직접 지정
  --tenant   tenant workspace로 대화 (tenantIsolation이 켜져 있어야 함)
  --resume   이전 대화 이어가기 (종료할 때 출력되는 id)
`

/** Frames from the gateway, onto the screen. */
export function bind(app: App, frame: ServerFrame, commands?: Commands): void {
  switch (frame.type) {
    case 'sessions':
      commands?.listed(frame.items)
      return
    case 'history':
      app.history(frame.items)
      return
    case 'panel':
      app.setPanel(frame.agents, frame.jobs)
      app.setStatus({ tokens: frame.usage.tokens, contextPct: frame.usage.contextPct })
      return
    case 'question':
      app.ask(frame.id, frame.questions)
      return
    case 'question.close':
      app.closeQuestion(frame.id)
      return
    case 'view':
      if (frame.kind === 'agent') app.agentLines(frame.id, frame.lines)
      else app.jobOutput(frame.id, frame.text, frame.append, frame.status)
      return
    case 'ready':
      commands?.ready()
      app.setBusy(frame.busy)
      app.setStatus({ connected: true, workspace: frame.workspace, session: frame.conversation, model: frame.model, preset: app.status.preset || 'ask' })
      if (frame.tenant !== null) app.notice(`tenant ${frame.tenant} workspace에서 대화 중`, 'info')
      return
    case 'typing':
      if (frame.on) app.turnStarted()
      else app.turnEnded()
      return
    case 'post':
      app.message(frame.ts, frame.text, frame.replace, frame.answer)
      if (frame.buttons.length > 0) app.offer(frame.ts, frame.buttons)
      return
    case 'stream':
      if (frame.kind === 'text') app.delta(frame.text)
      else if (frame.kind === 'reset') app.resetAttempt()
      else if (frame.kind === 'thinking') app.thinking(frame.text)
      else if (frame.kind === 'tool.result') app.toolResult(frame.callId, frame.ok, frame.text)
      else if (frame.kind === 'tool') app.toolCall(frame)
      return
    case 'remove':
      app.unpost(frame.ts)
      return
    case 'error':
      app.notice(`gateway: ${frame.message}`, 'error')
      return
  }
}

/** The /commands the terminal handles itself. Anything else — "/Users/me/x" included — is sent as text. */
export const COMMANDS = ['new', 'sessions', 'resume', 'tenant', 'interview', 'usage', 'clear', 'help', 'quit'] as const
export type CommandName = (typeof COMMANDS)[number]

export function parseCommand(text: string): { name: CommandName; args: string } | null {
  const m = /^\/([a-z]+)(?:\s+(.*))?$/s.exec(text.trim())
  if (m === null || !(COMMANDS as readonly string[]).includes(m[1])) return null
  return { name: m[1] as CommandName, args: (m[2] ?? '').trim() }
}

/** What each command takes and does: the source of /help and of the completion list. */
export const COMMAND_INFO: Array<CommandInfo & { name: CommandName }> = [
  { name: 'new', hint: '새 대화 (같은 workspace)', args: false },
  { name: 'sessions', hint: '터미널 대화 목록 (어느 tenant인지 표시)', args: false },
  { name: 'resume', usage: '<번호|id>', hint: '목록의 대화 이어가기', args: true },
  { name: 'tenant', usage: '[이름]', hint: '그 tenant workspace에서 새 대화 (이름 없이: 설정의 기본, 없으면 home)', args: true },
  { name: 'interview', usage: '<주제>', hint: '딥인터뷰: 질문을 하나씩 받아 명확도를 올리고 spec으로 정리', args: true },
  { name: 'usage', hint: '지금까지 쓴 토큰', args: false },
  { name: 'clear', hint: '화면 비우기 (대화는 그대로)', args: false },
  { name: 'help', hint: '이 도움말', args: false },
  { name: 'quit', hint: '종료 (ctrl+c 두 번, ctrl+d도 같음)', args: false },
]

const column = (text: string, width: number) => text + ' '.repeat(Math.max(1, width - stringWidth(text)))

export const HELP = [
  ...COMMAND_INFO.map((c) => `${column(`/${c.name}${c.usage ? ` ${c.usage}` : ''}`, 18)}${c.hint}`),
  '',
  '↵ 전송 · alt+↵ 줄바꿈 · esc 중단 · 휠/PgUp/PgDn 스크롤 · 드래그 복사',
  '/ 명령 · @ 파일 (tab으로 넣기) · ctrl+r 입력 기록 검색 · ctrl+o 생각·도구 결과 펼치기/접기',
].join('\n')

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}초 전`
  if (s < 3600) return `${Math.round(s / 60)}분 전`
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`
  return `${Math.round(s / 86400)}일 전`
}

/** The /sessions list, numbered for /resume <n>. */
export function formatSessions(items: Array<{ conversation: string; lastAt: number; turns: number; tenant: string | null; title: string }>, now: number, current: string | null): string {
  if (items.length === 0) return '이 workspace에 터미널 대화가 아직 없음'
  return items.map((item, i) => {
    const mark = item.conversation === current ? '●' : ' '
    const where = item.tenant !== null ? ` · tenant ${item.tenant}` : ''
    const title = item.title === '' ? '(제목 없음)' : item.title
    return `${mark}${String(i + 1).padStart(2)}. ${title}\n     ${ago(item.lastAt, now)} · ${item.turns}턴${where} · ${item.conversation}`
  }).join('\n') + '\n/resume <번호>로 이어가기'
}

/** What the commands need of the connection. */
export interface ConversationLink {
  conversation: string | null
  tenant: string | undefined
  send(frame: ClientFrame): boolean
  switchTo(conversation: string | null, tenant?: string): void
}

export interface Commands {
  /** A typed line: true when it was a command (handled here, not sent). */
  intercept(text: string): boolean
  listed(items: ConversationItem[]): void
  ready(): void
  /** A switch was refused: the screen goes back to the conversation that is still current. */
  rolledBack(message: string): void
}

/**
 * The /commands. `resumeOnStart` asks for the conversation's history once the first ready arrives,
 * which is what --resume does.
 */
export function createCommands(app: App, link: ConversationLink, options: { now?: () => number; resumeOnStart?: boolean } = {}): Commands {
  const now = options.now ?? (() => Date.now())
  let listed: ConversationItem[] = []
  let wantHistory = options.resumeOnStart === true
  const offline = () => app.notice('gateway에 연결되어 있지 않음', 'error')

  return {
    intercept(text) {
      const command = parseCommand(text)
      if (command === null) return false
      const { name, args } = command
      switch (name) {
        case 'new':
          app.clear()
          link.switchTo(null, link.tenant)
          app.notice(`새 대화${link.tenant !== undefined ? ` · tenant ${link.tenant}` : ''}`, 'info')
          break
        case 'tenant':
          // A conversation's workspace is fixed when it starts (a session resumes in the directory it
          // was created in), so changing tenant means a new conversation there.
          app.clear()
          link.switchTo(null, args === '' ? undefined : args)
          app.notice(args === '' ? '새 대화 · 기본 workspace' : `새 대화 · tenant ${args}`, 'info')
          break
        case 'sessions':
          if (!link.send({ type: 'sessions' })) offline()
          break
        case 'resume': {
          const n = Number(args)
          const item = Number.isInteger(n) && n >= 1 && n <= listed.length ? listed[n - 1] : listed.find((i) => i.conversation === args)
          const id = item?.conversation ?? args
          if (!NAME.test(id)) { app.notice('/resume <번호|id> — 번호는 /sessions 목록의 것', 'error'); break }
          app.clear()
          // The listed conversation's own workspace; a bare id lets the gateway use the recorded one.
          link.switchTo(id, item?.tenant ?? undefined)
          // Asked for on ready: sent now it would reach the old conversation, and a refusal would show it twice.
          wantHistory = true
          break
        }
        case 'interview':
          if (args === '') { app.notice('/interview <주제> — 무엇에 대해 인터뷰할지', 'error'); break }
          app.startInterview(args)
          app.sendAs(`딥인터뷰: ${args}`, interviewPrompt(args))
          break
        case 'usage':
          if (!link.send({ type: 'usage' })) offline()
          break
        case 'clear':
          app.clear()
          break
        case 'help':
          app.notice(HELP, 'info')
          break
        case 'quit':
          app.stop(0)
          break
      }
      return true
    },
    listed(items) {
      listed = items
      app.notice(formatSessions(items, now(), link.conversation), 'info')
    },
    ready() {
      if (wantHistory && link.send({ type: 'history' })) wantHistory = false
    },
    rolledBack(message) {
      app.clear()
      app.notice(`전환하지 못함: ${message} — 이전 대화를 계속함`, 'error')
      wantHistory = !link.send({ type: 'history' })
    },
  }
}
