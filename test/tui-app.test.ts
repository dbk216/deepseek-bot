/**
 * The TUI's interactions, against a fake terminal and a fake backend.
 *
 * What the user does is checked by what they would see: the bytes the app writes are replayed
 * through a VT emulator and the assertions read that screen. Typing must show on the keystroke,
 * Enter must reach the backend, a drag must copy exactly the text under it (Hangul included,
 * the prompt marks left out), and every exit must hand the terminal back.
 *
 * Run: node test/tui-app.test.ts
 */
import './dist-fresh.ts'   // fails loudly on a stale dist

import { App } from '../dist/tui/app.js'
import { RESTORE } from '../dist/tui/render/terminal.js'
import { fakeClock, fakeTerminal } from './tui-fakes.ts'
import { commandInfo, COMMANDS, help } from '../dist/tui/cli.js'
import { appendHistory, loadHistory, HISTORY_KEEP } from '../dist/tui/history.js'
import { fileFinder } from '../dist/tui/files.js'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function setup({ cols = 80, rows = 30, env = { COLORTERM: 'truecolor' }, extra = {} }: { cols?: number; rows?: number; env?: Record<string, string>; extra?: Record<string, unknown> } = {}) {
  const term = fakeTerminal(cols, rows)
  const clock = fakeClock()
  const sent = []
  const actions = []
  const views = []
  const answers_ = []
  const copied = []
  let cancels = 0
  let exited = null
  const app = new App({
    io: term.io, env, platform: 'darwin', clock,
    backend: {
      send: (t) => sent.push(t), cancel: () => { cancels++ }, action: (id) => actions.push(id),
      view: (...a) => views.push(['view', ...a]), agentSend: (...a) => views.push(['send', ...a]),
      agentInterrupt: (...a) => views.push(['interrupt', ...a]), jobKill: (...a) => views.push(['kill', ...a]),
      answer: (id, answers) => answers_.push({ id, answers }),
    },
    copy: (t) => { copied.push(t); return 'pbcopy' },
    onExit: (code) => { exited = code },
    ...extra,
  })
  app.start()
  app.setStatus({ connected: true, effort: 'medium', session: 'tui-3f2a9c1e-aaaa', workspace: '~/dsh-agent', model: 'deepseek-v4.1' })
  clock.advance(20)
  return {
    app, term, clock, sent, actions, views, answers: answers_, copied,
    get cancels() { return cancels },
    get exited() { return exited },
    key: (s) => term.type(s),
    frames: () => term.out.length,
  }
}

const SGR = (b, x, y, release = false) => `\x1b[<${b};${x + 1};${y + 1}${release ? 'm' : 'M'}`
// The app draws a selection by adding SGR 7. Match that exactly: a colour such as '…;167m' also
// ends in "7m", and a looser test passed on the banner's gradient alone.
const inverted = (cell) => cell.style === '\x1b[0;7m' || cell.style.endsWith('\x1b[7m')

// 1. First screen: banner, the info line, the input box, and the status line.
{
  const t = setup()
  const text = t.term.screen.text()
  check('start: fullscreen with mouse tracking', t.term.screen.state.altScreen && t.term.screen.state.mouse)
  check('start: the block-letter banner is drawn', text.includes('██████╗'))
  check('start: the info line names model, workspace and session', /deepseek-bot\s+deepseek-v4\.1 · ~\/dsh-agent · session tui-3f2a9c1e-aaaa/.test(text), text.split('\n').find((l) => l.includes('deepseek-bot  ')) ?? '')
  check('start: the header names the project, deepseek-bot', text.split('\n')[0].trimStart().startsWith('deepseek-bot '), text.split('\n')[0])
  check('start: the input box and the status line', text.includes('╭') && text.includes('╰') && text.includes('▸▸ effort medium'))
}

// 1b. The workspace under the home directory is shown as ~, so a screen, or a recording of one, does
// not carry the account's path; the status keeps the real path, which file completion reads.
{
  const t = setup({ env: { COLORTERM: 'truecolor', HOME: '/Users/someone' } })
  t.app.setStatus({ workspace: '/Users/someone/dsh-agent' })
  t.clock.advance(20)
  let text = t.term.screen.text()
  check('workspace: under HOME, the header and the info line show ~', text.split('\n')[0].includes('~/dsh-agent') && /deepseek-v4\.1 · ~\/dsh-agent · /.test(text) && !text.includes('/Users/someone'), text.split('\n')[0])
  check('workspace: the status keeps the real path', t.app.status.workspace === '/Users/someone/dsh-agent')
  t.app.setStatus({ workspace: '/Users/someone2/agent' })
  t.clock.advance(20)
  text = t.term.screen.text()
  check('workspace: a sibling of HOME that shares its prefix is shown in full', text.includes('/Users/someone2/agent'), text.split('\n')[0])
}

// 2. Typing appears on the keystroke; Enter sends; Alt+Enter does not.
{
  const t = setup()
  const before = t.frames()
  t.key('안녕')
  check('typing: drawn immediately, without waiting for a frame tick', t.frames() > before && t.term.screen.find('› 안녕') !== null)
  t.key('\x1b\r')
  t.key('둘째 줄')
  check('typing: Alt+Enter is a newline, not a send', t.sent.length === 0 && t.app.editor.text === '안녕\n둘째 줄')
  t.key('\r')
  check('enter: sends the text to the backend', t.sent.length === 1 && t.sent[0] === '안녕\n둘째 줄')
  check('enter: clears the box and shows the message in the transcript', t.app.editor.text === '' && t.term.screen.find('› 안녕') !== null)
  t.key('\r')
  check('enter: an empty box sends nothing', t.sent.length === 1)
  const cursor = t.term.screen.state.cursor
  const box = t.term.screen.find('│ ›')
  check('cursor: rests in the input box after the prompt', box !== null && cursor.y === box.row && cursor.x === box.col + 4, JSON.stringify({ cursor, box }))
}

// 3. A streamed turn: spinner while running, text as it arrives, a dropped attempt, a tool step.
{
  const t = setup()
  t.key('배포 일정 알려줘\r')
  t.app.turnStarted()
  t.app.delta('잘못된 시도')
  t.clock.advance(20)
  t.app.resetAttempt()
  t.app.delta('어제 스레드 기준으로 ')
  t.clock.advance(20)
  const streaming = t.term.screen.text()
  check('stream: a failed attempt\'s text is dropped', !streaming.includes('잘못된 시도'))
  check('stream: text appears with a caret while streaming', streaming.includes('어제 스레드 기준으로 ▍') || streaming.includes('어제 스레드 기준으로▍'))
  check('stream: the status line shows a spinner and elapsed time', /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d+\.\ds/.test(streaming))
  t.app.toolCall({ name: 'recall', title: '2 passages' })
  t.app.delta('staging 먼저.')
  t.app.final('staging 먼저, 그다음 production.')
  t.app.turnEnded()
  t.clock.advance(20)
  const done = t.term.screen.text()
  check('stream: a tool step appears between the two parts', done.includes('● recall  2 passages'))
  check('stream: the final text replaces the streamed text', done.includes('staging 먼저, 그다음 production.') && !done.includes('staging 먼저.▍'))
  check('stream: no spinner after the turn', !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d+\.\ds/.test(done))
}

// 3b. The turn's reply takes the place of what was streamed — and only the reply does.
{
  const t = setup()
  t.key('지워줘\r')
  t.app.turnStarted()
  t.app.delta('build 폴더를 지울게.')
  t.app.toolCall({ name: 'bash' })
  // An approval request arrives mid-turn as a message with buttons. It must not replace the text.
  t.app.message('ts-ask', '권한이 필요합니다: rm -rf build', null, false)
  t.app.offer('ts-ask', [{ id: 'approval:allow:k', label: '허용', style: 'primary' }, { id: 'approval:deny:k', label: '거부', style: 'danger' }])
  t.clock.advance(20)
  const asking = t.term.screen.text()
  check('mid-turn: the approval request is its own message; the streamed text stays', asking.includes('build 폴더를 지울게.') && asking.includes('권한이 필요합니다'))
  check('choice: offered above the input box', /⚠ +허용 +거부/.test(asking) || (asking.includes('⚠') && asking.includes(' 허용 ') && asking.includes(' 거부 ')))
  t.key('\x1b[C')
  t.key('\r')
  check('choice: → then Enter picks the second option', t.actions.length === 1 && t.actions[0] === 'approval:deny:k' && t.app.choice === null, JSON.stringify(t.actions))
  // The model ended with a tool call, so its last text is the one already streamed: no duplicate.
  t.app.message('ts-final', 'build 폴더를 지울게.', null, true)
  t.app.turnEnded()
  t.clock.advance(20)
  const done = t.term.screen.text()
  check('answer: the reply takes the streamed block\'s place instead of repeating it', done.split('build 폴더를 지울게.').length - 1 === 1, `${done.split('build 폴더를 지울게.').length - 1} copies`)
}
{
  const t = setup()
  t.app.turnStarted()
  t.app.message('ts-1', '스트림 없이 온 답변', null, true)
  t.app.turnEnded()
  t.clock.advance(20)
  check('answer: without a stream the reply is simply shown (the fallback)', t.term.screen.text().includes('스트림 없이 온 답변'))
  t.app.offer('ts-2', [{ id: 'a', label: '허용' }, { id: 'b', label: '거부' }])
  t.clock.advance(20)
  const at = t.term.screen.find(' 허용 ')
  t.key(SGR(0, at.col + 1, at.row)); t.key(SGR(0, at.col + 1, at.row, true))
  check('choice: a click on an option picks it', t.actions[0] === 'a' && t.app.choice === null)
  t.app.offer('ts-3', [{ id: 'x', label: '허용' }])
  t.app.unpost('ts-3')
  check('choice: withdrawn with the message that offered it', t.app.choice === null)
  t.key('입력 중')
  t.app.offer('ts-4', [{ id: 'y', label: '허용' }])
  t.key('\r')
  check('choice: with text typed, Enter sends the text instead of picking', t.actions.length === 1 && t.sent.includes('입력 중'))
}

