import type { ITableJson } from '@univerjs/sheets-table'
import { overlaps } from './format-ranges'
import { openTag, valueOf } from './format-xml'
import { readRels, relsPath } from './patch'
import { ruleBook, type RulesOptions } from './rules-reader'
import { RulesRefused } from './rules-xml'
import { fullCalculation, sharedText, tableCells, type CellPlan } from './tables-cells'
import {
  defaultColumn,
  fileReferences,
  fold,
  footerOn,
  headerOn,
  parseTable,
  renderTable,
  sameTable,
  tableBox,
  TablesRefused,
  type SourceTable,
  type TableModel
} from './tables-model'
import {
  CONTENT_TYPES,
  dropRelationship,
  tableGuards,
  tableLinks,
  updateContentTypes,
  worksheet,
  type TableSheet
} from './tables-package'
import { tableReferences, type TableReferenceEdit } from './tables-refs'
import { parseRef } from './xml'
import { writeZip } from './zip'

export { TablesRefused, type TableModel } from './tables-model'
export type TablesOptions = RulesOptions
export interface TablesEdit {
  kind: 'tables'
  sheet: string
  /** The complete table list for this tab. */
  tables: readonly TableModel[]
}
export interface TablesReport {
  partsChanged: string[]
  partsAdded: string[]
  partsRemoved: string[]
}

function bookOf(bytes: Uint8Array, options: TablesOptions) {
  try {
    return ruleBook(bytes, options)
  } catch (err) {
    if (err instanceof RulesRefused) throw new TablesRefused(err.message)
    throw err
  }
}

export interface ReadTablesResult {
  sheets: Record<string, { id: string; tables: TableModel[] }>
}

/** Read Excel tab names and their Univer table models without reading grid cells. */
export function readTables(
  bytes: Uint8Array,
  sheet?: string,
  options: TablesOptions = {}
): ReadTablesResult {
  const { zip, book, read, sheetIds } = bookOf(bytes, options)
  const tabs = book.sheets.filter(
    (tab) => tab.kind === 'worksheet' && (sheet === undefined || sheet === tab.name)
  )
  if (sheet !== undefined && !tabs.length) throw new TablesRefused(`No worksheet named “${sheet}”.`)
  const sheets: ReadTablesResult['sheets'] = Object.create(null)
  for (const tab of tabs) {
    const hasPart = readRels(zip, tab.part).rels.some(
      (rel) => !rel.external && rel.type.endsWith('/table')
    )
    sheets[tab.name] = {
      id: sheetIds[tab.index],
      tables: hasPart
        ? worksheet(zip, tab.part, tab.name, read).tables.map(({ model }) => model)
        : []
    }
  }
  return { sheets }
}

/**
 * For a cell's formula on its way into this file, already in file form: its table references in the
 * words Excel keeps (`fileReferences`). `[@Qty]` means the table the cell sits in; a bare table name is
 * the whole table. Rows and columns count from 1. A workbook with no table gets its formulas back as
 * they came.
 */
export function cellReferences(
  bytes: Uint8Array,
  options: TablesOptions = {}
): (sheet: string, row: number, col: number, formula: string) => string {
  let sheets: ReadTablesResult['sheets']
  try {
    ;({ sheets } = readTables(bytes, undefined, options))
  } catch (err) {
    if (err instanceof TablesRefused) return (_sheet, _row, _col, formula) => formula
    throw err
  }
  const tables = new Set<string>()
  for (const tab of Object.values(sheets))
    for (const table of tab.tables) tables.add(fold(table.name))
  if (!tables.size) return (_sheet, _row, _col, formula) => formula
  return (sheet, row, col, formula) => {
    const own = sheets[sheet]?.tables.find(({ range }) => {
      const box = tableBox(range)
      return row >= box.r1 && row <= box.r2 && col >= box.c1 && col <= box.c2
    })
    return fileReferences(formula, { own: own?.name ?? '', tables })
  }
}

function validateName(name: string) {
  const invalid = `“${name}” is not a valid Excel table name.`
  if (
    !/^[\p{L}_\\][\p{L}\p{M}\p{N}_.]*$/u.test(name) ||
    name.length > 255 ||
    /^_xlnm\./i.test(name) ||
    /^(?:R(?:\d+)?C(?:\d+)?|R|C|TRUE|FALSE)$/i.test(name)
  )
    throw new TablesRefused(invalid)
  if (/^[A-Z]{1,3}\d+$/i.test(name)) {
    try {
      parseRef(name)
    } catch {
      return
    }
    throw new TablesRefused(`“${name}” looks like an Excel cell address.`)
  }
}

