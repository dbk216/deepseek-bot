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
import { messages } from '../dist/messages.js'
import { stringWidth } from '../dist/tui/render/width.js'
import { RESTORE } from '../dist/tui/render/terminal.js'
import { fakeClock, fakeTerminal } from './tui-fakes.ts'
import { commandInfo, COMMANDS, help } from '../dist/tui/cli.js'
import { appendHistory, loadHistory, HISTORY_KEEP } from '../dist/tui/history.js'
import { fileFinder, gitBranch } from '../dist/tui/files.js'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
  const withdrawals = []
  const sentIds = []
  let withdrawOk = true
  let sendOk = true
  let exited = null
  const app = new App({
    io: term.io, env, platform: 'darwin', clock,
    backend: {
      send: (t, id) => { sent.push(t); sentIds.push(id); return sendOk }, cancel: () => { cancels++ }, action: (id) => actions.push(id),
      view: (...a) => views.push(['view', ...a]), agentSend: (...a) => views.push(['send', ...a]),
      agentInterrupt: (...a) => views.push(['interrupt', ...a]), jobKill: (...a) => views.push(['kill', ...a]),
      answer: (id, answers) => answers_.push({ id, answers }),
      withdraw: (ids) => { withdrawals.push(ids); return withdrawOk },
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
    withdrawals, sentIds,
    set withdrawOk(ok) { withdrawOk = ok },
    set sendOk(ok) { sendOk = ok },
    get exited() { return exited },
    key: (s) => term.type(s),
    frames: () => term.out.length,
  }
}

const SGR = (b, x, y, release = false) => `\x1b[<${b};${x + 1};${y + 1}${release ? 'm' : 'M'}`
// The app draws a selection by adding SGR 7. Match that exactly: a colour such as '…;167m' also
// ends in "7m", and a looser test passed on the banner's gradient alone.
const inverted = (cell) => cell.style === '\x1b[0;7m' || cell.style.endsWith('\x1b[7m')

// 1. First screen: the welcome box, the input box, and the status line.
{
  const t = setup()
  const text = t.term.screen.text()
  check('start: fullscreen with mouse tracking', t.term.screen.state.altScreen && t.term.screen.state.mouse)
  check('start: the welcome box says the project, the model, the workspace and the session', text.includes('deepseek-bot') && text.includes('deepseek-v4.1') && /~\/dsh-agent · session tui-3f2a/.test(text), text.split('\n').filter((l) => l.includes('│')).slice(0, 6).join(' | '))
  check('start: the input box and the status line', text.includes('│ ›') && text.includes('▸▸ effort medium'))
}

// 1b. The workspace under the home directory is shown as ~, so a screen, or a recording of one, does
// not carry the account's path; the status keeps the real path, which file completion reads.
{
  const t = setup({ env: { COLORTERM: 'truecolor', HOME: '/Users/someone' } })
  t.app.setStatus({ workspace: '/Users/someone/dsh-agent' })
  t.clock.advance(20)
  let text = t.term.screen.text()
  check('workspace: under HOME, the welcome box shows ~', /~\/dsh-agent · /.test(text) && !text.includes('/Users/someone'), text.split('\n').find((l) => l.includes('dsh-agent')) ?? '(none)')
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

// 3. A streamed turn: the working indicator while running, text as it arrives, a dropped attempt, a tool step.
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
  check('stream: text appears as it streams, with no caret', streaming.includes('어제 스레드 기준으로') && !streaming.includes('▍'))
  check('stream: the status line shows what it is doing, for how long, and how to stop it', /✻ \S+… \(\d+s · esc to interrupt\)/.test(streaming))
  t.app.toolCall({ name: 'recall', title: '2 passages' })
  t.app.delta('staging 먼저.')
  t.app.final('staging 먼저, 그다음 production.')
  t.app.turnEnded()
  t.clock.advance(20)
  const done = t.term.screen.text()
  check('stream: a tool step appears between the two parts', done.includes('● Recall(2 passages)'))
  check('stream: the final text replaces the streamed text', done.includes('staging 먼저, 그다음 production.') && !done.includes('staging 먼저.▍'))
  check('stream: no working indicator after the turn', !done.includes('esc to interrupt'))
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
  check('choice: the request\'s first line, then its options numbered, one a row', /⚠ 권한이 필요합니다: rm -rf build/.test(asking) && /❯ 1\. 허용/.test(asking) && / {2}2\. 거부/.test(asking), asking.split('\n').slice(-6).join(' | '))
  check('choice: and the input box gives way to it while nothing is typed, as in Claude Code', !asking.includes('│ ›'), asking.split('\n').slice(-4).join(' | '))
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
  const at = t.term.screen.find('1. 허용')
  if (at !== null) { t.key(SGR(0, at.col + 1, at.row)); t.key(SGR(0, at.col + 1, at.row, true)) }
  check('choice: a click on an option picks it', t.actions[0] === 'a' && t.app.choice === null)
  t.app.offer('ts-3', [{ id: 'x', label: '허용' }])
  t.app.unpost('ts-3')
  check('choice: withdrawn with the message that offered it', t.app.choice === null)
  t.key('입력 중')
  t.app.offer('ts-4', [{ id: 'y', label: '허용' }])
  t.clock.advance(20)
  check('choice: with text typed, the input box stays, with the text', t.term.screen.text().includes('│ ›') && t.term.screen.text().includes('입력 중'))
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
  check('question: the input box gives way to the options', !asked.includes('│ ›'), asked.split('\n').slice(-4).join(' | '))
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

  t.app.ask('q-own', [{ id: 'own', question: '직접 쓸래?', options: [{ label: 'a' }], multiSelect: false }])
  t.key('\x1b[B'); t.key('\r'); t.clock.advance(20)
  check('question: "type your own…" chosen brings the input box back, empty, to type in', t.app.question?.typing === true && t.app.editor.text === '' && t.term.screen.text().includes('│ ›'), t.term.screen.text().split('\n').slice(-4).join(' | '))
  t.app.closeQuestion('q-own'); t.clock.advance(20)
  // Pasted words are the person's own words too: the question switches to them, and Enter answers with them.
  t.app.ask('q-paste', [{ id: 'p', question: '붙여 넣을래?', options: [{ label: 'a' }], multiSelect: false }])
  t.key('\x1b[200~붙여 넣은 답\x1b[201~'); t.clock.advance(20)
  check('question: a paste switches to typing, in the input box', t.app.question?.typing === true && t.app.editor.text === '붙여 넣은 답' && t.term.screen.text().includes('│ ›'))
  // A choice arriving while the question is being typed into leaves the box: the typing goes on.
  t.app.offer('ts-q', [{ id: 'z', label: '허용' }])
  t.key('\x15'); t.clock.advance(20)
  check('question: typing an answer keeps the input box even with a choice pending', t.app.question?.typing === true && t.app.editor.text === '' && t.term.screen.text().includes('│ ›'), t.term.screen.text().split('\n').slice(-4).join(' | '))
  t.key('붙여 넣은 답'); t.key('\r'); t.clock.advance(20)
  check('question: and Enter answers with the pasted words', t.answers.some((a) => a.id === 'q-paste' && a.answers[0]?.custom === '붙여 넣은 답'), JSON.stringify(t.answers.at(-1)))
  t.app.unpost('ts-q')

  t.app.ask('q-3', [{ id: 'skip-me', question: '건너뛸 질문', options: [{ label: 'a' }], multiSelect: false }])
  t.key('\x1b'); t.clock.advance(40)
  check('question: esc skips it, and the turn is not cancelled', JSON.stringify(t.answers[3]) === JSON.stringify({ id: 'q-3', answers: [{ id: 'skip-me', selected: [] }] }) && t.cancels === 0)

  t.app.ask('q-4', [{ id: 'click', question: '클릭으로 고르기', options: [{ label: '첫째' }, { label: '둘째' }], multiSelect: false }])
  t.clock.advance(20)
  const second = t.term.screen.find('둘째')
  t.key(SGR(0, second.col, second.row)); t.key(SGR(0, second.col, second.row, true))
  check('question: a click on an option answers it', JSON.stringify(t.answers[4]?.answers) === JSON.stringify([{ id: 'click', selected: ['둘째'] }]))

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
  check('narrow: a 50-column terminal gets the welcome words, not the mark cut', narrow.term.screen.text().includes('deepseek-bot') && !narrow.term.screen.text().includes('▄▄████▄▄'))
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
  // Thinking and tool steps: shown briefly; thinking in full on ctrl+t, tool output on ctrl+o.
  const t = setup({ rows: 40 })
  t.app.turnStarted()
  t.app.thinking('계획을 세우는 중\n둘째 생각\n셋째 생각\n넷째 생각')
  t.clock.advance(20)
  let screen = t.term.screen.text()
  check('thinking: shown while it streams, its latest lines', screen.includes('Thinking…') && screen.includes('넷째 생각') && !screen.includes('계획을 세우는 중'), screen.split('\n').slice(10, 20).join(' | '))
  t.app.delta('답을 씁니다')
  t.clock.advance(20)
  screen = t.term.screen.text()
  check('thinking: folded to one line once the answer starts', /Thought for /.test(screen) && !screen.includes('넷째 생각') && screen.includes('답을 씁니다'))
  t.key('\x14')   // ctrl+t
  t.clock.advance(20)
  screen = t.term.screen.text()
  check('ctrl+t: unfolds the thinking in full', screen.includes('계획을 세우는 중') && screen.includes('넷째 생각'))
  t.key('\x14')
  t.clock.advance(20)
  check('ctrl+t: and folds it again', !t.term.screen.text().includes('계획을 세우는 중'))

  t.app.toolCall({ name: 'str_replace_editor', callId: 'c1', title: 'str_replace /w/a.ts',
    diff: [{ path: '/w/a.ts', old: 'same one\nold value\nsame two', new: 'same one\nnew value\nsame two' }] })
  t.clock.advance(20)
  screen = t.term.screen.text()
  check('tools: the call shows its name and title', screen.includes('● str_replace_editor') && screen.includes('str_replace /w/a.ts'))
  check('tools: an edit shows what changed, not the lines around it', screen.includes('- old value') && screen.includes('+ new value') && !screen.includes('same one'), screen.split('\n').slice(-16).join(' | '))
  t.app.toolResult('c1', true, 'r1\nr2\nr3\nr4\nr5')
  t.clock.advance(20)
  screen = t.term.screen.text()
  check('tools: an edit\'s result is its diff: the tool\'s own words wait for ctrl+o', !screen.includes('r1') && screen.includes('Updated /w/a.ts'))
  t.key('\x0f')
  t.clock.advance(20)
  check('ctrl+o: unfolds the result too', t.term.screen.text().includes('r5'))
  t.key('\x0f')
  t.app.toolCall({ name: 'bash', callId: 'c2', title: 'false' })
  t.app.toolResult('c2', false, 'exit 1')
  t.app.toolResult('unknown', true, '아무 데도 안 붙음')
  t.clock.advance(20)
  screen = t.term.screen.text()
  check('tools: a failed result is shown, and one for an unknown call is dropped', screen.includes('⎿  Error: exit 1') && !screen.includes('아무 데도 안 붙음'))
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
  t.key('\x14')
  t.app.thinking(Array.from({ length: 600 }, (_, i) => `생각 ${i}`).join('\n'))
  t.clock.advance(20)
  check('thinking: unfolded past its limit, it says how much more there is', /… \+\d+ lines/.test(t.term.screen.text()))
  t.key('\x14')
  // A retried attempt drops its thinking even when its answer had begun.
  t.app.thinking('버려질 계획')
  t.app.delta('버려질 답')
  t.app.resetAttempt()
  t.clock.advance(20)
  screen = t.term.screen.text()
  check('thinking: a retry after the answer began drops the folded thinking too', !/Thought for /.test(screen) && !screen.includes('버려질 답'), screen.split('\n').slice(-14).join(' | '))
  // A thinking block from before a tool call belongs to a model call that succeeded: it stays.
  t.app.thinking('남을 계획')
  t.app.toolCall({ name: 'bash', callId: 'b1' })
  t.app.delta('다음 답')
  t.app.resetAttempt()
  t.clock.advance(20)
  check('thinking: the thinking of an earlier, finished step stays', /Thought for /.test(t.term.screen.text()))
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
// blue with a light passing over it, no rule between exchanges, and what waits shown as waiting.
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
  const first = styleAt('● Bash')
  t.clock.advance(480)
  const second = styleAt('● Bash')
  check('tool: the dot blinks while the tool runs', first !== null && second !== null && first !== second, `${first} / ${second}`)
  check('status: says which tool runs', t.term.screen.text().includes('Running bash…'))
  t.app.toolResult('c1', true, 'a.txt')
  t.clock.advance(20)
  check('tool: green once it succeeded', (styleAt('● Bash') ?? '').includes(OK), styleAt('● Bash'))
  t.app.toolCall({ name: 'grep', callId: 'c2', title: 'x' })
  t.app.toolResult('c2', false, 'no such file')
  t.clock.advance(20)
  check('tool: red once it failed', (styleAt('● Grep') ?? '').includes(DANGER), styleAt('● Grep'))
  t.app.toolCall({ name: 'fetch', callId: 'c3', title: 'https://example.com' })
  t.app.thinking('weighing the two options\n')
  t.clock.advance(20)
  const label = t.term.screen.find('✻ Thinking…')
  const styles = label === null ? new Set() : new Set(Array.from({ length: 9 }, (_, i) => cell(label.row, label.col + 2 + i).style))
  check('thinking: in sky blue, with a light passing over its label', label !== null && styles.size > 1 && [...styles].some((s) => String(s).includes(SKY)), [...styles].join(' | ').slice(0, 120))
  check('status: says it is thinking', /✻ Thinking… \(\d+s · esc to interrupt\)/.test(t.term.screen.row(t.term.screen.find('esc to interrupt')?.row ?? 0)))
  t.app.delta('The answer.')
  t.app.final('The answer.')
  t.app.turnEnded()
  t.clock.advance(20)
  check('answer: marked with a dot where it starts', t.term.screen.text().includes('● The answer.'))
  const lines = t.term.screen.text().split('\n')
  const answerAt = lines.findIndex((l) => l.includes('● The answer.'))
  check('steps: a blank line before the answer, and before each tool call', answerAt > 0 && lines[answerAt - 1].trim() === '' && lines[lines.findIndex((l) => l.includes('● Grep')) - 1].trim() === '', lines.slice(Math.max(0, answerAt - 2), answerAt + 1).join(' | '))
  const settled = styleAt('● Fetch')
  t.clock.advance(480)
  check('tool: a call left without a result stops blinking when the turn ends', settled !== null && settled === styleAt('● Fetch') && settled.includes(MUTED), settled)
  check('thinking: folded, it says what it was, in one colour', (() => { const at = t.term.screen.find('∴ Thought for'); return at !== null && cell(at.row, at.col + 2).style === cell(at.row, at.col + 8).style && cell(at.row, at.col + 2).style.includes(SKY) })())

  t.key('second question\r')
  t.clock.advance(20)
  const rows = t.term.screen.text().split('\n')
  const ruleAt = rows.findIndex((l) => /^ {2}─{20,}/.test(l))
  const secondAt = rows.findIndex((l) => l.includes('› second question'))
  check('rule: none between one exchange and the next, as in Claude Code and pi', ruleAt === -1 && secondAt !== -1, `${ruleAt} < ${secondAt}`)

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
  check('clear: after, nothing is queued and no old tool is named', !t.term.screen.text().includes('queued') && !t.term.screen.text().includes('Running bash'))
  t.app.turnStarted()
  t.clock.advance(20)
  // Checked while the first turn runs: its end would reset the tool anyway, and hide a clear() that did not.
  check('clear: the new conversation\'s first turn is working, not running the old one\'s tool', t.term.screen.text().includes('Working…') && !t.term.screen.text().includes('Running bash'))
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
  check('no colour: the thinking label is one style', (() => { const l = t.term.screen.find('✻ Thinking…'); return l !== null && new Set(Array.from({ length: 9 }, (_, i) => t.term.screen.grid[l.row * 60 + l.col + 2 + i].style)).size === 1 })())
  t.app.turnEnded()
}

// 70. The bottom of the screen. The input box keeps the last rows and a short conversation sits right above
// it, so nothing opens in the middle of an empty screen (it once followed the conversation down from the
// top, with the rest of the screen empty under it); /model and /sessions are pickers in the box's place;
// shift+tab steps the effort, shown where a permission label the gateway never sent ("▸▸ ask") used to
// be; and the mouse works on what the keys work on.
{
  const steps = []
  const t = setup({ cols: 80, rows: 40, extra: { stepEffort: () => steps.push(1) } })
  const box = () => { const prompt = t.term.screen.find('│ ›'); return prompt === null ? -1 : prompt.row - 1 }
  const info = t.term.screen.find('session tui-3f2a')?.row ?? -1
  const welcomeEnd = t.term.screen.find('╰')?.row ?? -1
  check('layout: the input box keeps the last rows, and a short conversation sits right above it', box() === 40 - 4 && info >= 0 && welcomeEnd === box() - 3, `info ${info}, welcome ends ${welcomeEnd}, box ${box()}`)
  check('layout: the empty rows are above the conversation, not between it and the box', t.term.screen.row(3).trim() === '', t.term.screen.row(3))
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
  check('picker: numbered rows, the current one marked and highlighted, at the bottom in the input box\'s place', first !== null && box() === -1 && first.row > 30 && /❯ 1\. og\/m1 +M one +✓/.test(t.term.screen.row(first.row)), `${t.term.screen.row(first?.row ?? 0)} @${first?.row} box ${box()}`)
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
  check('picker: and the input box is back in its rows', box() === 40 - 4, String(box()))
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
  // The completion row, the lowest /help on screen (the welcome box names it too).
  const shownRows = t.term.screen.text().split('\n')
  const helpRow = shownRows.findLastIndex((l) => l.includes('/help'))
  const help_ = { row: helpRow, col: shownRows[helpRow].indexOf('/help') }
  t.key(SGR(0, help_.col, help_.row)); t.key(SGR(0, help_.col, help_.row, true)); t.clock.advance(20)
  check('mouse: a click on one that takes none runs it', JSON.stringify(intercepted) === '["/help"]', JSON.stringify(intercepted))
}

// 72. Review of the pickers. A small screen keeps the hint line and the highlighted row (the picker has the
// input box's place); text being typed when a picker opens
// keeps ↵ and digits; the picker does not share the screen with the completion list or a history
// search; shift+tab steps the effort with the completion list open; a click in a tall input box does
// not scroll it; rows above the window are counted; numbers line up past nine.
{
  const many = Array.from({ length: 12 }, (_, i) => ({ label: `p/model-${i + 1}`, detail: `M${i + 1}` }))
  for (const rows of [16, 13]) {
    const small = setup({ cols: 80, rows })
    small.app.openPicker({ title: 'Model', rows: many, onPick: () => {} })
    small.clock.advance(20)
    check(`picker: on a screen ${rows} rows tall the hint line keeps the last row and the highlighted row shows`, small.term.screen.row(rows - 1).includes('↑↓ pick') && small.term.screen.text().includes('❯'), small.term.screen.text().split('\n').slice(-5).join(' | '))
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

// 73. Second review. A deployment whose models take no effort shows "takes no effort" on every row: its
// line was drawn and not counted. A crowded screen (interview strip, panel, approval) left the picker one
// or two rows, and it drew more. And with text in the box, every key but esc is the text's.
{
  const none = Array.from({ length: 12 }, (_, i) => ({ label: `p/model-${i + 1}`, detail: `M${i + 1}`, efforts: [] }))
  for (const rows of [15, 14]) {
    const t = setup({ cols: 80, rows })
    t.app.openPicker({ title: 'Model', rows: none, onPick: () => {} })
    t.clock.advance(20)
    check(`picker: models that take no effort, ${rows} rows: the hint line keeps the last row and the highlighted row shows`, t.term.screen.row(rows - 1).includes('↑↓ pick') && t.term.screen.text().includes('❯'), t.term.screen.text().split('\n').slice(-4).join(' | '))
    check(`picker: and the highlighted model says it takes none (${rows} rows)`, t.term.screen.text().includes('this model takes no effort'))
  }
  // 18 rows leave the picker three, 17 two, 16 one: the title and the effort line give way to the rows.
  for (const rows of [18, 17, 16]) {
    const crowd = setup({ cols: 80, rows })
    const now = crowd.clock.now()
    crowd.app.startInterview('topic')
    crowd.app.setPanel([{ id: 'c1', label: 'helper', mode: 'one-shot', status: 'running', since: now, settledMs: 0, tokens: 0 }], [{ id: 'bash-1', owner: 'root', kind: 'bash', label: 'sleep', status: 'running', startedAt: now, progress: '' }])
    crowd.app.offer('ts-1', [{ id: 'yes', label: 'yes' }, { id: 'no', label: 'no' }])
    crowd.app.openPicker({ title: 'Model', rows: none, onPick: () => {} })
    crowd.clock.advance(20)
    check(`picker: on a crowded screen (${rows} rows) the hint line keeps the last row and the highlighted row shows`, crowd.term.screen.row(rows - 1).includes('↑↓ pick') && crowd.term.screen.text().includes('❯'), crowd.term.screen.text().split('\n').slice(-5).join(' | '))
    check(`picker: and a row to pick is still shown (${rows} rows)`, /❯ +1\. p\/model-1 /.test(crowd.term.screen.text()))
  }

  const picked = []
  const t = setup({ cols: 80, rows: 40 })
  t.key('ab')
  t.app.openPicker({ title: 'Model', rows: [{ label: 'og/m1', current: true, efforts: ['low', 'high'], effort: 'low' }, { label: 'og/m2' }], onPick: (i, e) => picked.push([i, e]) })
  t.key('\x1b[D'); t.key('X'); t.clock.advance(20)
  check('picker: with text in the box, ← moves the cursor in the text, not the effort', t.app.editor.text === 'aXb' && /effort ◂ low ▸/.test(t.term.screen.text()), JSON.stringify(t.app.editor.text))
  t.key('\x1b[B'); t.clock.advance(20)
  check('picker: and ↓ is not the picker\'s', /❯ 1\. og\/m1/.test(t.term.screen.text()))
  t.key('\x1b'); t.clock.advance(40)
  check('picker: esc still closes it, and leaves the text', t.app.picker === null && t.app.editor.text === 'aXb' && picked.length === 0)
}

// 74. Words the core answers at once, without a turn (a stop, the usage word), are not queued behind the
// running turn. Queued, the usage word waited as the next turn's message, and when the turn ended the next
// real message's turn started under it. A stop also withdraws what waits, so that goes back to the box, as
// with esc. (An approval's yes or no is answered with its buttons here, which send no text.)
{
  const t = setup()
  t.app.setAnsweredAtOnce(['그만'], ['사용량'])
  t.app.turnStarted()
  t.clock.advance(20)
  t.key('사용량!\r'); t.clock.advance(20)
  t.key('다음 질문\r'); t.clock.advance(20)
  check('instant: a usage word while a turn runs is said at once; a real message waits', t.sent.includes('사용량!') && /\b1 queued\b/.test(t.term.screen.text()), t.term.screen.text().split('\n').filter((l) => /사용량|queued/.test(l)).join(' | '))
  // The real message's turn is queued in the gateway (its typing comes), then the running one ends.
  t.app.turnStarted()
  t.app.turnEnded()
  t.clock.advance(20)
  const users = t.term.screen.text().split('\n').filter((l) => /^ ?› /.test(l)).map((l) => l.trim())
  check('instant: the turn that starts next is the real message\'s', users.at(-1) === '› 다음 질문' && users.includes('› 사용량!'), JSON.stringify(users))
  t.app.turnEnded()

  const s = setup()
  s.app.setAnsweredAtOnce(['그만'], ['사용량'])
  s.app.turnStarted()
  s.key('하나 더\r'); s.key('그만\r'); s.clock.advance(20)
  check('instant: a typed stop is said at once, and what waited goes back to the box', s.sent.includes('그만') && s.app.editor.text === '하나 더' && !/queued/.test(s.term.screen.text()), JSON.stringify(s.app.editor.text))
}

// 75. ctrl+r searching what was typed keeps the input box, a choice pending or not, nothing typed yet and no history.
{
  const t = setup()
  t.app.offer('ts-r', [{ id: 'r', label: '허용' }])
  t.key('\x12'); t.clock.advance(20)
  check('search: ctrl+r keeps the input box while a choice is pending', t.app.editor.text === '' && t.term.screen.text().includes('│ ›') && t.term.screen.text().includes('history search'), t.term.screen.text().split('\n').slice(-4).join(' | '))
}

// 76. The transcript after Claude Code and pi. A tool call reads `Name(what it was asked)`; its result sits under
// `⎿`, summarised for reads and searches, the last lines of a shell's output, otherwise the first few, with
// "… +N lines (ctrl+o to expand)"; an edit says which file and how much changed, its lines on red and green;
// thinking folds to "Thought for Ns", opened by ctrl+t, apart from ctrl+o; a stop leaves "Interrupted"; and
// no rule between exchanges, no caret on the streaming text.
{
  const t = setup({ cols: 100, rows: 60 })
  t.app.turnStarted()
  t.app.thinking('첫째 생각\n둘째 생각')
  t.clock.advance(4200)
  t.app.thinking('\n셋째 생각')
  t.app.delta('답을 씁니다')
  t.clock.advance(20)
  const thought = t.term.screen.text()
  check('thinking: folded to "Thought for Ns", with the key that opens it', /∴ Thought for 4s \(ctrl\+t to expand\)/.test(thought) && !thought.includes('둘째 생각'), thought.split('\n').find((l) => l.includes('Thought')) ?? '(none)')
  check('stream: no caret on the text being streamed', !thought.includes('▍'))
  t.key('\x0f'); t.clock.advance(20)
  check('ctrl+o: does not open the thinking', !t.term.screen.text().includes('둘째 생각'))
  t.key('\x0f'); t.key('\x14'); t.clock.advance(20)
  check('ctrl+t: opens the thinking', t.term.screen.text().includes('둘째 생각') && t.term.screen.text().includes('셋째 생각'))
  t.key('\x14'); t.clock.advance(20)

  const read = Array.from({ length: 120 }, (_, i) => `${i + 1}\tline ${i + 1}`).join('\n')
  t.app.toolCall({ name: 'read', callId: 'r1', title: 'src/index.ts' })
  t.app.toolResult('r1', true, read)
  t.app.toolCall({ name: 'grep', callId: 'g1', title: 'TODO' })
  t.app.toolResult('g1', true, 'a.ts:1: TODO one\nb.ts:9: TODO two\nc.ts:3: TODO three')
  const out = Array.from({ length: 12 }, (_, i) => `out ${i + 1}`).join('\n')
  t.app.toolCall({ name: 'bash', callId: 'b1', title: 'npm test' })
  t.app.toolResult('b1', true, out)
  t.app.toolCall({ name: 'schedule_create', callId: 's1', title: 'water' })
  t.app.toolResult('s1', true, 'one\ntwo\nthree\nfour\nfive')
  t.app.toolCall({ name: 'bash', callId: 'b2', title: 'false' })
  t.app.toolResult('b2', false, 'command failed: exit 1')
  t.clock.advance(20)
  const tools = t.term.screen.text()
  const rowOf = (s) => tools.split('\n').find((l) => l.includes(s)) ?? '(none)'
  check('tool: a call reads Name(what it was asked)', /● Read\(src\/index\.ts\)/.test(tools) && /● Bash\(npm test\)/.test(tools) && /● Grep\(TODO\)/.test(tools), rowOf('index.ts'))
  check('tool: a read is one line under ⎿: how much was read', /⎿ {2}Read 120 lines/.test(tools) && !tools.includes('line 3'), rowOf('Read 120'))
  check('tool: a search says how much it found', /⎿ {2}Found 3 lines/.test(tools) && !tools.includes('TODO two'), rowOf('Found'))
  check('tool: a shell shows its last five lines, and how many came before', /… \+7 lines \(ctrl\+o to expand\)/.test(tools) && tools.includes('out 8') && tools.includes('out 12') && !tools.includes('out 7\n') && !/\bout 1\b/.test(tools), rowOf('+7 lines'))
  check('tool: anything else shows its first lines, then how many more', /⎿ {2}one/.test(tools) && tools.includes('three') && !tools.includes('four') && /… \+2 lines \(ctrl\+o to expand\)/.test(tools), rowOf('+2 lines'))
  check('tool: a failure says Error, in red', /⎿ {2}Error: command failed: exit 1/.test(tools), rowOf('Error'))
  t.key('\x0f'); t.clock.advance(20)
  const open = t.term.screen.text()
  check('ctrl+o: opens the tool output, all of it', /\bout 1\b/.test(open) && open.includes('four') && open.includes('line 3'))
  t.key('\x0f'); t.clock.advance(20)
  check('tool: a shell\'s folded output still sits under ⎿', /⎿ {2}… \+7 lines/.test(tools), rowOf('+7 lines'))
  t.key('\x14'); t.clock.advance(20)
  check('ctrl+t: leaves the tool output folded', !t.term.screen.text().includes('line 3') && /Read 120 lines/.test(t.term.screen.text()))
  t.key('\x14'); t.clock.advance(20)
  // A read cut before it reached the terminal: the count is the gateway's, from before the cut.
  t.app.toolCall({ name: 'read', callId: 'r2', title: 'src/long.ts' })
  t.app.toolResult('r2', true, 'cut text…', 300)
  // A long shell output opened: its end, where the error is, stays in view.
  t.app.toolCall({ name: 'bash', callId: 'b3', title: 'make' })
  t.app.toolResult('b3', true, Array.from({ length: 100 }, (_, i) => `make ${i + 1}`).join('\n'))
  // A shell that failed: its last lines, under a line saying it failed.
  t.app.toolCall({ name: 'bash', callId: 'b4', title: 'npm test' })
  t.app.toolResult('b4', false, [...Array.from({ length: 10 }, (_, i) => `log ${i + 1}`), 'assertion failed'].join('\n'))
  t.clock.advance(20)
  const more = t.term.screen.text()
  check('tool: a read counts the lines the gateway counted', /Read 300 lines/.test(more), more.split('\n').find((l) => l.includes('Read 3')) ?? '(none)')
  t.app.toolCall({ name: 'read', callId: 'r3', title: 'notes.md' })
  t.app.toolResult('r3', true, 'No results yet, says the file\nsecond line', 2)
  t.clock.advance(20)
  check('tool: a file that starts with "No results" is still read whole', /Read 2 lines/.test(t.term.screen.text()))
  check('tool: a failed shell shows its end, under Error', /⎿ {2}Error/.test(more) && more.includes('assertion failed') && !more.includes('log 1\n') && !/Error: log 1/.test(more), more.split('\n').filter((l) => /Error|assertion/.test(l)).join(' | '))
  t.key('\x0f'); t.clock.advance(20)
  check('ctrl+o: a long shell output opened keeps its last lines in view', t.term.screen.text().includes('make 100'), t.term.screen.text().split('\n').filter((l) => l.includes('make')).slice(-2).join(' | '))
  t.key('\x0f'); t.clock.advance(20)

  t.app.toolCall({ name: 'edit', callId: 'e1', title: 'src/a.ts', diff: [{ path: 'src/a.ts', old: 'const a = 1\nconst b = 2', new: 'const a = 10\nconst b = 2\nconst c = 3' }] })
  t.clock.advance(20)
  check('diff: not "Updated" before the edit has answered', !t.term.screen.text().includes('Updated src/a.ts'))
  t.app.toolResult('e1', true, 'edited')
  t.clock.advance(20)
  const edit = t.term.screen.text()
  check('diff: says which file, and how many lines came and went', /⎿ {2}Updated src\/a\.ts with 2 additions and 1 removal/.test(edit), edit.split('\n').find((l) => l.includes('Updated')) ?? '(none)')
  const plus = t.term.screen.find('+ const a = 10')
  const minus = t.term.screen.find('- const a = 1')
  check('diff: added lines on green, removed on red, the colour behind the text', plus !== null && minus !== null && /\x1b\[[0-9;]*48;2;/.test(t.term.screen.grid[plus.row * 100 + plus.col + 2].style) && /\x1b\[[0-9;]*48;2;/.test(t.term.screen.grid[minus.row * 100 + minus.col + 2].style) && t.term.screen.grid[plus.row * 100 + plus.col + 2].style !== t.term.screen.grid[minus.row * 100 + minus.col + 2].style, `${plus?.row} ${minus?.row}`)
  t.app.toolCall({ name: 'edit', callId: 'e2', title: 'src/b.ts', diff: [{ path: 'src/b.ts', old: 'x', new: 'y' }] })
  t.app.toolResult('e2', false, 'old_string not found in src/b.ts')
  t.clock.advance(20)
  check('diff: an edit that failed is not "Updated"', !t.term.screen.text().includes('Updated src/b.ts') && /Error: old_string not found/.test(t.term.screen.text()))
  t.app.final('끝')
  t.app.turnEnded()
  t.key('다음 질문'); t.key('\r'); t.clock.advance(20)
  t.key('그다음 질문'); t.key('\r'); t.clock.advance(20)
  t.app.turnStarted()
  t.clock.advance(20)
  const between = t.term.screen.text().split('\n')
  check('exchanges: no rule between one and the next (only the divider, from the edge)', !between.some((l) => /^ {2}─{10,}/.test(l)), between.filter((l) => l.includes('────')).join(' | '))
  t.app.delta('길게 쓰는 중')
  t.key('\x1b'); t.clock.advance(60)
  check('stop: a stopped turn says Interrupted, in red', /⎿ {2}Interrupted/.test(t.term.screen.text()), t.term.screen.text().split('\n').filter((l) => l.includes('Interrupted')).join(' | '))
  t.key('\x1b'); t.clock.advance(60)
  check('stop: once, however many times esc is pressed', t.term.screen.text().split('Interrupted').length - 1 === 1)
  t.app.turnEnded()
  // A message sent behind a stopped turn starts its own turn when that one ends: stopped in turn, it is marked too.
  const marks = () => t.term.screen.text().split('Interrupted').length - 1
  t.app.turnStarted()
  t.key('\x1b'); t.clock.advance(60)
  t.key('second\r'); t.clock.advance(20)
  t.app.turnStarted()
  t.app.turnEnded()
  t.key('\x1b'); t.clock.advance(60)
  check('stop: a turn that started behind a stopped one is marked when stopped too', marks() === 3, String(marks()))
  t.app.turnEnded()
  // A stop that withdraws a waiting message: the waiting one's end comes first, and the stopped turn is still the
  // same turn — esc again does not mark it twice.
  t.app.turnStarted()
  t.key('queued\r'); t.clock.advance(20)
  t.app.turnStarted()
  t.key('\x1b'); t.clock.advance(60)
  t.app.turnEnded()
  t.key('\x1b'); t.clock.advance(60)
  check('stop: a waiting message withdrawn first does not let the stopped turn be marked twice', marks() === 4, String(marks()))
  t.app.turnEnded()
  // A stop typed as a word marks the turn too.
  t.app.setAnsweredAtOnce(['stop'], [])
  t.app.turnStarted()
  t.key('\x15'); t.key('stop'); t.key('\r'); t.clock.advance(20)
  check('stop: a typed stop marks the turn Interrupted too', t.term.screen.text().split('Interrupted').length - 1 === 5)
  t.app.turnEnded()
}

// 76b. In 256 colours an edit's added and removed lines are still green and red behind the text.
{
  const t = setup({ cols: 80, rows: 30, env: { TERM: 'xterm-256color' } })
  t.app.turnStarted()
  t.app.toolCall({ name: 'edit', callId: 'e', title: 'a.ts', diff: [{ path: 'a.ts', old: 'old', new: 'new' }] })
  t.app.toolResult('e', true, 'ok')
  t.clock.advance(20)
  const plus = t.term.screen.find('+ new')
  const minus = t.term.screen.find('- old')
  const bg = (at) => (at === null ? '' : t.term.screen.grid[at.row * 80 + at.col + 2].style)
  check('diff: 256 colours, green and red behind the lines', /48;5;22m/.test(bg(plus)) && /48;5;52m/.test(bg(minus)), `${JSON.stringify(bg(plus))} ${JSON.stringify(bg(minus))}`)
  // A row wider than the screen wraps; copied, it is the line as written, without the colour's padding.
  const long = Array.from({ length: 10 }, (_, i) => `abcdefgh${i}`).join(' ')
  t.app.toolCall({ name: 'edit', callId: 'w', title: 'b.ts', diff: [{ path: 'b.ts', old: 'x', new: long }] })
  t.app.toolResult('w', true, 'ok')
  t.clock.advance(20)
  const from = t.term.screen.find('+ abcdefgh0')
  const to = t.term.screen.find('abcdefgh9')
  if (from !== null && to !== null) { t.key(SGR(0, from.col, from.row)); t.key(SGR(32, to.col + 9, to.row)); t.key(SGR(0, to.col + 9, to.row, true)) }
  t.clock.advance(20)
  check('diff: a wrapped row copies as one line, no padding in it', t.copied.at(-1) === `+ ${long}`, JSON.stringify(t.copied.at(-1)))
  t.app.turnEnded()
}

// 77. Working, approvals and hints after Claude Code. One indicator while a turn runs, with the time and the key that
// stops it; an approval's options answered by number, and esc answers no; the hint line is "? for shortcuts", and
// ? on an empty box shows them.
{
  const t = setup({ cols: 100, rows: 30 })
  t.app.turnStarted()
  t.clock.advance(3200)
  const running = t.term.screen.text()
  const statusRow = running.split('\n').find((l) => l.includes('✻')) ?? '(none)'
  check('working: one indicator, the time and how to stop it', /✻ Working… \(3s · esc to interrupt\)/.test(statusRow), statusRow)
  check('working: no second spinner and no effort label while it runs', !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(running) && !statusRow.includes('▸▸'), statusRow)
  t.app.thinking('생각 중')
  t.clock.advance(20)
  check('working: thinking says so', /✻ Thinking… \(3s · esc to interrupt\)/.test(t.term.screen.text()), t.term.screen.text().split('\n').find((l) => l.includes('✻ Thinking')) ?? '(none)')

  t.app.message('ts-a', '권한이 필요합니다: rm -rf build\n세부 내용', null, false)
  t.app.offer('ts-a', [{ id: 'approval:allow:k', label: 'Allow', style: 'primary' }, { id: 'approval:deny:k', label: 'Deny', style: 'danger' }])
  t.clock.advance(20)
  t.key('2')
  check('approval: a digit picks that option', t.actions.at(-1) === 'approval:deny:k' && t.app.choice === null, JSON.stringify(t.actions))
  t.app.offer('ts-a', [{ id: 'approval:allow:k2', label: 'Allow', style: 'primary' }, { id: 'approval:deny:k2', label: 'Deny', style: 'danger' }])
  t.clock.advance(20)
  check('approval: the hint line says the keys', /↑↓ .*1–2 .*↵ .*esc deny/.test(t.term.screen.row(29)), t.term.screen.row(29))
  t.key('\x1b'); t.clock.advance(60)
  check('approval: esc answers no, and the turn goes on', t.actions.at(-1) === 'approval:deny:k2' && t.cancels === 0 && t.app.choice === null, JSON.stringify({ actions: t.actions, cancels: t.cancels }))
  t.app.offer('ts-a', [{ id: 'approval:allow:k3', label: 'Allow' }, { id: 'approval:deny:k3', label: 'Deny' }])
  t.key('\x1b[B'); t.key('\r')
  check('approval: ↓ and Enter pick the next one', t.actions.at(-1) === 'approval:deny:k3', JSON.stringify(t.actions))
  // ↑ moves through the options too: it used to bring back the last message sent, which Enter then sent again.
  t.key('지난 메시지'); t.key('\r'); t.clock.advance(20)
  const sentBefore = t.sent.length
  t.app.offer('ts-a', [{ id: 'approval:allow:k4', label: 'Allow' }, { id: 'approval:deny:k4', label: 'Deny' }])
  t.key('\x1b[B'); t.key('\x1b[A'); t.key('\r')
  check('approval: ↑ moves through the options, not the history', t.actions.at(-1) === 'approval:allow:k4' && t.sent.length === sentBefore && t.app.editor.text === '', JSON.stringify({ actions: t.actions.slice(-1), sent: t.sent.slice(sentBefore) }))
  t.app.turnEnded()
  t.clock.advance(20)

  check('hint: "? for shortcuts" while nothing is typed', /^ \? for shortcuts( {2,}~\/dsh-agent · tui-3f2a…)?\s*$/.test(t.term.screen.row(29)), t.term.screen.row(29))
  t.key('?'); t.clock.advance(20)
  const panel = t.term.screen.text()
  check('shortcuts: ? on an empty box shows them, in the box\'s place', panel.includes('Shortcuts') && panel.includes('shift+tab effort') && panel.includes('ctrl+t expand/fold thinking') && !panel.includes('│ ›') && t.app.editor.text === '', panel.split('\n').slice(-8).join(' | '))
  t.key('\x1b'); t.clock.advance(60)
  check('shortcuts: esc closes them', !t.term.screen.text().includes('Shortcuts') && t.term.screen.text().includes('│ ›'))
  t.key('?'); t.key('a'); t.clock.advance(20)
  check('shortcuts: typing closes them and types', t.app.editor.text === 'a' && !t.term.screen.text().includes('Shortcuts'), JSON.stringify(t.app.editor.text))
  t.key('?'); t.clock.advance(20)
  check('shortcuts: ? in text being typed is a question mark', t.app.editor.text === 'a?')
}

// 77b. What review found in 77. An approval is answered only where it is seen and only by the keys the hint names;
// esc is "no" only when nothing else (a selection) is what it would close; the status line does not offer esc
// for a stop it will not do; the time is the running turn's own; and the shortcuts fit the screen.
{
  const t = setup({ cols: 100, rows: 30 })
  const en = messages('en')
  const allowDeny = (k) => [{ id: `approval:allow:${k}`, label: 'Allow', style: 'primary' }, { id: `approval:deny:${k}`, label: 'Deny', style: 'danger' }]
  t.app.turnStarted()
  t.app.message('ts-b', `${en.approvalNeeded('rm -rf build')}\n${en.approvalHowTerminal}`, null, false)
  t.app.offer('ts-b', allowDeny('b1')); t.clock.advance(20)
  // The last line that says so: the transcript has the message too, above.
  const title = t.term.screen.text().split('\n').filter((l) => l.includes('I need permission')).at(-1) ?? '(none)'
  check('approval: the adapter\'s own request, with one warning sign', /⚠ I need permission: rm -rf build/.test(title) && (title.match(/⚠/g) ?? []).length === 1, title)
  // The status line, not the screen: the welcome box names esc too.
  const statusLine = () => t.term.screen.text().split('\n').find((l) => l.includes('✻')) ?? '(none)'
  check('approval: the status line does not offer esc for a stop while esc answers no', !statusLine().includes('esc to interrupt') && /esc deny/.test(t.term.screen.row(29)), statusLine())
  check('approval: what the message tells the person is how it is answered here', /↑↓/.test(en.approvalHowTerminal) && !/←→/.test(en.approvalHowTerminal), en.approvalHowTerminal)

  // A question over it: the digit that starts an answer is the answer's.
  t.app.ask('q-b', [{ id: 'n', question: 'How many replicas?', options: [{ label: 'three' }], multiSelect: false }])
  t.key('1'); t.clock.advance(20)
  check('approval: a digit typed into a question never answers the approval under it', t.actions.length === 0 && t.app.choice !== null && t.app.editor.text === '1', JSON.stringify({ actions: t.actions, text: t.app.editor.text }))
  t.key('\r'); t.clock.advance(20)
  // A picker over it: a digit with no row of its own closes it and is text, not the approval's.
  t.app.openPicker({ title: 'Model', rows: [{ label: 'm1' }], onPick: () => {} }); t.clock.advance(20)
  t.key('2'); t.clock.advance(20)
  check('approval: a digit that closes a picker over it is text, not an answer', t.actions.length === 0 && t.app.choice !== null && t.app.editor.text === '2', JSON.stringify({ actions: t.actions, text: t.app.editor.text }))
  t.app.editor.set(''); t.clock.advance(20)

  // A selection: esc clears it, as it does anywhere, and the approval waits.
  const at = t.term.screen.find('rm -rf build')
  t.key(SGR(0, at.col, at.row)); t.key(SGR(32, at.col + 6, at.row)); t.key(SGR(0, at.col + 6, at.row, true))
  t.key('\x1b'); t.clock.advance(60)
  check('approval: esc with text selected clears the selection, and answers nothing', t.actions.length === 0 && t.app.choice !== null && t.cancels === 0 && t.term.screen.grid.filter(inverted).length === 0, JSON.stringify({ actions: t.actions, cancels: t.cancels }))
  // Each half of what makes an option "no": its style, or its id.
  t.key('\x1b'); t.clock.advance(60)
  check('approval: esc answers no', t.actions.at(-1) === 'approval:deny:b1', JSON.stringify(t.actions))
  t.app.offer('ts-b', [{ id: 'approval:allow:b2', label: 'Allow' }, { id: 'approval:refuse:b2', label: 'Refuse', style: 'danger' }]); t.key('\x1b'); t.clock.advance(60)
  check('approval: "no" by its danger style alone', t.actions.at(-1) === 'approval:refuse:b2', JSON.stringify(t.actions.at(-1)))
  t.app.offer('ts-b', [{ id: 'approval:allow:b3', label: 'Allow' }, { id: 'approval:deny:b3', label: 'Deny' }]); t.key('\x1b'); t.clock.advance(60)
  check('approval: "no" by its id alone', t.actions.at(-1) === 'approval:deny:b3', JSON.stringify(t.actions.at(-1)))
  // A choice with no "no": the hint does not promise one, and esc is the turn's stop, as the status line says.
  t.app.offer('ts-b', [{ id: 'pick:a', label: 'A' }, { id: 'pick:b', label: 'B' }]); t.clock.advance(20)
  check('choice: with no "no" option the hint does not say esc denies', !/esc deny/.test(t.term.screen.row(29)) && statusLine().includes('esc to interrupt'), `${t.term.screen.row(29)} | ${statusLine()}`)
  // ↑ alone, from the first of three, goes to the last: back, not forward. Shift with ↓ is still ↓.
  t.app.offer('ts-b', [{ id: 'o:1', label: 'One' }, { id: 'o:2', label: 'Two' }, { id: 'o:3', label: 'Three' }]); t.clock.advance(20)
  t.key('\x1b[A')
  check('choice: ↑ goes back', t.app.choice?.index === 2, String(t.app.choice?.index))
  t.key('\x1b[1;2B')
  check('choice: shift+↓ goes forward, as ↓ does', t.app.choice?.index === 0, String(t.app.choice?.index))
  t.app.offer('ts-b', Array.from({ length: 12 }, (_, i) => ({ id: `o:${i}`, label: `Option ${i + 1}` }))); t.clock.advance(20)
  check('choice: the digits named are the ones that work, 1–9', /1–9 pick/.test(t.term.screen.row(29)), t.term.screen.row(29))
  t.app.offer('ts-b', [{ id: 'o:only', label: 'OK' }]); t.clock.advance(20)
  check('choice: one option, no range of digits', !/1–1/.test(t.term.screen.row(29)) && /↵ choose/.test(t.term.screen.row(29)), t.term.screen.row(29))
  // A message whose first line is blank still has a title, and a long one is cut with an ellipsis.
  t.app.message('ts-c', `\n${en.approvalNeeded('x'.repeat(200))}`, null, false)
  t.app.offer('ts-c', allowDeny('c1')); t.clock.advance(20)
  const long = t.term.screen.text().split('\n').filter((l) => l.includes('I need permission')).at(-1) ?? '(none)'
  check('approval: the first line with words is the title, cut with …', /⚠ I need permission: x+…/.test(long), long.slice(0, 60))
  t.key('1')

  // Something that arrives while the shortcuts are open closes them; the panel, when it had the keys, gives them back.
  t.app.turnEnded(); t.clock.advance(20)
  t.key('?'); t.clock.advance(20)
  t.app.offer('ts-b', allowDeny('b4')); t.clock.advance(20)
  check('shortcuts: an approval closes them', !t.term.screen.text().includes('Shortcuts') && /esc deny/.test(t.term.screen.row(29)), t.term.screen.row(29))
  t.key('1'); t.clock.advance(20)
  t.app.setPanel([{ id: 'a', label: 'idle a', mode: 'one-shot', status: 'idle', since: null, settledMs: 0, tokens: 0 }], [])
  t.key('\t'); t.clock.advance(20)
  const focused = t.app.focus
  t.app.offer('ts-b', allowDeny('b5')); t.clock.advance(20)
  check('approval: one arriving while the panel has the keys takes them', focused === 'panel' && t.app.focus === 'editor', `${focused} → ${t.app.focus}`)
  t.key('\r')
  check('approval: and ↵ answers it', t.actions.at(-1) === 'approval:allow:b5', JSON.stringify(t.actions.at(-1)))
  t.key('\t'); t.clock.advance(20)
  t.key('?'); t.clock.advance(20)
  check('shortcuts: ? with the panel focused does not open them', !t.term.screen.text().includes('Shortcuts'), String(t.app.focus))
  t.app.editor.set(''); t.app.setPanel([], []); t.clock.advance(20)

  // Two turns, the second queued by another terminal: the time is the second's own from its start.
  t.app.turnStarted(); t.app.turnStarted()
  t.clock.advance(15000)
  t.app.turnEnded()
  t.clock.advance(2200)
  const second = t.term.screen.text().split('\n').find((l) => l.includes('✻')) ?? '(none)'
  check('working: the next turn\'s time starts at its start', /\(2s · esc to interrupt\)/.test(second), second)
  // shift+tab while a turn runs: the effort label is hidden, so the step says itself.
  // A terminal that attaches mid-turn learns the effort; nothing was stepped.
  t.app.setStatus({ effort: 'low' }); t.clock.advance(20)
  check('working: the effort learned while a turn runs is not called a step', !t.term.screen.text().includes('from the next turn'), t.term.screen.text().split('\n').find((l) => l.includes('✻')))
  t.app.effortStepped('high'); t.clock.advance(20)
  check('working: an effort step while a turn runs is shown', t.term.screen.text().includes('effort high from the next turn'), t.term.screen.text().split('\n').find((l) => l.includes('✻')))
  t.app.turnEnded(); t.clock.advance(20)
  // A stop withdraws the turn waiting behind it; its end is not a next turn's start, and the end of the stopped
  // one is: a turn queued after the stop has its own time.
  t.app.turnStarted(); t.app.turnStarted()
  t.clock.advance(4000)
  t.key('\x1b'); t.clock.advance(60)
  t.app.turnEnded()
  t.clock.advance(1000)
  const stopped = t.term.screen.text().split('\n').find((l) => l.includes('✻')) ?? '(none)'
  check('working: the end of a turn a stop withdrew does not restart the stopped turn\'s time', /\(5s/.test(stopped), stopped)
  t.app.turnStarted()
  t.clock.advance(10000)
  t.app.turnEnded()
  t.clock.advance(1200)
  const after = t.term.screen.text().split('\n').find((l) => l.includes('✻')) ?? '(none)'
  check('working: after a withdrawn turn, the turn queued next has its own time', /\(1s · esc to interrupt\)/.test(after), after)
  t.app.turnEnded(); t.clock.advance(20)
  // The link drops between a stop and the withdrawn turn's end: the gateway's count on reconnect is the truth,
  // and a turn queued after it starts with its own time.
  t.app.turnStarted(); t.app.turnStarted()
  t.key('\x1b'); t.clock.advance(60)
  t.app.setBusy(1)
  t.app.turnStarted()
  t.clock.advance(6000)
  t.app.turnEnded()
  t.clock.advance(1200)
  const reconnected = t.term.screen.text().split('\n').find((l) => l.includes('✻')) ?? '(none)'
  check('working: a reconnect forgets the turns a stop withdrew', /\(1s · esc to interrupt\)/.test(reconnected), reconnected)
  // The panel has the keys: esc gives them back to the input and stops nothing, so the line does not offer it.
  t.app.setPanel([{ id: 'a', label: 'idle a', mode: 'one-shot', status: 'idle', since: null, settledMs: 0, tokens: 0 }], [])
  t.key('\t'); t.clock.advance(20)
  const panelled = t.term.screen.text().split('\n').find((l) => l.includes('✻')) ?? '(none)'
  check('working: with the panel focused, no "esc to interrupt"', t.app.focus === 'panel' && !panelled.includes('esc to interrupt'), `${t.app.focus} ${panelled}`)
  t.key('\x1b'); t.clock.advance(60); t.app.setPanel([], [])
  // Text selected: esc clears it first, so the line does not offer a stop either.
  const word = t.term.screen.find('I need permission')
  t.key(SGR(0, word.col, word.row)); t.key(SGR(32, word.col + 6, word.row)); t.key(SGR(0, word.col + 6, word.row, true)); t.clock.advance(20)
  const selecting = t.term.screen.text().split('\n').find((l) => l.includes('✻')) ?? '(none)'
  check('working: with text selected, no "esc to interrupt"', !selecting.includes('esc to interrupt'), selecting)
  t.key('\x1b'); t.clock.advance(60)
  t.app.turnEnded(); t.clock.advance(20)
  // A first line that is the warning sign alone: the title is the next line with words.
  t.app.message('ts-d', '⚠️\nI need permission: ls', null, false)
  t.app.offer('ts-d', allowDeny('d1')); t.clock.advance(20)
  const lone = t.term.screen.text().split('\n').filter((l) => l.includes('⚠')).at(-1) ?? '(none)'
  check('approval: a sign alone on the first line is skipped', /⚠ I need permission: ls/.test(lone), lone)
  t.key('2'); t.clock.advance(20)
}

// 77c. The shortcuts in as many columns as fit, and no more rows than the screen has.
{
  const wide = setup({ cols: 100, rows: 30 })
  wide.key('?'); wide.clock.advance(20)
  const lines = wide.term.screen.text().split('\n')
  const start = lines.findIndex((l) => l.includes('Shortcuts'))
  const shown = lines.slice(start + 1).findIndex((l) => l.trim() === '' || /esc close/.test(l))
  check('shortcuts: in columns as wide as their own items, five rows at 100 columns', start !== -1 && shown > 0 && shown <= 5, `${shown} rows`)
  const small = setup({ cols: 40, rows: 14 })
  small.key('?'); small.clock.advance(20)
  const text = small.term.screen.text()
  check('shortcuts: on a small screen they stop above the hint, and say how many are not shown', /esc close/.test(small.term.screen.row(13)) && /\+\d+ more/.test(text) && text.includes('Shortcuts'), text.split('\n').slice(-8).join(' | '))
  // No header row in the main view: one more row for them than a pane with a header has.
  const tiny = setup({ cols: 40, rows: 5 })
  tiny.key('?'); tiny.clock.advance(20)
  const none = setup({ cols: 40, rows: 4 })
  none.key('?'); none.clock.advance(20)
  check('shortcuts: with no room, nothing, and the hint stays', /esc close/.test(none.term.screen.row(3)) && !none.term.screen.text().includes('Shortcuts'), none.term.screen.text().split('\n').join(' | '))
  check('shortcuts: with room for one line, the title alone, and the hint stays', /esc close/.test(tiny.term.screen.row(4)) && tiny.term.screen.text().includes('Shortcuts') && !/\+\d+ more/.test(tiny.term.screen.text()), tiny.term.screen.text().split('\n').join(' | '))
}

// 78. The first screen and the footer after Claude Code and pi. No header row over the conversation: a welcome box
// says what this is (the mark, the version), what it runs on, where, and the keys to start with. The context bar
// turns yellow past 70% and red past 90%; tokens read as sent ↑ and received ↓.
{
  const t = setup({ cols: 100, rows: 30, extra: { version: '0.2.0' } })
  const first = t.term.screen.text()
  const rows = first.split('\n')
  check('welcome: no header row over the conversation', !/^ deepseek-bot\s{4,}/.test(rows[0]) && !rows[0].includes('tui-3f2a9c1e'), rows[0])
  check('welcome: a box with the mark, the name and version, the model, the workspace and where to start', first.includes('╭') && first.includes('▄▄████▄▄') && /deepseek-bot v0\.2\.0/.test(first) && first.includes('deepseek-v4.1') && first.includes('~/dsh-agent') && /\/help/.test(first) && /\? for shortcuts/.test(first), rows.filter((r) => r.trim() !== '').slice(0, 9).join(' | '))
  check('welcome: no block-letter banner', !first.includes('██████╗'))
  const narrow = setup({ cols: 50, rows: 24, extra: { version: '0.2.0' } })
  const small = narrow.term.screen.text()
  check('welcome: on a narrow screen, the words without the mark, the box closed', /deepseek-bot v0\.2\.0/.test(small) && !small.includes('▄▄████▄▄') && (small.split('\n').find((l) => l.includes('╭')) ?? '').includes('╮'), small.split('\n').filter((r) => r.trim() !== '').slice(0, 6).join(' | '))
  const tiny = setup({ cols: 20, rows: 16, extra: { version: '0.2.0' } }).term.screen.text()
  check('welcome: too narrow for a box, the words alone', /^ deepseek-bot/m.test(tiny) && !tiny.includes('│ deep'), tiny.split('\n').filter((r) => r.trim() !== '').slice(0, 5).join(' | '))
  const at = (needle) => { const p = t.term.screen.find(needle); return p === null ? '' : t.term.screen.grid[p.row * 100 + p.col].style }
  t.app.setStatus({ contextPct: 50, tokensIn: 12000, tokensOut: 3400 })
  t.clock.advance(20)
  const calm = at('ctx ')
  check('footer: tokens as sent and received', /↑12(\.0)?k ↓3\.4k/.test(t.term.screen.text()), t.term.screen.text().split('\n').find((l) => l.includes('ctx')) ?? '(none)')
  t.app.setStatus({ contextPct: 75 })
  t.clock.advance(20)
  const warm = at('ctx ')
  t.app.setStatus({ contextPct: 95 })
  t.clock.advance(20)
  const hot = at('ctx ')
  check('footer: the context bar turns yellow past 70% and red past 90%', calm !== warm && warm !== hot && warm.includes('38;2;242;176;61') && hot.includes('38;2;240;90;90'), `${JSON.stringify(calm)} ${JSON.stringify(warm)} ${JSON.stringify(hot)}`)
  t.app.setStatus({ contextPct: null })
  t.app.setStatus({ tokensIn: 12000, tokensOut: 3400, tokensCached: 9000 }); t.clock.advance(20)
  check('footer: the share of what was sent that the cache served', /↑12(\.0)?k ↓3\.4k · cache 75%/.test(t.term.screen.text()), t.term.screen.text().split('\n').find((l) => l.includes('↑12')) ?? '(none)')
  t.app.setStatus({ tokensCached: null }); t.clock.advance(20)
  check('footer: and nothing about the cache when the harness does not say', !t.term.screen.text().includes('cache'))
  t.app.setStatus({ tokens: 1050, tokensIn: 1000, tokensOut: 50 }); t.clock.advance(20)
  check('footer: with the split, no total beside it', /↑1\.0k ↓50/.test(t.term.screen.text()) && !/ tok\b/.test(t.term.screen.text()), t.term.screen.text().split('\n').find((l) => l.includes('↑')) ?? '(none)')
  t.app.setStatus({ tokens: 0, tokensIn: 0, tokensOut: 0 }); t.clock.advance(20)
  check('footer: nothing sent yet, no ↑0 ↓0', !t.term.screen.text().includes('↑0'), t.term.screen.text().split('\n').find((l) => l.includes('ctx') || l.includes('↑')) ?? '(none)')
  // 80 columns while a turn runs: what does not fit goes whole, from the right; nothing is cut mid-figure.
  const tight = setup({ cols: 80, rows: 24 })
  tight.app.turnStarted(); tight.app.thinking('생각'); tight.clock.advance(12000)
  tight.app.setStatus({ contextPct: 52, tokensIn: 1_200_000, tokensOut: 34_600, tokensCached: 900_000 }); tight.clock.advance(20)
  // The status line: the row over the input box's top border.
  const busyLine = tight.term.screen.row((tight.term.screen.find('│ ›')?.row ?? 2) - 2)
  check('footer: on a narrow line whole parts go, never half a figure', busyLine.includes('ctx ▰▰▰▰▱▱▱▱ 52%') && busyLine.includes('↑1.2M ↓34.6k') && (!busyLine.includes('cache') || busyLine.includes('cache 75%')), busyLine)
  // Dragging to the top row selects past the screen's top, as it does under a header.
  const tall = setup({ cols: 80, rows: 20 })
  tall.app.final(Array.from({ length: 60 }, (_, i) => `L-${String(i + 1).padStart(2, '0')}`).join('\n\n')); tall.clock.advance(20)
  const firstShown = Number(/L-(\d+)/.exec(tall.term.screen.text())?.[1] ?? 0)
  const from = tall.term.screen.find('L-60')
  tall.key(SGR(0, from.col, from.row))
  // A terminal reports a cell once: up into the top row, down out of it, and up again.
  for (let i = 0; i < 10; i++) { tall.key(SGR(32, 2, 1)); tall.key(SGR(32, 2, 0)) }
  tall.key(SGR(0, 2, 0, true)); tall.clock.advance(20)
  const above = `L-${String(firstShown - 2).padStart(2, '0')}`
  check('drag: to the top row it scrolls up and selects what was above the screen', firstShown > 3 && (tall.copied.at(-1) ?? '').includes(above), `${above} in ${JSON.stringify((tall.copied.at(-1) ?? '').slice(0, 40))}`)
  // Along the top row it selects the words under it, and scrolls nothing.
  const row0 = setup({ cols: 80, rows: 20 })
  for (let i = 1; i <= 60; i++) row0.app.notice(`alpha beta gamma delta ${i}`)
  row0.clock.advance(20)
  const top = row0.term.screen.row(0)
  const col = top.indexOf('alpha')
  row0.key(SGR(0, col, 0))
  for (let x = col + 1; x <= col + 10; x++) row0.key(SGR(32, x, 0))
  row0.key(SGR(0, col + 10, 0, true)); row0.clock.advance(20)
  check('drag: along the top row, the words under it, nothing scrolled', col !== -1 && row0.copied.at(-1) === 'alpha beta', `${JSON.stringify(top.slice(0, 40))} → ${JSON.stringify(row0.copied.at(-1))}`)
  // Under the box, as pi has it: where the agent works, and the conversation; the branch when it is a repository.
  check('footer: under the box, the workspace and the conversation', /\? for shortcuts {2,}.*~\/dsh-agent · tui-3f2a…\s*$/.test(t.term.screen.row(29)), t.term.screen.row(29))
  // The branch is read from the real path, not the one shown with ~.
  const git = setup({ cols: 100, rows: 30, env: { COLORTERM: 'truecolor', HOME: '/home' }, extra: { branchOf: (dir) => dir === '/home/agent' ? 'main' : null } })
  git.app.setStatus({ workspace: '/home/agent' }); git.clock.advance(20)
  check('footer: with the branch when the workspace is a repository', /~\/agent \(main\) · tui-3f2a…\s*$/.test(git.term.screen.row(29)), git.term.screen.row(29))
  // In a subagent's view the header says where the pane looks; the footer would say it again.
  git.app.setPanel([{ id: 'child-1', label: 'research', mode: 'one-shot', status: 'running', since: null, settledMs: 0, tokens: 0 }], [])
  git.key('\t'); git.key('\x1b[B'); git.key('\r'); git.clock.advance(20)
  check('footer: only in the conversation\'s own view', git.app.view.kind === 'agent' && !git.term.screen.row(29).includes('(main)'), `${git.app.view.kind} ${git.term.screen.row(29)}`)
  const thin = setup({ cols: 40, rows: 20 })
  check('footer: left out where it does not fit beside the hint', /\? for shortcuts\s*$/.test(thin.term.screen.row(19)), thin.term.screen.row(19))
  // The status line's label: a tool step with no result to wait for is over once the answer streams.
  t.app.turnStarted()
  t.app.toolCall({ name: 'recall', title: '2 passages' })
  t.app.delta('답을 씁니다'); t.clock.advance(20)
  const label = t.term.screen.text().split('\n').find((l) => l.includes('✻')) ?? '(none)'
  check('working: once the answer streams, it says Working, not the last tool', /✻ Working…/.test(label) && !label.includes('Running recall'), label)
  t.app.turnEnded()
}

// 78b. The branch is read from the workspace's own .git: a branch, a detached head, a worktree's gitdir, and none.
{
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-'))
  try {
    mkdirSync(join(root, 'repo', '.git'), { recursive: true })
    writeFileSync(join(root, 'repo', '.git', 'HEAD'), 'ref: refs/heads/feat/footer\n')
    mkdirSync(join(root, 'detached', '.git'), { recursive: true })
    writeFileSync(join(root, 'detached', '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n')
    mkdirSync(join(root, 'meta', 'worktrees', 'wt'), { recursive: true })
    writeFileSync(join(root, 'meta', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/wt-branch\n')
    mkdirSync(join(root, 'wt'), { recursive: true })
    writeFileSync(join(root, 'wt', '.git'), `gitdir: ${join(root, 'meta', 'worktrees', 'wt')}\n`)
    mkdirSync(join(root, 'plain'), { recursive: true })
    check('branch: a branch by its name', gitBranch(join(root, 'repo')) === 'feat/footer', String(gitBranch(join(root, 'repo'))))
    check('branch: a detached head by its short hash', gitBranch(join(root, 'detached')) === '0123456', String(gitBranch(join(root, 'detached'))))
    check('branch: a worktree, through its gitdir', gitBranch(join(root, 'wt')) === 'wt-branch', String(gitBranch(join(root, 'wt'))))
    check('branch: none outside a repository, and none for a path that is not there', gitBranch(join(root, 'plain')) === null && gitBranch(join(root, 'absent')) === null)
    // git reads the first line only; a reftable repository's HEAD names no branch (.invalid).
    mkdirSync(join(root, 'odd', '.git'), { recursive: true })
    writeFileSync(join(root, 'odd', '.git', 'HEAD'), 'garbage\nref: refs/heads/x\n')
    mkdirSync(join(root, 'reftable', '.git'), { recursive: true })
    writeFileSync(join(root, 'reftable', '.git', 'HEAD'), 'ref: refs/heads/.invalid\n')
    mkdirSync(join(root, 'tail', '.git'), { recursive: true })
    writeFileSync(join(root, 'tail', '.git', 'HEAD'), 'ref: refs/heads/main\nsomething after\n')
    check('branch: only HEAD\'s first line counts, and a reftable placeholder is no branch', gitBranch(join(root, 'odd')) === null && gitBranch(join(root, 'tail')) === 'main' && gitBranch(join(root, 'reftable')) === null, String([gitBranch(join(root, 'odd')), gitBranch(join(root, 'tail')), gitBranch(join(root, 'reftable'))]))
    // The workspace is the agent's to write: what it leaves in .git must not hang the terminal or fill memory.
    if (process.platform !== 'win32') {
      mkdirSync(join(root, 'fifo', '.git'), { recursive: true })
      execFileSync('mkfifo', [join(root, 'fifo', '.git', 'HEAD')])
      mkdirSync(join(root, 'fifo2'), { recursive: true })
      execFileSync('mkfifo', [join(root, 'fifo2', '.git')])
      mkdirSync(join(root, 'zero', '.git'), { recursive: true })
      symlinkSync('/dev/zero', join(root, 'zero', '.git', 'HEAD'))
      const started = Date.now()
      const read = [gitBranch(join(root, 'fifo')), gitBranch(join(root, 'fifo2')), gitBranch(join(root, 'zero'))]
      check('branch: a FIFO at HEAD or at .git, or HEAD linked to a device, is no branch, at once', read.every((b) => b === null) && Date.now() - started < 1000, JSON.stringify(read))
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// 79. The input box after Claude Code and pi. A placeholder while it is empty; the rows it cannot show are counted
// in its border; a long paste is a chip until it is sent; a backslash before Enter is a new line; and messages
// waiting behind a turn come back to the box with ↑, taken back from the gateway, the turn going on.
{
  const t = setup({ cols: 80, rows: 30 })
  const boxRow = () => { const p = t.term.screen.find('│ ›'); return p === null ? -1 : p.row }
  check('input: a placeholder in the empty box', /│ › Message deepseek-bot/.test(t.term.screen.row(boxRow())), t.term.screen.row(boxRow()))
  t.key('a'); t.clock.advance(20)
  check('input: gone once something is typed', !t.term.screen.text().includes('Message deepseek-bot'))
  t.key('\x15')
  for (let i = 1; i <= 8; i++) { t.key(`line ${i}`); if (i < 8) t.key('\x1b\r') }
  t.clock.advance(20)
  const top = t.term.screen.text().split('\n').find((l) => l.startsWith('╭') && l.includes('more')) ?? '(none)'
  check('input: rows above the box\'s six are counted in its border', /↑ 2 more/.test(top), top)
  for (let i = 0; i < 7; i++) t.key('\x1b[A')
  t.clock.advance(20)
  const bottom = t.term.screen.text().split('\n').find((l) => l.startsWith('╰') && l.includes('more')) ?? '(none)'
  check('input: and the rows below it, the cursor on the first', /↓ 2 more/.test(bottom) && !/↑ \d+ more/.test(t.term.screen.text()), bottom)
  t.key('\x15'); t.key('\x15'); t.key('\x15'); t.key('\x15'); t.key('\x15'); t.key('\x15'); t.key('\x15'); t.key('\x15')
  t.app.editor.set(''); t.clock.advance(20)
  const pasted = Array.from({ length: 12 }, (_, i) => `pasted ${i + 1}`).join('\n')
  t.key(`\x1b[200~${pasted}\x1b[201~`); t.clock.advance(20)
  check('paste: twelve lines are a chip in the box', t.app.editor.text === '[paste #1 +12 lines]' && t.term.screen.text().includes('[paste #1 +12 lines]'), JSON.stringify(t.app.editor.text))
  t.key(' 이거 봐'); t.key('\r'); t.clock.advance(20)
  check('paste: sent, the chip is the text it stands for', t.sent.at(-1) === `${pasted} 이거 봐`, JSON.stringify(t.sent.at(-1)?.slice(-30)))
  t.key('\x1b[200~short\npaste\x1b[201~'); t.clock.advance(20)
  check('paste: a short one is the text itself', t.app.editor.text === 'short\npaste', JSON.stringify(t.app.editor.text))
  t.app.editor.set('')
  t.app.ask('q-chip', [{ id: 'p', question: 'logs?', options: [{ label: 'none' }], multiSelect: false }])
  t.key(`\x1b[200~${pasted}\x1b[201~`); t.key('\r'); t.clock.advance(20)
  check('paste: an answer typed in a chip goes back as the text it stands for', t.answers.some((a) => a.id === 'q-chip' && a.answers[0]?.custom === pasted), JSON.stringify(t.answers.at(-1)?.answers[0]?.custom?.slice(0, 30)))
  t.key('👍 첫 줄\\'); t.key('\r'); t.clock.advance(20)
  check('input: a backslash before Enter is a new line, not a send', t.app.editor.text === '👍 첫 줄\n' && !t.sent.some((m) => m.startsWith('👍')), JSON.stringify(t.app.editor.text))
  t.app.editor.set(''); t.clock.advance(20)
  t.app.turnStarted()
  // Each message queued says "typing" too, as the gateway does.
  t.key('queued one\r'); t.app.turnStarted(); t.key('queued two\r'); t.app.turnStarted(); t.clock.advance(5000)
  const queuedIds = t.sentIds.slice(-2)
  const queuedRows = () => t.term.screen.text().split('\n').filter((l) => /^› queued (one|two)/.test(l)).length
  check('queue: the hint says how to take them back', /↑ edit queued/.test(t.term.screen.row(29)), t.term.screen.row(29))
  t.key('\x1b[A'); t.clock.advance(20)
  check('queue: ↑ asks the gateway for exactly the messages waiting here, and keeps them until it answers', JSON.stringify(t.withdrawals.at(-1)) === JSON.stringify(queuedIds) && queuedIds.every((id) => typeof id === 'string' && id !== '') && new Set(queuedIds).size === 2 && t.app.editor.text === '' && queuedRows() === 2, JSON.stringify({ asked: t.withdrawals.at(-1), queuedIds, text: t.app.editor.text, rows: queuedRows() }))
  t.app.withdrawn(queuedIds); t.clock.advance(20)
  check('queue: the gateway\'s answer brings them back to the box, the turn going on', t.app.editor.text === 'queued one\nqueued two' && t.cancels === 0 && queuedRows() === 0, JSON.stringify({ text: t.app.editor.text, rows: queuedRows() }))
  // The withdrawn turns end; the running one is still the same turn, its time going on.
  t.app.turnEnded(); t.app.turnEnded(); t.clock.advance(1000)
  const still = t.term.screen.text().split('\n').find((l) => l.includes('✻')) ?? '(none)'
  check('queue: the ends of the turns taken back are not a new turn', /\(6s · esc to interrupt\)/.test(still), still)
  // Another terminal's message withdrawn: its end is not a turn here, and nothing of this terminal's comes back.
  t.app.editor.set(''); t.key('mine\r'); t.app.turnStarted(); t.clock.advance(20)
  t.app.turnStarted()   // the other terminal's message says "typing" here too
  t.app.withdrawn(['other-terminal-1']); t.app.turnEnded(); t.clock.advance(1000)
  const others = t.term.screen.text().split('\n').find((l) => l.includes('✻')) ?? '(none)'
  check('queue: another terminal\'s withdrawn message ends no turn here, and mine stays queued', /\(7s · esc to interrupt\)/.test(others) && /^› mine/m.test(t.term.screen.text()) && t.app.editor.text === '', `${others} | ${JSON.stringify(t.app.editor.text)}`)
  // Not connected: nothing is taken back, and it says why.
  t.withdrawOk = false
  t.key('\x1b[A'); t.clock.advance(20)
  check('queue: a withdraw that could not be sent leaves the queue, and says so', /^› mine/m.test(t.term.screen.text()) && t.app.editor.text === '' && t.term.screen.text().includes('not sent'), t.term.screen.text().split('\n').filter((l) => /mine|not sent/.test(l)).join(' | '))
  t.withdrawOk = true
  // A question's answer being typed: ↑ is the answer's, not the queue's.
  const asked = t.withdrawals.length
  t.app.ask('q-up', [{ id: 'q', question: 'which?', options: [{ label: 'a' }], multiSelect: false }]); t.clock.advance(20)
  t.key('x'); t.key('\x7f'); t.key('\x1b[A'); t.clock.advance(20)
  // (↑ there is the box's own: it recalls what was sent before.)
  check('queue: ↑ while typing an answer does not take the queue into it', t.withdrawals.length === asked && /^› mine/m.test(t.term.screen.text()) && t.app.question !== null, JSON.stringify({ asked: t.withdrawals.length - asked, text: t.app.editor.text }))
  // A backslash before Enter is a new line in an answer too.
  t.app.editor.set('')
  t.key('a\\'); t.key('\r'); t.clock.advance(20)
  check('input: a backslash before Enter is a new line in an answer too', t.app.editor.text === 'a\n' && t.app.question !== null && !t.answers.some((a) => a.id === 'q-up'), JSON.stringify(t.app.editor.text))
  t.key('\x1b'); t.key('\x1b'); t.clock.advance(60)
  t.app.editor.set(''); t.app.turnEnded(); t.app.turnEnded(); t.clock.advance(20)
}

// 79b. What review found in 79. A paste's line breaks may be CR; a final newline is not a line; a chip is one
// thing to the cursor and to deleting; the placeholder is for the empty message box only; and the border's count
// keeps clear of a narrow box's corner.
{
  const t = setup({ cols: 80, rows: 30 })
  const lines = Array.from({ length: 12 }, (_, i) => `cr ${i + 1}`)
  t.key(`\x1b[200~${lines.join('\r')}\x1b[201~`); t.clock.advance(20)
  check('paste: CR line breaks count, as a chip', /^\[paste #\d+ \+12 lines\]$/.test(t.app.editor.text), JSON.stringify(t.app.editor.text))
  t.key('\r'); t.clock.advance(20)
  check('paste: and it is sent with newlines, not CRs', t.sent.at(-1) === lines.join('\n'), JSON.stringify(t.sent.at(-1)?.slice(0, 20)))
  t.key(`\x1b[200~${Array.from({ length: 10 }, (_, i) => `ten ${i + 1}`).join('\n')}\n\x1b[201~`); t.clock.advance(20)
  check('paste: ten lines and a final newline are ten lines, not a chip', !t.app.editor.text.includes('[paste'), JSON.stringify(t.app.editor.text.slice(0, 20)))
  t.app.editor.set('')
  const twelve = Array.from({ length: 12 }, (_, i) => `p ${i + 1}`).join('\n')
  t.key(`\x1b[200~${twelve}\x1b[201~`); t.clock.advance(20)
  const chip = t.app.editor.text
  t.key('\x7f'); t.clock.advance(20)
  check('chip: backspace takes the whole chip', t.app.editor.text === '', JSON.stringify(t.app.editor.text))
  t.key(`\x1b[200~${twelve}\x1b[201~`); t.key('\x1b[D'); t.key('x'); t.clock.advance(20)
  const second = t.app.editor.text.slice(1)
  check('chip: ← goes over it whole, so a key typed there lands before it', t.app.editor.text.startsWith('x[paste #') && /^\[paste #\d+ \+12 lines\]$/.test(second), JSON.stringify(t.app.editor.text))
  t.key('\x1b[3~'); t.clock.advance(20)
  check('chip: delete takes the whole chip after the cursor', t.app.editor.text === 'x', JSON.stringify(t.app.editor.text))
  t.key(`\x1b[200~${twelve}\x1b[201~`); t.key('\x17'); t.clock.advance(20)
  check('chip: ctrl+w takes the whole chip', t.app.editor.text === 'x', JSON.stringify(t.app.editor.text))
  t.key(`\x1b[200~${twelve}\x1b[201~`); t.clock.advance(20)
  const inside = t.term.screen.find('[paste #')
  t.key(SGR(0, inside.col + 4, inside.row)); t.key(SGR(0, inside.col + 4, inside.row, true)); t.key('y'); t.clock.advance(20)
  check('chip: a click inside it, then a key: the key goes after it, the chip whole', /^x\[paste #\d+ \+12 lines\]y$/.test(t.app.editor.text), JSON.stringify(t.app.editor.text))
  t.key('\x7f'); t.key('\x17'); t.clock.advance(20)
  t.key(`\x1b[200~${twelve}\x1b[201~`); t.key('\r'); t.clock.advance(20)
  check('chip: sent, still the text it stands for', t.sent.at(-1) === `x${twelve}`, JSON.stringify(t.sent.at(-1)?.slice(0, 12)))
  check('chip: chips not in the box or what was sent are let go', t.app.pasteChips <= 2, String(t.app.pasteChips))
  t.key('\x1b[A'); t.key('\r'); t.clock.advance(20)
  check('chip: a sent one brought back with ↑ is sent as its text again', t.sent.at(-1) === `x${twelve}` && t.sent.at(-2) === `x${twelve}`, JSON.stringify(t.sent.slice(-2).map((m) => m.slice(0, 14))))
  t.key('\x12'); t.key('zzz'); t.clock.advance(20)
  check('placeholder: not inside a history search', !t.term.screen.text().includes('Message deepseek-bot'))
  t.key('\x1b'); t.clock.advance(60)
  const narrow = setup({ cols: 12, rows: 20 })
  for (let i = 1; i <= 8; i++) { narrow.key(`l${i}`); if (i < 8) narrow.key('\x1b\r') }
  narrow.clock.advance(20)
  const border = narrow.term.screen.text().split('\n').find((l) => l.startsWith('╭')) ?? '(none)'
  check('overflow: on a box too narrow for the count, the corner stays', border.startsWith('╭─') && !border.includes('more'), border)
}

// 79c. What the second review found. A CR paste is not "too long"; ctrl+w after a chip and words takes the words,
// then the chip whole; a click inside a chip puts the cursor at its edge; ↑ answered after the next turn started here
// takes that turn's message back out of the transcript; text taken back while a question has the box waits for
// the box; a message that could not be sent stays in the box; and ↑ that took nothing back says so.
{
  const t = setup({ cols: 80, rows: 30 })
  const twelve = Array.from({ length: 12 }, (_, i) => `q ${i + 1}`)
  t.key(`\x1b[200~${twelve.join('\r')}\x1b[201~`); t.clock.advance(20)
  check('paste: a CR paste is not called too long', !t.term.screen.text().includes('too long'), t.term.screen.text().split('\n').find((l) => l.includes('paste')) ?? '')
  t.key(' 이거 봐'); t.key('\x17'); t.key('\x17'); t.key('\x17'); t.clock.advance(20)
  check('chip: ctrl+w after a chip and words takes the words, then the chip whole', t.app.editor.text === '', JSON.stringify(t.app.editor.text))
  t.key(`\x1b[200~${twelve.join('\n')}\x1b[201~`); t.clock.advance(20)
  const chip = t.app.editor.text
  const at = t.term.screen.find('[paste #')
  t.key(SGR(0, at.col + 4, at.row)); t.key(SGR(0, at.col + 4, at.row, true)); t.key('\x0b'); t.clock.advance(20)
  check('chip: a click inside it puts the cursor at its edge, so ctrl+k leaves it whole', t.app.editor.text === chip, JSON.stringify(t.app.editor.text))
  t.app.editor.set(''); t.clock.advance(20)

  // ↑ asks for B and C; the running turn's end arrives first, so B is shown as started; then the gateway says it
  // withdrew both (B was still waiting there): B leaves the transcript and both come back.
  t.app.turnStarted(); t.key('B-msg\r'); t.app.turnStarted(); t.key('C-msg\r'); t.app.turnStarted(); t.clock.advance(20)
  const [idB, idC] = t.sentIds.slice(-2)
  t.key('\x1b[A'); t.app.turnEnded(); t.clock.advance(20)
  const startedB = /^› B-msg/m.test(t.term.screen.text())
  t.app.withdrawn([idB, idC]); t.clock.advance(20)
  check('queue: a message shown as started that the gateway withdrew leaves the transcript and comes back', startedB && t.app.editor.text === 'B-msg\nC-msg' && !/^› B-msg/m.test(t.term.screen.text()), JSON.stringify({ startedB, text: t.app.editor.text }))
  t.app.turnEnded(); t.app.turnEnded(); t.clock.advance(20)
  t.app.editor.set('')

  // Taken back while a question has the box: it waits, and comes to the box when the question is done.
  t.app.turnStarted(); t.key('D-msg\r'); t.app.turnStarted(); t.clock.advance(20)
  const idD = t.sentIds.at(-1)
  t.key('\x1b[A')
  t.app.ask('q-hold', [{ id: 'q', question: 'which?', options: [{ label: 'a' }], multiSelect: false }]); t.clock.advance(20)
  t.app.withdrawn([idD]); t.clock.advance(20)
  const during = t.app.editor.text
  t.key('\x1b'); t.clock.advance(60)
  check('queue: taken back while a question has the box, it waits for the box', during === '' && t.app.question === null && t.app.editor.text === 'D-msg' && !t.answers.some((a) => JSON.stringify(a).includes('D-msg')), JSON.stringify({ during, after: t.app.editor.text }))
  t.app.turnEnded(); t.app.turnEnded(); t.clock.advance(20)
  t.app.editor.set('')

  // A message that could not be sent is not queued: it stays in the box.
  t.app.turnStarted(); t.sendOk = false
  t.key('E-msg\r'); t.clock.advance(20)
  check('send: a message that could not be sent stays in the box, not queued', t.app.editor.text === 'E-msg' && !/^› E-msg/m.test(t.term.screen.text()), JSON.stringify(t.app.editor.text))
  t.sendOk = true; t.app.editor.set('')

  // ↑ that the gateway answers with nothing: every message had started.
  t.key('F-msg\r'); t.app.turnStarted(); t.clock.advance(20)
  t.key('\x1b[A'); t.app.withdrawn([]); t.clock.advance(20)
  check('queue: ↑ that took nothing back says so', t.term.screen.text().includes('already started') && /^› F-msg/m.test(t.term.screen.text()), t.term.screen.text().split('\n').filter((l) => /F-msg|started/.test(l)).join(' | '))
  t.app.turnEnded(); t.app.turnEnded()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
