/**
 * Just enough Markdown for a chat answer: code blocks, headings, lists, quotes, rules, and inline
 * **bold**, *emphasis*, `code`, [links](url) — plus the Slack forms the core's own messages use
 * (*bold*, :warning:), because those are written for Slack and reach the terminal unchanged.
 *
 * Markers are not drawn, so a copy gives the text as read. Lines wrap by display width across
 * styles; a code line wraps where it overflows, never at its spaces.
 */
import { graphemes, graphemeWidth } from './width.js'
import type { Line, Span } from './text.js'

export interface MarkdownStyles {
  text: string
  bold: string
  italic: string
  code: string
  heading: string
  quote: string
  codeBlock: string
  dim: string
  link: string
}

const SHORTCODES: Record<string, string> = {
  warning: '⚠', white_check_mark: '✅', heavy_check_mark: '✔', x: '❌', hourglass: '⏳', hourglass_flowing_sand: '⏳',
  bulb: '💡', memo: '📝', rocket: '🚀', tada: '🎉', eyes: '👀', thumbsup: '👍', '+1': '👍', fire: '🔥', link: '🔗',
}

/** Inline markup → styled pieces. Unknown or unbalanced markers stay as text. */
export function inline(text: string, base: string, s: MarkdownStyles): Span[] {
  const out: Span[] = []
  const push = (t: string, style: string) => { if (t !== '') out.push({ text: t, style }) }
  // Emphasis only at word edges, as Markdown has it: snake_case_names and 2*3*4 stay as written.
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|((?<![\w*])\*[^*\s][^*\n]*?\*(?![\w*]))|((?<![\w_])_[^_\s][^_\n]*?_(?![\w_]))|(\[[^\]\n]+\]\([^)\s]+\))|(:[a-z0-9_+]+:)/g
  let last = 0
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0
    const token = m[0]
    if (m[6] !== undefined && SHORTCODES[token.slice(1, -1)] === undefined) continue
    push(text.slice(last, at), base)
    if (m[1]) push(token.slice(1, -1), s.code)
    else if (m[2]) push(token.slice(2, -2), s.bold)
    else if (m[3] || m[4]) push(token.slice(1, -1), m[3] ? s.bold : s.italic)
    else if (m[5]) {
      const label = token.slice(1, token.indexOf(']'))
      const url = token.slice(token.indexOf('(') + 1, -1)
      push(label, s.link)
      if (url !== label) push(` (${url})`, s.dim)
    } else push(SHORTCODES[token.slice(1, -1)], base)
    last = at + token.length
  }
  push(text.slice(last), base)
  return out
}

interface Cell { g: string; w: number; style: string }

/**
 * Wrap styled text into lines no wider than `width`, preferring spaces (or anywhere, for code).
 * Each line after the first records the spaces its break removed, so a copy can restore them.
 */
function wrapSpans(spans: Span[], width: number, anywhere: boolean): Array<{ spans: Span[]; gap: string }> {
  const max = Math.max(1, width)
  const cells: Cell[] = []
  for (const span of spans) for (const g of graphemes(span.text)) cells.push({ g, w: graphemeWidth(g), style: span.style })
  const lines: Array<{ cells: Cell[]; gap: string }> = []
  let line: Cell[] = []
  let used = 0
  let gap = ''
  for (const cell of cells) {
    if (used + cell.w > max && line.length > 0) {
      let cut = line.length
      if (!anywhere) {
        if (cell.g === ' ') cut = line.length
        else { const space = line.map((c) => c.g).lastIndexOf(' '); if (space > 0) cut = space }
      }
      const kept = line.slice(0, cut)
      let rest = line.slice(cut)
      let removed = ''
      while (kept.length > 0 && kept[kept.length - 1].g === ' ' && !anywhere) removed = kept.pop()!.g + removed
      while (rest.length > 0 && rest[0].g === ' ' && !anywhere) { removed += rest[0].g; rest = rest.slice(1) }
      lines.push({ cells: kept, gap })
      gap = removed
      line = rest
      used = line.reduce((n, c) => n + c.w, 0)
    }
    if (line.length === 0 && cell.g === ' ' && lines.length > 0 && !anywhere) { gap += ' '; continue }
    line.push(cell)
    used += cell.w
  }
  lines.push({ cells: line, gap })
  return lines.map(({ cells: cs, gap: g }) => {
    const grouped: Span[] = []
    for (const c of cs) {
      const prev = grouped[grouped.length - 1]
      if (prev !== undefined && prev.style === c.style) prev.text += c.g
      else grouped.push({ text: c.g, style: c.style })
    }
    return { spans: grouped, gap: g }
  })
}

/**
 * Lay out a Markdown answer under a prefix (e.g. two spaces), as transcript lines.
 */
export function markdown(text: string, width: number, s: MarkdownStyles, prefix: Span): Line[] {
  const lines: Line[] = []
  const lead = (extra: Span[] = []): Span[] => [{ ...prefix, decor: true }, ...extra.map((e) => ({ ...e, decor: true }))]
  const emit = (spans: Span[], decor: Span[], anywhere = false) => {
    const room = Math.max(1, width - [prefix, ...decor].reduce((n, d) => n + [...graphemes(d.text)].reduce((a, g) => a + graphemeWidth(g), 0), 0))
    wrapSpans(spans, room, anywhere).forEach((piece, i) => {
      lines.push({ spans: [...lead(decor), ...piece.spans], soft: i > 0, ...(i > 0 ? { gap: piece.gap } : {}) })
    })
  }
  let fence: string | null = null
  for (const raw of text.split('\n')) {
    const open = /^\s*```(\S*)\s*$/.exec(raw)
    if (open !== null) {
      if (fence === null) { fence = open[1]; if (fence !== '') lines.push({ spans: lead([{ text: `${fence}`, style: s.dim }]), soft: false }) }
      else fence = null
      continue
    }
    if (fence !== null) { emit([{ text: raw === '' ? ' ' : raw, style: s.codeBlock }], [{ text: '│ ', style: s.dim }], true); continue }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (heading !== null) { emit(inline(heading[2], s.heading, s), []); continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) { lines.push({ spans: lead([{ text: '─'.repeat(Math.max(1, Math.min(width - 2, 40))), style: s.dim }]), soft: false }); continue }
    const quote = /^>\s?(.*)$/.exec(raw)
    if (quote !== null) { emit(inline(quote[1], s.quote, s), [{ text: '│ ', style: s.dim }]); continue }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw)
    if (bullet !== null) { emit(inline(bullet[2], s.text, s), [{ text: `${bullet[1]}• `, style: s.dim }]); continue }
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw)
    if (numbered !== null) { emit(inline(numbered[3], s.text, s), [{ text: `${numbered[1]}${numbered[2]}. `, style: s.dim }]); continue }
    if (raw.trim() === '') { lines.push({ spans: lead(), soft: false }); continue }
    emit(inline(raw, s.text, s), [])
  }
  // An answer never starts or ends with blank lines of its own.
  while (lines.length > 0 && lines[lines.length - 1].spans.every((sp) => sp.decor)) lines.pop()
  while (lines.length > 0 && lines[0].spans.every((sp) => sp.decor)) lines.shift()
  return lines
}
