import { posix } from 'node:path'
import {
  children,
  elementText,
  isOn,
  openTag,
  setNumber,
  valueOf
} from './format-xml'
import { overlaps } from './format-ranges'
import { readRels, relsPath } from './patch'
import { RulePart, SHEET_ORDER, tag } from './rules-xml'
import { parseAttrs, type Box } from './xml'
import type { Zip } from './zip'
import { parseTable, tableBox, TablesRefused, type SourceTable } from './tables-model'

export const CONTENT_TYPES = '[Content_Types].xml'
export const TABLE_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml'
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

export type Relationship = ReturnType<typeof readRels>['rels'][number]
export interface TableSheet {
  part: RulePart
  path: string
  name: string
  rels: ReturnType<typeof readRels>
  tables: SourceTable[]
}

export function worksheet(
  z: Zip,
  path: string,
  name: string,
  read: (part: string) => string
): TableSheet {
  const part = new RulePart(read(path), 'worksheet', SHEET_ORDER)
  const rels = readRels(z, path)
  const parent = part.first('tableParts')
  const tables: SourceTable[] = []
  if (parent) {
    const p = part.prefix
    const ids = new Set<string>()
    for (const link of children(part.xml, parent)) {
      if (link.name !== p + 'tablePart') continue
      const id = parseAttrs(openTag(part.xml, link)).find(({ name }) => name.endsWith(':id'))?.value
      const rel = rels.rels.find((r) => r.id === id && r.type.endsWith('/table') && !r.external)
      if (!id || ids.has(id) || !rel || !z.byName.has(rel.target))
        throw new TablesRefused(`A table on “${name}” is missing its Excel part or relationship.`)
      ids.add(id)
      tables.push(parseTable(read(rel.target), rel.target, id))
    }
  }
  return { part, path, name, rels, tables }
}

export function tableGuards(sheet: TableSheet, read: (part: string) => string) {
  const { part, name } = sheet
  const { xml, prefix } = part
  const protection = part.first('sheetProtection')
  if (protection && isOn(valueOf(openTag(xml, protection), 'sheet')))
    throw new TablesRefused(
      `“${name}” is protected. Unprotect the sheet in Excel before editing its tables.`
    )
  const areas: { range: Box; kind: string }[] = []
  const add = (ref: string | undefined, kind: string) => {
    if (!ref) throw new TablesRefused(`Excel's ${kind} on “${name}” has no usable range.`)
    areas.push({ range: tableBox(ref), kind })
  }
  const merge = part.first('mergeCells')
  if (merge)
    for (const cell of children(xml, merge))
      if (cell.name === prefix + 'mergeCell')
        add(valueOf(openTag(xml, cell), 'ref'), 'merged cells')
  const filter = part.first('autoFilter')
  if (filter) add(valueOf(openTag(xml, filter), 'ref'), 'worksheet filter')
  for (const rel of sheet.rels.rels) {
    if (rel.external || !rel.type.endsWith('/pivotTable')) continue
    const pivot = new RulePart(read(rel.target), 'pivotTableDefinition', [])
    const location = pivot.first('location')
    add(location && valueOf(openTag(pivot.xml, location), 'ref'), 'pivot table')
  }
  return (box: Box, table: string) => {
    const match = areas.find(({ range }) => overlaps(range, box))
    if (match) throw new TablesRefused(`Table “${table}” overlaps ${match.kind} on “${name}”.`)
  }
}

export function tableLinks(sheet: TableSheet, wanted: readonly { rid: string; file: string }[]) {
  const { part, rels, path, tables } = sheet
  const { xml, prefix } = part
  const before = new Set(tables.map((table) => table.rid))
  const after = new Set(wanted.map(({ rid }) => rid))
  const gone = new Set([...before].filter((id) => !after.has(id)))
  const added = wanted.filter(({ rid }) => !before.has(rid))
  if (!gone.size && !added.length) return undefined
  const tableParts = part.first('tableParts')
  if (tableParts && !wanted.length) part.replace(tableParts, '')
  else {
    const root = tableParts ? openTag(xml, tableParts) : ''
    const existing = new Map<string, string>()
    if (tableParts)
      for (const el of children(xml, tableParts)) {
        const id = parseAttrs(openTag(xml, el)).find(({ name }) => name.endsWith(':id'))?.value
        if (id) existing.set(id, elementText(xml, el))
      }
    const records = wanted.map(
      ({ rid }) =>
        existing.get(rid) ?? tag(prefix + 'tablePart', { 'xmlns:r': DOC_REL, 'r:id': rid })
    )
    const text = tableParts
      ? setNumber(root, 'count', wanted.length).replace(/\s*\/>$/, '>') +
        records.join('') +
        `</${prefix}tableParts>`
      : tag(prefix + 'tableParts', { count: wanted.length }, records.join(''))
    if (tableParts) part.replace(tableParts, text)
    else part.add('tableParts', text)
  }
  const original = rels.text || DECL + `<Relationships xmlns="${PKG_REL}"/>`
  const relPart = new RulePart(original, 'Relationships', ['Relationship'])
  for (const el of relPart.siblings)
    if (gone.has(valueOf(openTag(original, el), 'Id') ?? '')) relPart.replace(el, '')
  if (added.length)
    relPart.add(
      'Relationship',
      added
        .map(({ rid, file }) =>
          tag(relPart.prefix + 'Relationship', {
            Id: rid,
            Type: DOC_REL + '/table',
            Target: posix.relative(posix.dirname(path), file)
          })
        )
        .join('')
    )
  const live = rels.rels.some(({ id }) => !gone.has(id)) || !!added.length
  return { path: relsPath(path), xml: live ? relPart.render() : null }
}

export function updateContentTypes(xml: string, remove: Set<string>, additions: readonly string[]) {
  const part = new RulePart(xml, 'Types', ['Default', 'Override'])
  const covered = new Set<string>()
  for (const el of part.siblings) {
    if (el.name !== part.prefix + 'Override') continue
    const path = valueOf(openTag(xml, el), 'PartName')?.replace(/^\//, '')
    if (!path) continue
    covered.add(path.toLowerCase())
    if (remove.has(path)) part.replace(el, '')
  }
  for (const file of additions) {
    if (covered.has(file.toLowerCase()))
      throw new TablesRefused(`The file already declares “${file}”.`)
    part.add(
      'Override',
      tag(part.prefix + 'Override', { PartName: '/' + file, ContentType: TABLE_TYPE })
    )
  }
  return part.render()
}

export function dropRelationship(xml: string, id: string) {
  const part = new RulePart(xml, 'Relationships', ['Relationship'])
  const el = part.siblings.find((candidate) => valueOf(openTag(xml, candidate), 'Id') === id)
  if (el) part.replace(el, '')
  return part.render()
}
