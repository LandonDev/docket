import type { IRange } from '@univerjs/core'
import {
  applySplices,
  children,
  documentRoot,
  elements,
  elementText,
  insertionPoint,
  openTag,
  valueOf,
  withBody,
  type ElementSpan,
  type Splice
} from './format-xml'
import { boxRef, fullHeight, fullWidth, readRange } from './format-ranges'
import { colName, escText, parseAttrs, unesc, type Box } from './xml'
import { toFileFormula } from './formula'

export class RulesRefused extends Error {
  override name = 'RulesRefused'
}

export const SHEET_ORDER = (
  'sheetPr dimension sheetViews sheetFormatPr cols sheetData sheetCalcPr sheetProtection ' +
  'protectedRanges scenarios autoFilter sortState dataConsolidate customSheetViews mergeCells ' +
  'phoneticPr conditionalFormatting dataValidations hyperlinks printOptions pageMargins pageSetup ' +
  'headerFooter rowBreaks colBreaks customProperties cellWatches ignoredErrors smartTags drawing ' +
  'legacyDrawing legacyDrawingHF picture oleObjects controls webPublishItems tableParts extLst'
).split(' ')
export const BOOK_ORDER = (
  'fileVersion fileSharing workbookPr workbookProtection bookViews sheets functionGroups ' +
  'externalReferences definedNames calcPr oleSize customWorkbookViews pivotCaches pivotTableParts ' +
  'smartTagPr smartTagTypes webPublishing fileRecoveryPr webPublishObjects extLst'
).split(' ')
export const STYLE_ORDER =
  'numFmts fonts fills borders cellStyleXfs cellXfs cellStyles dxfs tableStyles colors extLst'.split(
    ' '
  )

export const OPERATORS = new Set([
  'between',
  'notBetween',
  'equal',
  'notEqual',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual'
])
export const between = (op: string) => op === 'between' || op === 'notBetween'
export const on = (value: boolean | undefined) => (value ? '1' : undefined)
export const local = (qualified: string) => qualified.slice(qualified.indexOf(':') + 1)
export const inner = (xml: string, span: ElementSpan) => xml.slice(span.openEnd, span.close)

export function countLimit(count: number, what: string) {
  if (count > 2000)
    throw new RulesRefused(`This editor can save at most 2,000 ${what} in this edit.`)
}

export type RuleRange = IRange | string

export function gridBox(range: RuleRange): Box {
  try {
    const box = readRange(range, true)
    if (
      typeof range !== 'string' &&
      (range.startRow > range.endRow || range.startColumn > range.endColumn)
    )
      throw new Error('Reversed range')
    return box
  } catch {
    throw new RulesRefused('Use an ordered cell range within the worksheet.')
  }
}

export function ruleRef(box: Box): string {
  if (fullHeight(box)) return `${colName(box.c1)}:${colName(box.c2)}`
  if (fullWidth(box)) return `${box.r1}:${box.r2}`
  return boxRef(box)
}

export function sqref(ranges: readonly RuleRange[]): string {
  if (!ranges.length) throw new RulesRefused('Give the rule at least one cell range.')
  return ranges.map((range) => ruleRef(gridBox(range))).join(' ')
}

export function fileBoxes(ref: string): Box[] {
  return ref
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => {
      try {
        if (text.split(':').length > 2 || text.endsWith(':')) throw new Error()
        return readRange(text, true)
      } catch {
        throw new RulesRefused(`“${text}” is outside the worksheet or is not a cell range.`)
      }
    })
}

export function rangeKey(ref: string): string {
  return fileBoxes(ref).map(ruleRef).join(' ')
}

export function checkedFormula(value: string, convert = false): string {
  if (typeof value !== 'string' || !value.trim() || !value.replace(/^\s*=/, '').trim())
    throw new RulesRefused('Give the rule a formula or a value.')
  if (Buffer.byteLength(value) > 65_536) throw new RulesRefused('The formula exceeds 64 KiB.')
  const file = convert ? toFileFormula(value) : value.replace(/^\s*=/, '')
  if (Buffer.byteLength(file) > 65_536) throw new RulesRefused('The formula exceeds 64 KiB.')
  return file
}

/** Excel escapes control characters and literal _xHHHH_ sequences in ST_Xstring. */
export function xstring(text: string): string {
  return escText(text).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;')
}

export function xunescape(text: string): string {
  return unesc(text).replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  )
}

export function xattr(opening: string, name: string): string | undefined {
  const value = parseAttrs(opening).find((entry) => entry.name === name)?.value
  return value === undefined ? undefined : xunescape(value)
}

export function tagAttrs(values: Record<string, string | number | undefined>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ` ${name}="${xstring(String(value))}"`)
    .join('')
}

export function tag(
  name: string,
  attrs: Record<string, string | number | undefined> = {},
  body = ''
) {
  return `<${name}${tagAttrs(attrs)}${body ? `>${body}</${name}>` : '/>'}`
}

export const formulaTag = (name: string, value: string) => `<${name}>${xstring(value)}</${name}>`

