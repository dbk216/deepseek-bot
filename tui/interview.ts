/**
 * The deep interview: what /interview asks of the model, and the state it reports back.
 *
 * A model cannot attach data to its question (the ask_user_question tool drops anything but the
 * question and its options), so each round it writes a fenced `interview-state` block before
 * asking. The terminal reads the newest block into gauges and hides every block from the text.
 * The scores are the model's own judgement, not a measurement, and the screen says so.
 */

export interface InterviewState {
  round: number
  scores: Record<string, number>
  ambiguity: number
  done: boolean
  spec: string | null
}

const FENCE = /```interview-state\s*\n([\s\S]*?)(?:```|$)/g

/** The text without its state blocks (a block still being streamed is hidden too). */
export function stripState(text: string): string {
  return text.replace(FENCE, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** The last complete, well-formed state block in the text, or null. */
export function readState(text: string): InterviewState | null {
  let found: InterviewState | null = null
  for (const m of text.matchAll(/```interview-state\s*\n([\s\S]*?)```/g)) {
    try {
      const v = JSON.parse(m[1])
      const scores: Record<string, number> = {}
      for (const [k, n] of Object.entries(v?.scores ?? {})) if (Number.isFinite(n)) scores[k] = Math.max(0, Math.min(100, Math.round(Number(n))))
      found = {
        round: Number.isFinite(v?.round) ? Number(v.round) : 0,
        scores,
        ambiguity: Number.isFinite(v?.ambiguity) ? Math.max(0, Math.min(100, Math.round(Number(v.ambiguity)))) : 100,
        done: v?.done === true,
        spec: typeof v?.spec === 'string' && v.spec !== '' ? v.spec : null,
      }
    } catch { /* a malformed block is ignored, not shown */ }
  }
  return found
}

export const AMBIGUITY_TARGET = 20

/** The opening message of /interview: the topic, then how to run it. */
export function interviewPrompt(topic: string): string {
  return [
    `딥인터뷰: ${topic}`,
    '',
    '진행 방식:',
    '- 라운드마다 ask_user_question 도구로 질문을 딱 하나만 해. 선택지는 2~4개, 짧게.',
    '- 도구를 부르기 직전에 지금까지의 명확도를 아래 형식 그대로 먼저 써. 터미널이 이 블록을 읽어 게이지로 보여주고 본문에서는 숨긴다.',
    '```interview-state',
    '{"round": 1, "scores": {"목표": 0, "제약": 0, "성공 기준": 0, "맥락": 0}, "ambiguity": 100}',
    '```',
    '- scores는 항목별 명확도 0~100, ambiguity는 아직 모호한 정도 0~100. 네 판단이지 측정값이 아니다.',
    `- ambiguity가 ${AMBIGUITY_TARGET} 이하가 되면 질문을 멈추고, 답을 정리한 spec을 작업 폴더의 specs/<짧은-영문-slug>.md 로 써. 마지막 블록에 "done": true 와 "spec": "specs/….md" 를 넣어.`,
  ].join('\n')
}
