import { columnStyleAt, type ColumnStyle } from './format-columns'
import {
  COLS,
  ROWS,
  boxRef,
  columnInterval,
  contains,
  fullHeight,
  fullWidth,
  overlaps,
  readRange,
  union
} from './format-ranges'
import {
  FormatRefused,
  children,
  isOn,
  openTag,
  setNumber,
  setSize,
  valueOf,
  withBody,
  type ElementSpan,
  type Splice
} from './format-xml'
import { parseRef, refName, removeAttrInTag, setAttrInTag, type Box } from './xml'

const MAX_CREATED = 1_000_000
const MAX_CROSS_POINTS = 20_000

function tooLarge(): never {
  throw new FormatRefused(
    'This edit would create more than one million cells or rows. Format whole rows or columns, or use a smaller range.'
  )
}

export type RowOperation =
  | {
      order: number
      kind: 'cells'
      boxes: Box[]
      columns: ColumnStyle[]
      style: (old: number) => number
    }
  | { order: number; kind: 'height'; from: number; to: number; height: number | null }
  | { order: number; kind: 'merge'; box: Box; columns: ColumnStyle[]; anchorStyle?: number }

type ActiveOperation =
  | Exclude<RowOperation, { kind: 'cells' }>
  | (Extract<RowOperation, { kind: 'cells' }> & { prepare: CellSelection })

function selection(boxes: Box[]) {
  const columns = union(boxes.filter(fullHeight).map(columnInterval))
  const wholeGrid = columns.some(({ from, to }) => from === 1 && to === COLS)
  const wholeRow = boxes.some((box) => !fullHeight(box) && fullWidth(box))
  const explicit = union(
    boxes.filter((box) => !fullHeight(box) && !fullWidth(box)).map(columnInterval)
  )
  return {
    columns,
    wholeGrid,
    wholeRow,
    explicit,
    targets: wholeRow ? [{ from: 1, to: COLS }] : union([...columns, ...explicit])
  }
}
type CellSelection = ReturnType<typeof selection>

/** Sweep range boundaries once. Between them the same edits apply to every row. */
class RowTimeline {
  private events: { row: number; start: boolean; operation: RowOperation; box?: Box }[] = []
  private current = new Map<RowOperation, Set<Box>>()
  private cursor = 0
  active: ActiveOperation[] = []

  constructor(operations: RowOperation[]) {
    for (const operation of operations) {
      const add = (from: number, to: number, box?: Box) => {
        this.events.push({ row: from, start: true, operation, box })
        this.events.push({ row: to + 1, start: false, operation, box })
      }
      if (operation.kind === 'height') add(operation.from, operation.to)
      else if (operation.kind === 'merge') add(operation.box.r1, operation.box.r2)
      else for (const box of operation.boxes) add(box.r1, box.r2, box)
    }
    this.events.sort((a, b) => a.row - b.row)
  }

  get next() {
    return this.events[this.cursor]?.row ?? ROWS + 1
  }

  seek(row: number) {
    if (row < this.next) return
    while (this.cursor < this.events.length && this.next <= row) {
      const { operation, box, start } = this.events[this.cursor++]
      if (start) {
        const boxes = this.current.get(operation) ?? new Set<Box>()
        if (box) boxes.add(box)
        this.current.set(operation, boxes)
      } else if (box) {
        const boxes = this.current.get(operation)!
        boxes.delete(box)
        if (!boxes.size) this.current.delete(operation)
      } else {
        this.current.delete(operation)
      }
    }
    this.active = [...this.current]
      .sort(([a], [b]) => a.order - b.order)
      .map(([op, boxes]) => (op.kind === 'cells' ? { ...op, prepare: selection([...boxes]) } : op))
  }
}

interface Cell {
  span?: ElementSpan
  tag?: string
  originalStyle: number
  style: number
}

class Row {
  readonly cells = new Map<number, Cell>()
  readonly original: [number, Cell][] = []
  readonly number: number
  readonly originalTag: string
  protectedArray?: (box: Box) => void
  tag: string
  newCells = 0
  private end: number

  constructor(
    number: number,
    private xml: string,
    private prefix: string,
    private span?: ElementSpan
  ) {
    this.number = number
    this.tag = this.originalTag = span ? openTag(xml, span) : `<${prefix}row r="${number}"/>`
    this.end = span?.close ?? 0
  }

