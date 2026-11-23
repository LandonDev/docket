// The ground the chart writer and the picture writer share: a package's parts, relationships and
// content types changed as text, and a sheet's drawing part with its anchors. Nothing here parses
// a part into a tree: an anchor is a span, a change is a splice, and every byte outside a splice
// stays as it was. An entry no change names is copied raw by the zip writer.
import { posix } from 'node:path'
import type { AnchorCell, ObjectAnchor } from 'work-kit/sheet/xlsx'
import {
  applySplices,
  children,
  documentRoot,
  elementText,
  isOn,
  openTag,
  valueOf,
  withBody,
  type ElementSpan,
  type Splice
} from './format-xml'
import { readRels, relsPath, workbookMap } from './patch'
import { local, RulePart, SHEET_ORDER, tag } from './rules-xml'
import { parseAttrs, removeAttrInTag, setAttrInTag } from './xml'
import { readEntry, readZip, writeZip, type Zip } from './zip'

export const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export const XDR_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
export const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
export const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
export const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CONTENT_TYPES = '[Content_Types].xml'
const DRAWING_TYPE = 'application/vnd.openxmlformats-officedocument.drawing+xml'
const CHARTSHEET_ORDER = (
  'sheetPr sheetViews sheetProtection customSheetViews pageMargins pageSetup headerFooter ' +
  'drawing legacyDrawing legacyDrawingHF drawingHF picture webPublishItems extLst'
).split(' ')
const ANCHORS = new Map<string, ObjectAnchor['kind']>([
  ['twoCellAnchor', 'twoCell'],
  ['oneCellAnchor', 'oneCell'],
  ['absoluteAnchor', 'absolute']
])
const PLACE = new Set(['from', 'to', 'ext', 'pos'])
const MAX_DEPTH = 32
/** DrawingML's ST_Coordinate, in EMU. */
const MAX_EMU = 27_273_042_316_900

/** A change to a chart or a picture that cannot be written, in words for the person. */
export class ObjectsRefused extends Error {
  override name = 'ObjectsRefused'
}

export interface Tab {
  name: string
  part: string
  kind: string
  index: number
}

export interface PackageReport {
  partsChanged: string[]
  partsAdded: string[]
  partsRemoved: string[]
}

type Relationship = ReturnType<typeof readRels>['rels'][number]
const fold = (name: string) => name.toLowerCase()
const extension = (part: string) => posix.extname(part).slice(1).toLowerCase()

/** One patch's changes to a package: parts set, added and removed, written once at the end. */
export class PackageEdit {
  readonly zip: Zip
  readonly book: ReturnType<typeof workbookMap>
  readonly tabs: Tab[]
  private readonly decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  private readonly texts = new Map<string, string>()
  private readonly updates = new Map<string, string>()
  private readonly additions = new Map<string, string | Uint8Array>()
  private readonly removals = new Set<string>()
  private readonly overrides = new Map<string, string>()
  private readonly defaults = new Map<string, string>()
  private readonly names: Set<string>

  constructor(readonly bytes: Uint8Array) {
    this.zip = readZip(bytes)
    this.book = workbookMap(this.zip)
    this.tabs = this.book.sheets
    this.names = new Set([...this.zip.byName.keys()].map(fold))
    for (const part of this.original(CONTENT_TYPES).matchAll(/\bPartName=["']\/([^"']+)["']/g))
      this.names.add(fold(part[1]))
  }

  tab(name: string): Tab | undefined {
    return this.tabs.find((tab) => tab.name === name)
  }

  /** A part's text as the file holds it. */
  original(part: string): string {
    let text = this.texts.get(part)
    if (text === undefined) {
      text = this.decoder.decode(readEntry(this.zip, part))
      this.texts.set(part, text)
    }
    return text
  }

  has(part: string): boolean {
    return this.additions.has(part) || (this.zip.byName.has(part) && !this.removals.has(part))
  }

  /** A part's text as this patch leaves it. */
  text(part: string): string {
    const added = this.additions.get(part)
    if (typeof added === 'string') return added
    return this.updates.get(part) ?? this.original(part)
  }

