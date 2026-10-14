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
    `Deep interview: ${topic}`,
    '',
    'How to run it:',
    '- Each round, ask exactly one question with the ask_user_question tool, in the language the topic is written in. Two to four short options.',
    '- Right before calling the tool, write the clarity so far in exactly this form. The terminal reads this block into gauges and hides it from the text.',
    '```interview-state',
    '{"round": 1, "scores": {"goal": 0, "constraints": 0, "success criteria": 0, "context": 0}, "ambiguity": 100}',
    '```',
    '- scores is the clarity of each item, 0 to 100; ambiguity is how unclear it still is, 0 to 100. Both are your judgement, not a measurement.',
    `- Once ambiguity is ${AMBIGUITY_TARGET} or less, stop asking and write the answers up as a spec at specs/<short-english-slug>.md in the working folder. Put "done": true and "spec": "specs/….md" in the last block.`,
  ].join('\n')
}
