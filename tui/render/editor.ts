/**
 * The input box: multi-line text, a cursor that moves by grapheme, and history.
 *
 * Positions are grapheme indexes into the whole text, so a Hangul syllable or an emoji is one
 * step of the arrow keys and one Backspace, never half a character. The box wraps at the
 * grapheme where a row fills (not at words, unlike messages): that keeps every cursor position
 * mapped to exactly one cell, which is what up/down and the hardware cursor need.
 */
import { graphemes, graphemeWidth } from './width.js'

export interface EditorLayout {
  rows: string[]
  /** Cursor position within the text area. */
  cursor: { x: number; y: number }
}

export class Editor {
  private chars: string[] = []
  private pos = 0
  private history: string[] = []
  private browsing = -1
  private draft = ''

  get text(): string {
    return this.chars.join('')
  }

  get cursor(): number {
    return this.pos
  }

  set(text: string): void {
    this.chars = graphemes(text)
    this.pos = this.chars.length
  }

  insert(text: string): void {
    const add = graphemes(text.replace(/\r\n?/g, '\n'))
    // Not splice(...add): spreading a large paste into a call overflows the stack.
    this.chars = this.chars.slice(0, this.pos).concat(add, this.chars.slice(this.pos))
    this.pos += add.length
    this.browsing = -1
  }

  /** Replace the text between two cursor positions, leaving the cursor after what was put in. */
  replace(from: number, to: number, text: string): void {
    const add = graphemes(text)
    // Held to the text as it is now: positions computed for an earlier text must not leave the
    // cursor past the end, where the layout has no cell for it.
    const start = Math.max(0, Math.min(from, this.chars.length))
    const end = Math.max(start, Math.min(to, this.chars.length))
    this.chars = this.chars.slice(0, start).concat(add, this.chars.slice(end))
    this.pos = start + add.length
    this.browsing = -1
  }

  /** Whether the box shows an earlier entry reached with the arrows, not something being typed. */
  get browsingHistory(): boolean {
    return this.browsing !== -1
  }

  /** What was sent before, oldest first: earlier runs' (loaded) and this one's. */
  get past(): readonly string[] {
    return this.history
  }

  /** Earlier runs' entries, oldest first, placed before this run's. */
  load(entries: readonly string[]): void {
    this.history = [...entries.filter((e) => e.trim() !== ''), ...this.history]
    this.browsing = -1
  }

  // Deleting, like typing, makes a recalled entry text being written again.
  backspace(): void {
    if (this.pos === 0) return
    this.chars.splice(this.pos - 1, 1)
    this.pos--
    this.browsing = -1
  }

  del(): void {
    if (this.pos < this.chars.length) { this.chars.splice(this.pos, 1); this.browsing = -1 }
  }

  left(): void { this.pos = Math.max(0, this.pos - 1) }
  right(): void { this.pos = Math.min(this.chars.length, this.pos + 1) }

  /** Start of the current line (Ctrl+A / Home). */
  home(): void {
    while (this.pos > 0 && this.chars[this.pos - 1] !== '\n') this.pos--
  }

  /** End of the current line (Ctrl+E / End). */
  end(): void {
    while (this.pos < this.chars.length && this.chars[this.pos] !== '\n') this.pos++
  }

  /** Delete back to the start of the line (Ctrl+U). */
  killLine(): void {
    const end = this.pos
    this.home()
    this.chars.splice(this.pos, end - this.pos)
    this.browsing = -1
  }

  /** Delete to the end of the line (Ctrl+K). */
  killToEnd(): void {
    let end = this.pos
    while (end < this.chars.length && this.chars[end] !== '\n') end++
    this.chars.splice(this.pos, end - this.pos)
    this.browsing = -1
  }

  /** Delete the word before the cursor (Ctrl+W / Alt+Backspace). */
  killWord(): void {
    const end = this.pos
    while (this.pos > 0 && /\s/.test(this.chars[this.pos - 1])) this.pos--
    while (this.pos > 0 && !/\s/.test(this.chars[this.pos - 1])) this.pos--
    this.chars.splice(this.pos, end - this.pos)
    this.browsing = -1
  }

  /** Take the text for sending: records history and clears. */
  submit(): string {
    const text = this.text
    if (text.trim() !== '' && this.history[this.history.length - 1] !== text) this.history.push(text)
    this.chars = []
    this.pos = 0
    this.browsing = -1
    return text
  }

  /** Up a visual row, or on the first row back through history. Returns whether anything changed. */
  up(width: number): boolean {
    const { cells, cursor } = this.measure(width)
    if (cursor.y > 0) { this.pos = this.nearest(cells, cursor.y - 1, cursor.x); return true }
    if (this.history.length === 0) return false
    if (this.browsing === -1) { this.draft = this.text; this.browsing = this.history.length }
    if (this.browsing === 0) return false
    this.browsing--
    this.set(this.history[this.browsing])
    return true
  }

  /** Down a visual row, or forward through history toward the draft. */
  down(width: number): boolean {
    const { cells, cursor, rows } = this.measure(width)
    if (cursor.y < rows.length - 1) { this.pos = this.nearest(cells, cursor.y + 1, cursor.x); return true }
    if (this.browsing === -1) return false
    this.browsing++
    if (this.browsing >= this.history.length) { this.browsing = -1; this.set(this.draft) } else this.set(this.history[this.browsing])
    return true
  }

  layout(width: number): EditorLayout {
    const { rows, cursor } = this.measure(width)
    return { rows, cursor }
  }

  /** Every cursor position's cell, the rows' text, and the cursor. */
  private measure(width: number): { cells: Array<{ x: number; y: number }>; rows: string[]; cursor: { x: number; y: number } } {
    const max = Math.max(1, width)
    const cells: Array<{ x: number; y: number }> = []
    const rows: string[] = ['']
    let x = 0
    let y = 0
    for (const g of this.chars) {
      if (g === '\n') {
        cells.push({ x, y })
        y++; x = 0; rows.push('')
        continue
      }
      const w = graphemeWidth(g)
      if (x + w > max) { y++; x = 0; rows.push('') }
      cells.push({ x, y })
      rows[y] += g
      x += w
    }
    // The position after the last character; a full last row puts it at the start of the next.
    if (x >= max) { y++; x = 0; rows.push('') }
    cells.push({ x, y })
    return { cells, rows, cursor: cells[this.pos] }
  }

  /** The position on `row` closest to column `x` without passing it. */
  private nearest(cells: Array<{ x: number; y: number }>, row: number, x: number): number {
    let best = -1
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].y !== row) continue
      if (best === -1 || cells[i].x <= x) best = i
      if (cells[i].x >= x) break
    }
    return best === -1 ? this.pos : best
  }
}
