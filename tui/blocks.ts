/**
 * What the conversation is made of, as transcript blocks.
 *
 * Each block lays itself out for a width and carries a version, so the transcript re-wraps only
 * what changed. The answer being streamed is the one mutable block: deltas append to it, a failed
 * attempt is dropped from it, and the end replaces it with the committed text.
 */
import { banner } from './render/banner.js'
import { t } from './strings.js'
import { palette, sgr, theme, type ColorMode } from './render/style.js'
import { blink, currentFrame, shimmer } from './render/motion.js'
import { stringWidth } from './render/width.js'
import { layout, type Line, type Span } from './render/text.js'
import { markdown, type MarkdownStyles } from './render/markdown.js'
import { lineDiff } from './render/linediff.js'
import { stripState } from './interview.js'

function markdownStyles(mode: ColorMode): MarkdownStyles {
  return {
    text: sgr(theme.assistant, mode), bold: sgr(theme.bold, mode), italic: sgr(theme.italic, mode), code: sgr(theme.code, mode),
    heading: sgr(theme.heading, mode), quote: sgr(theme.quote, mode), codeBlock: sgr(theme.codeBlock, mode), dim: sgr(theme.muted, mode), link: sgr(theme.link, mode),
    keyword: sgr(theme.codeKeyword, mode), string: sgr(theme.codeString, mode), comment: sgr(theme.codeComment, mode), number: sgr(theme.codeNumber, mode),
  }
}
import type { Block } from './render/transcript.js'

let counter = 0
const nextId = (kind: string) => `${kind}-${++counter}`

const pad = (text: string, style = ''): Span => ({ text, style, decor: true })

/** The display width of a line's spans. */
const widthOf = (line: Line) => line.spans.reduce((n, span) => n + stringWidth(span.text), 0)

/** What the person said, on a band of its own across the pane, so a question never reads as part of an answer. */
export function userBlock(text: string, mode: ColorMode): Block {
  const banded = mode !== 'none'
  const mark = sgr(banded ? theme.userMark : theme.user, mode)
  const body = sgr(banded ? theme.userBand : theme.text, mode)
  return {
    id: nextId('user'),
    version: 0,
    lines(width) {
      const lines = layout(text, width, body, { first: pad('› ', mark), rest: pad('  ', body) })
      // The band runs to the edge; without colour there is no band, and no trailing spaces.
      if (banded) for (const line of lines) line.spans.push(pad(' '.repeat(Math.max(0, width - widthOf(line))), body))
      return [blank(), ...lines]
    },
  }
}

/** A line between one exchange and the next. */
export function ruleBlock(mode: ColorMode): Block {
  const style = sgr(theme.rule, mode)
  return { id: nextId('rule'), version: 0, lines: (width) => [blank(), { spans: [pad('  '), pad('─'.repeat(Math.max(0, width - 4)), style)], soft: false }] }
}

export interface AnswerBlock extends Block {
  version: number
  text: string
  streaming: boolean
  append(delta: string): void
  /** A failed attempt is retried from scratch: forget what it streamed. */
  reset(): void
  finish(text?: string): void
}

export function answerBlock(mode: ColorMode): AnswerBlock {
  const styles = markdownStyles(mode)
  const caret = sgr(theme.accent, mode)
  const mark = sgr(theme.answerMark, mode)
  const block: AnswerBlock = {
    id: nextId('answer'),
    version: 0,
    text: '',
    streaming: true,
    append(delta) { block.text += delta; block.version++ },
    reset() { block.text = ''; block.version++ },
    finish(text) { if (text !== undefined) block.text = text; block.streaming = false; block.version++ },
    lines(width) {
      // A deep interview's state blocks are for the gauges, not for reading.
      const shown = stripState(block.text)
      if (shown === '' && !block.streaming) return []
      const lines = markdown(shown, width, styles, pad('  '))
      if (lines.length === 0) lines.push({ spans: [pad('  ')], soft: false })
      // A dot where the answer starts, in the indent it would have had.
      const lead = lines[0].spans[0]
      if (lead?.decor === true && lead.text === '  ') lines[0].spans[0] = pad('● ', mark)
      if (block.streaming) lines[lines.length - 1].spans.push({ text: '▍', style: caret, decor: true })
      return lines
    },
  }
  return block
}