export function* descendants(
  xml: string,
  parent: ElementSpan,
  name: string
): Generator<ElementSpan> {
  for (const child of children(xml, parent)) {
    if (local(child.name) === name) yield child
    else yield* descendants(xml, child, name)
  }
}

/** XML equality for small records, independent of quote, attribute order, self-closing syntax and indentation. */
export function xmlKey(
  xml: string,
  normalize?: (name: string, attrs: Map<string, string>) => void
): string {
  const root = documentRoot(xml)!
  function key(el: ElementSpan): unknown {
    const name = local(el.name)
    const attrs = new Map(
      parseAttrs(openTag(xml, el))
        .filter((a) => !a.name.startsWith('xmlns'))
        .map((a) => [a.name, xunescape(a.value)])
    )
    normalize?.(name, attrs)
    const parts: unknown[] = []
    let from = el.openEnd
    for (const child of children(xml, el)) {
      const text = xunescape(xml.slice(from, child.start).trim())
      if (text) parts.push(text)
      parts.push(key(child))
      from = child.end
    }
    const text = xunescape(xml.slice(from, el.close).trim())
    if (text) parts.push(text)
    if (name === 'font') parts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    return [name, [...attrs].sort(([a], [b]) => a.localeCompare(b)), parts]
  }
  return JSON.stringify(key(root))
}

export class RulePart {
  readonly root: ElementSpan
  readonly prefix: string
  readonly siblings: ElementSpan[]
  readonly changes: Splice[] = []

  constructor(
    readonly xml: string,
    rootName: string,
    private order: readonly string[]
  ) {
    const root = documentRoot(xml)
    if (!root || local(root.name) !== rootName)
      throw new RulesRefused(`The file is missing its ${rootName} element.`)
    this.root = root
    this.prefix = root.name.slice(0, -rootName.length)
    this.siblings = [
      ...elements(
        xml,
        root.openEnd,
        root.close,
        rootName === 'worksheet' ? this.prefix + 'sheetData' : undefined
      )
    ]
  }

  first(name: string) {
    return this.siblings.find((el) => el.name === this.prefix + name)
  }

  replace(el: ElementSpan, text: string) {
    if (elementText(this.xml, el) !== text)
      this.changes.push({ start: el.start, end: el.end, text })
  }

  add(name: string, text: string) {
    const at = insertionPoint(this.root, this.siblings, name, this.order, this.prefix)
    this.changes.push({ start: at, end: at, text })
  }

  render() {
    if (this.root.openEnd === this.root.end && this.changes.length) {
      const updated = withBody(
        openTag(this.xml, this.root),
        this.root.name,
        this.changes.map((change) => change.text).join('')
      )
      return applySplices(this.xml, [{ start: this.root.start, end: this.root.end, text: updated }])
    }
    return applySplices(this.xml, this.changes)
  }
}

/** Replace record slots in order and leave intervening comments and unknown children where they are. */
export function recordSplices(
  xml: string,
  slots: ElementSpan[],
  records: string[],
  at: number
): Splice[] {
  const changes: Splice[] = []
  for (const [i, slot] of slots.entries()) {
    const updated = records[i] ?? ''
    if (updated !== elementText(xml, slot))
      changes.push({ start: slot.start, end: slot.end, text: updated })
  }
  const excess = records.slice(slots.length).join('')
  if (excess) changes.push({ start: at, end: at, text: excess })
  return changes
}

export function replaceValidations(
  part: RulePart,
  root: ElementSpan,
  slots: ElementSpan[],
  records: string[],
  countName = 'count'
) {
  const xml = part.xml
  const rootTag = openTag(xml, root)
  const replaced = new Set(slots.map((slot) => slot.start))
  const preserved = [...children(xml, root)].filter((el) => !replaced.has(el.start))
  const size = preserved.filter((el) => local(el.name) === 'dataValidation').length + records.length
  if (!preserved.length && !records.length) {
    part.replace(root, '')
    return
  }
  const changes = recordSplices(xml, slots, records, root.close)
  if (!changes.length) return
  const count = valueOf(rootTag, countName)
  const tagWithCount =
    count === String(size)
      ? rootTag
      : // The count is numeric, so replacing it cannot affect the surrounding attributes.
        count === undefined
        ? rootTag.replace(/(\/?>)$/, ` ${countName}="${size}"$1`)
        : rootTag.replace(new RegExp(`(\\s${countName}\\s*=\\s*)["'][^"']*["']`), `$1"${size}"`)
  if (root.openEnd === root.end) {
    part.replace(root, withBody(tagWithCount, root.name, records.join('')))
  } else {
    changes.push({ start: root.start, end: root.openEnd, text: tagWithCount })
    part.replace(root, applySplices(xml, changes, root.start, root.end))
  }
}

export function extraAttrs(xml: string, old: ElementSpan, owned: Set<string>): string {
  return parseAttrs(openTag(xml, old))
    .filter((a) => !owned.has(a.name))
    .map((a) => ` ${a.name}=${a.quote}${a.value}${a.quote}`)
    .join('')
}

export const quotedSheet = (name: string) => `'${name.replace(/'/g, "''")}'`
