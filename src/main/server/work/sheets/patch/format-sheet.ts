import type { CellFormat, FormatEdit } from './format'
import { FormatColumns } from './format-columns'
import { FormatRows, type RowOperation } from './format-rows'
import {
  COLS,
  ROWS,
  boxRef,
  checkAxis,
  columnInterval,
  fullHeight,
  overlaps,
  readRange,
  union
} from './format-ranges'
import { hasFormat } from './format-styles'
import {
  FormatRefused,
  applySplices,
  children,
  documentRoot,
  elements,
  insertionPoint,
  isOn,
  openTag,
  setNumber,
  setSize,
  valueOf,
  withBody,
  type ElementSpan,
  type Splice
} from './format-xml'
import { parseAttrs, removeAttrInTag, setAttrInTag, type Box } from './xml'

const ORDER = (
  'sheetPr dimension sheetViews sheetFormatPr cols sheetData sheetCalcPr sheetProtection ' +
  'protectedRanges scenarios autoFilter sortState dataConsolidate customSheetViews mergeCells ' +
  'phoneticPr conditionalFormatting dataValidations hyperlinks printOptions pageMargins pageSetup ' +
  'headerFooter rowBreaks colBreaks customProperties cellWatches ignoredErrors smartTags drawing ' +
  'legacyDrawing legacyDrawingHF picture oleObjects controls webPublishItems tableParts extLst'
).split(' ')

interface MergeEntry {
  box: Box
  ref: string
  span?: ElementSpan
}

export class FormatSheet {
  private root: ElementSpan
  private siblings: ElementSpan[]
  private prefix: string
  private changes: Splice[] = []
  private used?: Box

  constructor(
    private xml: string,
    private tableRelationships: () => Map<string, () => string>
  ) {
    const root = documentRoot(xml)
    if (!root || !/(^|:)worksheet$/.test(root.name))
      throw new FormatRefused('The worksheet XML is missing.')
    this.root = root
    this.prefix = root.name.slice(0, -'worksheet'.length)
    this.siblings = [...elements(xml, root.openEnd, root.close, this.prefix + 'sheetData')]
  }