export function toolBlock(name: string, detail: string, mode: ColorMode): Block {
  const mark = sgr(theme.toolMark, mode)
  const style = sgr(theme.tool, mode)
  const text = detail === '' ? name : `${name} · ${detail}`
  return { id: nextId('tool'), version: 0, lines: (width) => layout(text, width, style, { first: pad('● ', mark), rest: pad('  ') }) }
}

/** What folded blocks (thinking, tool steps) show: a few lines, or all of them (ctrl+o). Shared. */
export interface Detail { expanded: boolean }

const FOLDED = { thinking: 3, diff: 10, result: 3 }
const UNFOLDED = { thinking: 400, diff: 200, result: 40 }

/** Lines past `limit` folded into one "… N more lines" line. */
function fold(lines: Line[], limit: number, detail: Detail, style: string): Line[] {
  if (lines.length <= limit) return lines
  return [...lines.slice(0, limit), { spans: [pad('    '), { text: `… ${t().moreLines(lines.length - limit)}${detail.expanded ? '' : ' · ctrl+o'}`, style }], soft: false }]
}

export interface ThinkingBlock extends Block {
  text: string
  streaming: boolean
  append(text: string): void
  /** A failed attempt is retried from scratch: forget what it thought. */
  reset(): void
  /** The answer started (or the turn ended): fold to one line. */
  done(): void
}

/** The model's reasoning: its latest lines while it streams, one line after, all of it on ctrl+o. */
export function thinkingBlock(detail: Detail, mode: ColorMode): ThinkingBlock {
  const head = sgr(theme.thinking, mode)
  const body = sgr(theme.thinkingBody, mode)
  let own = 0
  const block: ThinkingBlock = {
    id: nextId('thinking'),
    // The layout depends on ctrl+o as much as on the text, and while it streams, on the frame.
    get version() { return `${own}:${detail.expanded ? 1 : 0}:${block.streaming ? currentFrame() : '-'}` },
    text: '',
    streaming: true,
    append(text) { block.text += text; own++ },
    reset() { block.text = ''; own++ },
    done() { block.streaming = false; own++ },
    lines(width) {
      const text = block.text.trim()
      if (text === '') return []
      const label = block.streaming
        ? shimmer(t().thinking, palette.sky, palette.glint, currentFrame(), mode)
        : [{ text: t().thought([...text].length, detail.expanded), style: head }]
      const lines: Line[] = [{ spans: [pad('✻ ', head), ...label], soft: false }]
      if (!detail.expanded && !block.streaming) return lines
      const all = layout(text, width, body, { first: pad('  '), rest: pad('  ') })
      return [...lines, ...(detail.expanded ? fold(all, UNFOLDED.thinking, detail, head) : all.slice(-FOLDED.thinking))]
    },
  }
  return block
}

export interface ToolStep {
  name: string
  callId?: string
  title?: string
  diff?: Array<{ path: string; old: string | null; new: string | null; oldCut?: boolean; newCut?: boolean }>
}

export interface ToolCallBlock extends Block {
  callId?: string
  name: string
  result(ok: boolean, text: string): void
  /** The turn ended with no result for it: stop blinking. */
  settle(): void
}

