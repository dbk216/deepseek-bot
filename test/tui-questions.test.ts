/**
 * Answering a turn's questions, and reading a deep interview's reports — the rules, without a screen.
 *
 * The answer shapes follow the harness's rule (dsh-user-questions): single-select answers with one
 * label, or with the person's own words in `custom` and nothing selected; multi-select answers with
 * the ticked labels, `custom` adding to them; a skipped question is `{ id, selected: [] }`.
 *
 * Run: node test/tui-questions.test.ts
 */
import './dist-fresh.ts'   // fails loudly on a stale dist

import { QuestionFlow } from '../dist/tui/question.js'
import { readState, stripState, interviewPrompt, AMBIGUITY_TARGET } from '../dist/tui/interview.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const single = { id: 'env', question: '배포 대상 환경은?', options: [{ label: 'staging' }, { label: 'production' }, { label: '둘 다' }], multiSelect: false }
const multi = { id: 'checks', question: '어떤 검사를 돌릴까?', options: [{ label: 'unit' }, { label: 'e2e' }, { label: 'lint' }], multiSelect: true }

// 1. Single-select.
{
  const f = new QuestionFlow('q1', [single])
  f.move(1)
  check('single: Enter on an option answers with that label', f.choose() === 'answered' && JSON.stringify(f.answers) === JSON.stringify([{ id: 'env', selected: ['production'] }]) && f.done)
  const g = new QuestionFlow('q2', [single])
  g.move(-1)
  check('single: the last row is "직접 입력…", and Enter on it starts typing', g.rows().at(-1).kind === 'custom' && g.choose() === 'typing' && g.typing)
  g.submitCustom('  canary 먼저  ')
  check('single: the person\'s own words replace the choice', JSON.stringify(g.answers[0]) === JSON.stringify({ id: 'env', selected: [], custom: 'canary 먼저' }))
}

// 2. Multi-select.
{
  const f = new QuestionFlow('q', [multi])
  f.toggle(); f.move(2); f.toggle()
  f.move(-1)
  check('multi: Enter confirms what is ticked, in option order', f.choose() === 'answered' && JSON.stringify(f.answers[0].selected) === JSON.stringify(['unit', 'lint']))
  const g = new QuestionFlow('q', [multi])
  g.move(1)
  g.choose()
  check('multi: with nothing ticked, Enter takes the option under the cursor', JSON.stringify(g.answers[0].selected) === JSON.stringify(['e2e']))
  const h = new QuestionFlow('q', [multi])
  h.toggle()
  h.cursor = h.rows().length - 1
  h.choose()
  h.submitCustom('smoke도')
  check('multi: the person\'s own words add to what is ticked', JSON.stringify(h.answers[0]) === JSON.stringify({ id: 'checks', selected: ['unit'], custom: 'smoke도' }))
  const i = new QuestionFlow('q', [single])
  i.toggle()
  check('single: Space ticks nothing', i.rows().every((r) => !r.checked))
}

// 3. A batch, skipping, and a plan review.
{
  const f = new QuestionFlow('batch', [single, multi])
  f.skip()
  check('skip: recorded as nothing selected, and the next question comes up', JSON.stringify(f.answers[0]) === JSON.stringify({ id: 'env', selected: [] }) && f.current?.id === 'checks' && !f.done)
  f.choose()
  check('batch: done after the last question, one answer each', f.done && f.answers.length === 2 && f.describe(f.answers[0]) === '(skipped)')
  const review = { id: 'plan', question: '이 계획으로 진행할까?', options: [{ label: 'Revise' }, { label: 'Approve' }], multiSelect: false, detail: '# Plan\n1. …', intent: { kind: 'plan-review', approve: 'Approve' } }
  const p = new QuestionFlow('p', [review])
  check('plan review: the cursor starts on the approving option', p.cursor === 1 && p.choose() === 'answered' && p.answers[0].selected[0] === 'Approve')
}

// 4. The deep interview's reports.
{
  const text = [
    '좋아, 첫 질문이야.',
    '```interview-state',
    '{"round": 1, "scores": {"목표": 30, "제약": 10}, "ambiguity": 85}',
    '```',
    '이어서 묻는다.',
    '```interview-state',
    '{"round": 2, "scores": {"목표": 82.4, "제약": 140, "맥락": -3}, "ambiguity": 42}',
    '```',
  ].join('\n')
  const st = readState(text)
  check('state: the newest block wins', st?.round === 2 && st.ambiguity === 42)
  check('state: scores are rounded and clamped to 0–100', JSON.stringify(st?.scores) === JSON.stringify({ 목표: 82, 제약: 100, 맥락: 0 }), JSON.stringify(st?.scores))
  check('text: every block is hidden, the words remain', stripState(text) === '좋아, 첫 질문이야.\n\n이어서 묻는다.' || stripState(text) === '좋아, 첫 질문이야.\n이어서 묻는다.', JSON.stringify(stripState(text)))
  const streaming = '정리 중이야\n```interview-state\n{"round": 3, "sco'
  check('text: a block still being streamed is hidden too, and not read', stripState(streaming) === '정리 중이야' && readState(streaming) === null)
  check('state: a malformed block is ignored, an earlier good one still counts', readState('```interview-state\n{"round": 1, "ambiguity": 60}\n```\n```interview-state\n{oops}\n```')?.ambiguity === 60)
  const done = readState('```interview-state\n{"round": 6, "scores": {}, "ambiguity": 15, "done": true, "spec": "specs/tui.md"}\n```')
  check('state: done, with the spec it wrote', done?.done === true && done.spec === 'specs/tui.md')
  check('prompt: the gauges are named in English, whatever the topic\'s language', interviewPrompt('TUI 설계').includes('"goal": 0'), interviewPrompt('TUI 설계').split('\n').find((l) => l.startsWith('{')))
  const prompt = interviewPrompt('TUI 설계')
  check('prompt: names the topic, one question per round, the block format and the stop rule', prompt.startsWith('Deep interview: TUI 설계') && prompt.includes('ask_user_question') && prompt.includes('```interview-state') && prompt.includes(`${AMBIGUITY_TARGET} or less`) && prompt.includes('specs/'))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
