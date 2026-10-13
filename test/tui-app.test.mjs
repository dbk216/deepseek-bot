/**
 * The TUI's interactions, against a fake terminal and a fake backend.
 *
 * What the user does is checked by what they would see: the bytes the app writes are replayed
 * through a VT emulator and the assertions read that screen. Typing must show on the keystroke,
 * Enter must reach the backend, a drag must copy exactly the text under it (Hangul included,
 * the prompt marks left out), and every exit must hand the terminal back.
 *
 * Run: node test/tui-app.test.mjs
 */
import './dist-fresh.mjs'   // fails loudly on a stale dist

import { App } from '../dist/tui/app.js'
import { RESTORE } from '../dist/tui/render/terminal.js'
import { fakeClock, fakeTerminal } from './tui-fakes.mjs'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function setup({ cols = 80, rows = 30, env = { COLORTERM: 'truecolor' } } = {}) {
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
  })
  app.start()
  app.setStatus({ connected: true, preset: 'ask', session: 'tui-3f2a9c1e-aaaa', workspace: '~/dsh-agent', model: 'deepseek-v4.1' })
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
  check('start: the info line names model, workspace and session', /deepbot\s+deepseek-v4\.1 · ~\/dsh-agent · session tui-3f2a9c1e-aaaa/.test(text), text.split('\n').find((l) => l.includes('deepbot  ')) ?? '')
  check('start: the input box and the status line', text.includes('╭') && text.includes('╰') && text.includes('▸▸ ask'))
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
  t.app.tool('recall', '2 passages')
  t.app.delta('staging 먼저.')
  t.app.final('staging 먼저, 그다음 production.')
  t.app.turnEnded()
  t.clock.advance(20)
  const done = t.term.screen.text()
  check('stream: a tool step appears between the two parts', done.includes('⏺ recall · 2 passages'))
  check('stream: the final text replaces the streamed text', done.includes('staging 먼저, 그다음 production.') && !done.includes('staging 먼저.▍'))
  check('stream: no spinner after the turn', !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d+\.\ds/.test(done))
}

// 3b. The turn's reply takes the place of what was streamed — and only the reply does.
{
  const t = setup()
  t.key('지워줘\r')
  t.app.turnStarted()
  t.app.delta('build 폴더를 지울게.')
  t.app.tool('bash')
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
  check('drag: the status line confirms the copy', t.term.screen.text().includes('복사됨 · '))
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
  const marker = t.term.screen.find('↓ 새 줄')
  check('wheel: lines arriving below are announced on the divider', marker !== null)
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
  check('ctrl+c: the first press only warns', t.exited === null && t.term.screen.text().includes('한 번 더 누르면 종료'))
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
  check('status line: shells and agents counted', text.includes('▸▸ ask · 1 shell · ← 2 agents'))
  t.clock.advance(1000)
  check('panel: the running agent\'s time moves without a new report', /research links +13s/.test(t.term.screen.text()))

  t.key('\t')
  t.key('\x1b[B')
  t.key('\r')
  check('tab, ↓, Enter: opens the agent and asks the gateway to follow it', JSON.stringify(t.views[0]) === JSON.stringify(['view', 'agent', 'child-1']) && t.app.view.kind === 'agent')
  t.app.agentLines('child-1', [{ role: 'user', text: '링크 3개를 요약해' }, { role: 'tool', text: 'web_fetch' }, { role: 'assistant', text: '요약 중간 결과' }])
  t.clock.advance(20)
  const view = t.term.screen.text()
  check('agent view: the header says where we are, the pane shows the child\'s conversation', view.includes('deepbot · main › research links') && view.includes('› 링크 3개를 요약해') && view.includes('⏺ web_fetch') && view.includes('요약 중간 결과'))
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
  check('job view: output accumulates, and the end is said', out.includes('PASS a') && out.includes('PASS c') && out.includes('종료됨 · completed'))
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
  check('question: the panel shows the question, its options and "직접 입력…"', /\? 질문 \(1\/2\)/.test(asked) && asked.includes('배포 대상 환경은?') && /❯ staging/.test(asked) && asked.includes('production — 실서비스') && asked.includes('직접 입력…'))
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
  check('plan review: the plan is laid out in the transcript, approve is preselected', review.includes('plan 검토 요청') && review.includes('1. 렌더러') && /❯ Approve/.test(review) && review.includes('? plan 검토'))
  t.app.closeQuestion('q-5')
  t.clock.advance(20)
  check('question: closed by the gateway (the turn stopped), the panel goes away', t.app.question === null && t.term.screen.text().includes('질문이 닫힘'))
  t.app.turnEnded()
}
{
  const t = setup({ cols: 100, rows: 34 })
  t.app.startInterview('TUI 설계')
  t.app.sendAs('딥인터뷰: TUI 설계', '(긴 지시문)')
  t.app.turnStarted()
  t.app.delta('좋아, 시작하자.\n```interview-state\n{"round": 2, "scores": {"목표": 80, "제약": 50, "성공 기준": 30}, "ambiguity": 42}\n```\n')
  t.clock.advance(20)
  const strip = t.term.screen.text()
  check('interview: the shown message is the short form, not the instructions', strip.includes('› 딥인터뷰: TUI 설계') && !strip.includes('(긴 지시문)') && t.sent[0] === '(긴 지시문)')
  check('interview: the strip shows the round, each dimension and the ambiguity left', strip.includes('딥인터뷰 · TUI 설계 · round 2') && /목표 ▰{8}▱{2} 80%/.test(strip) && strip.includes('모호도 42% → 목표 20% 이하'))
  check('interview: the state block itself is not in the conversation', !strip.includes('interview-state') && !strip.includes('"ambiguity"') && strip.includes('좋아, 시작하자.'))
  check('interview: the screen says the scores are the model\'s own judgement', strip.includes('모델의 자기 평가'))
  t.app.message('ts-done', '정리했어.\n```interview-state\n{"round": 5, "scores": {"목표": 95}, "ambiguity": 12, "done": true, "spec": "specs/tui.md"}\n```', null, true)
  t.app.turnEnded()
  t.clock.advance(20)
  check('interview: done, with the spec it wrote', t.term.screen.text().includes('완료 · spec: specs/tui.md'))
  t.app.clear()
  t.clock.advance(20)
  check('interview: a new conversation ends it', !t.term.screen.text().includes('딥인터뷰 ·'))
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
  check('narrow: a 50-column terminal gets the wordmark, not broken block letters', narrow.term.screen.text().includes('◆ DeepSeek-Harness') && !narrow.term.screen.text().includes('██████╗'))
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
  check('running: so Ctrl+C arms quit instead of cancelling', t.cancels === 0 && t.term.screen.text().includes('한 번 더 누르면 종료'))
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

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
