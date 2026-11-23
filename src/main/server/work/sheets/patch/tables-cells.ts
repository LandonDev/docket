import { overlaps } from './format-ranges'
import { children, documentRoot, openTag, valueOf, type ElementSpan } from './format-xml'
import { translate } from './formula'
import { BOOK_ORDER, inner, local, RulePart, tag, xunescape } from './rules-xml'
import { arrayRanges, patchSheet, type CellWrite, type Edit } from './sheet'
import { refName, parseRef, setAttrInTag, type Box } from './xml'
import {
  fileFormula,
  fileReferences,
  fold,
  footerOn,
  headerOn,
  sameFormula,
  TablesRefused,
  totalFormula,
  type FormulaContext,
  type TableColumn,
  type TableModel,
  type SourceTable
} from './tables-model'

function textRuns(xml: string, item: ElementSpan): string {
  let text = ''
  for (const el of children(xml, item)) {
    if (local(el.name) === 't') text += xunescape(inner(xml, el))
    if (local(el.name) === 'r')
      for (const child of children(xml, el))
        if (local(child.name) === 't') text += xunescape(inner(xml, child))
  }
  return text
}

export function sharedText(read: () => string | undefined) {
  let loaded = false
  let xml = ''
  let items: IterableIterator<ElementSpan> | undefined
  const strings: string[] = []
  return (index: number): string | undefined => {
    if (!loaded) {
      loaded = true
      xml = read() ?? ''
      const root = documentRoot(xml)
      if (root) items = children(xml, root)
    }
    while (items && strings.length <= index) {
      const next = items.next()
      if (next.done) break
      if (local(next.value.name) === 'si') strings.push(textRuns(xml, next.value))
    }
    return strings[index]
  }
}

interface Cell {
  type?: string
  value?: string
  formula?: string
}

export interface CellPlan {
  box: Box
  model: TableModel
  source?: SourceTable
}

function sameTotal(
  previous: TableColumn | undefined,
  next: TableColumn | undefined,
  table: FormulaContext
) {
  return (
    !!previous &&
    !!next &&
    previous.id === next.id &&
    previous.totalsRowLabel === next.totalsRowLabel &&
    sameFormula(previous.totalsRowFormula, next.totalsRowFormula, table) &&
    previous.totalsRowFunction === next.totalsRowFunction
  )
}

function sameFooterPosition(plan: CellPlan) {
  return (
    !!plan.source &&
    footerOn(plan.source.model) &&
    footerOn(plan.model) &&
    plan.source.box.r2 === plan.box.r2 &&
    plan.source.box.c1 === plan.box.c1
  )
}

