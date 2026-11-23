import { children, documentRoot, isOn, openTag, valueOf } from './format-xml'
import { readRels } from './patch'
import { writeZip, type Zip } from './zip'
import { parseAttrs } from './xml'
import { DifferentialStyles } from './rules-dxf'
import { conditional, type ConditionalRule } from './rules-conditional'
import { filter, type SheetFilter } from './rules-filter'
import { WorkbookNames, type DefinedNames } from './rules-names'
import { validation, type ValidationRule } from './rules-validation'
import { conditionalModels, ruleBook, type RulesOptions } from './rules-reader'
import { RulePart, RulesRefused, SHEET_ORDER, countLimit, fileBoxes, local } from './rules-xml'

export { RulesRefused } from './rules-xml'
export type { DefinedName, DefinedNames } from './rules-names'
export type { FilterSortState, SheetFilter } from './rules-filter'
export type { ConditionalRule } from './rules-conditional'
export type { ValidationRule } from './rules-validation'
export { readRules, type RulesOptions, type ReadRulesResult } from './rules-reader'

export type RulesEdit =
  | { kind: 'conditional'; sheet: string; rules: readonly ConditionalRule[] }
  | { kind: 'validation'; sheet: string; rules: readonly ValidationRule[] }
  | { kind: 'names'; names: DefinedNames }
  | {
      kind: 'filter'
      sheet: string
      filter: SheetFilter | null
      /** Zero-based rows the previous filter hid. Optional for files with no recorded ownership. */
      previousFilteredOut?: readonly number[]
    }

export interface RulesReport {
  partsChanged: string[]
  dxfsAdded: number
}

function filteredTables(zip: Zip, name: string, part: RulePart, read: (name: string) => string) {
  const tableParts = part.first('tableParts')
  if (!tableParts) return []
  const rels = readRels(zip, name).rels.filter(
    (rel) => !rel.external && rel.type.endsWith('/table')
  )
  const lookup = new Map(rels.map((rel) => [rel.id, rel.target]))
  return [...children(part.xml, tableParts)]
    .filter((el) => el.name === part.prefix + 'tablePart')
    .flatMap((el) => {
      const id = parseAttrs(openTag(part.xml, el)).find((a) => a.name.endsWith(':id'))?.value
      const target = id && lookup.get(id)
      if (!target || !zip.byName.has(target))
        throw new RulesRefused('The worksheet lists a table whose file is missing.')
      const xml = read(target)
      const table = documentRoot(xml)
      const ref = table && valueOf(openTag(xml, table), 'ref')
      if (!table || !ref) throw new RulesRefused('A table on this worksheet has no range.')
      return [...children(xml, table)].some((el) => local(el.name) === 'autoFilter')
        ? fileBoxes(ref)
        : []
    })
}

/** Apply rule edits in order and replace only their changed XML parts. */
export function patchRules(
  bytes: Uint8Array,
  edits: readonly RulesEdit[],
  opts: RulesOptions = {}
): { bytes: Uint8Array; report: RulesReport } {
  const report: RulesReport = { partsChanged: [], dxfsAdded: 0 }
  if (!edits.length) return { bytes, report }
  const { zip, book, read, readOptional, wbXml, wb, sheetIds, stylePart, theme } = ruleBook(
    bytes,
    opts
  )
  const sheets = new Map(book.sheets.map((sheet) => [sheet.name, sheet]))
  const updates = new Map<string, { before: string; after: string }>()
  const current = (name: string, source?: string) => {
    let part = updates.get(name)
    if (!part) {
      const text = source ?? read(name)
      part = { before: text, after: text }
      updates.set(name, part)
    }
    return part
  }
  let styles: DifferentialStyles | undefined
  let colors: string[] | undefined
  let additions = 0
  const addedRule = () => countLimit(++additions, 'new worksheet rules')
  for (const edit of edits) {
    if (edit.kind === 'names') {
      const state = current(book.wbPart, wbXml)
      state.after = new WorkbookNames(state.after).replace(edit.names, sheetIds)
      continue
    }
    const sheet = sheets.get(edit.sheet)
    if (!sheet) throw new RulesRefused(`No worksheet named “${edit.sheet}”.`)
    if (sheet.kind !== 'worksheet')
      throw new RulesRefused(
        `“${edit.sheet}” is a ${sheet.kind}, so it cannot hold worksheet rules.`
      )
    const state = current(sheet.part)
    const part = new RulePart(state.after, 'worksheet', SHEET_ORDER)
    const protection = part.first('sheetProtection')
    if (protection && isOn(valueOf(openTag(part.xml, protection), 'sheet')))
      throw new RulesRefused(
        `“${edit.sheet}” is protected in Excel. Unprotect the sheet in Excel first.`
      )
    if (edit.kind === 'conditional')
      conditional(
        part,
        sheetIds[sheet.index],
        edit.rules,
        part.first('conditionalFormatting')
          ? conditionalModels(
              part,
              sheetIds[sheet.index],
              (colors ??= theme()),
              styles?.render() ?? readOptional(stylePart)
            )
          : [],
        (style) => {
          if (!Object.values(style).some((field) => field != null)) return undefined
          if (!stylePart || !zip.byName.has(stylePart))
            throw new RulesRefused('The workbook has no styles part for this conditional format.')
          return (styles ??= new DifferentialStyles(current(stylePart).before)).intern(style)
        },
        addedRule
      )
    else if (edit.kind === 'validation')
      validation(part, sheetIds[sheet.index], edit.rules, wb.date1904, addedRule)
    else {
      const range = filter(
        part,
        edit.filter,
        () => filteredTables(zip, sheet.part, part, read),
        edit.previousFilteredOut
      )
      const state = current(book.wbPart, wbXml)
      state.after = new WorkbookNames(state.after).filter(edit.sheet, sheet.index, range)
    }
    state.after = part.render()
  }
  if (styles && stylePart) {
    report.dxfsAdded = styles.appends
    current(stylePart).after = styles.render()
  }
  const encoder = new TextEncoder()
  const replace = new Map<string, Uint8Array>()
  for (const [name, state] of updates) {
    if (state.before === state.after) continue
    report.partsChanged.push(name)
    replace.set(name, encoder.encode(state.after))
  }
  return { bytes: replace.size ? writeZip(zip, replace, new Set(), new Map()) : bytes, report }
}