  bytesOf(part: string): Uint8Array {
    const added = this.additions.get(part)
    if (added !== undefined)
      return typeof added === 'string' ? new TextEncoder().encode(added) : added
    return readEntry(this.zip, part)
  }

  set(part: string, xml: string): void {
    if (this.additions.has(part)) this.additions.set(part, xml)
    else this.updates.set(part, xml)
  }

  /** A new part. `type` is its content type: an Override, or for media a Default by its extension. */
  add(part: string, data: string | Uint8Array, type?: { override: string } | { default: string }) {
    this.additions.set(part, data)
    this.names.add(fold(part))
    if (type && 'override' in type) this.overrides.set(part, type.override)
    else if (type) this.defaults.set(extension(part), type.default)
  }

  remove(part: string): void {
    this.updates.delete(part)
    this.overrides.delete(part)
    if (!this.additions.delete(part)) this.removals.add(part)
  }

  /** A part name no part has, had or is declared under: `xl/charts/chart` + n + `.xml`. */
  free(stem: string, extension: string): string {
    let n = 1
    while (this.names.has(fold(`${stem}${n}${extension}`))) n++
    const part = `${stem}${n}${extension}`
    this.names.add(fold(part))
    return part
  }

  /** Whether any relationship part but `except` still points at `target`. */
  referenced(target: string, except: ReadonlySet<string>): boolean {
    const parts = new Set([...this.zip.byName.keys(), ...this.additions.keys()])
    for (const path of parts) {
      if (!/(^|\/)_rels\/[^/]+\.rels$/.test(path) || except.has(path) || !this.has(path)) continue
      const source = path.replace(/_rels\/([^/]+)\.rels$/, '$1')
      if (
        readRels(this.zip, source, this.text(path)).rels.some(
          (rel) => !rel.external && rel.target === target
        )
      )
        return true
    }
    return false
  }

  finish(): { bytes: Uint8Array; report: PackageReport } {
    const report: PackageReport = { partsChanged: [], partsAdded: [], partsRemoved: [] }
    if (this.removals.size || this.overrides.size || this.defaults.size)
      this.updates.set(CONTENT_TYPES, this.contentTypes())
    const encoder = new TextEncoder()
    const replace = new Map<string, Uint8Array>()
    const add = new Map<string, Uint8Array>()
    for (const [part, xml] of this.updates)
      if (!this.removals.has(part) && xml !== this.original(part))
        replace.set(part, encoder.encode(xml))
    for (const [part, data] of this.additions)
      add.set(part, typeof data === 'string' ? encoder.encode(data) : data)
    report.partsChanged = [...replace.keys()]
    report.partsAdded = [...add.keys()]
    report.partsRemoved = [...this.removals]
    if (!replace.size && !add.size && !this.removals.size) return { bytes: this.bytes, report }
    return { bytes: writeZip(this.zip, replace, this.removals, add), report }
  }

