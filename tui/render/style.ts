/**
 * Colour and text attributes, resolved once for the terminal in front of us.
 *
 * Three modes: 24-bit when the terminal says it has it (`COLORTERM`), the 256-colour cube
 * otherwise, and nothing at all under `NO_COLOR`. A style is reduced to its SGR string up front,
 * and that string doubles as the cell's style key, so the diff compares styles as strings.
 */

export type ColorMode = 'truecolor' | '256' | 'none'

export type Rgb = readonly [number, number, number]

export interface Style {
  fg?: Rgb
  bg?: Rgb
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

export function detectColorMode(env: Record<string, string | undefined>): ColorMode {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none'
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return 'truecolor'
  return '256'
}

/** Nearest entry in the xterm 6×6×6 cube or the grey ramp. */
export function rgbTo256([r, g, b]: Rgb): number {
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)))
  const steps = [0, 95, 135, 175, 215, 255]
  const [lr, lg, lb] = [level(r), level(g), level(b)]
  const cube = 16 + 36 * lr + 6 * lg + lb
  const cubeDist = (steps[lr] - r) ** 2 + (steps[lg] - g) ** 2 + (steps[lb] - b) ** 2
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)))
  const greyValue = 8 + grey * 10
  const greyDist = (greyValue - r) ** 2 + (greyValue - g) ** 2 + (greyValue - b) ** 2
  return greyDist < cubeDist ? 232 + grey : cube
}

/**
 * The SGR sequence for a style, always starting from a reset so a cell never inherits
 * attributes from whatever was drawn before it. `''` means "default", which is the key the
 * screen's empty cells carry.
 */
export function sgr(style: Style | undefined, mode: ColorMode): string {
  if (style === undefined) return ''
  const codes: string[] = []
  if (style.bold) codes.push('1')
  if (style.dim) codes.push('2')
  if (style.italic) codes.push('3')
  if (style.underline) codes.push('4')
  if (style.inverse) codes.push('7')
  if (mode !== 'none') {
    if (style.fg) codes.push(mode === 'truecolor' ? `38;2;${style.fg.join(';')}` : `38;5;${rgbTo256(style.fg)}`)
    if (style.bg) codes.push(mode === 'truecolor' ? `48;2;${style.bg.join(';')}` : `48;5;${rgbTo256(style.bg)}`)
  }
  return codes.length === 0 ? '' : `\x1b[0;${codes.join(';')}m`
}

/** Linear blend from `a` to `b`, `t` in [0, 1]. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t))
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k)) as unknown as Rgb
}

/** The palette of docs/logo.svg. */
export const palette = {
  primary: [0x2e, 0x7b, 0xff] as Rgb,
  deep: [0x0b, 0x3f, 0xa8] as Rgb,
  accent: [0x1e, 0x6f, 0xff] as Rgb,
  light: [0x5b, 0x9b, 0xff] as Rgb,
  muted: [0x8a, 0x93, 0xa6] as Rgb,
  text: [0xe6, 0xe9, 0xef] as Rgb,
  warn: [0xf2, 0xb0, 0x3d] as Rgb,
  danger: [0xf0, 0x5a, 0x5a] as Rgb,
  ok: [0x4c, 0xc3, 0x8a] as Rgb,
}

/** Named styles the views use, so a view never spells a colour. */
export const theme = {
  text: {} as Style,
  muted: { fg: palette.muted } as Style,
  dim: { dim: true } as Style,
  user: { fg: palette.light, bold: true } as Style,
  assistant: {} as Style,
  tool: { fg: palette.muted } as Style,
  toolMark: { fg: palette.primary } as Style,
  brand: { fg: palette.primary, bold: true } as Style,
  border: { fg: palette.deep } as Style,
  status: { fg: palette.muted } as Style,
  accent: { fg: palette.primary } as Style,
  warn: { fg: palette.warn } as Style,
  danger: { fg: palette.danger } as Style,
  ok: { fg: palette.ok } as Style,
  selected: { inverse: true } as Style,
  bold: { bold: true } as Style,
  italic: { italic: true } as Style,
  code: { fg: palette.light } as Style,
  heading: { fg: palette.primary, bold: true } as Style,
  quote: { fg: palette.muted, italic: true } as Style,
  codeBlock: { fg: palette.text } as Style,
  link: { fg: palette.light, underline: true } as Style,
}
