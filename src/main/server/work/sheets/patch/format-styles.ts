import { BUILTIN_NUMFMTS } from 'work-kit/sheet/xlsx'
import type { CellFormat, FormatReport, XColor } from './format'
import {
  FormatRefused,
  applySplices,
  children,
  documentRoot,
  elementText,
  insertionPoint,
  openTag,
  valueOf,
  withBody,
  type ElementSpan,
  type Splice
} from './format-xml'
import { esc, parseAttrs, removeAttrInTag, setAttrInTag, unesc } from './xml'

const ORDER =
  'numFmts fonts fills borders cellStyleXfs cellXfs cellStyles dxfs tableStyles colors extLst'.split(
    ' '
  )
const RECORDS = {
  numFmts: 'numFmt',
  fonts: 'font',
  fills: 'fill',
  borders: 'border',
  cellStyleXfs: 'xf',
  cellXfs: 'xf',
  cellStyles: 'cellStyle'
} as const
type Collection = keyof typeof RECORDS
type AttrValues = Record<string, string | number | null | undefined>
const EDGES = 'start end left right top bottom diagonal vertical horizontal'.split(' ')
const FONT_ORDER =
  'b i strike condense extend outline shadow u vertAlign sz color name family charset scheme'.split(
    ' '
  )
const FONT_SWITCHES = new Set(['b', 'i', 'strike', 'outline', 'shadow', 'condense', 'extend'])
// Locale-dependent IDs are appropriate for named presets. Explicit patterns keep their literal meaning.
const LOCALE_FORMAT_IDS = new Set([5, 6, 7, 8, 14, 15, 16, 17, 18, 19, 20, 21, 22, 41, 42, 43, 44])
const BUILTINS = new Map(
  Object.entries(BUILTIN_NUMFMTS)
    .filter(([id]) => !LOCALE_FORMAT_IDS.has(Number(id)))
    .map(([id, code]) => [code, Number(id)])
)

// Office's built-in presets. Use the workbook's Normal font as the base for its theme and size.
const NAMED: Partial<Record<number, { name: string; format?: CellFormat; numFmtId?: number }>> = {
  0: { name: 'Normal' },
  3: { name: 'Comma', numFmtId: 43 },
  4: { name: 'Currency', numFmtId: 44 },
  5: { name: 'Percent', numFmtId: 9 },
  10: { name: 'Note', format: { fill: { rgb: 'FFFFCC' }, border: around('B2B2B2') } },
  16: {
    name: 'Heading 1',
    format: {
      font: { bold: true, size: 15, color: { theme: 3 } },
      border: { bottom: { style: 'thick', color: { theme: 4 } } }
    }
  },
  17: {
    name: 'Heading 2',
    format: {
      font: { bold: true, size: 13, color: { theme: 3 } },
      border: { bottom: { style: 'thick', color: { theme: 4, tint: 0.5 } } }
    }
  },
  20: {
    name: 'Input',
    format: {
      font: { color: { rgb: '3F3F76' } },
      fill: { rgb: 'FFCC99' },
      border: around('7F7F7F')
    }
  },
  25: {
    name: 'Total',
    format: {
      font: { bold: true },
      border: {
        top: { style: 'thin', color: { theme: 4 } },
        bottom: { style: 'double', color: { theme: 4 } }
      }
    }
  },
  26: { name: 'Good', format: { font: { color: { rgb: '006100' } }, fill: { rgb: 'C6EFCE' } } },
  27: { name: 'Bad', format: { font: { color: { rgb: '9C0006' } }, fill: { rgb: 'FFC7CE' } } },
  28: { name: 'Neutral', format: { font: { color: { rgb: '9C5700' } }, fill: { rgb: 'FFEB9C' } } }
}

function around(rgb: string): CellFormat['border'] {
  const edge = { style: 'thin' as const, color: { rgb } }
  return { left: edge, right: edge, top: edge, bottom: edge }
}

function setValues(tag: string, values: AttrValues): string {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || valueOf(tag, name) === (value === null ? undefined : String(value)))
      continue
    tag = value === null ? removeAttrInTag(tag, name) : setAttrInTag(tag, name, String(value))
  }
  return tag
}

function argb(rgb: string): string {
  return (rgb.length === 6 ? 'FF' + rgb : rgb).toUpperCase()
}