interface TablePlan extends CellPlan {
  id: number
  file: string
  rid: string
  changed: boolean
}

const MAX_TABLES = 1024
function namedMatches(models: readonly ITableJson[], existing: SourceTable[]) {
  const ids = new Map(existing.map((source) => [source.model.id, source]))
  const names = new Map(existing.map((source) => [fold(source.model.name), source]))
  const assigned = new Set<SourceTable>()
  const match = models.map(({ id }) => {
    const source = ids.get(id)
    if (source) assigned.add(source)
    return source
  })
  return models.map(({ name }, index) => {
    if (match[index]) return match[index]
    const source = names.get(fold(name))
    if (!source || assigned.has(source)) return undefined
    assigned.add(source)
    return source
  })
}

function columnsFor(
  model: TableModel,
  width: number,
  source: SourceTable | undefined,
  freshId: () => number
) {
  const input = model.columns.length ? model.columns : (model.options.columns ?? [])
  if (input.length > width)
    throw new TablesRefused(`Table “${model.name}” has more columns than its range.`)
  const retained = new Map(source?.model.columns.map((col) => [col.id, col]))
  const reserved = new Set(input.map(({ id }) => id).filter((id) => retained.has(id)))
  const ids = new Set<string>()
  return Array.from({ length: width }, (_, index) => {
    const col = input[index] ?? defaultColumn(index)
    const match = retained.get(col.id)
    const at = source?.model.columns[index]
    const old = match ?? (at && !reserved.has(at.id) ? at : undefined)
    const id = old?.id ?? 'col' + freshId()
    if (ids.has(id)) throw new TablesRefused(`Table “${model.name}” repeats a column ID.`)
    ids.add(id)
    const out = { ...col, id }
    if (old && out.formula === old.formula) out.formulaIsArray ??= old.formulaIsArray
    if (old && out.totalsRowFunction === old.totalsRowFunction)
      out.totalsRowFormula ??= old.totalsRowFormula
    if (out.totalsRowFormula) out.totalsRowFunction = 'custom'
    return out
  })
}

function nextId(used: Set<number>) {
  let id = 1
  return () => {
    while (used.has(id)) id++
    if (id > 0xffffffff) throw new TablesRefused('The workbook has no free Excel table IDs.')
    used.add(id)
    return id++
  }
}