export function tableCells(
  part: RulePart,
  plans: CellPlan[],
  shared: (index: number) => string | undefined,
  tables: ReadonlySet<string>
) {
  const rows = new Set<number>()
  // A total cell Excel saved says `SUBTOTAL(109,Sales[Units])`, another writer's `SUBTOTAL(109,[Units])`:
  // one formula, so both are compared as Excel would write them.
  const said = fileReferences
  for (const plan of plans) {
    const { box, model, source } = plan
    const table = { own: model.name, tables }
    if (headerOn(model)) rows.add(box.r1)
    if (
      source &&
      footerOn(source.model) &&
      (!sameFooterPosition(plan) ||
        source.model.columns.some((col, i) => !sameTotal(col, model.columns[i], table)))
    )
      rows.add(source.box.r2)
    if (footerOn(model)) rows.add(box.r2)
  }
  const { xml, prefix } = part
  const cells = new Map<string, Cell>()
  const data = part.first('sheetData')
  if (data && rows.size) {
    const end = Math.max(...rows)
    let r = 0
    for (const row of children(xml, data)) {
      if (row.name !== prefix + 'row') continue
      r = Number(valueOf(openTag(xml, row), 'r') ?? r + 1)
      if (r > end) break
      if (!rows.has(r)) continue
      let c = 0
      for (const cell of children(xml, row)) {
        if (cell.name !== prefix + 'c') continue
        const opening = openTag(xml, cell)
        const ref = valueOf(opening, 'r')
        c = ref ? parseRef(ref).col : c + 1
        const type = valueOf(opening, 't')
        let value: string | undefined, formula: string | undefined
        for (const el of children(xml, cell)) {
          if (el.name === prefix + 'f') formula = xunescape(inner(xml, el))
          if (el.name === prefix + 'v') value = xunescape(inner(xml, el))
          if (el.name === prefix + 'is') value = textRuns(xml, el)
        }
        if (type === 's' && value !== undefined) {
          const index = Number(value)
          if (!Number.isSafeInteger(index) || index < 0 || (value = shared(index)) === undefined)
            throw new TablesRefused(`The shared text in cell ${refName(r, c)} is missing.`)
        }
        if (type === 'b' && value !== undefined) value = value === '1' ? 'TRUE' : 'FALSE'
        cells.set(refName(r, c), { type, value, formula })
      }
    }
  }
  const writes = new Map<string, Edit>()
  const set = (row: number, col: number, write: CellWrite) => {
    writes.set(refName(row, col), { row, col, write })
    if (writes.size > 250_000)
      throw new TablesRefused(
        'This table edit needs more than 250,000 cell writes. Make it in smaller steps or use Excel.'
      )
  }
  const current = (row: number, col: number) => cells.get(refName(row, col))
  const textCell = (cell: Cell | undefined) =>
    !!cell && ['s', 'inlineStr', 'str'].includes(cell.type ?? '') && cell.formula === undefined
  const writeText = (row: number, col: number, value: string) => {
    const cell = current(row, col)
    if (textCell(cell) && cell?.value === value) {
      if (writes.get(refName(row, col))?.write.kind === 'clear') writes.delete(refName(row, col))
    } else set(row, col, { kind: 'text', value })
  }

  // Remove old totals only when the edit moves or changes them and their cells still match.
  for (const plan of plans) {
    const { model, source } = plan
    if (!source || !footerOn(source.model) || !rows.has(source.box.r2)) continue
    const was = { own: source.model.name, tables }
    for (const [i, column] of source.model.columns.entries()) {
      if (
        sameFooterPosition(plan) &&
        sameTotal(column, model.columns[i], { own: model.name, tables })
      )
        continue
      const row = source.box.r2,
        col = source.box.c1 + i
      const cell = current(row, col)
      if (!cell) continue
      if (
        column.totalsRowLabel !== undefined &&
        cell.formula === undefined &&
        cell.value === column.totalsRowLabel
      )
        set(row, col, { kind: 'clear' })
      else if (cell.formula && said(cell.formula, was) === totalFormula(column, was))
        set(row, col, { kind: 'clear' })
    }
  }
  for (const plan of plans) {
    const { box, model, source } = plan
    const table = { own: model.name, tables }
    if (headerOn(model)) {
      const headers = model.columns.map((_, i) => current(box.r1, box.c1 + i))
      for (const [i, cell] of headers.entries()) {
        if (cell?.formula !== undefined || cell?.type === 'e')
          throw new TablesRefused(
            `Table header ${refName(box.r1, box.c1 + i)} must be text or a plain value. Replace its formula or error first.`
          )
      }
      const used = new Set<string>()
      const names = headers.map((cell) => (cell?.value?.trim() ? cell.value : ''))
      const reserved = new Set(names.filter(Boolean).map(fold))
      for (const [i, column] of model.columns.entries()) {
        const raw = names[i]
        let name = raw
        if (!name) {
          let n = i + 1
          do name = `Column${n++}`
          while (reserved.has(fold(name)) || used.has(fold(name)))
        } else if (used.has(fold(name))) {
          let n = 2
          do name = raw + n++
          while (reserved.has(fold(name)) || used.has(fold(name)))
        }
        column.displayName = name
        used.add(fold(name))
        writeText(box.r1, box.c1 + i, name)
      }
    }
    const names = new Set<string>()
    const oldById = new Map(source?.model.columns.map((col, i) => [col.id, { col, i }]))
    for (const [i, column] of model.columns.entries()) {
      const name = column.displayName
      if (
        !name.trim() ||
        name.length > 255 ||
        /[\u0000-\u001f]/.test(name) ||
        names.has(fold(name))
      )
        throw new TablesRefused(
          `“${name}” is not a distinct table column name of 1 to 255 characters.`
        )
      names.add(fold(name))
      const file = totalFormula(column, table)
      if (file && column.totalsRowLabel !== undefined)
        throw new TablesRefused(`Choose a total label or a formula for “${name}”.`)
      const oldAt = source?.model.columns[i]
      if (
        footerOn(model) &&
        (!sameFooterPosition(plan) ||
          !sameTotal(oldAt, column, table) ||
          oldAt?.displayName !== name)
      ) {
        const col = box.c1 + i
        if (file) {
          const there = current(box.r2, col)?.formula
          if (there !== undefined && said(there, table) === file) {
            if (writes.get(refName(box.r2, col))?.write.kind === 'clear')
              writes.delete(refName(box.r2, col))
          } else set(box.r2, col, { kind: 'formula', file })
        } else if (column.totalsRowLabel !== undefined)
          writeText(box.r2, col, column.totalsRowLabel)
      }
      if (!column.formula) continue
      const old = oldById.get(column.id)
      const first = box.r1 + Number(headerOn(model))
      const last = box.r2 - Number(footerOn(model))
      const sameColumn =
        old &&
        source &&
        source.box.c1 + old.i === box.c1 + i &&
        sameFormula(old.col.formula, column.formula, table) &&
        old.col.formulaIsArray === column.formulaIsArray &&
        source.box.r1 === box.r1
      const firstWrite = sameColumn
        ? Math.max(first, source.box.r2 + 1 - Number(footerOn(source.model)))
        : first
      if (firstWrite > last) continue
      if (column.formulaIsArray)
        throw new TablesRefused(`Change the array formula in table column “${name}” in Excel.`)
      if (last - firstWrite + 1 > 250_000)
        throw new TablesRefused(
          'This calculated column needs more than 250,000 cell writes. Make it in Excel.'
        )
      const formula = fileFormula(column.formula, table)
      for (let row = firstWrite; row <= last; row++)
        set(row, box.c1 + i, { kind: 'formula', file: translate(formula, row - first, 0) })
    }
  }
  if (!writes.size) return { xml: part.render(), recalc: false }
  const edits = [...writes.values()]
  const arrays = arrayRanges(xml, prefix)
  for (const { row, col } of edits)
    if (arrays.some(({ box }) => overlaps(box, { r1: row, r2: row, c1: col, c2: col })))
      throw new TablesRefused(
        `The table edit would overwrite an array formula at ${refName(row, col)}.`
      )
  const result = patchSheet(part.render(), edits, { strings: 'inline' })
  return {
    xml: result.xml,
    recalc:
      result.report.formulasAdded > 0 ||
      result.report.formulasRemoved > 0 ||
      edits.some((edit) => edit.write.kind === 'formula')
  }
}

export function fullCalculation(xml: string): string {
  const book = new RulePart(xml, 'workbook', BOOK_ORDER)
  const calc = book.first('calcPr')
  if (calc) {
    const opening = openTag(xml, calc)
    book.changes.push({
      start: calc.start,
      end: calc.openEnd,
      text:
        valueOf(opening, 'fullCalcOnLoad') === 'true'
          ? opening
          : setAttrInTag(opening, 'fullCalcOnLoad', '1')
    })
  } else book.add('calcPr', tag(book.prefix + 'calcPr', { fullCalcOnLoad: '1' }))
  return book.render()
}
