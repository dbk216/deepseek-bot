/**
 * What the conversation is made of, as transcript blocks.
 *
 * Each block lays itself out for a width and carries a version, so the transcript re-wraps only
 * what changed. The answer being streamed is the one mutable block: deltas append to it, a failed
 * attempt is dropped from it, and the end replaces it with the committed text.
 */
import { banner } from './render/banner.js'
import { sgr, theme, type ColorMode } from './render/style.js'
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

export function userBlock(text: string, mode: ColorMode): Block {
  const style = sgr(theme.user, mode)
  return {
    id: nextId('user'),
    version: 0,
    lines: (width) => [blank(), ...layout(text, width, sgr(theme.text, mode), { first: pad('› ', style), rest: pad('  ') })],
  }
}

export interface AnswerBlock extends Block {
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
  return { id: nextId('tool'), version: 0, lines: (width) => layout(text, width, style, { first: pad('⏺ ', mark), rest: pad('  ') }) }
}

/** What folded blocks (thinking, tool steps) show: a few lines, or all of them (ctrl+o). Shared. */
export interface Detail { expanded: boolean }

const FOLDED = { thinking: 3, diff: 10, result: 3 }
const UNFOLDED = { thinking: 400, diff: 200, result: 40 }

/** Lines past `limit` folded into one "… N줄 더" line. */
function fold(lines: Line[], limit: number, detail: Detail, style: string): Line[] {
  if (lines.length <= limit) return lines
  return [...lines.slice(0, limit), { spans: [pad('    '), { text: `… ${lines.length - limit}줄 더${detail.expanded ? '' : ' · ctrl+o'}`, style }], soft: false }]
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
  const head = sgr(theme.muted, mode)
  const body = sgr({ ...theme.muted, italic: true }, mode)
  let own = 0
  const block: ThinkingBlock = {
    id: nextId('thinking'),
    // The layout depends on ctrl+o as much as on the text.
    get version() { return own * 2 + (detail.expanded ? 1 : 0) },
    text: '',
    streaming: true,
    append(text) { block.text += text; own++ },
    reset() { block.text = ''; own++ },
    done() { block.streaming = false; own++ },
    lines(width) {
      const text = block.text.trim()
      if (text === '') return []
      const label = block.streaming ? '생각 중…' : `생각함 · ${[...text].length}자${detail.expanded ? '' : ' · ctrl+o 펼치기'}`
      const lines: Line[] = [{ spans: [pad('✻ ', head), { text: label, style: head }], soft: false }]
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
  diff?: Array<{ path: string; old: string | null; new: string; oldCut?: boolean; newCut?: boolean }>
}

export interface ToolCallBlock extends Block {
  callId?: string
  result(ok: boolean, text: string): void
}

/** A tool call: its name and title, an edit's changed lines, then its result under it. */
export function toolCallBlock(step: ToolStep, detail: Detail, mode: ColorMode): ToolCallBlock {
  const mark = sgr(theme.toolMark, mode)
  const style = sgr(theme.tool, mode)
  const removed = sgr(theme.danger, mode)
  const added = sgr(theme.ok, mode)
  // Only what changed: the lines around a change are in the file. Of a cut edit, a change after
  // the last line both sides share may be no change at all — the other side's copy of that line can
  // lie past its cut. So there a removal is withheld when the new side was cut (the line may still
  // be in the file), and an addition when the old side was (it may have been there already).
  let uncompared = false
  let withheld = 0
  const changes = (step.diff ?? []).flatMap((d) => {
    const ops = lineDiff(d.old === null ? [] : d.old.split('\n'), d.new.split('\n'))
    // Too long to compare line by line: said, never guessed at.
    if (ops === null) { uncompared = true; return [] }
    const shared = ops.map((l) => l.op).lastIndexOf(' ')
    const sure = ops.slice(0, shared + 1)
    const tail = ops.slice(shared + 1).filter((l) => !(l.op === '-' && d.newCut === true) && !(l.op === '+' && d.oldCut === true))
    withheld += ops.length - sure.length - tail.length
    return [...sure, ...tail].filter((l) => l.op !== ' ')
  })
  const cut = (step.diff ?? []).some((d) => d.oldCut === true || d.newCut === true)
  let own = 0
  let outcome: { ok: boolean; text: string } | null = null
  const block: ToolCallBlock = {
    id: nextId('tool'),
    get version() { return own * 2 + (detail.expanded ? 1 : 0) },
    callId: step.callId,
    result(ok, text) { outcome = { ok, text }; own++ },
    lines(width) {
      const title = (step.title ?? '').split('\n')[0]
      const out = layout(title === '' || title === step.name ? step.name : `${step.name}  ${title}`, width, style, { first: pad('⏺ ', mark), rest: pad('  ') })
      const diff = changes.flatMap((d) => layout(d.text === '' ? ' ' : d.text, width, d.op === '-' ? removed : added, { first: pad(`  ${d.op} `, d.op === '-' ? removed : added), rest: pad('    ') }))
      out.push(...fold(diff, detail.expanded ? UNFOLDED.diff : FOLDED.diff, detail, style))
      const note = uncompared ? '… 변경이 커서 줄 단위로 비교하지 않음'
        : !cut ? ''
          : changes.length > 0 ? '… 큰 변경이라 앞부분만 표시 (잘림)'
            : withheld > 0 ? '… 큰 변경: 잘린 경계의 줄이라 표시하지 않음 (잘림)'
              : '… 큰 변경: 표시할 수 있는 앞부분에 차이 없음 (잘림)'
      if (note !== '') out.push({ spans: [pad('    '), { text: note, style }], soft: false })
      if (outcome !== null) {
        const shown = outcome.ok ? style : removed
        const text = outcome.text.replace(/\s+$/, '')
        const rows = layout(text === '' ? '(출력 없음)' : text, width, shown, { first: pad('  ⎿ ', shown), rest: pad('    ') })
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
        { spans: [pad('  '), { text: 'deepbot', style: sgr(theme.brand, mode) }, { text: `  ${info()}`, style: sgr(theme.muted, mode) }], soft: false },
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