/** A tool call: its name and title, an edit's changed lines, then its result under it. */
export function toolCallBlock(step: ToolStep, detail: Detail, mode: ColorMode): ToolCallBlock {
  const marks = {
    on: sgr({ fg: palette.light, bold: true }, mode), off: sgr({ fg: palette.deep }, mode),
    ok: sgr(theme.ok, mode), failed: sgr(theme.danger, mode), settled: sgr(theme.muted, mode),
  }
  const name = sgr({ ...theme.text, bold: true }, mode)
  const style = sgr(theme.tool, mode)
  const removed = sgr(theme.danger, mode)
  const added = sgr(theme.ok, mode)
  // Only what changed: the lines around a change are in the file (and the core sends the changed
  // part alone). When a side was cut, the comparison was made against a text that stops early, and
  // proves little:
  //  - a line of the whole side with no partner may have its partner past the cut — so a removal is
  //    withheld when the new side was cut, and an addition when the old side was;
  //  - a line of the cut side may have been paired with the wrong blank line or brace, leaving a
  //    kept line between them looking changed — so of the cut side only a line whose text is
  //    nowhere on the whole side is shown. That one is certain.
  let uncompared = false
  let withheld = 0
  const linesOf = (text: string | null) => (text === null ? [] : text.split('\n'))
  const changes = (step.diff ?? []).flatMap((d) => {
    const ops = lineDiff(linesOf(d.old), linesOf(d.new))
    // Too long to compare line by line: said, never guessed at.
    if (ops === null) { uncompared = true; return [] }
    const changed = ops.filter((l) => l.op !== ' ')
    const wholeOld = d.newCut === true && d.oldCut !== true ? new Set(linesOf(d.old)) : null
    const wholeNew = d.oldCut === true && d.newCut !== true ? new Set(linesOf(d.new)) : null
    const sure = changed.filter((l) => (l.op === '-'
      ? d.newCut !== true && (wholeNew === null || !wholeNew.has(l.text))
      : d.oldCut !== true && (wholeOld === null || !wholeOld.has(l.text))))
    withheld += changed.length - sure.length
    return sure
  })
  const cut = (step.diff ?? []).some((d) => d.oldCut === true || d.newCut === true)
  let own = 0
  let outcome: { ok: boolean; text: string } | null = null
  let settled = false
  const running = () => outcome === null && !settled
  const block: ToolCallBlock = {
    id: nextId('tool'),
    get version() { return `${own}:${detail.expanded ? 1 : 0}:${running() ? (blink(currentFrame()) ? 'on' : 'off') : '-'}` },
    callId: step.callId,
    name: step.name,
    result(ok, text) { outcome = { ok, text }; own++ },
    settle() { if (running()) { settled = true; own++ } },
    lines(width) {
      const title = (step.title ?? '').split('\n')[0]
      const mark = outcome !== null ? (outcome.ok ? marks.ok : marks.failed) : settled ? marks.settled : blink(currentFrame()) ? marks.on : marks.off
      const out = layout(title === '' || title === step.name ? step.name : `${step.name}  ${title}`, width, style, { first: pad('● ', mark), rest: pad('  ') })
      // The tool's name in bold, what it was asked in the tool's own grey.
      const head = out[0]?.spans[1]
      if (head !== undefined && head.text.startsWith(step.name)) out[0].spans.splice(1, 1, { text: step.name, style: name }, { text: head.text.slice(step.name.length), style })
      const diff = changes.flatMap((d) => layout(d.text === '' ? ' ' : d.text, width, d.op === '-' ? removed : added, { first: pad(`  ${d.op} `, d.op === '-' ? removed : added), rest: pad('    ') }))
      out.push(...fold(diff, detail.expanded ? UNFOLDED.diff : FOLDED.diff, detail, style))
      const note = uncompared ? t().diffUncompared
        : !cut ? ''
          : changes.length > 0 ? (withheld > 0 ? t().diffWithheld(withheld) : t().diffHead)
            : withheld > 0 ? t().diffNoneCertain
              : t().diffNoDifference
      if (note !== '') out.push({ spans: [pad('    '), { text: note, style }], soft: false })
      if (outcome !== null) {
        const shown = outcome.ok ? style : removed
        const text = outcome.text.replace(/\s+$/, '')
        const rows = layout(text === '' ? t().noOutput : text, width, shown, { first: pad('  ⎿ ', shown), rest: pad('    ') })
        out.push(...fold(rows, detail.expanded ? UNFOLDED.result : FOLDED.result, detail, style))
      }
      return out
    },
  }
  return block
}

export type NoticeKind = 'info' | 'warn' | 'error' | 'ok'

export function noticeBlock(text: string, kind: NoticeKind, mode: ColorMode): Block {
  const style = sgr(kind === 'error' ? theme.danger : kind === 'warn' ? theme.warn : kind === 'ok' ? theme.ok : theme.muted, mode)
  const mark = kind === 'error' ? '✕ ' : kind === 'warn' ? '⚠ ' : kind === 'ok' ? '✓ ' : '· '
  return { id: nextId('notice'), version: 0, lines: (width) => layout(text, width, style, { first: pad(mark, style), rest: pad('  ') }) }
}

/** The banner, and one line saying where this terminal is connected. */
export function bannerBlock(info: () => string, mode: ColorMode): Block & { refresh(): void } {
  const block = {
    id: nextId('banner'),
    version: 0,
    refresh() { block.version++ },
    lines(width: number): Line[] {
      return [
        blank(),
        ...banner(width, mode),
        blank(),
        { spans: [pad('  '), { text: 'deepseek-bot', style: sgr(theme.brand, mode) }, { text: `  ${info()}`, style: sgr(theme.muted, mode) }], soft: false },
      ]
    },
  }
  return block
}

export function spacerBlock(): Block {
  return { id: nextId('spacer'), version: 0, lines: () => [blank()] }
}

function blank(): Line {
  return { spans: [], soft: false }
}
