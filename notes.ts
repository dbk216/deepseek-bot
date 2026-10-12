/**
 * Note hygiene: noticing that a persona's notes have outgrown being read.
 *
 * `MEMORY.md` only ever grows — the agent appends a line per thing worth keeping and nothing merges
 * the lines back together. At three lines that is invisible; at a few hundred the file is in every
 * prompt, the oldest entries are stale, and the same preference can be written three times.
 *
 * This does not rewrite the notes. Merging and summarising is a writing job that needs intent, so it
 * goes to the model — the same division as recall, where the scorer picks candidates and the model
 * writes the implication. What this decides is *when* to ask, which is a counting job.
 *
 * The advice goes into the standing block, which is digest-gated: it is sent once when the notes
 * change and then cached, so noticing an oversized file costs nothing per turn.
 */

export interface NotesReport {
  /** Characters in the file, after trimming. */
  chars: number
  /** Non-empty lines. */
  lines: number
  /** Lines that appear more than once, normalised, in file order. */
  duplicates: string[]
  /** True when the file is past the budget. */
  overBudget: boolean
  /** The line to inject, or null when there is nothing to say. */
  advice: string | null
}

export interface NotesOptions {
  /** Characters at which consolidation is asked for. */
  budgetChars?: number
  /** How many distinct lines to name when reporting duplicates. */
  maxReportedDuplicates?: number
}

/** A line is compared with its whitespace collapsed and its case folded. */
function normalise(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

export function analyzeNotes(text: string | null | undefined, options: NotesOptions = {}): NotesReport {
  const budget = options.budgetChars ?? 6000
  const maxReported = options.maxReportedDuplicates ?? 3
  const raw = typeof text === 'string' ? text : ''
  const body = raw.trim()
  const lines = body === '' ? [] : body.split('\n').filter((l) => l.trim() !== '')

  const seen = new Map<string, number>()
  for (const line of lines) {
    const key = normalise(line).toLowerCase()
    if (key === '') continue
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  const duplicates = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .slice(0, maxReported)

  const chars = body.length
  const overBudget = chars > budget
  if (!overBudget && duplicates.length === 0) {
    return { chars, lines: lines.length, duplicates, overBudget, advice: null }
  }

  const reasons: string[] = []
  if (overBudget) reasons.push(`${chars} characters, past the ${budget} budget`)
  if (duplicates.length > 0) reasons.push(`${duplicates.length === 1 ? 'a line is' : 'lines are'} written more than once`)
  const advice = [
    `[your notes need tidying — ${reasons.join('; ')}]`,
    'Merge the repeated entries, fold the older ones into single lines, and drop what is no longer true.',
    'Keep the file in short lines: it is read in full on every conversation from now on.',
    duplicates.length > 0 ? `Repeated so far: ${duplicates.map((d) => JSON.stringify(d)).join(', ')}` : '',
  ].filter((l) => l !== '').join('\n')

  return { chars, lines: lines.length, duplicates, overBudget, advice }
}
