/**
 * What moves on the screen while the bot works: a light sweeping across a label, a mark that
 * blinks while its tool runs. One clock drives all of it — the app's 80 ms tick sets the frame —
 * so every animated block agrees on where the light is, and a block that is not animating never
 * re-lays itself.
 */
import { mix, sgr, type ColorMode, type Rgb, type Style } from './style.js'
import { graphemes } from './width.js'
import type { Span } from './text.js'

let frame = 0

/** The app's tick sets this; blocks read it while they animate. */
export function setFrame(n: number): void {
  frame = n
}

export function currentFrame(): number {
  return frame
}

/** How far either side of its centre the light reaches, in characters. */
const REACH = 3

/**
 * `text` with a light passing over it, left to right: each character blended from `base` toward
 * `light` by its distance from the light's centre, which moves one character a frame and starts
 * again past the end. Without colour there is nothing to sweep, and the text is drawn plain.
 */
export function shimmer(text: string, base: Rgb, light: Rgb, at: number, mode: ColorMode, extra: Style = {}): Span[] {
  if (mode === 'none') return [{ text, style: sgr(extra, mode) }]
  const chars = graphemes(text)
  const cycle = chars.length + REACH * 2 + 4
  const centre = (at % cycle) - REACH
  const out: Span[] = []
  chars.forEach((c, i) => {
    const d = Math.abs(i - centre)
    const style = sgr({ ...extra, fg: mix(base, light, d >= REACH ? 0 : 1 - d / REACH) }, mode)
    const last = out[out.length - 1]
    if (last !== undefined && last.style === style) last.text += c
    else out.push({ text: c, style })
  })
  return out
}

/** On, then off, `period` frames each: a mark that blinks while what it stands for is running. */
export function blink(at: number, period = 6): boolean {
  return Math.floor(at / period) % 2 === 0
}