  readCells() {
    if (!this.span) return
    let col = 0
    for (const span of children(this.xml, this.span)) {
      if (span.name !== this.prefix + 'c') {
        this.end = span.start
        break
      }
      const tag = openTag(this.xml, span)
      const ref = valueOf(tag, 'r')
      col = ref === undefined ? col + 1 : parseRef(ref).col
      const style = Number(valueOf(tag, 's') ?? 0)
      const cell = { span, tag, originalStyle: style, style }
      this.cells.set(col, cell)
      this.original.push([col, cell])
      if (!this.protectedArray || !this.xml.slice(span.openEnd, span.close).includes('array'))
        continue
      for (const formula of children(this.xml, span)) {
        if (formula.name !== this.prefix + 'f') continue
        const formulaTag = openTag(this.xml, formula)
        const range = valueOf(formulaTag, 'ref')
        if (range && valueOf(formulaTag, 't') === 'array') this.protectedArray(readRange(range))
      }
    }
  }

  defaultStyle(): number | undefined {
    if (!isOn(valueOf(this.tag, 'customFormat'))) return
    const style = valueOf(this.tag, 's')
    return style === undefined ? undefined : Number(style)
  }

  setDefaultStyle(old: number, next: number) {
    if (old !== next) this.tag = setAttrInTag(setNumber(this.tag, 's', next), 'customFormat', '1')
  }

  occupy(col: number, style: number) {
    this.cells.set(col, { originalStyle: style, style })
    this.newCells++
  }

  private cellXml(col: number, cell: Cell) {
    return `<${this.prefix}c r="${refName(this.number, col)}" s="${cell.style}"/>`
  }

  render(changes: Splice[]): string | undefined {
    for (const [, cell] of this.original) {
      if (cell.style !== cell.originalStyle)
        changes.push({
          start: cell.span!.start,
          end: cell.span!.openEnd,
          text: setNumber(cell.tag!, 's', cell.style)
        })
    }
    if (!this.newCells) {
      if (this.span && this.tag !== this.originalTag)
        changes.push({ start: this.span.start, end: this.span.openEnd, text: this.tag })
      return undefined
    }
    const inserted = [...this.cells].filter(([, cell]) => !cell.span).sort(([a], [b]) => a - b)
    const tag = removeAttrInTag(this.tag, 'spans')
    if (!this.span || this.span.openEnd === this.span.end) {
      const text = withBody(
        tag,
        this.prefix + 'row',
        inserted.map(([col, cell]) => this.cellXml(col, cell)).join('')
      )
      if (!this.span) return text
      changes.push({ start: this.span.start, end: this.span.end, text })
      return undefined
    }
    if (tag !== this.originalTag)
      changes.push({ start: this.span.start, end: this.span.openEnd, text: tag })
    let original = 0
    let texts: string[] = []
    let offset = this.span.openEnd
    for (const [col, cell] of inserted) {
      while (original < this.original.length && this.original[original][0] < col) original++
      const at = this.original[original]?.[1].span!.start ?? this.end
      if (offset !== at && texts.length) {
        changes.push({ start: offset, end: offset, text: texts.join('') })
        texts = []
      }
      offset = at
      texts.push(this.cellXml(col, cell))
    }
    changes.push({ start: offset, end: offset, text: texts.join('') })
    return undefined
  }
}

export class FormatRows {
  private newCells = 0
  private newRows = 0
  private crossPoints = new Map<number, number>()

  constructor(
    private xml: string,
    private prefix: string,
    private changes: Splice[],
    private include: (box: Box) => void
  ) {}

  private insertCell(row: Row, col: number, style: number, crossPoint?: number) {
    if (crossPoint !== undefined) {
      const n = (this.crossPoints.get(crossPoint) ?? 0) + 1
      if (n > MAX_CROSS_POINTS)
        throw new FormatRefused(
          'This edit would create more than 20,000 cells where styled rows and columns cross. Use a smaller range.'
        )
      this.crossPoints.set(crossPoint, n)
    }
    if (++this.newCells > MAX_CREATED) tooLarge()
    row.occupy(col, style)
    this.include({ r1: row.number, r2: row.number, c1: col, c2: col })
  }

