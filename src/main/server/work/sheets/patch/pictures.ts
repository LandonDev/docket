// A tab's pictures written into the Excel file as real parts: an image in xl/media, an `image`
// relationship from the sheet's drawing, and a `pic` in its own anchor. An edit is the complete
// list for one tab, in the kit's own model (work-kit's PictureSpec), so the canvas hands back what
// it read. Every refusal comes before anything is written; an edit that changes nothing returns
// the same bytes object.
import { createHash } from 'node:crypto'
import { readObjects, type ObjectFrame, type PictureSpec } from 'work-kit/sheet/xlsx'
import {
  A_NS,
  anchorMoved,
  checkedAnchor,
  DOC_REL,
  ObjectsRefused,
  PackageEdit,
  SheetDrawing,
  type AnchorSlot,
  type PackageReport,
  type Tab
} from './drawings'
import { applySplices, children, openTag, type ElementSpan, type Splice } from './format-xml'
import { workbookMap } from './patch'
import { local } from './rules-xml'
import { esc, parseAttrs, removeAttrInTag } from './xml'
import { readZip } from './zip'

/** Pictures and charts refuse in the same words for the same faults: one class. */
export { ObjectsRefused as PicturesRefused } from './drawings'

/** A picture as the canvas hands it back: the kit's PictureSpec, and for a new one its bytes. */
export type PictureModel = Omit<PictureSpec, 'part' | 'contentType'> & {
  part?: string
  contentType?: string
  bytes?: Uint8Array
}
export interface PicturesEdit {
  kind: 'pictures'
  sheet: string
  /** The complete picture list for this tab. */
  pictures: readonly PictureModel[]
}
export interface PicturesReport extends PackageReport {
  /** The id handed in -> the id the file now has. */
  ids: Record<string, string>
}

const MAX_PICTURES = 2_000
const MAX_BYTES = 20 * 1024 * 1024
const MAX_NAME = 255
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0))
const starts = (bytes: Uint8Array, sign: number[]) => sign.every((b, i) => bytes[i] === b)
/** The formats Excel draws that we know by their first bytes, with the extension Excel gives each. */
const FORMATS: { ext: string; type: string; label: string; is: (bytes: Uint8Array) => boolean }[] =
  [
    {
      ext: 'png',
      type: 'image/png',
      label: 'PNG',
      is: (b) => starts(b, [0x89, ...ascii('PNG\r\n\x1a\n')])
    },
    { ext: 'jpeg', type: 'image/jpeg', label: 'JPEG', is: (b) => starts(b, [0xff, 0xd8, 0xff]) },
    {
      ext: 'gif',
      type: 'image/gif',
      label: 'GIF',
      is: (b) => starts(b, ascii('GIF87a')) || starts(b, ascii('GIF89a'))
    },
    {
      ext: 'bmp',
      type: 'image/bmp',
      label: 'BMP',
      // "BM" alone is two letters of text: the header's own size must be one a bitmap has.
      is: (b) =>
        starts(b, ascii('BM')) &&
        b.length >= 26 &&
        [12, 40, 52, 56, 64, 108, 124].includes(
          new DataView(b.buffer, b.byteOffset).getUint32(14, true)
        )
    }
  ]

interface Image {
  bytes: Uint8Array
  hash: string
  ext: string
  type: string
}

const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function imageOf(model: PictureModel): Image {
  const bytes = model.bytes
  if (!bytes?.length) throw new ObjectsRefused('A new picture needs its image.')
  if (bytes.length > MAX_BYTES) throw new ObjectsRefused('An image can be at most 20 MB.')
  const format = FORMATS.find((f) => f.is(bytes))
  if (!format) throw new ObjectsRefused('The image is not a PNG, JPEG, GIF or BMP picture.')
  if (model.contentType !== undefined && model.contentType !== format.type)
    throw new ObjectsRefused(`The image is a ${format.label} picture, not ${model.contentType}.`)
  return { bytes, hash: hashOf(bytes), ext: format.ext, type: format.type }
}

const sameFrame = (a: ObjectFrame | undefined, b: ObjectFrame | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height)

interface Kept {
  spec: PictureSpec
  model: PictureModel
  /** What changes; the slot is set where anything does. */
  move: boolean
  name?: string
  /** The description to write, or null to drop it. */
  descr?: string | null
  image?: Image
  slot?: AnchorSlot
  cNvPr?: ElementSpan
  blip?: ElementSpan
}

