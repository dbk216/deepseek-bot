/**
 * The deepseek-bot mark, in the logo's blue, sized to the terminal.
 *
 * One line of block letters needs 93 columns. Two lines need 68, with BOT under the end of DEEPSEEK.
 * Anything narrower gets a one-line wordmark — a banner that wraps is worse than a small one.
 * docs/banner.svg is the one-line banner drawn as an image, for the README.
 */
import { mix, palette, sgr, type ColorMode } from './style.js'
import type { Line } from './text.js'

const GLYPHS: Record<string, string[]> = {
  D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  P: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔═══╝ ', '██║     ', '╚═╝     '],
  S: ['███████╗', '██╔════╝', '███████╗', '╚════██║', '███████║', '╚══════╝'],
  K: ['██╗  ██╗', '██║ ██╔╝', '█████╔╝ ', '██╔═██╗ ', '██║  ██╗', '╚═╝  ╚═╝'],
  B: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██████╔╝', '╚═════╝ '],
  O: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
  T: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
  ' ': ['   ', '   ', '   ', '   ', '   ', '   '],
}

function word(text: string): string[] {
  return GLYPHS[text[0]].map((_, row) => [...text].map((c) => GLYPHS[c][row]).join(''))
}

const ONE = word('DEEPSEEK BOT')
const DEEPSEEK = word('DEEPSEEK'), BOT = word('BOT')
const TWO = [...DEEPSEEK, ...BOT.map((row) => ' '.repeat([...DEEPSEEK[0]].length - [...BOT[0]].length + 4) + row)]
const width = (rows: string[]) => Math.max(...rows.map((r) => [...r].length))

export const BANNER_WIDTHS = { one: width(ONE), two: width(TWO) }

/** Banner lines for a terminal `columns` wide, top-to-bottom gradient from light to deep blue. */
export function banner(columns: number, mode: ColorMode, indent = 2): Line[] {
  const rows = columns >= BANNER_WIDTHS.one + indent * 2 ? ONE
    : columns >= BANNER_WIDTHS.two + indent * 2 ? TWO
      : null
  const pad = { text: ' '.repeat(indent), style: '', decor: true }
  if (rows === null) {
    return [{ spans: [pad, { text: '◆ deepseek-bot', style: sgr({ fg: palette.primary, bold: true }, mode) }], soft: false }]
  }
  return rows.map((row, i) => ({
    spans: [pad, { text: row, style: sgr({ fg: mix(palette.light, palette.deep, i / (rows.length - 1)) }, mode) }],
    soft: false,
  }))
}