// 4. A drag copies the text under it — Hangul intact, prompt marks left out — and says so.
{
  const t = setup()
  t.key('첫 번째 질문입니다\r')
  t.app.final('두 번째 줄의 답변')
  t.clock.advance(20)
  const from = t.term.screen.find('번째 질문')
  const to = t.term.screen.find('답변')
  t.key(SGR(0, from.col, from.row))
  t.key(SGR(32, to.col + 2, to.row))   // drag to the end of '답변' (two wide characters = 4 columns: stop inside)
  t.key(SGR(32, to.col + 4, to.row))
  t.key(SGR(0, to.col + 4, to.row, true))
  check('drag: copies from the start point to the end point across messages', t.copied.length === 1 && t.copied[0] === '번째 질문입니다\n\n두 번째 줄의 답변', JSON.stringify(t.copied))
  check('drag: the status line confirms the copy', t.term.screen.text().includes('copied · '))
  const selected = t.term.screen.grid.filter(inverted).length
  check('drag: the selection is drawn inverted', selected > 10, `${selected} cells`)
  t.key('\x1b')
  t.clock.advance(40)
  check('escape: clears the selection without cancelling anything', t.cancels === 0 && t.term.screen.grid.filter(inverted).length === 0)
  t.key(SGR(0, 5, 3)); t.key(SGR(0, 5, 3, true))
  check('click without a drag copies nothing', t.copied.length === 1)
}

// 5. The wheel scrolls; new text while scrolled away is counted; clicking the marker returns.
{
  const t = setup({ rows: 20 })
  for (let i = 0; i < 30; i++) t.app.notice(`줄 ${i}`)
  t.clock.advance(20)
  check('wheel: starts at the bottom', t.term.screen.text().includes('줄 29'))
  t.key(SGR(64, 10, 5)); t.key(SGR(64, 10, 5))
  t.clock.advance(20)
  check('wheel: scrolling up leaves the bottom', !t.term.screen.text().includes('줄 29') && !t.app.transcript.follow)
  t.app.notice('새 소식')
  t.clock.advance(20)
  const marker = t.term.screen.find('↓ ')
  check('wheel: lines arriving below are announced on the divider', marker !== null && /↓ \d+ new /.test(t.term.screen.text()))
  t.key(SGR(0, marker.col + 2, marker.row)); t.key(SGR(0, marker.col + 2, marker.row, true))
  t.clock.advance(20)
  check('wheel: clicking the marker returns to the bottom', t.term.screen.text().includes('새 소식') && t.app.transcript.follow)
}

// 6. Esc and Ctrl+C while a turn runs cancel it; Ctrl+C clears a typed line first.
{
  const t = setup()
  t.app.turnStarted()
  t.key('\x1b'); t.clock.advance(40)
  check('escape: cancels a running turn', t.cancels === 1)
  t.key('지울 내용')
  t.key('\x03')
  check('ctrl+c: clears the input first', t.app.editor.text === '' && t.cancels === 1)
  t.key('\x03')
  check('ctrl+c: then cancels the running turn', t.cancels === 2 && t.exited === null)
}

// 7. Leaving: Ctrl+C twice, the window between presses, Ctrl+D; the terminal is restored.
{
  const t = setup()
  t.key('\x03')
  check('ctrl+c: the first press only warns', t.exited === null && t.term.screen.text().includes('press Ctrl+C again to quit'))
  t.clock.advance(2000)
  t.key('\x03')
  check('ctrl+c: a second press after the window warns again', t.exited === null)
  t.key('\x03')
  check('ctrl+c: two presses inside the window quit and restore the terminal', t.exited === 0 && t.term.out.includes(RESTORE) && !t.term.raw)
  const d = setup()
  d.key('\x04')
  check('ctrl+d: on an empty box quits', d.exited === 0 && d.term.out.includes(RESTORE))
}