  private contentTypes(): string {
    const xml = this.original(CONTENT_TYPES)
    const part = new RulePart(xml, 'Types', ['Default', 'Override'])
    const gone = new Set([...this.removals].map(fold))
    const declared = new Map<string, string>()
    const extensions = new Map<string, string>()
    for (const el of part.siblings) {
      const open = openTag(xml, el)
      if (el.name === part.prefix + 'Default') {
        extensions.set(fold(valueOf(open, 'Extension') ?? ''), valueOf(open, 'ContentType') ?? '')
        continue
      }
      if (el.name !== part.prefix + 'Override') continue
      const path = fold((valueOf(open, 'PartName') ?? '').replace(/^\//, ''))
      if (gone.has(path)) part.replace(el, '')
      else declared.set(path, valueOf(open, 'ContentType') ?? '')
    }
    const overrides = new Map(this.overrides)
    for (const [ext, type] of this.defaults) {
      const held = extensions.get(ext)
      if (held === undefined)
        part.add('Default', tag(part.prefix + 'Default', { Extension: ext, ContentType: type }))
      // The extension already means something else here: each new part says its own type.
      else if (held !== type)
        for (const added of this.additions.keys())
          if (extension(added) === ext) overrides.set(added, type)
    }
    for (const [path, type] of overrides) {
      const held = declared.get(fold(path))
      if (held === type) continue
      if (held !== undefined) throw new ObjectsRefused(`The file already declares “${path}”.`)
      part.add(
        'Override',
        tag(part.prefix + 'Override', { PartName: '/' + path, ContentType: type })
      )
    }
    return part.render()
  }
}

/** One part's relationships: read, added to and dropped from, written back as text. */
export class Rels {
  readonly path: string
  readonly list: Relationship[]
  private readonly text: string
  private readonly gone = new Set<string>()
  private readonly added: { id: string; type: string; target: string }[] = []
  private readonly ids: Set<string>

  constructor(
    private readonly edit: PackageEdit,
    readonly source: string
  ) {
    this.path = relsPath(source)
    this.text = edit.has(this.path) ? edit.text(this.path) : ''
    this.list = this.text ? readRels(edit.zip, source, this.text).rels : []
    this.ids = new Set(this.list.map(({ id }) => id))
  }

  get(id: string | undefined): Relationship | undefined {
    return id === undefined ? undefined : this.list.find((rel) => rel.id === id)
  }

  /** A relationship of `type` (the last word of its URI: chart, image, drawing) to a part in the package. */
  add(type: string, target: string): string {
    let n = 1
    while (this.ids.has('rId' + n)) n++
    const id = 'rId' + n
    this.ids.add(id)
    this.added.push({ id, type: `${DOC_REL}/${type}`, target })
    this.list.push({ id, type: `${DOC_REL}/${type}`, target, external: false, span: [0, 0] })
    return id
  }

  drop(id: string): void {
    const at = this.list.findIndex((rel) => rel.id === id)
    if (at < 0) return
    this.list.splice(at, 1)
    const mine = this.added.findIndex((rel) => rel.id === id)
    if (mine >= 0) this.added.splice(mine, 1)
    else this.gone.add(id)
  }

  flush(): void {
    if (!this.gone.size && !this.added.length) return
    if (!this.list.length) {
      if (this.text) this.edit.remove(this.path)
      return
    }
    const original = this.text || DECL + `<Relationships xmlns="${PKG_REL}"/>`
    const part = new RulePart(original, 'Relationships', ['Relationship'])
    for (const el of part.siblings)
      if (this.gone.has(valueOf(openTag(original, el), 'Id') ?? '')) part.replace(el, '')
    if (this.added.length)
      part.add(
        'Relationship',
        this.added
          .map(({ id, type, target }) =>
            tag(part.prefix + 'Relationship', {
              Id: id,
              Type: type,
              Target: posix.relative(posix.dirname(this.source), target)
            })
          )
          .join('')
      )
    if (this.text) this.edit.set(this.path, part.render())
    else this.edit.add(this.path, part.render())
  }
}

// ---------------------------------------------------------------------------------------------
// Anchors

const whole = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max

function checkedCell(cell: AnchorCell | undefined): AnchorCell {
  if (
    !cell ||
    !whole(cell.column, 0, 16_383) ||
    !whole(cell.row, 0, 1_048_575) ||
    !whole(cell.columnOffset, 0, MAX_EMU) ||
    !whole(cell.rowOffset, 0, MAX_EMU)
  )
    throw new ObjectsRefused('Place the object on cells inside the worksheet.')
  return cell
}

/** An anchor's own fields, checked, in one order: what two anchors are compared by. */
export function checkedAnchor(anchor: ObjectAnchor | undefined): ObjectAnchor {
  const size = (width: number, height: number) => {
    if (!whole(width, 1, MAX_EMU) || !whole(height, 1, MAX_EMU))
      throw new ObjectsRefused('Give the object a width and a height.')
  }
  if (anchor?.kind === 'twoCell') {
    const from = checkedCell(anchor.from)
    const to = checkedCell(anchor.to)
    if (to.column < from.column || to.row < from.row)
      throw new ObjectsRefused('An object’s lower right corner must come after its upper left.')
    if (!['twoCell', 'oneCell', 'absolute'].includes(anchor.behaviour))
      throw new ObjectsRefused('An object moves with its cells, moves without sizing, or stays.')
    return { kind: 'twoCell', from: cellOf(from), to: cellOf(to), behaviour: anchor.behaviour }
  }
  if (anchor?.kind === 'oneCell') {
    size(anchor.width, anchor.height)
    return {
      kind: 'oneCell',
      from: cellOf(checkedCell(anchor.from)),
      width: anchor.width,
      height: anchor.height
    }
  }
  if (anchor?.kind === 'absolute') {
    size(anchor.width, anchor.height)
    if (!whole(anchor.x, -MAX_EMU, MAX_EMU) || !whole(anchor.y, -MAX_EMU, MAX_EMU))
      throw new ObjectsRefused('Place the object inside the worksheet.')
    return {
      kind: 'absolute',
      x: anchor.x,
      y: anchor.y,
      width: anchor.width,
      height: anchor.height
    }
  }
  throw new ObjectsRefused('Give the object a place on the sheet.')
}

const cellOf = ({ column, row, columnOffset, rowOffset }: AnchorCell): AnchorCell => ({
  column,
  row,
  columnOffset,
  rowOffset
})

export const sameAnchor = (a: ObjectAnchor, b: ObjectAnchor) =>
  JSON.stringify(checkedAnchor(a)) === JSON.stringify(checkedAnchor(b))

/**
 * Whether an object handed back sits somewhere else than the file has it. The file's own anchor
 * is taken as it is, however odd; only a new place is checked, and refused where it cannot be.
 */
export function anchorMoved(next: ObjectAnchor, old: ObjectAnchor): boolean {
  if (JSON.stringify(next) === JSON.stringify(old)) return false
  const place = JSON.stringify(checkedAnchor(next))
  try {
    return place !== JSON.stringify(checkedAnchor(old))
  } catch {
    return true
  }
}

function placeXml(p: string, anchor: ObjectAnchor): string {
  const cell = (name: string, c: AnchorCell) =>
    `<${p}${name}><${p}col>${c.column}</${p}col><${p}colOff>${c.columnOffset}</${p}colOff>` +
    `<${p}row>${c.row}</${p}row><${p}rowOff>${c.rowOffset}</${p}rowOff></${p}${name}>`
  if (anchor.kind === 'twoCell') return cell('from', anchor.from) + cell('to', anchor.to)
  const ext = `<${p}ext cx="${anchor.width}" cy="${anchor.height}"/>`
  if (anchor.kind === 'oneCell') return cell('from', anchor.from) + ext
  return `<${p}pos x="${anchor.x}" y="${anchor.y}"/>` + ext
}

const editAs = (anchor: ObjectAnchor) =>
  anchor.kind === 'twoCell' && anchor.behaviour !== 'twoCell' ? anchor.behaviour : undefined

/** A whole anchor around `body` (a graphic frame or a picture), with `p` the drawing's own prefix. */
export function anchorXml(p: string, input: ObjectAnchor, body: string): string {
  const anchor = checkedAnchor(input)
  const name = `${p}${anchor.kind}Anchor`
  return (
    tag(name, { editAs: editAs(anchor) }).replace(/\/>$/, '>') +
    placeXml(p, anchor) +
    body +
    `<${p}clientData/></${name}>`
  )
}

/** How an anchor element reads, as the kit's reader reads it; undefined where a field is missing. */
function readAnchor(
  xml: string,
  el: ElementSpan,
  kind: ObjectAnchor['kind']
): ObjectAnchor | undefined {
  const kids = new Map<string, ElementSpan>()
  for (const child of children(xml, el))
    if (!kids.has(local(child.name))) kids.set(local(child.name), child)
  const digits = (text: string | undefined, signed = false) =>
    text !== undefined && (signed ? /^\s*-?\d{1,15}\s*$/ : /^\s*\d{1,15}\s*$/).test(text)
      ? Number(text)
      : undefined
  const cell = (span: ElementSpan | undefined): AnchorCell | undefined => {
    if (!span) return undefined
    const field = new Map<string, string>()
    for (const child of children(xml, span))
      if (!field.has(local(child.name)))
        field.set(local(child.name), xml.slice(child.openEnd, child.close))
    const column = digits(field.get('col'))
    const row = digits(field.get('row'))
    if (column === undefined || row === undefined) return undefined
    return {
      column,
      row,
      columnOffset: digits(field.get('colOff'), true) ?? 0,
      rowOffset: digits(field.get('rowOff'), true) ?? 0
    }
  }
  const from = cell(kids.get('from'))
  const ext = kids.get('ext')
  const width = ext && digits(valueOf(openTag(xml, ext), 'cx'))
  const height = ext && digits(valueOf(openTag(xml, ext), 'cy'))
  if (kind === 'twoCell') {
    const to = cell(kids.get('to'))
    const behaviour = valueOf(openTag(xml, el), 'editAs')
    return from && to
      ? {
          kind,
          from,
          to,
          behaviour: behaviour === 'oneCell' || behaviour === 'absolute' ? behaviour : 'twoCell'
        }
      : undefined
  }
  if (width === undefined || height === undefined) return undefined
  if (kind === 'oneCell') return from ? { kind, from, width, height } : undefined
  const pos = kids.get('pos')
  const x = pos && digits(valueOf(openTag(xml, pos), 'x'), true)
  const y = pos && digits(valueOf(openTag(xml, pos), 'y'), true)
  return x === undefined || y === undefined ? undefined : { kind, x, y, width, height }
}

/** A chart or a picture an anchor holds, by the relationship that names its part. */
export interface ObjectRef {
  type: 'chart' | 'picture'
  rid: string
  /** The part the relationship points at; undefined when the drawing has no such relationship. */
  target?: string
  /** The object's own element: a graphic frame or a pic. */
  span: ElementSpan
  /** A picture's place among the drawing's pictures, from 1: the reader's id is `<drawing>#n`. */
  n?: number
}

export interface AnchorSlot {
  span: ElementSpan
  kind: ObjectAnchor['kind']
  anchor?: ObjectAnchor
  refs: ObjectRef[]
  removed?: true
}

const relAttr = (open: string, name: string) =>
  parseAttrs(open).find((a) => a.name === name || a.name.endsWith(':' + name))?.value

/** A sheet's drawing part: found through the sheet's own `<drawing r:id>`, or made at the first add. */
export class SheetDrawing {
  readonly chartsheet: boolean
  readonly sheetRels: Rels
  readonly slots: AnchorSlot[] = []
  path?: string
  rels?: Rels
  /** The drawing's prefix for its own namespace, with the colon: `xdr:`. */
  prefix = 'xdr:'
  private readonly sheet: RulePart
  private readonly link?: { el: ElementSpan; rid: string }
  private xml = ''
  private root?: ElementSpan
  private others = 0
  private fresh = false
  private fault?: string
  private readonly splices: Splice[] = []
  private readonly pending: string[] = []
  private readonly shapeIds = new Set<number>()
  private readonly shapeNames = new Set<string>()

  constructor(
    readonly edit: PackageEdit,
    readonly tab: Tab
  ) {
    this.chartsheet = tab.kind === 'chartsheet'
    this.sheet = new RulePart(
      edit.text(tab.part),
      this.chartsheet ? 'chartsheet' : 'worksheet',
      this.chartsheet ? CHARTSHEET_ORDER : SHEET_ORDER
    )
    this.sheetRels = new Rels(edit, tab.part)
    const el = this.sheet.first('drawing')
    if (!el) return
    const rid = relAttr(openTag(this.sheet.xml, el), 'id')
    const rel = this.sheetRels.get(rid)
    if (!rid || !rel || rel.external || !rel.type.endsWith('/drawing') || !edit.has(rel.target)) {
      this.fault = `“${tab.name}” names a drawing the file does not have.`
      return
    }
    this.link = { el, rid }
    this.load(rel.target)
  }

  private load(path: string) {
    this.path = path
    this.xml = this.edit.text(path)
    this.rels = new Rels(this.edit, path)
    const root = documentRoot(this.xml)
    if (!root || local(root.name) !== 'wsDr') {
      this.fault = `The drawing of “${this.tab.name}” is not one this editor can change.`
      return
    }
    this.root = root
    this.prefix = root.name.slice(0, -'wsDr'.length)
    const bound = valueOf(
      openTag(this.xml, root),
      this.prefix ? 'xmlns:' + this.prefix.slice(0, -1) : 'xmlns'
    )
    if (bound !== XDR_NS)
      this.fault = `The drawing of “${this.tab.name}” is not one this editor can change.`
    let pictures = 0
    const scan = (parent: ElementSpan, refs: ObjectRef[], depth: number) => {
      if (depth > MAX_DEPTH) return
      for (const el of children(this.xml, parent)) {
        const name = local(el.name)
        if (name === 'graphicFrame') {
          const chart = this.find(el, 'chart', 0)
          const rid = chart && relAttr(openTag(this.xml, chart), 'id')
          if (rid) refs.push({ type: 'chart', rid, target: this.target(rid), span: el })
        } else if (name === 'pic') {
          const n = ++pictures
          const blip = this.find(el, 'blip', 0)
          const rid = blip && relAttr(openTag(this.xml, blip), 'embed')
          if (rid) refs.push({ type: 'picture', rid, target: this.target(rid), span: el, n })
        } else scan(el, refs, depth + 1)
      }
    }
    for (const el of children(this.xml, root)) {
      const kind = el.name.startsWith(this.prefix)
        ? ANCHORS.get(el.name.slice(this.prefix.length))
        : undefined
      if (!kind) {
        this.others++
        continue
      }
      const slot: AnchorSlot = { span: el, kind, anchor: readAnchor(this.xml, el, kind), refs: [] }
      scan(el, slot.refs, 0)
      this.slots.push(slot)
    }
    for (const m of this.xml.matchAll(/<(?:[\w.-]+:)?cNvPr\b[^>]*>/g)) {
      const id = valueOf(m[0], 'id')
      const name = valueOf(m[0], 'name')
      if (id !== undefined && /^\d+$/.test(id)) this.shapeIds.add(Number(id))
      if (name !== undefined) this.shapeNames.add(fold(name))
    }
  }

  private find(parent: ElementSpan, name: string, depth: number): ElementSpan | undefined {
    if (depth > MAX_DEPTH) return undefined
    for (const el of children(this.xml, parent)) {
      if (local(el.name) === name) return el
      const inside = this.find(el, name, depth + 1)
      if (inside) return inside
    }
    return undefined
  }

  private target(rid: string): string | undefined {
    const rel = this.rels?.get(rid)
    return rel && !rel.external ? rel.target : undefined
  }

  /**
   * The anchor that holds this object and nothing else, placed where the reader says it is: the
   * one anchor a move, a size or a removal may change. Undefined for an object in a group, beside
   * another in one anchor, or in a drawing whose walk does not match the reader's.
   */
  slotOf(
    type: ObjectRef['type'],
    id: string,
    anchor: ObjectAnchor,
    frame?: unknown
  ): AnchorSlot | undefined {
    if (this.fault || frame !== undefined) return undefined
    const found = this.slots.filter(
      (slot) =>
        !slot.removed &&
        slot.refs.some(
          (ref) =>
            ref.type === type &&
            (type === 'chart' ? ref.target === id : `${this.path}#${ref.n}` === id)
        )
    )
    const slot = found[0]
    if (found.length !== 1 || slot.refs.length !== 1 || !slot.anchor) return undefined
    try {
      return sameAnchor(slot.anchor, anchor) ? slot : undefined
    } catch {
      return undefined
    }
  }

  /** Refuses any change where the sheet's objects are locked or its drawing cannot be read. */
  guard(): void {
    if (this.fault) throw new ObjectsRefused(this.fault)
    const protection = this.sheet.first('sheetProtection')
    if (!protection) return
    const open = openTag(this.sheet.xml, protection)
    const locked = this.chartsheet
      ? isOn(valueOf(open, 'content')) || isOn(valueOf(open, 'objects'))
      : isOn(valueOf(open, 'sheet')) && isOn(valueOf(open, 'objects'))
    if (locked)
      throw new ObjectsRefused(
        `“${this.tab.name}” is protected. Unprotect the sheet in Excel before changing its charts and pictures.`
      )
  }

  /** A shape id no shape in the drawing has, and a name such as “Chart 2” none has. */
  shape(word: string): { id: number; name: string } {
    let id = 2
    while (this.shapeIds.has(id)) id++
    this.shapeIds.add(id)
    let n = 1
    while (this.shapeNames.has(fold(`${word} ${n}`))) n++
    this.shapeNames.add(fold(`${word} ${n}`))
    return { id, name: `${word} ${n}` }
  }

  /** Moves or sizes an anchor: its place is written afresh, what it holds stays byte for byte. */
  move(slot: AnchorSlot, input: ObjectAnchor): void {
    const anchor = checkedAnchor(input)
    const p = this.prefix
    const name = `${p}${anchor.kind}Anchor`
    let open = openTag(this.xml, slot.span)
      .replace(/^<[^\s/>]+/, '<' + name)
      .replace(/\s*\/>$/, '>')
    const as = editAs(anchor)
    open = as ? setAttrInTag(open, 'editAs', as) : removeAttrInTag(open, 'editAs')
    const kept = [...children(this.xml, slot.span)]
      .filter((el) => !(el.name.startsWith(p) && PLACE.has(el.name.slice(p.length))))
      .map((el) => elementText(this.xml, el))
      .join('')
    const text = open + placeXml(p, anchor) + kept + `</${name}>`
    if (text !== elementText(this.xml, slot.span))
      this.splices.push({ start: slot.span.start, end: slot.span.end, text })
  }

  remove(slot: AnchorSlot): void {
    slot.removed = true
    this.splices.push({ start: slot.span.start, end: slot.span.end, text: '' })
  }

  /** The drawing's relationships, making the drawing part where the sheet has none. */
  links(): Rels {
    if (this.rels) return this.rels
    if (this.chartsheet)
      throw new ObjectsRefused(`“${this.tab.name}” is a chart sheet with no chart.`)
    this.path = this.edit.free('xl/drawings/drawing', '.xml')
    this.fresh = true
    this.xml = DECL + `<xdr:wsDr xmlns:xdr="${XDR_NS}" xmlns:a="${A_NS}"/>`
    this.root = documentRoot(this.xml)
    return (this.rels = new Rels(this.edit, this.path))
  }

  /** A new anchor, last in the drawing and so drawn over the others. */
  add(anchor: ObjectAnchor, body: string): void {
    this.links()
    this.pending.push(anchorXml(this.prefix, anchor, body))
  }

  /** Writes the drawing as it now stands; with no anchor left it goes, with its link from the sheet. */
  flush(): void {
    if (!this.path || !this.root || !this.rels) return
    if (!this.splices.length && !this.pending.length) return this.rels.flush()
    const left =
      this.slots.filter((slot) => !slot.removed).length + this.others + this.pending.length
    if (!left) {
      if (this.edit.has(this.rels.path)) this.edit.remove(this.rels.path)
      this.edit.remove(this.path)
      if (this.link) {
        this.sheet.replace(this.link.el, '')
        this.sheetRels.drop(this.link.rid)
        this.edit.set(this.tab.part, this.sheet.render())
        this.sheetRels.flush()
      }
      return
    }
    const added = this.pending.join('')
    const root = this.root
    const xml =
      root.openEnd === root.end
        ? applySplices(this.xml, [
            {
              start: root.start,
              end: root.end,
              text: withBody(openTag(this.xml, root), root.name, added)
            }
          ])
        : applySplices(this.xml, [
            ...this.splices,
            { start: root.close, end: root.close, text: added }
          ])
    if (!this.fresh) this.edit.set(this.path, xml)
    else {
      this.edit.add(this.path, xml, { override: DRAWING_TYPE })
      const rid = this.sheetRels.add('drawing', this.path)
      this.sheet.add(
        'drawing',
        tag(this.sheet.prefix + 'drawing', { 'xmlns:r': DOC_REL, 'r:id': rid })
      )
      this.edit.set(this.tab.part, this.sheet.render())
      this.sheetRels.flush()
    }
    this.rels.flush()
  }
}
