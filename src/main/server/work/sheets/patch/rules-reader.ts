import type { IConditionFormattingRule } from '@univerjs/sheets-conditional-formatting'
import {
  autoFilter,
  conditionalFormats,
  filterHiddenState,
  parseStyles,
  parseTheme,
  validations
} from 'work-kit/sheet/xlsx'
import { children, elementText, isOn, openTag, valueOf } from './format-xml'
import { workbookMap } from './patch'
import { RulePart, RulesRefused, SHEET_ORDER, inner, xunescape } from './rules-xml'
import { WorkbookNames, workbookSheetIds, type DefinedName } from './rules-names'
import { type SheetFilter, readSort } from './rules-filter'
import { readEntry, readZip } from './zip'
import { parseAttrs } from './xml'

export interface RulesOptions {
  /** Univer sheet IDs in the same order as workbook.xml's sheets. */
  sheetIds?: readonly string[]
}

export interface ReadRulesResult {
  sheets: Record<
    string,
    {
      id: string
      conditional: IConditionFormattingRule[]
      validation: ReturnType<typeof validations>['rules']
      filter: SheetFilter | null
    }
  >
  names: Record<string, DefinedName>
}

export function ruleBook(bytes: Uint8Array, options: RulesOptions) {
  const zip = readZip(bytes)
  const book = workbookMap(zip)
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  const read = (part: string) => decoder.decode(readEntry(zip, part))
  const wbXml = read(book.wbPart)
  const originalIds = workbookSheetIds(wbXml)
  const sheetIds = options.sheetIds ?? originalIds
  if (
    sheetIds.length !== originalIds.length ||
    new Set(sheetIds).size !== sheetIds.length ||
    sheetIds.some((id) => typeof id !== 'string' || !id)
  )
    throw new RulesRefused('Supply one distinct Univer ID for each sheet in workbook order.')
  const rel = (type: string) =>
    book.wbRels.rels.find((r) => !r.external && r.type.endsWith('/' + type))?.target
  const readOptional = (part: string | undefined) =>
    part && zip.byName.has(part) ? read(part) : undefined
  const stylePart = rel('styles')
  const wb = new WorkbookNames(wbXml)
  return {
    zip,
    book,
    read,
    readOptional,
    wbXml,
    wb,
    sheetIds,
    stylePart,
    theme: () => parseTheme(readOptional(rel('theme')))
  }
}

/** Feed only rule elements to work-kit's exact importer feature readers. */
export function ruleTail(part: RulePart, kinds: readonly string[]): string {
  const names = new Set(kinds.map((kind) => part.prefix + kind))
  return part.siblings
    .filter((el) => names.has(el.name))
    .map((el) => elementText(part.xml, el))
    .join('')
}

export const conditionalModels = (
  part: RulePart,
  id: string,
  theme: string[],
  styles: string | undefined
) =>
  conditionalFormats(ruleTail(part, ['conditionalFormatting', 'extLst']), id, {
    theme,
    dxfs: parseStyles(styles, theme).dxfs
  }).rules

/** Legacy workbooks store one hidden bit. Read it only when there is a filter to describe. */
function legacyHiddenRows(part: RulePart, from: number, to: number) {
  const data = part.first('sheetData')
  const hidden: number[] = []
  if (!data) return hidden
  let index = -1
  for (const row of children(part.xml, data)) {
    if (row.name !== part.prefix + 'row') break
    const opening = openTag(part.xml, row)
    index = Number(valueOf(opening, 'r') ?? index + 2) - 1
    if (index > to) break
    if (index > from && isOn(valueOf(opening, 'hidden'))) hidden.push(index)
  }
  return hidden
}

function readFilter(part: RulePart): SheetFilter | null {
  const af = part.first('autoFilter')
  if (!af) return null
  const opening = openTag(part.xml, af)
  const element = {
    attrs: Object.fromEntries(
      parseAttrs(opening).map(({ name, value }) => [name, xunescape(value)])
    ),
    inner: inner(part.xml, af)
  }
  const model = autoFilter(element, [])
  if (!model) return null
  const rows =
    filterHiddenState(ruleTail(part, ['extLst']))?.filtered ??
    legacyHiddenRows(part, model.ref.startRow, model.ref.endRow)
  if (rows.length) model.cachedFilteredOut = rows
  const sort = readSort(part, af)
  return sort ? { ...model, sortState: sort } : model
}

/** Read workbook names and each requested worksheet's rules by Excel tab name. */
export function readRules(
  bytes: Uint8Array,
  sheet?: string,
  options: RulesOptions = {}
): ReadRulesResult {
  const { book, read, readOptional, wb, sheetIds, stylePart, theme } = ruleBook(bytes, options)
  const sheets: ReadRulesResult['sheets'] = Object.create(null)
  const picked = book.sheets.filter(
    (tab) => tab.kind === 'worksheet' && (sheet === undefined || tab.name === sheet)
  )
  if (sheet !== undefined && !picked.length)
    throw new RulesRefused(`No worksheet named “${sheet}”.`)
  let colors: string[] | undefined
  let styles: ReturnType<typeof parseStyles> | undefined
  for (const tab of picked) {
    const part = new RulePart(read(tab.part), 'worksheet', SHEET_ORDER)
    const id = sheetIds[tab.index]
    const cf = ruleTail(part, ['conditionalFormatting', 'extLst'])
    if (part.first('conditionalFormatting') && !styles)
      styles = parseStyles(readOptional(stylePart), (colors ??= theme()))
    sheets[tab.name] = {
      id,
      conditional: styles
        ? conditionalFormats(cf, id, { dxfs: styles.dxfs, theme: colors! }).rules
        : [],
      validation: validations(ruleTail(part, ['dataValidations', 'extLst']), id).rules,
      filter: readFilter(part)
    }
  }
  return { sheets, names: wb.read(sheetIds) }
}