  apply(
    edits: FormatEdit[],
    resolveStyle: (format: CellFormat) => (old: number) => number
  ): string {
    const format = this.child('sheetFormatPr')
    const formatTag = format
      ? openTag(this.xml, format)
      : `<${this.prefix}sheetFormatPr defaultRowHeight="15"/>`
    let updatedFormatTag = formatTag
    // A column with no width of its own is `baseColWidth` characters wide (8 unless the file says: Excel for Mac often writes 10). Excel
    // draws it at those characters and 5 px of padding, rounded up to a multiple of 8 px, and a `<col>` stores that as characters:
    // 8 is 61 px, drawn at 64, stored as 9.140625.
    const base = Number(valueOf(formatTag, 'baseColWidth') ?? 8)
    const pixels = Math.ceil(((Number.isFinite(base) && base > 0 ? base : 8) * 7 + 5) / 8) * 8
    const padded = Math.trunc((pixels / 7) * 256) / 256
    const defaultWidth = Number(valueOf(formatTag, 'defaultColWidth') ?? padded)
    const cols = new FormatColumns(
      this.xml,
      this.siblings.filter((el) => el.name === this.prefix + 'cols'),
      this.prefix,
      defaultWidth
    )
    const operations: RowOperation[] = []
    const originalMerges = edits.some((edit) => edit.kind === 'merge' || edit.kind === 'unmerge')
      ? this.merges()
      : []
    const mergeChecks: Box[] = []
    const merges = [...originalMerges]
    let tables: Box[] | undefined

    for (const [order, edit] of edits.entries()) {
      this.checkProtection(edit)
      switch (edit.kind) {
        case 'cells': {
          const ranges =
            edit.range === undefined ? (edit.ranges ?? []) : [edit.range, ...(edit.ranges ?? [])]
          const boxes = ranges.map((range) => readRange(range, true))
          if (!boxes.length || !hasFormat(edit.format)) break
          const columns = cols.styles()
          const style = resolveStyle(edit.format)
          const wholeColumns = union(boxes.filter(fullHeight).map(columnInterval))
          for (const { from, to } of wholeColumns) cols.setStyle(from, to, style)
          // If several whole-column ranges cover the grid together, treat them as one grid edit.
          if (wholeColumns.some(({ from, to }) => from === 1 && to === COLS)) {
            operations.push({
              order,
              kind: 'cells',
              boxes: [{ r1: 1, r2: ROWS, c1: 1, c2: COLS }],
              columns,
              style
            })
          } else operations.push({ order, kind: 'cells', boxes, columns, style })
          break
        }
        case 'colWidth':
          checkAxis(edit.from, edit.to, COLS, edit.width, 255, 'column')
          cols.setWidth(edit.from + 1, edit.to + 1, edit.width)
          break
        case 'rowHeight': {
          checkAxis(edit.from, edit.to, ROWS, edit.height, 409, 'row')
          const wholeSheet = edit.from === 0 && edit.to === ROWS - 1
          if (wholeSheet) {
            if (edit.height !== null)
              updatedFormatTag = setSize(
                updatedFormatTag,
                'defaultRowHeight',
                'customHeight',
                edit.height
              )
            else if (isOn(valueOf(updatedFormatTag, 'customHeight')))
              updatedFormatTag = setNumber(
                removeAttrInTag(updatedFormatTag, 'customHeight'),
                'defaultRowHeight',
                15
              )
          }
          operations.push({
            order,
            kind: 'height',
            from: edit.from + 1,
            to: edit.to + 1,
            height: wholeSheet ? null : edit.height
          })
          break
        }
        case 'merge':
        case 'unmerge': {
          const box = readRange(edit.range)
          const merge = edit.kind === 'merge'
          const ref = boxRef(box)
          if (merge && box.r1 === box.r2 && box.c1 === box.c2)
            throw new FormatRefused(`Merging ${ref} requires at least two cells.`)
          if (merge) {
            tables ??= this.tables()
            if (tables.some((table) => overlaps(box, table)))
              throw new FormatRefused(
                `Cells in a table can't be merged. ${ref} overlaps a table on “${edit.sheet}”.`
              )
            mergeChecks.push(box)
          }
          const exact = this.findMerge(merges, box, ref)
          if (merge && exact === -1) {
            operations.push({ order, kind: 'merge', box, columns: cols.styles() })
            merges.push({ box, ref })
            this.include(box)
          } else if (!merge && exact !== -1) merges.splice(exact, 1)
        }
      }
    }
    if (operations.length || mergeChecks.length) {
      const data = this.child('sheetData')
      if (!data) throw new FormatRefused('The worksheet is missing its sheet data.')
      new FormatRows(this.xml, this.prefix, this.changes, (box) => this.include(box)).apply(
        data,
        operations,
        mergeChecks
      )
    }
    if (updatedFormatTag !== formatTag) {
      if (format)
        this.changes.push({ start: format.start, end: format.openEnd, text: updatedFormatTag })
      else this.insert('sheetFormatPr', updatedFormatTag)
    }
    cols.render(this.xml, this.changes, (name, text) => this.insert(name, text))
    this.renderMerges(originalMerges, merges)
    this.expandDimension()
    return applySplices(this.xml, this.changes)
  }

  private child(name: string) {
    return this.siblings.find((el) => el.name === this.prefix + name)
  }

  private insert(name: string, text: string) {
    const at = insertionPoint(this.root, this.siblings, name, ORDER, this.prefix)
    this.changes.push({ start: at, end: at, text })
  }

  private checkProtection(edit: FormatEdit) {
    const protection = this.child('sheetProtection')
    if (!protection) return
    const tag = openTag(this.xml, protection)
    if (!isOn(valueOf(tag, 'sheet'))) return
    // ECMA-376 CT_SheetProtection flags are prohibitions. For formatting, false permits
    // the operation, and the schema default (when the attribute is absent) is true.
    const flag = {
      cells: 'formatCells',
      colWidth: 'formatColumns',
      rowHeight: 'formatRows',
      merge: undefined,
      unmerge: undefined
    }[edit.kind]
    if (!flag || !['0', 'false'].includes(valueOf(tag, flag) ?? ''))
      throw new FormatRefused(
        `“${edit.sheet}” is protected in Excel. Unprotect the sheet in Excel first.`
      )
  }