function colorAttrs(color: XColor): string {
  if ('rgb' in color) {
    if (!/^(?:#?[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color.rgb))
      throw new FormatRefused(`“${color.rgb}” isn't an Excel RGB colour.`)
    return `rgb="${esc(argb(color.rgb.replace(/^#/, '')))}"`
  }
  if ('theme' in color) {
    if (
      !Number.isInteger(color.theme) ||
      color.theme < 0 ||
      color.theme > 11 ||
      (color.tint !== undefined && (!Number.isFinite(color.tint) || Math.abs(color.tint) > 1))
    )
      throw new FormatRefused("The theme colour or tint is outside Excel's range.")
    return `theme="${color.theme}"${color.tint === undefined ? '' : ` tint="${color.tint}"`}`
  }
  return 'auto="1"'
}

/** Compare style records independent of quote style, attribute order and equivalent empty tags. */
function recordKey(text: string, prefix: string): string {
  const root = documentRoot(text)!
  function key(el: ElementSpan, solidFill = false): string {
    const name = el.name.startsWith(prefix) ? el.name.slice(prefix.length) : el.name
    const attrs = new Map(parseAttrs(openTag(text, el)).map((a) => [a.name, unesc(a.value)]))
    if (el.name === prefix + name) {
      for (const field of [
        'applyFont',
        'applyFill',
        'applyBorder',
        'applyNumberFormat',
        'applyAlignment',
        'applyProtection',
        'quotePrefix',
        'pivotButton',
        'wrapText',
        'shrinkToFit',
        'locked',
        'hidden',
        'diagonalUp',
        'diagonalDown',
        'outline',
        'auto'
      ]) {
        if (attrs.get(field) === 'true') attrs.set(field, '1')
        if (attrs.get(field) === 'false') attrs.set(field, '0')
      }
      if (FONT_SWITCHES.has(name)) {
        if (attrs.get('val') === '0' || attrs.get('val') === 'false') {
          if (attrs.size === 1 && el.openEnd === el.close) return ''
        } else if (!attrs.has('val') || attrs.get('val') === 'true') attrs.set('val', '1')
      }
      if (name === 'u') {
        if (attrs.get('val') === 'none' && attrs.size === 1 && el.openEnd === el.close) return ''
        if (!attrs.has('val')) attrs.set('val', 'single')
      }
      if (name === 'xf') {
        for (const id of ['numFmtId', 'fontId', 'fillId', 'borderId']) {
          if (!attrs.has(id)) attrs.set(id, '0')
        }
      }
      if (name === 'patternFill' && !attrs.has('patternType')) attrs.set('patternType', 'none')
      if (name === 'color' || name === 'fgColor' || name === 'bgColor') {
        const rgb = attrs.get('rgb')
        if (rgb) attrs.set('rgb', argb(rgb))
        if (Number(attrs.get('tint')) === 0) attrs.delete('tint')
        if (name === 'bgColor' && solidFill && attrs.size === 1 && attrs.get('indexed') === '64')
          return ''
      }
      if (EDGES.includes(name)) {
        if (attrs.get('style') === 'none') attrs.delete('style')
        if (attrs.size === 0 && !text.slice(el.openEnd, el.close).trim()) return ''
      }
    }
    const subkeys: string[] = []
    let pos = el.openEnd
    for (const child of children(text, el)) {
      const gap = text.slice(pos, child.start).trim()
      if (gap) subkeys.push(gap)
      const k = key(
        child,
        el.name === prefix + 'patternFill' && attrs.get('patternType') === 'solid'
      )
      if (k) subkeys.push(k)
      pos = child.end
    }
    const tail = text.slice(pos, el.close).trim()
    if (tail) subkeys.push(tail)
    if (el.name === prefix + 'font') subkeys.sort()
    return JSON.stringify([el.name, [...attrs].sort(([a], [b]) => a.localeCompare(b)), subkeys])
  }
  return key(root)
}

function setChildren(
  text: string,
  edits: Map<string, string>,
  order: readonly string[] = []
): string {
  if (!edits.size) return text
  const parent = documentRoot(text)!
  const siblings = [...children(text, parent)]
  const changes: Splice[] = []
  for (const [name, value] of edits) {
    const existing = siblings.find((el) => el.name === name)
    if (existing) {
      changes.push({ start: existing.start, end: existing.end, text: value })
    } else if (value) {
      const i = insertionPoint(parent, siblings, name, order, '')
      changes.push({ start: i, end: i, text: value })
    }
  }
  if (!changes.length) return text
  if (parent.openEnd === parent.end)
    return withBody(openTag(text, parent), parent.name, changes.map((edit) => edit.text).join(''))
  return applySplices(text, changes)
}

class Records {
  readonly entries: string[]
  readonly originalCount: number
  private keys?: Map<string, number>

  constructor(
    readonly span: ElementSpan | undefined,
    xml: string,
    record: string,
    private prefix: string
  ) {
    this.entries = span
      ? [...children(xml, span)]
          .filter((el) => el.name === prefix + record)
          .map((el) => elementText(xml, el))
      : []
    this.originalCount = this.entries.length
  }

  add(record: string): number {
    const id = this.entries.push(record) - 1
    this.keys?.set(recordKey(record, this.prefix), id)
    return id
  }

  find(record: string): number | undefined {
    if (!this.keys) {
      this.keys = new Map()
      for (const [id, entry] of this.entries.entries()) {
        const key = recordKey(entry, this.prefix)
        if (!this.keys.has(key)) this.keys.set(key, id)
      }
    }
    return this.keys.get(recordKey(record, this.prefix))
  }
}

export function hasFormat(format: CellFormat): boolean {
  return (
    format.clear === true ||
    format.namedStyle !== undefined ||
    format.fill !== undefined ||
    format.numFmt !== undefined ||
    [format.font, format.border, format.align].some(
      (section) => section && Object.values(section).some((value) => value !== undefined)
    )
  )
}

export class StyleTable {
  private root: ElementSpan
  private siblings: ElementSpan[]
  private prefix: string
  private records = new Map<Collection, Records>()

  constructor(
    readonly xml: string,
    private stats: FormatReport['styles']
  ) {
    this.root = documentRoot(xml)!
    if (!this.root || !/(^|:)styleSheet$/.test(this.root.name))
      throw new FormatRefused('The workbook has no styleSheet element.')
    this.prefix = this.root.name.slice(0, -'styleSheet'.length)
    this.siblings = [...children(xml, this.root)]
    for (const name of Object.keys(RECORDS) as Collection[]) {
      const span = this.siblings.find((el) => el.name === this.prefix + name)
      this.records.set(name, new Records(span, xml, RECORDS[name], this.prefix))
    }
    const P = this.prefix
    this.seed(
      'fonts',
      `<${P}font><${P}sz val="11"/><${P}color theme="1"/><${P}name val="Calibri"/><${P}family val="2"/><${P}scheme val="minor"/></${P}font>`
    )
    this.seed(
      'fills',
      `<${P}fill><${P}patternFill patternType="none"/></${P}fill>`,
      `<${P}fill><${P}patternFill patternType="gray125"/></${P}fill>`
    )
    this.seed(
      'borders',
      `<${P}border><${P}left/><${P}right/><${P}top/><${P}bottom/><${P}diagonal/></${P}border>`
    )
    this.seed('cellStyleXfs', `<${P}xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>`)
    this.seed('cellXfs', `<${P}xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`)
    this.seed('cellStyles', `<${P}cellStyle name="Normal" xfId="0" builtinId="0"/>`)
  }

  private add(name: Collection, record: string): number {
    const counter = name === 'cellXfs' ? 'xfs' : name
    if (counter !== 'cellStyleXfs' && counter !== 'cellStyles') this.stats[counter]++
    return this.records.get(name)!.add(record)
  }

  private seed(name: Collection, ...defaults: string[]) {
    if (!this.records.get(name)!.entries.length)
      for (const record of defaults) this.add(name, record)
  }

  private at(name: Collection, id: number): string {
    const record = this.records.get(name)!.entries[id]
    if (record === undefined)
      throw new FormatRefused(`The workbook is missing style record ${id} in ${name}.`)
    return record
  }

  private intern(name: Collection, record: string, current?: number): number {
    const records = this.records.get(name)!
    const existing =
      current !== undefined &&
      recordKey(this.at(name, current), this.prefix) === recordKey(record, this.prefix)
        ? current
        : records.find(record)
    if (existing !== undefined) {
      this.stats.reused++
      return existing
    }
    return this.add(name, record)
  }

  private font(base: string, font: NonNullable<CellFormat['font']>): string {
    const P = this.prefix
    const changes = new Map<string, string>()
    const val = (name: string, value: string | number) =>
      `<${P}${name} val="${esc(String(value))}"/>`
    for (const [field, tag] of [
      ['bold', 'b'],
      ['italic', 'i'],
      ['strike', 'strike']
    ] as const) {
      if (font[field] !== undefined) changes.set(P + tag, font[field] ? `<${P}${tag}/>` : '')
    }
    if (font.underline !== undefined)
      changes.set(
        P + 'u',
        !font.underline ? '' : font.underline === 'double' ? val('u', 'double') : `<${P}u/>`
      )
    // A family or a size given back takes the workbook's default font's (font 0), as Normal has them.
    const normal = font.name === null || font.size === null ? this.at('fonts', 0) : ''
    const inNormal = (tag: string): string => {
      const el = normal ? [...children(normal, documentRoot(normal)!)].find((c) => c.name === P + tag) : undefined
      return el ? elementText(normal, el) : ''
    }
    if (font.name === null) for (const tag of ['name', 'charset', 'family', 'scheme']) changes.set(P + tag, inNormal(tag))
    else if (font.name !== undefined) {
      if (!font.name.trim() || font.name.length > 31)
        throw new FormatRefused('Use a font name from 1 to 31 characters.')
      const oldName = [...children(base, documentRoot(base)!)].find((el) => el.name === P + 'name')
      if (!oldName || valueOf(openTag(base, oldName), 'val') !== font.name)
        changes.set(P + 'charset', '')
      changes.set(P + 'name', val('name', font.name))
      // A theme scheme would take precedence over the explicit font name in Excel.
      changes.set(P + 'scheme', '')
    }
    if (font.size === null) changes.set(P + 'sz', inNormal('sz'))
    else if (font.size !== undefined) {
      if (!Number.isFinite(font.size) || font.size < 1 || font.size > 409)
        throw new FormatRefused('Use a font size from 1 to 409 points.')
      changes.set(P + 'sz', val('sz', font.size))
    }
    if (font.vertAlign !== undefined)
      changes.set(P + 'vertAlign', font.vertAlign ? val('vertAlign', font.vertAlign) : '')
    if (font.color !== undefined)
      changes.set(P + 'color', font.color ? `<${P}color ${colorAttrs(font.color)}/>` : '')
    return setChildren(
      base,
      new Map(
        FONT_ORDER.map((name) => P + name)
          .filter((name) => changes.has(name))
          .map((name) => [name, changes.get(name)!])
      ),
      FONT_ORDER.map((name) => P + name)
    )
  }

  private border(base: string, border: NonNullable<CellFormat['border']>): string {
    const P = this.prefix
    const changes = new Map<string, string>()
    const edgeXml = (name: string, style: string | undefined, color: XColor | undefined) =>
      style && style !== 'none'
        ? color
          ? `<${name} style="${style}"><${P}color ${colorAttrs(color)}/></${name}>`
          : `<${name} style="${style}"/>`
        : `<${name}/>`
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const edge = border[side]
      if (edge !== undefined) changes.set(P + side, edgeXml(P + side, edge?.style, edge?.color))
    }
    if (border.diagonal !== undefined) {
      const { diagonal } = border
      base = this.updateXf(base, {
        diagonalUp:
          diagonal === null ? null : diagonal.up === undefined ? undefined : diagonal.up ? 1 : null,
        diagonalDown:
          diagonal === null
            ? null
            : diagonal.down === undefined
              ? undefined
              : diagonal.down
                ? 1
                : null
      })
      const name = P + 'diagonal'
      if (diagonal === null) changes.set(name, `<${name}/>`)
      else if (diagonal.style !== undefined || diagonal.color !== undefined) {
        const old = [...children(base, documentRoot(base)!)].find((el) => el.name === name)
        const style = diagonal.style ?? (old && valueOf(openTag(base, old), 'style'))
        const previous = old && [...children(base, old)].find((el) => el.name === P + 'color')
        changes.set(
          name,
          diagonal.color === undefined && previous && style && style !== 'none'
            ? `<${name} style="${style}">${elementText(base, previous)}</${name}>`
            : edgeXml(name, style, diagonal.color)
        )
      }
    }
    return setChildren(
      base,
      changes,
      EDGES.map((side) => P + side)
    )
  }

  private numberFormat(code: string): number {
    if (code === '') code = 'General'
    const used = new Set<number>()
    for (const entry of this.records.get('numFmts')!.entries) {
      const id = Number(valueOf(entry, 'numFmtId'))
      if (valueOf(entry, 'formatCode') === code) {
        this.stats.reused++
        return id
      }
      used.add(id)
    }
    // Excel numbers a conditional format's own number formats (in `dxfs`) from the same pool.
    for (const m of this.xml.matchAll(/<(?:[\w.-]+:)?numFmt(?=[\s/>])[^>]*\bnumFmtId\s*=\s*["'](\d+)["']/g)) used.add(Number(m[1]))
    const builtin = code === 'General' ? 0 : BUILTINS.get(code)
    if (builtin !== undefined && !used.has(builtin)) return builtin
    let id = 164
    while (used.has(id)) id++
    const encoded = esc(code).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;')
    this.add('numFmts', `<${this.prefix}numFmt numFmtId="${id}" formatCode="${encoded}"/>`)
    return id
  }

  private components(xf: string, format: CellFormat): AttrValues {
    const tag = openTag(xf, documentRoot(xf)!)
    const values: AttrValues = {}
    if (format.font && Object.values(format.font).some((v) => v !== undefined)) {
      const old = Number(valueOf(tag, 'fontId') ?? 0)
      values.fontId = this.intern('fonts', this.font(this.at('fonts', old), format.font), old)
      values.applyFont = 1
    }
    if (format.fill !== undefined) {
      const P = this.prefix
      values.fillId = format.fill
        ? this.intern(
            'fills',
            `<${P}fill><${P}patternFill patternType="solid"><${P}fgColor ${colorAttrs(format.fill)}/><${P}bgColor indexed="64"/></${P}patternFill></${P}fill>`
          )
        : this.intern('fills', `<${P}fill><${P}patternFill patternType="none"/></${P}fill>`)
      values.applyFill = 1
    }
    if (format.border && Object.values(format.border).some((v) => v !== undefined)) {
      const old = Number(valueOf(tag, 'borderId') ?? 0)
      values.borderId = this.intern(
        'borders',
        this.border(this.at('borders', old), format.border),
        old
      )
      values.applyBorder = 1
    }
    if (format.numFmt !== undefined) {
      values.numFmtId = this.numberFormat(format.numFmt)
      values.applyNumberFormat = 1
    }
    return values
  }

  private named(id: number): number {
    const entries = this.records.get('cellStyles')!.entries
    const byId = entries.find((entry) => Number(valueOf(entry, 'builtinId')) === id)
    if (byId) return Number(valueOf(byId, 'xfId'))
    const preset = NAMED[id]
    if (!preset) throw new FormatRefused(`Excel cell style ${id} is not supported by this editor.`)
    const byName = (name: string) =>
      entries.find((entry) => valueOf(entry, 'name')?.toLowerCase() === name.toLowerCase())
    const existing = byName(preset.name)
    if (existing) return Number(valueOf(existing, 'xfId'))
    const normal = entries.find((entry) => valueOf(entry, 'builtinId') === '0') ?? byName('Normal')
    const baseId = Number(normal ? valueOf(normal, 'xfId') : 0)
    const base = this.at('cellStyleXfs', baseId)
    const values = this.components(base, preset.format ?? {})
    if (preset.numFmtId !== undefined) {
      values.numFmtId = preset.numFmtId
      values.applyNumberFormat = 1
    }
    const index = this.add('cellStyleXfs', this.updateXf(base, values))
    this.add(
      'cellStyles',
      `<${this.prefix}cellStyle name="${preset.name}" xfId="${index}" builtinId="${id}"/>`
    )
    return index
  }

  private updateXf(xf: string, values: AttrValues): string {
    const root = documentRoot(xf)!
    return setValues(openTag(xf, root), values) + xf.slice(root.openEnd)
  }

  private align(xf: string, align: NonNullable<CellFormat['align']>): string {
    const P = this.prefix
    const root = documentRoot(xf)!
    const name = P + 'alignment'
    const old = [...children(xf, root)].find((el) => el.name === name)
    if (
      align.indent !== undefined &&
      (!Number.isInteger(align.indent) || align.indent < 0 || align.indent > 250)
    )
      throw new FormatRefused('Use a whole-number indent from 0 to 250.')
    const angle = align.rotation
    if (typeof angle === 'number' && (!Number.isInteger(angle) || Math.abs(angle) > 90))
      throw new FormatRefused('Use a whole-number text rotation from -90 to 90 degrees.')
    const rotation =
      angle === 'vertical' ? 255 : typeof angle === 'number' && angle < 0 ? 90 - angle : angle
    const tag = old ? openTag(xf, old) : `<${name}/>`
    const updated =
      setValues(tag, {
        horizontal: align.horizontal,
        vertical: align.vertical,
        wrapText: align.wrap === undefined ? undefined : Number(align.wrap),
        indent: align.indent,
        shrinkToFit: align.shrink === undefined ? undefined : Number(align.shrink),
        textRotation: rotation
      }) + (old ? xf.slice(old.openEnd, old.end) : '')
    return setChildren(xf, new Map([[name, updated]]), [name, P + 'protection', P + 'extLst'])
  }

  style(index: number, format: CellFormat): number {
    let xf = this.at('cellXfs', index)
    if (format.namedStyle !== undefined && format.namedOnly) xf = this.updateXf(xf, { xfId: this.named(format.namedStyle) })
    else if (format.namedStyle !== undefined) {
      const xfId = this.named(format.namedStyle)
      const preset = this.at('cellStyleXfs', xfId)
      const root = documentRoot(preset)!
      const tag = openTag(preset, root)
      const values: AttrValues = { xfId }
      for (const [id, flag] of [
        ['fontId', 'applyFont'],
        ['fillId', 'applyFill'],
        ['borderId', 'applyBorder'],
        ['numFmtId', 'applyNumberFormat']
      ]) {
        values[id] = valueOf(tag, id) ?? 0
        values[flag] = valueOf(tag, flag) ?? 1
      }
      xf = this.updateXf(xf, values)
      for (const el of children(preset, root)) {
        if (el.name !== this.prefix + 'alignment') continue
        xf = setChildren(xf, new Map([[el.name, elementText(preset, el)]]), [
          el.name,
          this.prefix + 'protection',
          this.prefix + 'extLst'
        ])
        xf = this.updateXf(xf, { applyAlignment: valueOf(tag, 'applyAlignment') ?? 1 })
      }
    }
    xf = this.updateXf(xf, this.components(xf, format))
    if (format.align && Object.values(format.align).some((v) => v !== undefined)) {
      xf = this.align(xf, format.align)
      xf = this.updateXf(xf, { applyAlignment: 1 })
    }
    return this.intern('cellXfs', xf, index)
  }

  render(): string {
    const edits: Splice[] = []
    for (const name of ORDER) {
      const records = this.records.get(name as Collection)
      if (!records || records.entries.length === records.originalCount) continue
      const qualified = this.prefix + name
      const newRecords = records.entries.slice(records.originalCount).join('')
      const original = records.span
      const count = String(records.entries.length)
      if (!original) {
        const at = insertionPoint(this.root, this.siblings, name, ORDER, this.prefix)
        edits.push({
          start: at,
          end: at,
          text: `<${qualified} count="${count}">${newRecords}</${qualified}>`
        })
      } else {
        const tag = setAttrInTag(openTag(this.xml, original), 'count', count)
        if (original.openEnd === original.end) {
          edits.push({
            start: original.start,
            end: original.end,
            text: withBody(tag, qualified, newRecords)
          })
        } else {
          edits.push({ start: original.start, end: original.openEnd, text: tag })
          edits.push({ start: original.close, end: original.close, text: newRecords })
        }
      }
    }
    if (this.root.openEnd === this.root.end && edits.length) {
      const text = withBody(
        openTag(this.xml, this.root),
        this.root.name,
        edits.map((edit) => edit.text).join('')
      )
      return applySplices(this.xml, [{ start: this.root.start, end: this.root.end, text }])
    }
    return applySplices(this.xml, edits)
  }
}
