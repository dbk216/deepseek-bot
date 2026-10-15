/**
 * A list to pick one row from, shown in the input box's place: /model's models, /sessions'
 * conversations. Pure, so its rules are tested without a screen.
 *
 * ↑↓ (and the wheel) move, a digit jumps to that row, ↵ (or a click) picks, esc closes. Typing filters
 * the rows: a row stays when every word typed is in its label or detail, in any case; after a letter,
 * digits are typed too. A row that lists efforts has one of its own, stepped with ←→; it starts at the
 * effort the row was given, or at none (the model's default), from which → takes the first and ← the last.
 */

export interface PickerRow {
  label: string
  detail?: string
  /** What the conversation is on now: marked, and where the highlight starts. */
  current?: boolean
  /** The efforts the row's model takes; [] for none. Absent: not a model, or not known. */
  efforts?: string[]
  effort?: string | null
}

export interface PickerSpec {
  title: string
  rows: PickerRow[]
  /** The row picked, with the effort chosen for it (null: none, the model's default). */
  onPick(index: number, effort: string | null): void
}

export class Picker {
  readonly spec: PickerSpec
  cursor: number
  /** What was typed to filter the rows. */
  query = ''
  private readonly efforts: Array<string | null>
  /** The rows the filter leaves, by their index in the list. */
  private matches: number[]

  constructor(spec: PickerSpec) {
    this.spec = spec
    this.cursor = Math.max(0, spec.rows.findIndex((r) => r.current === true))
    this.efforts = spec.rows.map((r) => (r.effort != null && (r.efforts ?? []).includes(r.effort) ? r.effort : null))
    this.matches = spec.rows.map((_, i) => i)
  }

  /** The rows shown, by their index in the list. */
  get shown(): readonly number[] {
    return this.matches
  }

  /** Where the highlight is among the rows shown, from 1; 0 when none is. */
  get position(): number {
    return this.matches.indexOf(this.cursor) + 1
  }

  /** Typed into the filter. The highlight stays on its row while the row matches, or goes to the first that does. */
  type(text: string): void {
    this.query += text
    this.refilter()
  }

  /** Backspace in the filter: false when there was nothing typed to take back. */
  erase(): boolean {
    if (this.query === '') return false
    this.query = [...this.query].slice(0, -1).join('')
    this.refilter()
    return true
  }

  private refilter(): void {
    const words = this.query.toLowerCase().split(/\s+/).filter((w) => w !== '')
    this.matches = this.spec.rows.flatMap((r, i) => {
      const text = `${r.label} ${r.detail ?? ''}`.toLowerCase()
      return words.every((w) => text.includes(w)) ? [i] : []
    })
    if (!this.matches.includes(this.cursor) && this.matches.length > 0) this.cursor = this.matches[0]
  }

  get rows(): PickerRow[] {
    return this.spec.rows
  }

  /** Whether the highlighted row can have an effort line: a row with efforts, or one that takes none. */
  get hasEffortLine(): boolean {
    return this.spec.rows.some((r) => r.efforts !== undefined)
  }

  /** Whether any row has efforts to step: the hint names ←→ only then. */
  get hasEfforts(): boolean {
    return this.spec.rows.some((r) => (r.efforts ?? []).length > 0)
  }

  effortAt(i: number): string | null {
    return this.efforts[i] ?? null
  }

  move(delta: number): void {
    const n = this.matches.length
    if (n === 0) return
    const at = Math.max(0, this.matches.indexOf(this.cursor))
    this.cursor = this.matches[(at + delta + n) % n]
  }

  /** A digit with nothing typed: row n (1-based), when there is one. */
  jump(n: number): boolean {
    if (this.query !== '' || n < 1 || n > this.spec.rows.length) return false
    this.cursor = n - 1
    return true
  }

  /** ←→: the highlighted row's effort, through the ones it takes, round. */
  stepEffort(delta: number): boolean {
    const values = this.spec.rows[this.cursor]?.efforts ?? []
    if (values.length === 0) return false
    const at = values.indexOf(this.efforts[this.cursor] ?? '')
    const next = at === -1 ? (delta > 0 ? 0 : values.length - 1) : (at + delta + values.length) % values.length
    this.efforts[this.cursor] = values[next]
    return true
  }

  pick(): void {
    if (!this.matches.includes(this.cursor)) return
    this.spec.onPick(this.cursor, this.effortAt(this.cursor))
  }

  /**
   * At most `max` lines around the highlight: its rows (positions among the rows shown), and a line
   * counting the rows above the window and one counting those below, each only when there are some.
   */
  window(max: number): { first: number; count: number; above: number; below: number } {
    const n = this.matches.length
    if (n <= max) return { first: 0, count: n, above: 0, below: 0 }
    const at = Math.max(0, this.position - 1)
    const place = (count: number) => Math.max(0, Math.min(at - count + 1, n - count))
    // Too little room for the counts: rows only.
    if (max < 3) { const count = Math.max(1, max); return { first: place(count), count, above: 0, below: 0 } }
    let count = Math.max(1, max - 1)
    let first = place(count)
    // Rows hidden at both ends: a line for each.
    if (first > 0 && first + count < n) { count = Math.max(1, max - 2); first = place(count) }
    return { first, count, above: first, below: n - first - count }
  }
}
