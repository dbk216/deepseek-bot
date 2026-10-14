/**
 * A list to pick one row from, shown just above the input box: /model's models, /sessions'
 * conversations. Pure, so its rules are tested without a screen.
 *
 * ↑↓ (and the wheel) move, a digit jumps to that row, ↵ (or a click) picks, esc closes. A row that
 * lists efforts has one of its own, stepped with ←→; it starts at the effort the row was given, or at
 * none (the model's default), from which → takes the first and ← the last.
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
  private readonly efforts: Array<string | null>

  constructor(spec: PickerSpec) {
    this.spec = spec
    this.cursor = Math.max(0, spec.rows.findIndex((r) => r.current === true))
    this.efforts = spec.rows.map((r) => (r.effort != null && (r.efforts ?? []).includes(r.effort) ? r.effort : null))
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
    const n = this.spec.rows.length
    if (n > 0) this.cursor = (this.cursor + delta + n) % n
  }

  /** A digit: row n (1-based), when there is one. */
  jump(n: number): boolean {
    if (n < 1 || n > this.spec.rows.length) return false
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
    if (this.spec.rows.length === 0) return
    this.spec.onPick(this.cursor, this.effortAt(this.cursor))
  }

  /**
   * At most `max` lines around the highlight: its rows, and a line counting the rows above the window
   * and one counting those below, each only when there are some.
   */
  window(max: number): { first: number; count: number; above: number; below: number } {
    const n = this.spec.rows.length
    if (n <= max) return { first: 0, count: n, above: 0, below: 0 }
    const place = (count: number) => Math.max(0, Math.min(this.cursor - count + 1, n - count))
    // Too little room for the counts: rows only.
    if (max < 3) { const count = Math.max(1, max); return { first: place(count), count, above: 0, below: 0 } }
    let count = Math.max(1, max - 1)
    let first = place(count)
    // Rows hidden at both ends: a line for each.
    if (first > 0 && first + count < n) { count = Math.max(1, max - 2); first = place(count) }
    return { first, count, above: first, below: n - first - count }
  }
}
