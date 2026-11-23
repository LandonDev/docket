import type { DependsInput } from './depends'
import { readRels, workbookMap } from './patch'
import { attr, parseAttrs, unesc } from './xml'
import { readText, readZip, type Zip } from './zip'

/**
 * A package as the dependency proof reads it (depends.ts): each worksheet's XML read when it is
 * asked for, the workbook part for its names, each table with its sheet, and whether it carries
 * macros.
 */
export function dependsInput(bytes: Uint8Array, zip: Zip = readZip(bytes)): DependsInput {
  const wb = workbookMap(zip)
  const sheets = wb.sheets.filter((s) => s.kind === 'worksheet' && zip.byName.has(s.part))
  const tables: { sheet: string; name: string; ref: string }[] = []
  for (const sheet of sheets) {
    for (const rel of readRels(zip, sheet.part).rels) {
      if (rel.external || !rel.type.endsWith('/table') || !zip.byName.has(rel.target)) continue
      const tag = /<(?:[\w.-]+:)?table(?=[\s>])[^>]*>/.exec(readText(zip, rel.target))?.[0]
      const attrs = tag ? parseAttrs(tag) : []
      const ref = attr(attrs, 'ref')
      // A structured reference names a table by its displayName; `name` is the same in every file Excel writes.
      const name = attr(attrs, 'displayName') ?? attr(attrs, 'name')
      if (ref && name) tables.push({ sheet: sheet.name, name: unesc(name), ref })
    }
  }
  const texts = new Map<string, string>()
  return {
    sheets: sheets.map((s) => ({
      name: s.name,
      index: s.index,
      xml: () => {
        let text = texts.get(s.part)
        if (text === undefined) texts.set(s.part, (text = readText(zip, s.part)))
        return text
      }
    })),
    workbookXml: wb.wbXml,
    tables,
    // A VBA project, an Excel 4 macro sheet or a dialog sheet: any of them may read a cell no formula names.
    macros: [...zip.byName.keys()].some((name) => /(^|\/)vbaProject\.bin$/i.test(name) || /^xl\/(macrosheets|dialogsheets)\//i.test(name)) || wb.sheets.some((s) => s.kind !== 'worksheet' && s.kind !== 'chartsheet')
  }
}