interface Plan {
  tab: Tab
  drawing: SheetDrawing
  specs: PictureSpec[]
  kept: Kept[]
  removed: PictureSpec[]
  added: { model: PictureModel; image: Image }[]
}

/** The child at the end of a path of local names, as the kit's reader walks it. */
function childAt(
  xml: string,
  el: ElementSpan | undefined,
  ...path: string[]
): ElementSpan | undefined {
  for (const name of path) el = el && [...children(xml, el)].find((kid) => local(kid.name) === name)
  return el
}

function planTab(
  edit: PackageEdit,
  tab: Tab,
  specs: PictureSpec[],
  models: readonly PictureModel[]
): Plan {
  const drawing = new SheetDrawing(edit, tab)
  const byId = new Map(specs.map((spec) => [spec.id, spec]))
  const ids = new Set<string>()
  const plan: Plan = { tab, drawing, specs, kept: [], removed: [], added: [] }
  for (const model of models) {
    if (ids.has(model.id))
      throw new ObjectsRefused(`The list for “${tab.name}” names one picture twice.`)
    ids.add(model.id)
    if ((model.name?.length ?? 0) > MAX_NAME)
      throw new ObjectsRefused(`A picture’s name can be at most ${MAX_NAME} characters.`)
    const spec = byId.get(model.id)
    if (!spec) {
      if (model.frame !== undefined)
        throw new ObjectsRefused('A new picture cannot be placed inside a group.')
      checkedAnchor(model.anchor)
      plan.added.push({ model, image: imageOf(model) })
      continue
    }
    const kept: Kept = { spec, model, move: anchorMoved(model.anchor, spec.anchor) }
    // A name is required in the file: one left out keeps the file's.
    const name = clean(model.name ?? '')
    const description = clean(model.description ?? '')
    if (name && name !== spec.name) kept.name = name
    if ((description || undefined) !== spec.description) kept.descr = description || null
    if (model.bytes !== undefined) {
      const image = imageOf(model)
      if (image.hash !== hashOf(edit.bytesOf(spec.part))) kept.image = image
    }
    if (!sameFrame(model.frame, spec.frame)) throw grouped(spec, tab)
    plan.kept.push(kept)
  }
  plan.removed = specs.filter((spec) => !ids.has(spec.id))
  const changed = plan.kept.filter((k) => k.move || k.name || k.descr !== undefined || k.image)
  if (!changed.length && !plan.removed.length && !plan.added.length) return plan
  drawing.guard()
  if (plan.added.length && (drawing.prefix === 'a:' || drawing.prefix === 'r:'))
    throw new ObjectsRefused(
      `The drawing of “${tab.name}” is not one this editor can add pictures to.`
    )
  for (const spec of plan.removed)
    if (!drawing.slotOf('picture', spec.id, spec.anchor, spec.frame)) throw grouped(spec, tab)
  const xml = drawing.path ? edit.text(drawing.path) : ''
  for (const k of changed) {
    k.slot = drawing.slotOf('picture', k.spec.id, k.spec.anchor, k.spec.frame)
    const pic = k.slot?.refs[0].span
    const named = !!k.name || k.descr !== undefined
    if (named) k.cNvPr = childAt(xml, pic, 'nvPicPr', 'cNvPr')
    if (k.image) k.blip = childAt(xml, pic, 'blipFill', 'blip')
    if (!k.slot || (named && !k.cNvPr) || (k.image && !k.blip)) throw grouped(k.spec, tab)
  }
  return plan
}

const grouped = (spec: PictureSpec, tab: Tab) =>
  new ObjectsRefused(
    `${spec.name ? `“${spec.name}”` : `A picture on “${tab.name}”`} is part of a group (or sits in a ` +
      'drawing this editor cannot change): move or remove it in Excel.'
  )

/** A name or a description without the characters XML cannot carry: a drawing has no way to write them. */
const clean = (text: string) => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '')

/**
 * A drawing's attribute text: XML's own escapes and nothing more. Excel reads a drawing's names
 * as plain strings, so a worksheet's `_xHHHH_` escape would show as typed.
 */
const attrText = (value: string) =>
  esc(clean(value)).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;')

/** Sets one attribute in a start tag; the rest of the tag stays. */
function withAttr(open: string, name: string, value: string | null): string {
  if (value === null) return removeAttrInTag(open, name)
  const text = `"${attrText(value)}"`
  const held = new RegExp(`(\\s${name.replace(/[.:]/g, '\\$&')}\\s*=\\s*)(?:"[^"]*"|'[^']*')`)
  return held.test(open)
    ? open.replace(held, (_, lead: string) => lead + text)
    : open.replace(/\s*(\/?>)$/, (_, end: string) => ` ${name}=${text}${end}`)
}