// 7b. The agent panel: rows like the screenshot, tab/arrows/Enter or a click to open, views.
{
  const t = setup({ cols: 100, rows: 34 })
  const now = t.clock.now()
  const agents = [
    { id: 'child-1', label: 'research links', mode: 'continuable', status: 'running', since: now - 12_000, settledMs: 0, tokens: 8_100 },
    { id: 'child-2', label: 'draft summary', mode: 'one-shot', status: 'idle', since: null, settledMs: 4_000, tokens: 0 },
  ]
  const jobs = [{ id: 'bash-1', owner: 'root-s', kind: 'bash', label: 'npm test', status: 'running', startedAt: now - 3_000, progress: '' }]
  t.app.setPanel(agents, jobs)
  t.clock.advance(20)
  const text = t.term.screen.text()
  check('panel: main, the running agent with its time and tokens, the idle one, the job', /● main/.test(text) && /○ research links +12s · ↓ 8\.1k tokens/.test(text) && /○ draft summary +idle/.test(text) && /◆ bash-1  npm test +running · 3s/.test(text), text.split('\n').filter((l) => /main|research|draft|bash-1/.test(l)).join(' | '))
  check('status line: shells and agents counted', /▸▸ effort medium.* · 1 shell · ← 2 agents/.test(text), text.split('\n').find((l) => l.includes('▸▸')))
  t.clock.advance(1000)
  check('panel: the running agent\'s time moves without a new report', /research links +13s/.test(t.term.screen.text()))

  t.key('\t')
  t.key('\x1b[B')
  t.key('\r')
  check('tab, ↓, Enter: opens the agent and asks the gateway to follow it', JSON.stringify(t.views[0]) === JSON.stringify(['view', 'agent', 'child-1']) && t.app.view.kind === 'agent')
  t.app.agentLines('child-1', [{ role: 'user', text: '링크 3개를 요약해' }, { role: 'tool', text: 'web_fetch' }, { role: 'assistant', text: '요약 중간 결과' }])
  t.clock.advance(20)
  const view = t.term.screen.text()
  check('agent view: the header says where we are, the pane shows the child\'s conversation', view.includes('deepseek-bot · main › research links') && view.includes('› 링크 3개를 요약해') && view.includes('● web_fetch') && view.includes('요약 중간 결과'))
  check('agent view: lines for another child are ignored', (t.app.agentLines('child-2', [{ role: 'user', text: '다른 아이' }]), !t.term.screen.text().includes('다른 아이')))
  t.key('더 짧게 해줘\r')
  check('agent view: Enter sends to that child, not to the conversation', JSON.stringify(t.views.at(-1)) === JSON.stringify(['send', 'child-1', '더 짧게 해줘']) && t.sent.length === 0)
  t.key('\x18')
  check('agent view: ctrl+x interrupts that child', JSON.stringify(t.views.at(-1)) === JSON.stringify(['interrupt', 'child-1']))
  t.key('\x1b'); t.clock.advance(40)
  check('agent view: esc returns to the conversation and tells the gateway', t.app.view.kind === 'main' && JSON.stringify(t.views.at(-1)) === JSON.stringify(['view', 'main']) && !t.term.screen.text().includes('요약 중간 결과'))

  const jobRow = t.term.screen.find('bash-1')
  t.key(SGR(0, jobRow.col, jobRow.row)); t.key(SGR(0, jobRow.col, jobRow.row, true))
  check('click: a job row opens its output', JSON.stringify(t.views.at(-1)) === JSON.stringify(['view', 'job', 'bash-1', 'root-s']) && t.app.view.kind === 'job')
  t.app.jobOutput('bash-1', 'PASS a\nPASS b\n', false, 'running')
  t.app.jobOutput('bash-1', 'PASS c\n', true, 'running')
  t.app.jobOutput('bash-1', '', true, 'completed')
  t.clock.advance(20)
  const out = t.term.screen.text()
  check('job view: output accumulates, and the end is said', out.includes('PASS a') && out.includes('PASS c') && out.includes('ended · completed'))
  t.key('\x18')
  check('job view: ctrl+x stops the job with its owner', JSON.stringify(t.views.at(-1)) === JSON.stringify(['kill', 'bash-1', 'root-s']))
  t.key('\x1b'); t.clock.advance(40)

  t.app.setPanel(['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, label: `idle ${id}`, mode: 'one-shot', status: 'idle', since: null, settledMs: 0, tokens: 0 })), [])
  t.clock.advance(20)
  const folded = t.term.screen.find('5 idle agents')
  check('panel: five idle agents fold into one row', folded !== null && !t.term.screen.text().includes('idle c'))
  t.key(SGR(0, folded.col, folded.row)); t.key(SGR(0, folded.col, folded.row, true))
  t.clock.advance(20)
  check('panel: clicking the folded row unfolds it', t.term.screen.text().includes('idle c'))
  t.key('\t')
  t.key('x')
  check('panel focus: typing goes back to the input box, with the key', t.app.focus === 'editor' && t.app.editor.text === 'x')
  t.app.setPanel([], [])
  t.clock.advance(20)
  check('panel: gone when there is nothing to show', !t.term.screen.text().includes('● main'))
}

// 7c. Questions in the panel above the input box, a plan review, and the deep interview strip.
{
  const t = setup({ cols: 90, rows: 36 })
  t.app.turnStarted()
  t.app.ask('q-1', [
    { id: 'env', question: '배포 대상 환경은?', options: [{ label: 'staging' }, { label: 'production', description: '실서비스' }], multiSelect: false },
    { id: 'checks', question: '어떤 검사를 돌릴까?', options: [{ label: 'unit' }, { label: 'e2e' }, { label: 'lint' }], multiSelect: true },
  ])
  t.clock.advance(20)
  const asked = t.term.screen.text()
  check('question: the panel shows the question, its options and "type your own…"', /\? question \(1\/2\)/.test(asked) && asked.includes('배포 대상 환경은?') && /❯ staging/.test(asked) && asked.includes('production — 실서비스') && asked.includes('type your own…'))
  t.key('\x1b[B'); t.key('\r')
  check('question: ↓ Enter answers the first and moves to the second', /\(2\/2\)/.test(t.term.screen.text()) && t.term.screen.text().includes('? 배포 대상 환경은? → production'))
  t.key(' '); t.key('\x1b[B'); t.key('\x1b[B'); t.key(' ')
  check('question: Space ticks options of a multi-select question', /\[x\] unit/.test(t.term.screen.text()) && /\[x\] lint/.test(t.term.screen.text()))
  t.key('\r')
  check('question: the batch goes back once the last one is answered', JSON.stringify(t.answers[0]) === JSON.stringify({ id: 'q-1', answers: [{ id: 'env', selected: ['production'] }, { id: 'checks', selected: ['unit', 'lint'] }] }) && t.app.question === null)
  check('question: nothing typed was sent as a message meanwhile', t.sent.length === 0)

  t.app.ask('q-2', [{ id: 'name', question: '이름을 뭐라고 할까?', options: [{ label: 'deepbot' }], multiSelect: false }])
  t.key('아')
  t.key('리')
  check('question: typing switches to the person\'s own words, in the input box', t.app.question?.typing === true && t.app.editor.text === '아리')
  t.key('\r')
  check('question: Enter sends those words as the answer', JSON.stringify(t.answers[1]) === JSON.stringify({ id: 'q-2', answers: [{ id: 'name', selected: [], custom: '아리' }] }) && t.app.editor.text === '')

  t.app.ask('q-3', [{ id: 'skip-me', question: '건너뛸 질문', options: [{ label: 'a' }], multiSelect: false }])
  t.key('\x1b'); t.clock.advance(40)
  check('question: esc skips it, and the turn is not cancelled', JSON.stringify(t.answers[2]) === JSON.stringify({ id: 'q-3', answers: [{ id: 'skip-me', selected: [] }] }) && t.cancels === 0)

  t.app.ask('q-4', [{ id: 'click', question: '클릭으로 고르기', options: [{ label: '첫째' }, { label: '둘째' }], multiSelect: false }])
  t.clock.advance(20)
  const second = t.term.screen.find('둘째')
  t.key(SGR(0, second.col, second.row)); t.key(SGR(0, second.col, second.row, true))
  check('question: a click on an option answers it', JSON.stringify(t.answers[3]?.answers) === JSON.stringify([{ id: 'click', selected: ['둘째'] }]))

  t.app.ask('q-5', [{ id: 'plan', question: '이 계획으로 진행할까?', options: [{ label: 'Revise' }, { label: 'Approve' }], multiSelect: false, detail: '1. 렌더러\n2. transport', intent: { kind: 'plan-review', approve: 'Approve' } }])
  t.clock.advance(20)
  const review = t.term.screen.text()
  check('plan review: the plan is laid out in the transcript, approve is preselected', review.includes('plan review requested') && review.includes('1. 렌더러') && /❯ Approve/.test(review) && review.includes('? plan review'))
  t.app.closeQuestion('q-5')
  t.clock.advance(20)
  check('question: closed by the gateway (the turn stopped), the panel goes away', t.app.question === null && t.term.screen.text().includes('question closed'))
  t.app.turnEnded()
}
{
  const t = setup({ cols: 100, rows: 34 })
  t.app.startInterview('TUI 설계')
  t.app.sendAs('deep interview: TUI 설계', '(긴 지시문)')
  t.app.turnStarted()
  t.app.delta('좋아, 시작하자.\n```interview-state\n{"round": 2, "scores": {"목표": 80, "제약": 50, "성공 기준": 30}, "ambiguity": 42}\n```\n')
  t.clock.advance(20)
  const strip = t.term.screen.text()
  check('interview: the shown message is the short form, not the instructions', strip.includes('› deep interview: TUI 설계') && !strip.includes('(긴 지시문)') && t.sent[0] === '(긴 지시문)')
  check('interview: the strip shows the round, each dimension and the ambiguity left', strip.includes('deep interview · TUI 설계 · round 2') && /목표 ▰{8}▱{2} 80%/.test(strip) && strip.includes('ambiguity 42% → target 20% or less'))
  check('interview: the state block itself is not in the conversation', !strip.includes('interview-state') && !strip.includes('"ambiguity"') && strip.includes('좋아, 시작하자.'))
  check('interview: the screen says the scores are the model\'s own judgement', strip.includes("the model's own estimate"))
  t.app.message('ts-done', '정리했어.\n```interview-state\n{"round": 5, "scores": {"목표": 95}, "ambiguity": 12, "done": true, "spec": "specs/tui.md"}\n```', null, true)
  t.app.turnEnded()
  t.clock.advance(20)
  check('interview: done, with the spec it wrote', t.term.screen.text().includes('done · spec: specs/tui.md'))
  t.app.clear()
  t.clock.advance(20)
  check('interview: a new conversation ends it', !t.term.screen.text().includes('deep interview ·'))
}

// 8. Connection state and colour.
{
  const t = setup()
  t.app.setStatus({ connected: false, link: '연결 끊김 · 1000ms 후 재연결' })
  t.clock.advance(20)
  check('status: a lost connection is shown', t.term.screen.text().includes('연결 끊김'))
  const plain = setup({ env: { NO_COLOR: '1' } })
  check('colour: NO_COLOR writes no colour codes', !plain.term.out.join('').match(/\x1b\[[\d;]*(38|48);[25];/))
  const narrow = setup({ cols: 50 })
  check('narrow: a 50-column terminal gets the wordmark, not broken block letters', narrow.term.screen.text().includes('◆ deepseek-bot') && !narrow.term.screen.text().includes('██████╗'))
}

// 8b. Running state: counted across queued turns, synced on (re)connect, reset for another conversation.
{
  const t = setup()
  t.app.turnStarted(); t.app.turnStarted()
  t.app.turnEnded()
  check('running: the first of two turns ending does not hide the second', t.app.status.running === true)
  t.app.turnEnded()
  check('running: the second ending does', t.app.status.running === false)
  t.app.setBusy(2)
  check('running: a terminal told on connect that two turns are queued shows it', t.app.status.running === true)
  t.app.turnEnded()
  check('running: the first typing-off of the two leaves it running', t.app.status.running === true)
  t.app.turnEnded()
  check('running: the second ends it', t.app.status.running === false)
  t.app.setBusy(1)
  t.app.setBusy(0)
  check('running: told none run, it stops showing one', t.app.status.running === false)
  t.app.setBusy(undefined)
  check('running: a ready without a count leaves nothing running', t.app.status.running === false)
  t.app.turnStarted()
  t.app.clear()
  check('running: another conversation starts not running', t.app.status.running === false)
  t.key('\x03')
  t.clock.advance(20)
  check('running: so Ctrl+C arms quit instead of cancelling', t.cancels === 0 && t.term.screen.text().includes('press Ctrl+C again to quit'))
}
{
  const t = setup()
  let threw = null
  try { t.key('\x1b[200~' + '가'.repeat(250_000) + '\x1b[201~') } catch (e) { threw = e }
  check('paste: a quarter-million characters does not crash, and is cut to the cap', threw === null && [...t.app.editor.text].length === 200_000, String(threw ?? [...t.app.editor.text].length))
}

// 9. Small terminals: nothing breaks, the input still works.
for (const [cols, rows] of [[40, 14], [24, 9], [12, 6]]) {
  let threw = null
  let t
  try {
    t = setup({ cols, rows })
    t.app.setPanel([{ id: 'a', label: 'a long subagent label that does not fit', mode: 'one-shot', status: 'running', since: t.clock.now(), settledMs: 0, tokens: 1234 }], [])
    t.app.ask('q', [{ id: 'x', question: '아주 긴 질문이 좁은 화면에서 어떻게 보이는지 확인한다', options: [{ label: '선택지 하나', description: '설명이 길다' }], multiSelect: false }])
    t.app.final('# 제목\n- 목록 하나\n```\ncode line that is long\n```')
    t.key('안녕')
    t.clock.advance(20)
  } catch (e) { threw = e }
  check(`small: ${cols}×${rows} draws without throwing`, threw === null, String(threw?.stack ?? ''))
  if (threw === null) check(`small: ${cols}×${rows} still takes input`, t.app.editor.text === '' || t.app.question?.typing === true)
}

// Input help: completing /commands and @files, searching what was typed before, and keeping it.
{
  const intercepted = []
  const remembered = []
  const files = ['src/', 'src/app.ts', 'src/apply.ts', 'README.md']
  const t = setup({ extra: {
    commands: commandInfo(),
    files: (query) => files.filter((f) => f.toLowerCase().includes(query.toLowerCase())),
    intercept: (text) => { intercepted.push(text); return text.startsWith('/') },
    remember: (text) => remembered.push(text),
  } })
  check('commands: every /command has a description for completion', COMMANDS.every((c) => commandInfo().some((i) => i.name === c)) && help().includes('/resume <n|id>'))
  t.key('/')
  check('complete: "/" lists the commands above the input box', t.term.screen.text().includes('/new') && t.term.screen.text().includes('/sessions') && t.term.screen.text().includes('/resume'))
  t.key('re')
  const screen = t.term.screen.text()
  check('complete: typing narrows the list', screen.includes('/resume') && !screen.includes('/sessions'), screen.split('\n').slice(-12).join(' | '))
  t.key('\t')
  check('complete: tab puts the command in, ready for its argument', t.app.editor.text === '/resume ' && t.sent.length === 0 && intercepted.length === 0)
  t.app.editor.set('')
  t.key('/he')
  t.key('\r')
  check('complete: enter on a command without arguments runs it', JSON.stringify(intercepted) === JSON.stringify(['/help']) && t.app.editor.text === '', JSON.stringify(intercepted))
  t.key('/inter')
  t.key('\r')
  check('complete: enter on a command that takes an argument only puts it in', t.app.editor.text === '/interview ' && intercepted.length === 1)
  t.app.editor.set('')
  t.key('/')
  t.key('\x1b'); t.clock.advance(40)
  check('complete: esc closes the list, and the text stays', !t.term.screen.text().includes('/sessions') && t.app.editor.text === '/')
  t.key('s')
  check('complete: typing again opens it again', t.term.screen.text().includes('/sessions'))
  t.app.editor.set('')
  t.key('see @ap')
  check('complete: "@" lists files of the workspace', t.term.screen.text().includes('@src/app.ts') && t.term.screen.text().includes('@src/apply.ts'))
  t.key('\x1b[B')   // down: the second
  t.key('\t')
  check('complete: arrows pick, tab puts the path in', t.app.editor.text === 'see @src/apply.ts ', JSON.stringify(t.app.editor.text))
  t.app.editor.set('')
  t.key('mail a@ap')
  check('complete: an @ inside a word is not a mention', !t.term.screen.text().includes('@src/app.ts'))
  t.app.editor.set('')
  t.key('/Users/me/notes 열어줘')
  check('complete: a path that starts with / is not a command', !t.term.screen.text().includes('/sessions'))
  t.app.editor.set('')
}

{
  // Ctrl+R: newest first, narrowed by what is typed, again for older; enter keeps it to edit, esc restores.
  const remembered = []
  const t = setup({ extra: { remember: (text) => remembered.push(text) } })
  t.app.editor.load(['first deploy', 'second build', 'third deploy'])
  t.key('draft')
  t.key('\x12')
  check('search: ctrl+r shows the newest entry', t.app.editor.text === 'third deploy' && /history search/.test(t.term.screen.text()))
  t.key('build')
  check('search: typing narrows it', t.app.editor.text === 'second build')
  t.key('\x1b'); t.clock.advance(40)
  check('search: esc gives back what was being typed', t.app.editor.text === 'draft' && !/history search/.test(t.term.screen.text()))
  t.key('\x12')
  t.key('deploy')
  t.key('\x12')
  check('search: ctrl+r again goes to an older match', t.app.editor.text === 'first deploy')
  t.key('\r')
  check('search: enter keeps it in the box to edit, without sending', t.app.editor.text === 'first deploy' && t.sent.length === 0 && !/history search/.test(t.term.screen.text()))
  t.key('\r')
  check('remember: what is sent is kept for the next run', t.sent.at(-1) === 'first deploy' && remembered.at(-1) === 'first deploy')
}

{
  // Thinking and tool steps: shown briefly, everything on ctrl+o.
  const t = setup({ rows: 40 })
  t.app.turnStarted()
  t.app.thinking('계획을 세우는 중\n둘째 생각\n셋째 생각\n넷째 생각')
  t.clock.advance(20)
  let screen = t.term.screen.text()
  check('thinking: shown while it streams, its latest lines', screen.includes('thinking…') && screen.includes('넷째 생각') && !screen.includes('계획을 세우는 중'), screen.split('\n').slice(10, 20).join(' | '))
  t.app.delta('답을 씁니다')
  t.clock.advance(20)
  screen = t.term.screen.text()
  check('thinking: folded to one line once the answer starts', /thought · /.test(screen) && !screen.includes('넷째 생각') && screen.includes('답을 씁니다'))
  t.key('\x0f')   // ctrl+o
  t.clock.advance(20)
  screen = t.term.screen.text()
  check('ctrl+o: unfolds the thinking in full', screen.includes('계획을 세우는 중') && screen.includes('넷째 생각'))
  t.key('\x0f')
  t.clock.advance(20)
  check('ctrl+o: and folds it again', !t.term.screen.text().includes('계획을 세우는 중'))

  t.app.toolCall({ name: 'str_replace_editor', callId: 'c1', title: 'str_replace /w/a.ts',
    diff: [{ path: '/w/a.ts', old: 'same one\nold value\nsame two', new: 'same one\nnew value\nsame two' }] })
  t.clock.advance(20)
  screen = t.term.screen.text()
  check('tools: the call shows its name and title', screen.includes('● str_replace_editor') && screen.includes('str_replace /w/a.ts'))
  check('tools: an edit shows what changed, not the lines around it', screen.includes('- old value') && screen.includes('+ new value') && !screen.includes('same one'), screen.split('\n').slice(-16).join(' | '))
  t.app.toolResult('c1', true, 'r1\nr2\nr3\nr4\nr5')
  t.clock.advance(20)
  screen = t.term.screen.text()
  check('tools: the result shows under its call, a few lines', screen.includes('⎿ r1') && screen.includes('r3') && !screen.includes('r4'))
  t.key('\x0f')
  t.clock.advance(20)
  check('ctrl+o: unfolds the result too', t.term.screen.text().includes('r5'))
  t.key('\x0f')
  t.app.toolCall({ name: 'bash', callId: 'c2', title: 'false' })
  t.app.toolResult('c2', false, 'exit 1')
  t.app.toolResult('unknown', true, '아무 데도 안 붙음')
  t.clock.advance(20)
  screen = t.term.screen.text()
  check('tools: a failed result is shown, and one for an unknown call is dropped', screen.includes('⎿ exit 1') && !screen.includes('아무 데도 안 붙음'))
  t.app.thinking('버려질 생각')
  t.app.resetAttempt()
  t.clock.advance(20)
  check('thinking: a failed attempt\'s thinking is dropped with its text', !t.term.screen.text().includes('버려질 생각'))
}

{
  // Found in review. A list left open after the box was emptied took the next Tab or Enter.
  const intercepted = []
  const t = setup({ extra: { commands: commandInfo(), files: () => ['src/app.ts'], intercept: (text) => { intercepted.push(text); return text.startsWith('/') } } })
  t.key('see @ap')
  t.key('\x03')   // ctrl+c empties the box
  let crashed = null
  try { t.key('\t'); t.clock.advance(20) } catch (e) { crashed = String(e?.message ?? e) }
  check('complete: ctrl+c closes the list with the text, and tab after it does nothing wrong', crashed === null && t.app.editor.text === '' && t.app.completion === null && !t.term.screen.text().includes('@src/app.ts'), String(crashed))
  t.app.message('ts-ask', '권한이 필요해: rm -rf build', null, false)
  t.app.offer('ts-ask', [{ id: 'approval:allow:k', label: '허용', style: 'primary' }, { id: 'approval:deny:k', label: '거부', style: 'danger' }])
  t.key('/q')
  t.key('\x03')
  t.key('\r')
  check('complete: enter after ctrl+c answers the approval, not a command left in the list', t.actions.length === 1 && intercepted.length === 0 && t.exited === null, JSON.stringify({ actions: t.actions, intercepted }))
}

{
  // Found in review. A question that arrives during a history search is answered by its options,
  // never by the entry the search was showing.
  const t = setup()
  t.app.editor.load(['rm -rf build 해줘'])
  t.key('\x12')
  check('search: the match is in the box', t.app.editor.text === 'rm -rf build 해줘')
  t.app.ask('q1', [{ id: 'pick', question: '어느 쪽?', options: [{ label: 'A' }, { label: 'B' }] }])
  t.clock.advance(20)
  check('search: a question ends the search and gives back what was typed', t.app.editor.text === '' && !/history search/.test(t.term.screen.text()))
  t.key('\r')
  check('search: enter then answers with an option, not with the history entry', t.answers.length === 1 && t.answers[0].answers?.[0]?.selected?.[0] === 'A' && t.answers[0].answers[0].custom === undefined, JSON.stringify(t.answers))
}

{
  // Found in review. An edit too large to send whole is cut: the card says so, and does not show
  // lines "removed" only because they fell past the cut.
  const t = setup({ rows: 40 })
  t.app.turnStarted()
  t.app.toolCall({ name: 'edit', callId: 'e1', title: 'Edit big.ts', diff: [{ path: 'big.ts', old: 'keep 1\nkeep 2\ntail out', new: 'new top\nkeep 1\nkeep 2', newCut: true }] })
  t.clock.advance(20)
  let screen = t.term.screen.text()
  check('tools: a cut diff shows the change, not the line that only fell past the cut', screen.includes('+ new top') && !screen.includes('- tail out'), screen.split('\n').slice(-14).join(' | '))
  check('tools: and says it was cut', /truncated/.test(screen))
  // A cut edit long enough that its lines are not compared at all: no line is shown as removed or
  // added on a guess (the fixture: one line put on top of 900).
  const many = Array.from({ length: 900 }, (_, i) => `line ${i}`)
  t.app.toolCall({ name: 'edit', callId: 'e2', title: 'Edit huge.ts', diff: [{ path: 'huge.ts', old: many.join('\n'), new: ['top', ...many.slice(0, 899)].join('\n'), oldCut: true, newCut: true }] })
  t.clock.advance(20)
  screen = t.term.screen.text()
  t.app.toolCall({ name: 'edit', callId: 'e2b', title: 'Edit both.ts', diff: [{ path: 'both.ts', old: 'a\nb', new: 'c\nd', oldCut: true, newCut: true }] })
  t.clock.advance(20)
  check('tools: with both sides cut the card says it can show no line for certain', /no line is certain/.test(t.term.screen.text()) && !t.term.screen.text().includes('- a'))
  check('tools: an edit too long to compare shows no invented removals', !screen.includes('- line 0') && /too large to compare/.test(screen), screen.split('\n').slice(-10).join(' | '))
  t.app.toolCall({ name: 'edit', callId: 'e3', title: 'Edit same.ts', diff: [{ path: 'same.ts', old: 'a\nb', new: 'a\nb', oldCut: true, newCut: true }] })
  t.clock.advance(20)
  check('tools: a cut edit whose kept parts are the same says so', /no difference in the part shown/.test(t.term.screen.text()))
  // Which side was cut decides what may be a guess. Three edits as the core's cut sends them:
  const olds = Array.from({ length: 300 }, (_, i) => `old ${i}`)
  const adds = Array.from({ length: 260 }, (_, i) => `add ${i}`)
  const card = (id, diff) => { t.app.toolCall({ name: 'edit', callId: id, title: `Edit ${id}`, diff: [diff] }); t.clock.advance(20); return t.term.screen.text().split('\n').slice(-24).join('\n') }
  // 1. A block put above a text that is all still there: only the new side lost its tail.
  let shown = card('n1', { path: 'a', old: olds.join('\n'), new: [...adds, ...olds.slice(0, 140)].join('\n'), newCut: true })
  check('tools: text still in the file is not shown removed because the new side was cut', shown.includes('+ add 0') && !/- old \d/.test(shown), shown.replace(/\n/g, ' | '))
  // 2. Lines put above the only line of a file: the new side's copy of that line is past its cut.
  shown = card('n2', { path: 'b', old: 'export default App', new: adds.slice(0, 160).join('\n'), newCut: true })
  check('tools: the one old line is not shown removed, and the additions are shown', shown.includes('+ add 0') && !shown.includes('- export default App'), shown.replace(/\n/g, ' | '))
  // 3. Lines put below it: additions after the last shared line are real when the old side is whole.
  shown = card('n3', { path: 'c', old: 'export default App', new: ['export default App', ...adds.slice(0, 160)].join('\n'), newCut: true })
  check('tools: additions below the last shared line are shown, not "no difference"', shown.includes('+ add 0') && !/no difference/.test(shown), shown.replace(/\n/g, ' | '))
  // And the other side: when the old text was cut, an addition past the last shared line may be old text.
  shown = card('n4', { path: 'd', old: 'same\nold kept', new: 'same\nmaybe old\n', oldCut: true })
  // Rows left out inside what is shown are said, with how many.
  shown = card('n5', { path: 'e', old: 'keep\n}\n\nmore', new: 'keep\nnew one\n}\nnew two\n\nnew three', newCut: true })
  check('tools: a card that leaves rows out says how many', /only the lines that are certain, \d+ left out/.test(shown), shown.replace(/\n/g, ' | '))
  check('tools: an addition past the last shared line is withheld when the old side was cut', !shown.includes('+ maybe old') && shown.includes('- old kept') && !/no difference/.test(shown), shown.replace(/\n/g, ' | '))
  t.key('\x0f')
  t.app.thinking(Array.from({ length: 600 }, (_, i) => `생각 ${i}`).join('\n'))
  t.clock.advance(20)
  check('thinking: unfolded past its limit, it says how much more there is', /more lines/.test(t.term.screen.text()))
  t.key('\x0f')
  // A retried attempt drops its thinking even when its answer had begun.
  t.app.thinking('버려질 계획')
  t.app.delta('버려질 답')
  t.app.resetAttempt()
  t.clock.advance(20)
  screen = t.term.screen.text()
  check('thinking: a retry after the answer began drops the folded thinking too', !/thought · /.test(screen) && !screen.includes('버려질 답'), screen.split('\n').slice(-14).join(' | '))
  // A thinking block from before a tool call belongs to a model call that succeeded: it stays.
  t.app.thinking('남을 계획')
  t.app.toolCall({ name: 'bash', callId: 'b1' })
  t.app.delta('다음 답')
  t.app.resetAttempt()
  t.clock.advance(20)
  check('thinking: the thinking of an earlier, finished step stays', /thought · /.test(t.term.screen.text()))
}

{
  // Found in review. Going up through history passes a /command entry (its list must not take the
  // arrows), and a list comes back for text still in the box when a question closes.
  const t = setup({ extra: { commands: commandInfo() } })
  t.app.editor.load(['첫 질문', '/help', '둘째 질문'])
  const seen = []
  for (let i = 0; i < 3; i++) { t.key('\x1b[A'); seen.push(t.app.editor.text) }
  check('history: up goes past a /command entry', JSON.stringify(seen) === JSON.stringify(['둘째 질문', '/help', '첫 질문']), JSON.stringify(seen))
  t.app.editor.set('')
  t.key('/he')
  t.app.ask('q9', [{ id: 'pick', question: '?', options: [{ label: 'A' }] }])
  t.app.closeQuestion('q9')
  t.clock.advance(20)
  check('complete: the list is back for the text in the box once the question is gone', t.app.completion !== null && t.term.screen.text().includes('/help'))
  // An entry reached with the arrows and then edited is being typed again: its list opens.
  t.app.editor.set('')
  t.key('\x1b[A'); t.key('\x1b[A')   // back to /help
  t.key('\x7f')
  check('complete: deleting in a recalled command opens its list', t.app.editor.text === '/hel' && t.app.completion !== null, JSON.stringify(t.app.editor.text))
  // A delete that removes nothing changes nothing: the entry is still one being walked through.
  t.app.editor.set('')
  t.key('draft')
  t.key('\x1b[A')          // the newest entry
  const recalled = t.app.editor.text
  t.key('\x0b')            // ctrl+k at the end: nothing to delete
  t.key('\x1b[B')          // down: back to what was being typed
  check('history: a delete that removes nothing does not end the walk', recalled !== 'draft' && t.app.editor.text === 'draft', JSON.stringify([recalled, t.app.editor.text]))
}

{
  // Found in review. Only what was sent or run is remembered: not text typed where it goes nowhere.
  const remembered = []
  const t = setup({ extra: { remember: (text) => remembered.push(text), intercept: (text) => text.startsWith('/') } })
  t.key('보낸 메시지\r')
  t.key('/help\r')
  t.app.setPanel([], [{ id: 'job-1', kind: 'bash', label: 'sleep', owner: 'o', status: 'running', startedAt: 1 }])
  t.clock.advance(20)
  t.key('\t'); t.key('\x1b[B'); t.key('\r')   // the panel, down past "main", open the shell
  t.clock.advance(20)
  t.key('셸에 친 글\r')
  check('remember: a message and a command are kept, text typed in a shell view is not', t.app.view.kind === 'job' && JSON.stringify(remembered) === JSON.stringify(['보낸 메시지', '/help']), JSON.stringify({ view: t.app.view.kind, remembered }))
}

{
  // The history file: owner-only, read back, and kept to the last HISTORY_KEEP entries.
  const dir = mkdtempSync(join(tmpdir(), 'deepbot-history-'))
  const file = join(dir, 'deepbot-tui', 'history.jsonl')
  appendHistory(file, '첫 질문')
  appendHistory(file, '여러 줄\n질문')
  check('history: entries are read back in order, newlines included', JSON.stringify(loadHistory(file)) === JSON.stringify(['첫 질문', '여러 줄\n질문']))
  check('history: the file is the owner\'s only', (statSync(file).mode & 0o777) === 0o600)
  for (let i = 0; i < HISTORY_KEEP * 2 + 5; i++) appendHistory(file, `q${i}`)
  const kept = loadHistory(file)
  check('history: only the last entries are kept, and the file does not grow forever', kept.length === HISTORY_KEEP && kept.at(-1) === `q${HISTORY_KEEP * 2 + 4}` && readFileSync(file, 'utf8').split('\n').filter(Boolean).length <= HISTORY_KEEP * 2)
  check('history: a missing or broken file is no history', loadHistory(join(dir, 'none.jsonl')).length === 0)
  const loose = join(dir, 'loose', 'history.jsonl')
  mkdirSync(join(dir, 'loose'))
  writeFileSync(loose, '', { mode: 0o644 })
  appendHistory(loose, 'x'.repeat(50_000))
  check('history: a file that was readable by others is made the owner\'s', (statSync(loose).mode & 0o777) === 0o600)
  check('history: one huge entry is cut, not kept whole', loadHistory(loose)[0].length <= 20_000)
  rmSync(dir, { recursive: true, force: true })
}

{
  // Files for @: the workspace, without dependency and build folders, best matches first.
  const root = mkdtempSync(join(tmpdir(), 'deepbot-files-'))
  for (const d of ['src', 'node_modules/pkg', '.git/objects', 'docs']) mkdirSync(join(root, d), { recursive: true })
  for (const f of ['src/app.ts', 'src/map.ts', 'node_modules/pkg/app.js', '.git/objects/app', 'docs/app-notes.md', 'README.md']) writeFileSync(join(root, f), '')
  const find = fileFinder()
  const hits = find(root, 'app')
  check('files: dependency and git folders are not listed', !hits.some((p) => p.startsWith('node_modules') || p.startsWith('.git')), JSON.stringify(hits))
  check('files: a name that starts with the query comes first', hits[0] === 'src/app.ts' || hits[0] === 'docs/app-notes.md', JSON.stringify(hits))
  check('files: folders end with /', find(root, 'sr').includes('src/'))
  check('files: no workspace, no files', find('', 'app').length === 0)
  // A scan stops when it has taken too long: the keystroke that asked must not wait on a huge tree.
  let ticks = 0
  const slow = fileFinder(() => (ticks += 1000))
  const partial = slow(root, '')
  check('files: a scan over its time budget returns what it has', partial.length > 0 && !partial.includes('src/app.ts'), JSON.stringify(partial))
  // A huge directory is listed in part, and which part does not depend on the order the disk gives.
  mkdirSync(join(root, 'many'))
  for (let i = 0; i < 2100; i++) writeFileSync(join(root, 'many', `f${String(i).padStart(4, '0')}`), '')
  // The disk's order is not sorted everywhere: read it backwards here, so only sorting before the cut passes.
  const backwards = (dir, options) => readdirSync(dir, options).reverse()
  const first = fileFinder(undefined, backwards)(root, 'many/f', 5000)
  check('files: a directory over the cap keeps its first names, whatever order the disk gives', first.includes('many/f0000') && first.includes('many/f1999') && !first.includes('many/f2099'), `${first.length} listed`)
  rmSync(root, { recursive: true, force: true })
}

// 60. How a conversation looks: what was said on a band, answers and tool calls marked, thinking in sky
// blue with a light passing over it, a rule between exchanges, and what waits shown as waiting.
{
  const BAND = '48;2;38;44;56', OK = '38;2;76;195;138', DANGER = '38;2;240;90;90', MUTED = '38;2;138;147;166', SKY = '38;2;125;211;252'
  const t = setup({ cols: 80, rows: 40 })
  const cell = (r, c) => t.term.screen.grid[r * 80 + c]
  const styleAt = (needle) => { const at = t.term.screen.find(needle); return at === null ? null : cell(at.row, at.col).style }
  t.key('hello there\r')
  t.clock.advance(20)
  const said = t.term.screen.find('› hello there')
  check('band: what was said sits on a band to the edge', said !== null && cell(said.row, said.col).style.includes(BAND) && cell(said.row, 79).style.includes(BAND), said === null ? 'not found' : cell(said.row, 79).style)
  t.app.turnStarted()
  t.app.toolCall({ name: 'bash', callId: 'c1', title: 'ls' })
  t.clock.advance(20)
  const first = styleAt('● bash')
  t.clock.advance(480)
  const second = styleAt('● bash')
  check('tool: the dot blinks while the tool runs', first !== null && second !== null && first !== second, `${first} / ${second}`)
  check('status: says which tool runs', t.term.screen.text().includes('running bash…'))
  t.app.toolResult('c1', true, 'a.txt')
  t.clock.advance(20)
  check('tool: green once it succeeded', (styleAt('● bash') ?? '').includes(OK), styleAt('● bash'))
  t.app.toolCall({ name: 'grep', callId: 'c2', title: 'x' })
  t.app.toolResult('c2', false, 'no such file')
  t.clock.advance(20)
  check('tool: red once it failed', (styleAt('● grep') ?? '').includes(DANGER), styleAt('● grep'))
  t.app.toolCall({ name: 'fetch', callId: 'c3', title: 'https://example.com' })
  t.app.thinking('weighing the two options\n')
  t.clock.advance(20)
  const label = t.term.screen.find('✻ thinking…')
  const styles = label === null ? new Set() : new Set(Array.from({ length: 9 }, (_, i) => cell(label.row, label.col + 2 + i).style))
  check('thinking: in sky blue, with a light passing over its label', label !== null && styles.size > 1 && [...styles].some((s) => String(s).includes(SKY)), [...styles].join(' | ').slice(0, 120))
  check('status: says it is thinking', /✻ thinking…/.test(t.term.screen.row(t.term.screen.find('▸▸ effort').row)))
  t.app.delta('The answer.')
  t.app.final('The answer.')
  t.app.turnEnded()
  t.clock.advance(20)
  check('answer: marked with a dot where it starts', t.term.screen.text().includes('● The answer.'))
  const lines = t.term.screen.text().split('\n')
  const answerAt = lines.findIndex((l) => l.includes('● The answer.'))
  check('steps: a blank line before the answer, and before each tool call', answerAt > 0 && lines[answerAt - 1].trim() === '' && lines[lines.findIndex((l) => l.includes('● grep')) - 1].trim() === '', lines.slice(Math.max(0, answerAt - 2), answerAt + 1).join(' | '))
  const settled = styleAt('● fetch')
  t.clock.advance(480)
  check('tool: a call left without a result stops blinking when the turn ends', settled !== null && settled === styleAt('● fetch') && settled.includes(MUTED), settled)
  check('thinking: folded, it says what it was, in one colour', (() => { const at = t.term.screen.find('✻ thought ·'); return at !== null && cell(at.row, at.col + 2).style === cell(at.row, at.col + 8).style && cell(at.row, at.col + 2).style.includes(SKY) })())

  t.key('second question\r')
  t.clock.advance(20)
  const rows = t.term.screen.text().split('\n')
  const ruleAt = rows.findIndex((l) => /^ {2}─{20,}/.test(l))
  const secondAt = rows.findIndex((l) => l.includes('› second question'))
  check('rule: a line between one exchange and the next, and none before the first', ruleAt !== -1 && ruleAt < secondAt && ruleAt > rows.findIndex((l) => l.includes('● The answer.')) && rows.findIndex((l) => /^ {2}─{20,}/.test(l)) === ruleAt, `${ruleAt} < ${secondAt}`)

  // A message sent while a turn runs waits above the input, and joins the transcript when its turn starts.
  t.app.turnStarted()
  t.key('and a third\r')
  t.app.turnStarted()   // the gateway's typing for the waiting message
  t.clock.advance(20)
  const waiting = t.term.screen.find('› and a third')
  const divider = t.term.screen.text().split('\n').findIndex((l) => /^─{60,}/.test(l))
  check('waiting: shown above the input, tagged, not yet in the transcript', waiting !== null && waiting.row === divider - 1 && t.term.screen.row(waiting.row).includes('queued'), waiting === null ? 'not shown' : `${waiting.row} vs ${divider}`)
  check('waiting: the status line counts it', t.term.screen.text().includes('1 queued'))
  t.app.final('Second answer.')
  t.app.turnEnded()
  t.clock.advance(20)
  const moved = t.term.screen.find('› and a third')
  check('waiting: its turn started, it is in the transcript, untagged', moved !== null && moved.row < divider && !t.term.screen.row(moved.row).includes('queued') && !t.term.screen.text().includes('1 queued'))
  t.app.turnEnded()

  // Stopping the turn withdraws what waited at the gateway: it comes back to the input.
  t.app.turnStarted()
  t.key('fourth\r')
  t.key('\x1b'); t.clock.advance(40)
  check('waiting: esc stops the turn and gives what waited back to the input', t.cancels === 1 && t.app.editor.text === 'fourth' && !t.term.screen.text().includes('queued'), `cancels ${t.cancels}, editor ${JSON.stringify(t.app.editor.text)}`)
  t.app.turnEnded()
}

// 60b. Another conversation (/new, /resume) starts clean: nothing waits from the old one, no tool of its runs.
{
  const t = setup({ cols: 80, rows: 30 })
  t.app.turnStarted()
  t.app.toolCall({ name: 'bash', callId: 'x1', title: 'sleep 9' })
  t.key('left behind\r')
  t.clock.advance(20)
  check('clear: the old conversation\'s queue shows before', t.term.screen.text().includes('1 queued'))
  t.app.clear()
  t.clock.advance(20)
  check('clear: after, nothing is queued and no old tool is named', !t.term.screen.text().includes('queued') && !t.term.screen.text().includes('running bash'))
  t.app.turnStarted()
  t.clock.advance(20)
  // Checked while the first turn runs: its end would reset the tool anyway, and hide a clear() that did not.
  check('clear: the new conversation\'s first turn is working, not running the old one\'s tool', t.term.screen.text().includes('working…') && !t.term.screen.text().includes('running bash'))
  t.app.turnEnded()
  t.clock.advance(20)
  check('clear: and its end does not bring the old message in', !t.term.screen.text().includes('left behind'))
}

// 61. Without colour there is no band and nothing sweeps: the same words, plain.
{
  const t = setup({ cols: 60, rows: 24, env: { NO_COLOR: '1' } })
  t.key('plain\r')
  t.app.turnStarted()
  t.app.thinking('hmm\n')
  t.clock.advance(20)
  const at = t.term.screen.find('› plain')
  check('no colour: what was said has no band and no trailing spaces', at !== null && !t.term.screen.grid.some((c) => c.style.includes('48;')) && t.term.screen.row(at.row).trimEnd() === '› plain')
  check('no colour: the thinking label is one style', (() => { const l = t.term.screen.find('✻ thinking…'); return l !== null && new Set(Array.from({ length: 9 }, (_, i) => t.term.screen.grid[l.row * 60 + l.col + 2 + i].style)).size === 1 })())
  t.app.turnEnded()
}

// 70. The bottom of the screen, as in Claude Code. A short conversation has the input box right under it
// (it used to wait at the last rows, with /model's list at the top of an empty screen); /model and
// /sessions are pickers just above the box; shift+tab steps the effort, shown where a permission label
// the gateway never sent ("▸▸ ask") used to be; and the mouse works on what the keys work on.
{
  const steps = []
  const t = setup({ cols: 80, rows: 40, extra: { stepEffort: () => steps.push(1) } })
  const box = () => t.term.screen.find('╭')?.row ?? -1
  const info = t.term.screen.find('session tui-3f2a9c1e-aaaa')?.row ?? -1
  check('layout: a short conversation has the input box right under it, not at the last rows', info >= 0 && box() > info && box() - info <= 4 && box() < 40 - 5, `info ${info}, box ${box()}`)
  const status = t.term.screen.row(box() - 1)
  check('status: the effort, with the key that steps it, and no permission label', /▸▸ effort medium \(shift\+tab\)/.test(status) && !/\bask\b/.test(status), status)
  check('status: the model it runs on, at the right', /deepseek-v4\.1\s*$/.test(status), status)
  t.key('\x1b[Z')
  check('shift+tab: steps the effort', steps.length === 1)
  const label = t.term.screen.find('▸▸ effort')
  t.key(SGR(0, label.col + 3, label.row)); t.key(SGR(0, label.col + 3, label.row, true))
  check('mouse: a click on the effort steps it too', steps.length === 2)
  t.app.setStatus({ effort: null })
  t.clock.advance(20)
  check('status: a model with no effort shows none', !t.term.screen.text().includes('▸▸'))
  t.app.setStatus({ effort: 'medium' })

  const picked = []
  const rows = [
    { label: 'og/m1', detail: 'M one', current: true, efforts: ['low', 'medium', 'high'], effort: 'medium' },
    { label: 'og/m2', detail: 'M two', efforts: [] },
    { label: 'og/m3', detail: 'M three', efforts: ['low', 'high'] },
    { label: 'back to the configured model' },
  ]
  const open = () => { t.app.openPicker({ title: 'Model', rows, onPick: (i, e) => picked.push([i, e]) }); t.clock.advance(20) }
  open()
  const first = t.term.screen.find('1. og/m1')
  check('picker: numbered rows, the current one marked and highlighted, just above the input box', first !== null && box() > first.row && box() - first.row <= 8 && /❯ 1\. og\/m1 +M one +✓/.test(t.term.screen.row(first.row)), t.term.screen.row(first?.row ?? 0))
  check('picker: the highlighted model\'s effort, and what it takes', /effort ◂ medium ▸ +low · medium · high/.test(t.term.screen.text()), t.term.screen.text().split('\n').find((l) => l.includes('effort ◂')))
  check('picker: the hint line says the keys', /↑↓ .*←→ effort.*↵ .*esc /.test(t.term.screen.row(39)) || /↑↓ .*←→ effort.*↵ .*esc /.test(t.term.screen.text()), t.term.screen.text().split('\n').filter((l) => l.includes('↑↓')).join(' | '))
  t.key('\x1b[C'); t.clock.advance(20)
  check('picker: → takes the next effort', /effort ◂ high ▸/.test(t.term.screen.text()))
  t.key('\x1b[B'); t.clock.advance(20)
  check('picker: ↓ moves; a model that takes no effort says so', /❯ 2\. og\/m2/.test(t.term.screen.text()) && t.term.screen.text().includes('takes no effort'), t.term.screen.text().split('\n').filter((l) => /og\/m2|effort/.test(l)).join(' | '))
  t.key('\x1b[B'); t.key('\x1b[D'); t.clock.advance(20)
  check('picker: on a model that is not the current one, ← starts from its default', /❯ 3\. og\/m3/.test(t.term.screen.text()) && /effort ◂ high ▸/.test(t.term.screen.text()), t.term.screen.text().split('\n').filter((l) => /effort/.test(l)).join(' | '))
  t.key('\x1b[A'); t.key('\x1b[A'); t.key('\r'); t.clock.advance(20)
  check('picker: ↵ picks the row with the effort chosen, and closes', JSON.stringify(picked) === '[[0,"high"]]' && t.term.screen.find('1. og/m1') === null, JSON.stringify(picked))
  check('picker: and nothing was sent as a message', t.sent.length === 0)
  open()
  t.key('4'); t.clock.advance(20)
  check('picker: a digit moves to that row', /❯ 4\. back to the configured model/.test(t.term.screen.text()) && !/effort ◂/.test(t.term.screen.text()))
  t.key('\x1b'); t.clock.advance(40)
  check('picker: esc closes it, picking nothing', picked.length === 1 && t.term.screen.find('og/m1') === null)
  open()
  const second = t.term.screen.find('2. og/m2')
  t.key(SGR(0, second.col, second.row)); t.key(SGR(0, second.col, second.row, true)); t.clock.advance(20)
  check('mouse: a click on a row picks it', JSON.stringify(picked.at(-1)) === '[1,null]' && t.term.screen.find('og/m1') === null, JSON.stringify(picked))
  open()
  const top = t.term.screen.find('1. og/m1')
  t.key(SGR(65, top.col, top.row)); t.clock.advance(20)
  check('mouse: the wheel over the picker moves the highlight, not the transcript', /❯ 2\. og\/m2/.test(t.term.screen.text()))
  t.key('h'); t.clock.advance(20)
  check('picker: typing closes it and goes to the input box', t.app.editor.text === 'h' && t.term.screen.find('og/m1') === null, JSON.stringify(t.app.editor.text))
  t.key('\x15')
  open()
  t.app.ask('q-70', [{ id: 'which', question: 'Which one?', options: [{ label: 'a' }, { label: 'b' }], multiSelect: false }])
  t.clock.advance(20)
  check('picker: a question from the turn takes its place', t.term.screen.find('og/m1') === null && t.term.screen.text().includes('Which one?'))
  t.key('\x1b'); t.clock.advance(40)
  check('picker: and it does not come back once the question is done', t.app.question === null && t.app.picker === null && t.term.screen.find('og/m1') === null)

  t.key('hello world'); t.clock.advance(20)
  const typed = t.term.screen.find('hello world')
  t.key(SGR(0, typed.col + 3, typed.row)); t.key(SGR(0, typed.col + 3, typed.row, true))
  t.key('X'); t.clock.advance(20)
  check('mouse: a click in the input box puts the cursor there', t.app.editor.text === 'helXlo world', JSON.stringify(t.app.editor.text))
  t.key('\x15')

  for (let i = 0; i < 40; i++) t.app.notice(`line ${i}`)
  t.clock.advance(20)
  const last = t.term.screen.find('line 39')?.row ?? -1
  check('layout: a long conversation pushes the box to the bottom, the newest line just above it', box() === 40 - 4 && last >= box() - 4 && last < box(), `box ${box()}, last ${last}`)
}

// 71. A completion row is picked with the mouse as with ↵.
{
  const intercepted = []
  const t = setup({ extra: { commands: commandInfo(), intercept: (text) => { intercepted.push(text); return true } } })
  t.key('/'); t.clock.advance(20)
  const resume = t.term.screen.find('/resume')
  t.key(SGR(0, resume.col, resume.row)); t.key(SGR(0, resume.col, resume.row, true)); t.clock.advance(20)
  check('mouse: a click on a command that takes an argument puts it in', t.app.editor.text === '/resume ' && intercepted.length === 0, JSON.stringify(t.app.editor.text))
  t.key('\x15'); t.key('/he'); t.clock.advance(20)
  const help_ = t.term.screen.find('/help')
  t.key(SGR(0, help_.col, help_.row)); t.key(SGR(0, help_.col, help_.row, true)); t.clock.advance(20)
  check('mouse: a click on one that takes none runs it', JSON.stringify(intercepted) === '["/help"]', JSON.stringify(intercepted))
}

// 72. Review of the pickers. A small screen keeps the input box; text being typed when a picker opens
// keeps ↵ and digits; the picker does not share the screen with the completion list or a history
// search; shift+tab steps the effort with the completion list open; a click in a tall input box does
// not scroll it; rows above the window are counted; numbers line up past nine.
{
  const many = Array.from({ length: 12 }, (_, i) => ({ label: `p/model-${i + 1}`, detail: `M${i + 1}` }))
  for (const rows of [16, 13]) {
    const small = setup({ cols: 80, rows })
    small.app.openPicker({ title: 'Model', rows: many, onPick: () => {} })
    small.clock.advance(20)
    check(`picker: on a screen ${rows} rows tall the input box and the hint line stay`, small.term.screen.find('╰') !== null && small.term.screen.find('╭') !== null && small.term.screen.text().includes('↑↓ pick'), small.term.screen.text().split('\n').slice(-5).join(' | '))
    check(`picker: and it still shows a row to pick (${rows} rows)`, /❯ +1\. p\/model-1 /.test(small.term.screen.text()))
  }

  const picked = []
  const t = setup({ cols: 80, rows: 40, extra: { commands: commandInfo(), intercept: (text) => text.startsWith('/') } })
  t.key('order ')
  t.app.openPicker({ title: 'Model', rows: many, onPick: (i) => picked.push(i) })
  t.clock.advance(20)
  t.key('2'); t.clock.advance(20)
  check('picker: opened over text being typed, a digit goes to the text', t.app.editor.text === 'order 2' && picked.length === 0, JSON.stringify(t.app.editor.text))
  t.app.openPicker({ title: 'Model', rows: many, onPick: (i) => picked.push(i) })
  t.key('\r'); t.clock.advance(20)
  check('picker: and ↵ sends the text instead of picking', JSON.stringify(t.sent) === '["order 2"]' && picked.length === 0, JSON.stringify([t.sent, picked]))

  const c = setup({ cols: 80, rows: 40, extra: { commands: commandInfo() } })
  c.key('/s'); c.clock.advance(20)
  c.app.openPicker({ title: 'Model', rows: many, onPick: () => {} })
  c.key('\x1b[5~'); c.clock.advance(20)
  check('picker: the completion list does not open under it', c.app.picker !== null && c.app.completion === null && !c.term.screen.text().includes('/sessions'), c.term.screen.text().split('\n').filter((l) => l.includes('/s')).join(' | '))
  c.key('\x12'); c.clock.advance(20)
  check('picker: nor does a history search', c.app.picker !== null && !/history search/.test(c.term.screen.text()))

  const steps = []
  const e = setup({ extra: { commands: commandInfo(), stepEffort: () => steps.push(1) } })
  e.key('/'); e.clock.advance(20)
  e.key('\x1b[Z'); e.clock.advance(20)
  check('shift+tab: with the completion list open it steps the effort, and inserts nothing', steps.length === 1 && e.app.editor.text === '/', JSON.stringify(e.app.editor.text))

  const tall = setup({ cols: 80, rows: 40 })
  tall.key(`\x1b[200~${Array.from({ length: 10 }, (_, i) => `row${i}`).join('\n')}\x1b[201~`)
  tall.clock.advance(20)
  // The cursor on the last row: the box shows the last six, row4 to row9, and a click goes on row4.
  const top = tall.term.screen.find('row4')
  const shownBefore = tall.term.screen.row(top.row).trim()
  tall.key(SGR(0, top.col + 2, top.row)); tall.key(SGR(0, top.col + 2, top.row, true)); tall.clock.advance(20)
  check('mouse: a click in a tall input box does not scroll it', tall.term.screen.row(top.row).trim() === shownBefore, `${shownBefore} → ${tall.term.screen.row(top.row).trim()}`)

  const w = setup({ cols: 80, rows: 40 })
  w.app.openPicker({ title: 'Model', rows: many, onPick: () => {} })
  for (let i = 0; i < 10; i++) w.key('\x1b[B')
  w.clock.advance(20)
  const text = w.term.screen.text()
  check('picker: rows above the window are counted', /↑ \d/.test(text), text.split('\n').filter((l) => /[↑↓] \d/.test(l)).join(' | '))
  const nine = w.term.screen.find('. p/model-9 '), eleven = w.term.screen.find('. p/model-11')
  check('picker: numbers line up past nine', nine !== null && eleven !== null && nine.col === eleven.col, text.split('\n').filter((l) => /model-(9|11) /.test(l)).join(' | '))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
