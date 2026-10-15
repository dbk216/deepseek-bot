/**
 * The deepseek-bot mark — the README's whale — in the logo's blue, top to bottom from light to deep. It sits
 * in the welcome box at the start of a conversation, as Claude Code's mark sits in its own; a narrow screen
 * gets the words without it. docs/banner.svg is the README's banner, drawn apart.
 */
import { stringWidth } from './width.js'
import { mix, palette, sgr, type ColorMode } from './style.js'

const MARK = [
  '   ▄▄████▄▄            ▄▄',
  ' ▄██████████▄▄▄     ▄▄██',
  '████▀ ▀████████████████▀',
  '████▄▄▄█████████████▀▀',
  ' ▀████████████▀▀▀',
  '    ▀▀▀▀▀▀',
]

/** How wide the mark is, in columns. */
export const MARK_WIDTH = Math.max(...MARK.map((row) => stringWidth(row)))

/** The mark's rows, each padded to MARK_WIDTH, with its colour. */
export function mark(mode: ColorMode): Array<{ text: string; style: string }> {
  return MARK.map((row, i) => ({
    text: row + ' '.repeat(MARK_WIDTH - stringWidth(row)),
    style: sgr({ fg: mix(palette.light, palette.deep, i / (MARK.length - 1)) }, mode),
  }))
}