/** The values of every prefixed attribute: where a drawing names its relationships. */
const relValues = (xml: string) =>
  new Set(
    [...xml.matchAll(/\s[\w.-]+:[\w.-]+\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => m[1] ?? m[2])
  )

/**
 * A new picture's element. Its own `a` and `r` are declared on it, so it is right whatever the
 * drawing's root declares. The anchor holds the place; `a:xfrm` says only what the anchor states
 * without the sheet's column widths: nothing for a two-cell anchor.
 */
function picXml(p: string, shape: { id: number; name: string }, rid: string, model: PictureModel) {
  const anchor = checkedAnchor(model.anchor)
  const { id } = shape
  const name = model.name || shape.name
  const descr = model.description || undefined
  const off = anchor.kind === 'absolute' ? `<a:off x="${anchor.x}" y="${anchor.y}"/>` : ''
  const ext = anchor.kind === 'twoCell' ? '' : `<a:ext cx="${anchor.width}" cy="${anchor.height}"/>`
  const xfrm = ext && `<a:xfrm>${off}${ext}</a:xfrm>`
  return (
    `<${p}pic xmlns:a="${A_NS}" xmlns:r="${DOC_REL}">` +
    `<${p}nvPicPr><${p}cNvPr id="${id}" name="${attrText(name)}"${descr ? ` descr="${attrText(descr)}"` : ''}/>` +
    `<${p}cNvPicPr><a:picLocks noChangeAspect="1"/></${p}cNvPicPr></${p}nvPicPr>` +
    `<${p}blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></${p}blipFill>` +
    `<${p}spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></${p}spPr></${p}pic>`
  )
}

/** Writes one tab's plan. `media` holds the parts this patch added, by their bytes' hash. */
function apply(edit: PackageEdit, plan: Plan, media: Map<string, string>, orphans: string[]) {
  let { drawing } = plan
  let pool: Map<string, string> | undefined
  // The relationship for an image: one the drawing has to the same bytes, else a new one.
  const ridOf = (image: Image) => {
    pool ??= new Map(
      (drawing.rels?.list ?? [])
        .filter((rel) => !rel.external && rel.type.endsWith('/image') && edit.has(rel.target))
        .map((rel) => [hashOf(edit.bytesOf(rel.target)), rel.id])
    )
    let rid = pool.get(image.hash)
    if (rid) return rid
    let part = media.get(image.hash)
    if (!part) {
      part = edit.free('xl/media/image', '.' + image.ext)
      edit.add(part, image.bytes, { default: image.type })
      media.set(image.hash, part)
    }
    rid = drawing.links().add('image', part)
    pool.set(image.hash, rid)
    return rid
  }

  // First a picture's name, description and image, spliced inside its element; then the anchors
  // are moved, removed and added on the drawing read afresh, so no two splices overlap.
  const inner = plan.kept.filter((k) => k.cNvPr || k.blip)
  const replaced = new Set<string>()
  if (inner.length) {
    const path = drawing.path!
    const xml = edit.text(path)
    const splices: Splice[] = []
    for (const k of inner) {
      if (k.cNvPr) {
        let open = openTag(xml, k.cNvPr)
        if (k.name) open = withAttr(open, 'name', k.name)
        if (k.descr !== undefined) open = withAttr(open, 'descr', k.descr)
        splices.push({ start: k.cNvPr.start, end: k.cNvPr.openEnd, text: open })
      }
      if (k.blip && k.image) {
        const open = openTag(xml, k.blip)
        const embed = parseAttrs(open).find((a) => a.name === 'embed' || a.name.endsWith(':embed'))!
        const text = withAttr(open, embed.name, ridOf(k.image))
        replaced.add(k.slot!.refs[0].rid)
        splices.push({ start: k.blip.start, end: k.blip.openEnd, text })
      }
    }
    drawing.rels!.flush()
    edit.set(path, applySplices(xml, splices))
    drawing = new SheetDrawing(edit, plan.tab)
  }

  const slot = (spec: PictureSpec) => drawing.slotOf('picture', spec.id, spec.anchor)!
  for (const k of plan.kept) if (k.move) drawing.move(slot(k.spec), k.model.anchor)
  const xml = drawing.path ? edit.text(drawing.path) : ''
  const gone = plan.removed.map(slot)
  // Every relationship a removed anchor named, and each replaced image's, may now be unused.
  const unsure = new Set(replaced)
  for (const s of gone)
    for (const value of relValues(xml.slice(s.span.start, s.span.end))) unsure.add(value)
  for (const s of gone) drawing.remove(s)
  const used = new Set<string>()
  for (const { model, image } of plan.added) {
    const rid = ridOf(image)
    used.add(rid)
    drawing.add(model.anchor, picXml(drawing.prefix, drawing.shape('Picture'), rid, model))
  }
  if (drawing.rels && unsure.size) {
    const cut = gone.map(({ span }) => ({ start: span.start, end: span.end, text: '' }))
    const left = relValues(applySplices(xml, cut))
    for (const rid of unsure) {
      const rel = drawing.rels.get(rid)
      if (!rel || left.has(rid) || used.has(rid)) continue
      drawing.rels.drop(rid)
      if (!rel.external) orphans.push(rel.target)
    }
  }
  drawing.flush()
  plan.drawing = drawing
}

/** Writes each tab's complete picture list into the workbook. */
export function patchPictures(
  bytes: Uint8Array,
  edits: readonly PicturesEdit[]
): { bytes: Uint8Array; report: PicturesReport } {
  const read = readObjects(bytes)
  const edit = new PackageEdit(bytes)
  const tabs = new Set<string>()
  let total = read.pictures.length
  const plans = edits.map(({ sheet, pictures }) => {
    const tab = edit.tab(sheet)
    if (!tab || tab.kind !== 'worksheet') throw new ObjectsRefused(`No worksheet named “${sheet}”.`)
    if (tabs.has(tab.name))
      throw new ObjectsRefused(
        `“${tab.name}” is listed twice: give one complete picture list for each tab.`
      )
    tabs.add(tab.name)
    const plan = planTab(
      edit,
      tab,
      read.pictures.filter((p) => p.sheet === tab.name),
      pictures
    )
    total += plan.added.length - plan.removed.length
    return plan
  })
  if (plans.some((plan) => plan.added.length) && total > MAX_PICTURES)
    throw new ObjectsRefused('A workbook can hold at most 2,000 pictures.')

  const media = new Map<string, string>()
  const orphans: string[] = []
  for (const plan of plans) apply(edit, plan, media, orphans)
  // A media part goes once no relationship anywhere points at it (an in-cell picture's does).
  for (const part of orphans)
    if (edit.has(part) && !edit.referenced(part, new Set())) edit.remove(part)
  const out = edit.finish()
  const ids = idsOf(plans, out.bytes !== bytes ? out.bytes : undefined)
  return { bytes: out.bytes, report: { ...out.report, ids } }
}

/**
 * Each id handed in -> the id the kit's reader gives that picture in the output. Removing or
 * adding pictures renumbers the drawing's, so the output is read back: a tab's pictures there are
 * the ones it kept, in their order, and then the new ones.
 */
function idsOf(plans: Plan[], written: Uint8Array | undefined): Record<string, string> {
  const ids: Record<string, string> = Object.create(null)
  const after = written && readObjects(written).pictures
  for (const plan of plans) {
    const gone = new Set(plan.removed)
    const kept = plan.specs.filter((spec) => !gone.has(spec))
    const listed = [...kept.map((spec) => spec.id), ...plan.added.map(({ model }) => model.id)]
    const found = after ? after.filter((p) => p.sheet === plan.tab.name).map((p) => p.id) : listed
    if (found.length !== listed.length)
      throw new Error(`The pictures written to “${plan.tab.name}” do not read back as written.`)
    listed.forEach((id, i) => (ids[id] = found[i]))
  }
  return ids
}

/** The kit's pictures grouped by worksheet: every worksheet listed, an empty list where it has none. */
export function readPictures(
  bytes: Uint8Array,
  sheet?: string
): { sheets: Record<string, { pictures: PictureSpec[] }>; warnings: string[] } {
  const tabs = workbookMap(readZip(bytes)).sheets.filter(
    (tab) => tab.kind === 'worksheet' && (sheet === undefined || tab.name === sheet)
  )
  if (sheet !== undefined && !tabs.length)
    throw new ObjectsRefused(`No worksheet named “${sheet}”.`)
  const { pictures, warnings } = readObjects(bytes)
  const sheets: Record<string, { pictures: PictureSpec[] }> = Object.create(null)
  for (const tab of tabs)
    sheets[tab.name] = { pictures: pictures.filter((p) => p.sheet === tab.name) }
  return { sheets, warnings }
}