  private tables(): Box[] {
    const parts = this.child('tableParts')
    if (!parts) return []
    const readTables = this.tableRelationships()
    const tables: Box[] = []
    for (const entry of children(this.xml, parts)) {
      if (entry.name !== this.prefix + 'tablePart') continue
      const id = parseAttrs(openTag(this.xml, entry)).find((attr) =>
        attr.name.endsWith(':id')
      )?.value
      const read = id && readTables.get(id)
      if (!read) throw new FormatRefused('The worksheet lists a table whose file is missing.')
      const xml = read()
      const table = documentRoot(xml)
      const ref = table && valueOf(openTag(xml, table), 'ref')
      if (!ref) throw new FormatRefused('A table on this worksheet has no range.')
      tables.push(readRange(ref))
    }
    return tables
  }

  private include(box: Box) {
    const used = this.used
    this.used = used
      ? {
          r1: Math.min(used.r1, box.r1),
          c1: Math.min(used.c1, box.c1),
          r2: Math.max(used.r2, box.r2),
          c2: Math.max(used.c2, box.c2)
        }
      : box
  }

  private expandDimension() {
    const dimension = this.child('dimension')
    if (!this.used || !dimension) return
    const tag = openTag(this.xml, dimension)
    const ref = valueOf(tag, 'ref')
    if (!ref) return
    const original = readRange(ref)
    this.include(original)
    const expanded = boxRef(this.used)
    if (boxRef(original) !== expanded)
      this.changes.push({
        start: dimension.start,
        end: dimension.openEnd,
        text: setAttrInTag(tag, 'ref', expanded)
      })
  }

  private merges(): MergeEntry[] {
    const root = this.child('mergeCells')
    if (!root) return []
    return [...children(this.xml, root)]
      .filter((el) => el.name === this.prefix + 'mergeCell')
      .map((span) => {
        const box = readRange(valueOf(openTag(this.xml, span), 'ref')!)
        return { ref: boxRef(box), box, span }
      })
  }

  private findMerge(merges: MergeEntry[], box: Box, ref: string): number {
    let exact = -1
    for (const [i, entry] of merges.entries()) {
      if (entry.ref === ref) exact = i
      else if (overlaps(box, entry.box))
        throw new FormatRefused(
          `${ref} overlaps the existing merge ${entry.ref}. Use the existing merge's full range to unmerge it.`
        )
    }
    return exact
  }

  private renderMerges(original: MergeEntry[], updated: MergeEntry[]) {
    const root = this.child('mergeCells')
    const keep = new Set(updated)
    const added = updated
      .filter((entry) => !entry.span)
      .map(({ ref }) => `<${this.prefix}mergeCell ref="${ref}"/>`)
      .join('')
    const removed = original.filter((entry) => !keep.has(entry))
    if (!added && !removed.length) return
    if (!root) {
      this.insert(
        'mergeCells',
        `<${this.prefix}mergeCells count="${updated.length}">${added}</${this.prefix}mergeCells>`
      )
      return
    }
    if (!updated.length) {
      this.changes.push({ start: root.start, end: root.end, text: '' })
      return
    }
    const tag = setNumber(openTag(this.xml, root), 'count', updated.length)
    if (root.openEnd === root.end) {
      this.changes.push({ start: root.start, end: root.end, text: withBody(tag, root.name, added) })
      return
    }
    if (tag !== openTag(this.xml, root))
      this.changes.push({ start: root.start, end: root.openEnd, text: tag })
    for (const { span } of removed)
      this.changes.push({ start: span!.start, end: span!.end, text: '' })
    if (added) this.changes.push({ start: root.close, end: root.close, text: added })
  }
}
