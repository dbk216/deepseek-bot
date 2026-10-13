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
import { stripState } from './interview.js'

function markdownStyles(mode: ColorMode): MarkdownStyles {
  return {
    text: sgr(theme.assistant, mode), bold: sgr(theme.bold, mode), italic: sgr(theme.italic, mode), code: sgr(theme.code, mode),
    heading: sgr(theme.heading, mode), quote: sgr(theme.quote, mode), codeBlock: sgr(theme.codeBlock, mode), dim: sgr(theme.muted, mode), link: sgr(theme.link, mode),
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