/** Change only the package parts required to write the supplied table lists. */
export function patchTables(
  bytes: Uint8Array,
  edits: readonly TablesEdit[],
  options: TablesOptions = {}
): { bytes: Uint8Array; report: TablesReport } {
  const report: TablesReport = { partsChanged: [], partsAdded: [], partsRemoved: [] }
  if (!edits.length && !options.sheetIds) return { bytes, report }
  const { zip, book, read: readPart, wb, sheetIds } = bookOf(bytes, options)
  const cached = new Map<string, string>()
  const read = (part: string): string => {
    let xml = cached.get(part)
    if (xml === undefined) {
      xml = readPart(part)
      cached.set(part, xml)
    }
    return xml
  }
  if (!edits.length) return { bytes, report }
  const tabs = new Map(book.sheets.map((tab) => [tab.name, tab]))
  const edited = new Map<string, TablesEdit>()
  for (const edit of edits) {
    const tab = tabs.get(edit.sheet)
    if (!tab || tab.kind !== 'worksheet')
      throw new TablesRefused(`No worksheet named “${edit.sheet}”.`)
    if (edited.has(edit.sheet))
      throw new TablesRefused(`Give one complete table list for “${edit.sheet}”.`)
    if (edit.tables.length > MAX_TABLES)
      throw new TablesRefused(`Save at most ${MAX_TABLES} tables per workbook.`)
    edited.set(edit.sheet, edit)
  }

  const sheets = new Map<string, TableSheet>()
  const referencedTables = new Set<string>()
  const ids = new Set<number>(),
    columnIds = new Set<number>()
  const reserve = (table: SourceTable) => {
    ids.add(table.id)
    for (const column of table.model.columns) columnIds.add(Number(column.id.slice(3)))
  }
  for (const tab of book.sheets) {
    if (tab.kind !== 'worksheet') continue
    if (
      !edited.has(tab.name) &&
      !readRels(zip, tab.part).rels.some((rel) => rel.type.endsWith('/table'))
    )
      continue
    const sheet = worksheet(zip, tab.part, tab.name, read)
    sheets.set(tab.name, sheet)
    for (const table of sheet.tables) {
      if (referencedTables.has(table.file))
        throw new TablesRefused(`More than one sheet points to “${table.file}”.`)
      referencedTables.add(table.file)
      reserve(table)
    }
  }

  const files = new Set([...zip.byName.keys()].map(fold))
  const contentTypes = read(CONTENT_TYPES)
  for (const part of contentTypes.matchAll(/\bPartName=["']\/([^"']+)["']/g))
    files.add(fold(part[1]))
  for (const file of zip.byName.keys())
    if (/^xl\/tables\/[^/]+\.xml$/i.test(file) && !referencedTables.has(file))
      reserve(parseTable(read(file), file, ''))
  const allocTable = nextId(ids),
    allocColumn = nextId(columnIds)
  const allocFile = () => {
    let n = 1
    while (files.has(`xl/tables/table${n}.xml`)) n++
    const file = `xl/tables/table${n}.xml`
    files.add(file)
    return file
  }

  const names = new Set(Object.values(wb.read(sheetIds)).map(({ name }) => fold(name)))
  const taken = new Set(names)
  let count = 0
  for (const [name, sheet] of sheets) {
    if (edited.has(name)) continue
    for (const table of sheet.tables) taken.add(fold(table.model.name))
    count += sheet.tables.length
  }

  // Every table's name, as the file has it and as the edit leaves it: a formula that says one bare
  // names the whole table.
  const tableNames = new Set<string>()
  for (const sheet of sheets.values())
    for (const table of sheet.tables) tableNames.add(fold(table.model.name))
  for (const edit of edited.values())
    for (const table of edit.tables) tableNames.add(fold(table.name))

  const updates = new Map<string, string>()
  const additions = new Map<string, string>()
  const remove = new Set<string>()
  const refEdits = new Map<string, TableReferenceEdit>()
  const sharedRel = book.wbRels.rels.find(
    (rel) => !rel.external && rel.type.endsWith('/sharedStrings')
  )
  const shared = sharedText(() => sharedRel && read(sharedRel.target))
  let recalc = false

  for (const [name, edit] of edited) {
    const sheet = sheets.get(name)!
    const guard = tableGuards(sheet, read)
    const sources = namedMatches(edit.tables, sheet.tables)
    const kept = new Set(sources.filter((source) => source !== undefined))
    const rels = new Set(sheet.rels.rels.map(({ id }) => id))
    const allocRel = () => {
      let n = 1
      while (rels.has('rId' + n)) n++
      const key = 'rId' + n
      rels.add(key)
      return key
    }
    const seenIds = new Set<string>()
    const plans: TablePlan[] = []
    for (const [i, input] of edit.tables.entries()) {
      const source = sources[i]
      const box = tableBox(input.range)
      const width = box.c2 - box.c1 + 1
      const inputName = fold(input.name)
      if (taken.has(inputName)) {
        const kind = names.has(inputName) ? 'a defined name' : 'another table'
        throw new TablesRefused(`“${input.name}” already names ${kind} in this workbook.`)
      }
      if (input.id && seenIds.has(input.id))
        throw new TablesRefused(`“${name}” repeats a table ID.`)
      seenIds.add(input.id)
      taken.add(inputName)
      if (++count > MAX_TABLES)
        throw new TablesRefused(`Save at most ${MAX_TABLES} tables per workbook.`)
      if (
        input.filters.tableColumnFilterList?.some(Boolean) ||
        input.filters.tableSortInfo ||
        input.options.filters?.some(Boolean)
      )
        throw new TablesRefused(`Set filter criteria for table “${input.name}” in Excel.`)
      const model = { ...input, columns: columnsFor(input, width, source, allocColumn) }
      const changed = !source || !sameTable(model, source, box, tableNames)
      if (changed) {
        validateName(model.name)
        if (box.r2 - box.r1 + 1 < 1 + Number(headerOn(model)) + Number(footerOn(model)))
          throw new TablesRefused(
            `Table “${model.name}” needs at least one data row besides its header and total rows.`
          )
        guard(box, model.name)
      }
      const overlap = plans.find((entry) => overlaps(entry.box, box))
      if (overlap)
        throw new TablesRefused(
          `Tables “${model.name}” and “${overlap.model.name}” overlap on “${name}”.`
        )
      plans.push({
        box,
        model,
        source,
        changed,
        id: source?.id ?? allocTable(),
        file: source?.file ?? allocFile(),
        rid: source?.rid ?? allocRel()
      })
    }
    for (const old of sheet.tables) {
      if (kept.has(old)) continue
      const type = valueOf(openTag(old.part.xml, old.part.root), 'tableType')
      if (zip.byName.has(relsPath(old.file)) || type === 'xml' || type === 'queryTable')
        throw new TablesRefused(`Remove the linked table “${old.model.name}” in Excel.`)
      remove.add(old.file)
      refEdits.set(fold(old.model.name), {
        name: old.model.name,
        sheetPart: sheet.path,
        oldRange: old.box
      })
    }
    const changed = plans.filter((plan) => plan.changed)
    const links = tableLinks(sheet, plans)
    if (links) {
      if (links.xml === null) remove.add(links.path)
      else (zip.byName.has(links.path) ? updates : additions).set(links.path, links.xml)
    }
    if (changed.length) {
      const cells = tableCells(sheet.part, changed, shared, tableNames)
      updates.set(sheet.path, cells.xml)
      recalc ||= cells.recalc
    } else if (links) updates.set(sheet.path, sheet.part.render())
    for (const plan of changed) {
      const { source, model, box, file, id } = plan
      const xml = renderTable(model, box, id, source, tableNames)
      ;(source ? updates : additions).set(file, xml)
      // A rename changes references, and a dropped column must not leave one dangling.
      if (!source) continue
      const current = new Set(model.columns.map((col) => fold(col.displayName)))
      const dropped = new Set(
        source.model.columns.map((col) => fold(col.displayName)).filter((col) => !current.has(col))
      )
      const renamed = model.name !== source.model.name
      if (renamed || dropped.size)
        refEdits.set(fold(source.model.name), {
          name: source.model.name,
          next: renamed ? model.name : undefined,
          sheetPart: sheet.path,
          oldRange: source.box,
          dropped
        })
    }
  }

  if (refEdits.size) {
    for (const [key, edit] of refEdits) {
      if ((!edit.dropped || (edit.next && fold(edit.next) !== key)) && taken.has(key))
        throw new TablesRefused(`Reuse the name “${edit.name}” in a separate table edit.`)
    }
    const formulaParts = new Map<string, string>([[book.wbPart, 'Workbook']])
    for (const tab of book.sheets)
      if (tab.kind === 'worksheet') formulaParts.set(tab.part, tab.name)
    for (const path of [...zip.byName.keys(), ...additions.keys()])
      if (referencedTables.has(path) || /^xl\/(charts|tables)\/[^/]+\.xml$/i.test(path))
        formulaParts.set(path, path)
    for (const [path, location] of formulaParts) {
      if (remove.has(path)) continue
      const previous = additions.get(path) ?? updates.get(path) ?? read(path)
      const next = tableReferences(previous, path, location, refEdits)
      if (previous === next) continue
      ;(additions.has(path) ? additions : updates).set(path, next)
      recalc = true
    }
  }
  if (recalc) {
    updates.set(book.wbPart, fullCalculation(updates.get(book.wbPart) ?? read(book.wbPart)))
    const chain = book.wbRels.rels.find((rel) => !rel.external && rel.type.endsWith('/calcChain'))
    if (chain) {
      remove.add(chain.target)
      updates.set(relsPath(book.wbPart), dropRelationship(book.wbRels.text, chain.id))
    }
  }
  const tableAdds = [...additions.keys()].filter((path) => /^xl\/tables\/table\d+\.xml$/.test(path))
  if (remove.size || tableAdds.length)
    updates.set(CONTENT_TYPES, updateContentTypes(contentTypes, remove, tableAdds))

  const enc = new TextEncoder()
  const replace = new Map<string, Uint8Array>(),
    add = new Map<string, Uint8Array>()
  for (const [path, xml] of updates)
    if (!remove.has(path) && xml !== read(path)) replace.set(path, enc.encode(xml))
  for (const [path, xml] of additions) add.set(path, enc.encode(xml))
  report.partsChanged = [...replace.keys()]
  report.partsAdded = [...add.keys()]
  report.partsRemoved = [...remove]
  if (!replace.size && !add.size && !remove.size) return { bytes, report }
  return { bytes: writeZip(zip, replace, remove, add), report }
}