  private applyCells(row: Row, op: Extract<ActiveOperation, { kind: 'cells' }>) {
    const { columns, wholeGrid, wholeRow, explicit, targets } = op.prepare
    const rowStyle = row.defaultStyle()
    if (wholeRow || (wholeGrid && rowStyle !== undefined))
      row.setDefaultStyle(rowStyle ?? 0, op.style(rowStyle ?? 0))

    // Existing cells use their own xf. Visit them before inserting new styled blanks.
    if (columns.length || wholeRow) {
      for (const [col, cell] of row.cells) {
        if (targets.some(({ from, to }) => col >= from && col <= to))
          cell.style = op.style(cell.style)
      }
    }
    // A blank cell where a styled row crosses a styled column shows the row's style, which the row's new default now carries: only a row with no style of its own needs the crossing written.
    if (wholeRow && !wholeGrid && rowStyle === undefined) {
      for (const { from, to, style } of op.columns) {
        for (let col = from; col <= to; col++) {
          if (!row.cells.has(col)) this.insertCell(row, col, op.style(style), op.order)
        }
      }
    }
    for (const { from, to } of explicit) {
      for (let col = from; col <= to; col++) {
        const cell = row.cells.get(col)
        if (cell) {
          if (!columns.length && !wholeRow) cell.style = op.style(cell.style)
        } else {
          const old = rowStyle ?? columnStyleAt(op.columns, col)
          const next = op.style(old)
          if (next !== old) this.insertCell(row, col, next)
        }
      }
    }
    if (!wholeGrid && !wholeRow && rowStyle !== undefined) {
      const next = op.style(rowStyle)
      for (const { from, to } of columns) {
        for (let col = from; col <= to; col++) {
          if (!row.cells.has(col)) this.insertCell(row, col, next, op.order)
        }
      }
    }
  }

  private applyMerge(row: Row, op: Extract<RowOperation, { kind: 'merge' }>) {
    const rowStyle = row.defaultStyle()
    const styleAt = (col: number) => rowStyle ?? columnStyleAt(op.columns, col)
    const { c1, c2 } = op.box
    const anchor = (op.anchorStyle ??= row.cells.get(c1)?.style ?? styleAt(c1))
    for (let col = c1; col <= c2; col++) {
      const cell = row.cells.get(col)
      if (cell) cell.style = anchor
      else if (anchor !== 0 || styleAt(col) !== 0) this.insertCell(row, col, anchor)
    }
  }

  private applyRow(row: Row, operations: ActiveOperation[]) {
    for (const op of operations) {
      if (op.kind === 'cells') this.applyCells(row, op)
      else if (op.kind === 'merge') this.applyMerge(row, op)
      else row.tag = setSize(row.tag, 'ht', 'customHeight', op.height)
    }
  }

  apply(data: ElementSpan, operations: RowOperation[], mergeChecks: Box[]) {
    const timeline = new RowTimeline(operations)
    const guardArray = mergeChecks.length
      ? (array: Box) => {
          for (const merge of mergeChecks) {
            if (overlaps(merge, array) && !contains(merge, array))
              throw new FormatRefused(
                `The merge ${boxRef(merge)} crosses part of the array formula range ${boxRef(array)}.`
              )
          }
        }
      : undefined
    const empty = (number: number) => {
      const row = new Row(number, this.xml, this.prefix)
      this.applyRow(row, timeline.active)
      return row
    }
    const insertRows = (from: number, to: number, at: number) => {
      if (from > to) return
      const text: string[] = []
      let next = from
      while (next <= to) {
        timeline.seek(next)
        const last = Math.min(to, timeline.next - 1)
        if (
          timeline.active.some(
            (op) =>
              op.kind === 'merge' ||
              (op.kind === 'height'
                ? op.height !== null
                : op.prepare.wholeRow || op.prepare.explicit.length > 0)
          )
        ) {
          // In this gap every missing row has the same operations and defaults.
          const first = empty(next)
          if (first.tag !== first.originalTag || first.newCells) {
            const remaining = last - next
            this.newRows++
            if (
              this.newRows + remaining > MAX_CREATED ||
              this.newCells + remaining * first.newCells > MAX_CREATED
            )
              tooLarge()
            text.push(first.render(this.changes) ?? first.tag)
            for (let r = next + 1; r <= last; r++) {
              const row = empty(r)
              this.newRows++
              text.push(row.render(this.changes) ?? row.tag)
            }
          }
        }
        next = last + 1
      }
      if (!text.length) return
      if (data.openEnd === data.end) {
        this.changes.push({
          start: data.start,
          end: data.end,
          text: withBody(openTag(this.xml, data), data.name, text.join(''))
        })
      } else this.changes.push({ start: at, end: at, text: text.join('') })
    }

    let last = 0
    let end = data.close
    for (const span of children(this.xml, data)) {
      if (span.name !== this.prefix + 'row') {
        end = span.start
        break
      }
      const tag = openTag(this.xml, span)
      const number = Number(valueOf(tag, 'r') ?? last + 1)
      insertRows(last + 1, number - 1, span.start)
      timeline.seek(number)
      last = number
      if (!guardArray && !timeline.active.length) continue
      const row = new Row(number, this.xml, this.prefix, span)
      row.protectedArray = guardArray
      if (guardArray || timeline.active.some((op) => op.kind !== 'height')) row.readCells()
      this.applyRow(row, timeline.active)
      row.render(this.changes)
    }
    insertRows(last + 1, ROWS, end)
  }
}
