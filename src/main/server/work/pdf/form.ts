import * as fontkit from '@pdf-lib/fontkit'
import {
  LineCapStyle,
  LineJoinStyle,
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFString,
  PDFTextField,
  StandardFonts,
  closePath,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setLineCap,
  setLineJoin,
  setFillingRgbColor,
  setGraphicsState,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  type PDFField,
  type PDFFont,
  type PDFForm,
  type PDFPage,
  type PDFWidgetAnnotation
} from 'pdf-lib'
import type { Bbox, PdfSignature } from '@shared/contract-work-pdf'

/**
 * Reading and writing a PDF's form in process, with pdf-lib (MIT)
 * (docs/agents/work-pdf.md). Bytes in, bytes out: nothing here touches the
 * disk or Node, so it can move to a worker later. Every rule below is a trap
 * the PDF research measured on the IRS W-9 (an XFA and AcroForm hybrid):
 * a value set is not a value shown until its appearance is rewritten,
 * flattening must paint the widgets rather than delete them, and the
 * standard fonts draw WinAnsi only.
 */

export interface FormField {
  /** the AcroForm field's full name */
  key: string
  /** /TU when the file has one, else '' (labelFields fills it) */
  label: string
  type: 'text' | 'checkbox' | 'choice' | 'signature'
  /** from 1: the page of its first widget */
  page: number
  /** normalised, origin top-left */
  bbox: Bbox
  value: string | boolean | null
  /** choice and radio fields */
  options?: string[]
  readOnly: boolean
  maxLength?: number
  multiline?: boolean
}

export interface FormRead {
  pages: Array<{ width: number; height: number }>
  fields: FormField[]
  /** an /XFA entry is present */
  xfa: boolean
  /** XFA and no AcroForm widget at all */
  xfaOnly: boolean
}

export interface WriteInput {
  /** values for the file's own fields, by key: a string for text and choice fields, a boolean for a checkbox */
  values: Array<{ key: string; value: string | boolean }>
  /** text, a check or the drawn signature on a page that has no field there */
  overlays: Array<{ page: number; bbox: Bbox; text?: string; check?: boolean; signature?: PdfSignature }>
  /** highlights, written as real /Highlight annotations */
  marks: Array<{ name: string; page: number; quads: Bbox[]; note?: string; author: string }>
  /** paint the fields into the page and drop the form */
  flatten: boolean
  /** a TrueType font that covers the values; absent: Helvetica, which is WinAnsi only */
  font?: Uint8Array
  /** the marks' modification date (/M); now when absent */
  now?: Date
}

export interface WriteResult {
  bytes: Uint8Array
  /** what could not be written, one sentence each; nothing is dropped silently */
  warnings: string[]
}

export class PdfFormError extends Error {}

// ── geometry ─────────────────────────────────────────────────────────

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const round4 = (n: number): number => Math.round(Math.min(1, Math.max(0, n)) * 10_000) / 10_000

/** A rectangle in points (origin bottom-left) as shares of the page, origin top-left. */
function normalise(r: Box, page: PDFPage): Bbox {
  const m = page.getMediaBox()
  return [round4((r.x - m.x) / m.width), round4((m.y + m.height - (r.y + r.height)) / m.height), round4((r.x + r.width - m.x) / m.width), round4((m.y + m.height - r.y) / m.height)]
}

/** A share of the page back to points, origin bottom-left. */
function toPoints(b: Bbox, page: PDFPage): Box {
  const m = page.getMediaBox()
  return { x: m.x + b[0] * m.width, y: m.y + m.height - b[3] * m.height, width: (b[2] - b[0]) * m.width, height: (b[3] - b[1]) * m.height }
}

const validBox = (b: Bbox): boolean => b.length === 4 && b.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) && b[2] > b[0] && b[3] > b[1]

// ── loading ──────────────────────────────────────────────────────────

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    // A copy: pdf-lib parses in place, and the caller's bytes stay theirs.
    return await PDFDocument.load(bytes.slice(), { updateMetadata: false })
  } catch (err) {
    const name = err instanceof Error ? err.constructor.name : ''
    if (name === 'EncryptedPDFError' || /encrypt/i.test(String(err))) throw new PdfFormError('This PDF is encrypted, so its form cannot be read or filled here.')
    throw new PdfFormError(`This file could not be read as a PDF: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The catalog's /AcroForm, when the file has one. */
const acroFormOf = (doc: PDFDocument): PDFDict | undefined => doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)

/**
 * pdf-lib drops the XFA part on `getForm()` and says so on the console;
 * this drops it first, quietly. The AcroForm layer every hybrid keeps is
 * what gets filled, and a viewer falls back to it.
 */
function formOf(doc: PDFDocument): PDFForm {
  acroFormOf(doc)?.delete(PDFName.of('XFA'))
  return doc.getForm()
}

/** The page index of every annotation, by its reference: a widget's own /P is often missing. */
function annotPages(doc: PDFDocument): Map<PDFRef, number> {
  const out = new Map<PDFRef, number>()
  doc.getPages().forEach((page, i) => {
    const annots = page.node.Annots()
    for (let j = 0; j < (annots?.size() ?? 0); j++) {
      const ref = annots?.get(j)
      if (ref instanceof PDFRef) out.set(ref, i)
    }
  })
  return out
}

function widgetPage(doc: PDFDocument, widget: PDFWidgetAnnotation, pages: Map<PDFRef, number>): number {
  const ref = doc.context.getObjectRef(widget.dict)
  const byAnnots = ref ? pages.get(ref) : undefined
  if (byAnnots !== undefined) return byAnnots
  const p = widget.P()
  const i = p ? doc.getPages().findIndex((page) => page.ref === p) : -1
  return i >= 0 ? i : 0
}

// ── reading ──────────────────────────────────────────────────────────

const tooltip = (field: PDFField): string => {
  const tu = field.acroField.dict.lookup(PDFName.of('TU'))
  return tu instanceof PDFString || tu instanceof PDFHexString ? tu.decodeText().trim() : ''
}

function describe(field: PDFField): Pick<FormField, 'type' | 'value' | 'options' | 'maxLength' | 'multiline'> | null {
  if (field instanceof PDFTextField) {
    const maxLength = field.getMaxLength()
    return { type: 'text', value: field.getText() ?? null, ...(maxLength !== undefined ? { maxLength } : {}), multiline: field.isMultiline() }
  }
  if (field instanceof PDFCheckBox) return { type: 'checkbox', value: field.isChecked() }
  if (field instanceof PDFRadioGroup) return { type: 'choice', value: field.getSelected() ?? null, options: field.getOptions() }
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) return { type: 'choice', value: field.getSelected()[0] ?? null, options: field.getOptions() }
  if (field instanceof PDFSignature) return { type: 'signature', value: null }
  return null // a push button holds no value
}

/** Throws `PdfFormError` with a plain sentence for an encrypted file or one pdf-lib cannot read. */
export async function readForm(bytes: Uint8Array): Promise<FormRead> {
  const doc = await load(bytes)
  const xfa = acroFormOf(doc)?.has(PDFName.of('XFA')) ?? false
  const form = formOf(doc)
  const pages = doc.getPages()
  const where = annotPages(doc)
  const fields: FormField[] = []
  for (const field of form.getFields()) {
    const widgets = field.acroField.getWidgets()
    const shape = describe(field)
    if (!shape || !widgets.length) continue
    const page = widgetPage(doc, widgets[0], where)
    fields.push({ key: field.getName(), label: tooltip(field), page: page + 1, bbox: normalise(widgets[0].getRectangle(), pages[page]), readOnly: field.isReadOnly(), ...shape })
  }
  return { pages: pages.map((p) => p.getSize()), fields, xfa, xfaOnly: xfa && fields.length === 0 }
}

/**
 * Labels for fields that have none, from the page's own words: the nearest
 * line that ends to the left of the field on its row, else the nearest line
 * above it that overlaps it across. Pure.
 */
export function labelFields(fields: FormField[], lines: Array<{ page: number; bbox: Bbox; text: string }>): FormField[] {
  return fields.map((f) => {
    if (f.label) return f
    const [x0, y0, x1, y1] = f.bbox
    const mid = (y0 + y1) / 2
    const onPage = lines.filter((l) => l.page === f.page && l.text.trim())
    const left = onPage
      .filter((l) => l.bbox[2] <= x0 + 0.005 && l.bbox[1] <= mid && l.bbox[3] >= mid)
      .sort((a, b) => b.bbox[2] - a.bbox[2])[0]
    const above = onPage
      .filter((l) => l.bbox[3] <= y0 + 0.005 && l.bbox[0] < x1 && l.bbox[2] > x0 && y0 - l.bbox[3] < 0.05)
      .sort((a, b) => b.bbox[3] - a.bbox[3])[0]
    const near = left && (!above || x0 - left.bbox[2] < y0 - above.bbox[3] + 0.02) ? left : above
    return near ? { ...f, label: near.text.trim() } : f
  })
}

// ── fonts ────────────────────────────────────────────────────────────

type ParsedFont = ReturnType<typeof fontkit.create>
const parsed = new WeakMap<Uint8Array, ParsedFont>()

/** Whether a font can draw every character of a value (control characters aside). */
export function fontCovers(font: Uint8Array, text: string): boolean {
  let f = parsed.get(font)
  if (!f) {
    f = fontkit.create(font)
    parsed.set(font, f)
  }
  const face = f
  return [...text].every((ch) => {
    const cp = ch.codePointAt(0) ?? 0
    return cp < 0x20 || face.hasGlyphForCodePoint(cp)
  })
}

/** What the value's font cannot draw, as a sentence; null when it can draw all of it. */
function cannotDraw(text: string, font: PDFFont, given: Uint8Array | undefined): string | null {
  if (given) {
    const missing = [...text].filter((ch) => !fontCovers(given, ch))
    return missing.length ? [...new Set(missing)].join('') : null
  }
  try {
    font.encodeText(text)
    return null
  } catch {
    return [...new Set([...text].filter((ch) => (ch.codePointAt(0) ?? 0) >= 0x20 && !canEncode(font, ch)))].join('') || text
  }
}

const canEncode = (font: PDFFont, ch: string): boolean => {
  try {
    font.encodeText(ch)
    return true
  } catch {
    return false
  }
}

// ── writing ──────────────────────────────────────────────────────────

/** Sets one field; a sentence when the value cannot go in. */
function setValue(form: PDFForm, key: string, value: string | boolean, font: PDFFont, given: Uint8Array | undefined): string | null {
  const field = form.getFieldMaybe(key)
  if (!field) return `${key}: the form has no field by that name.`
  if (field.isReadOnly()) return `${key}: the field is read-only.`
  if (field instanceof PDFCheckBox) {
    if (typeof value !== 'boolean') return `${key}: a checkbox takes true or false.`
    if (value) field.check()
    else field.uncheck()
    return null
  }
  if (typeof value !== 'string') return `${key}: this field takes text, not true or false.`
  if (field instanceof PDFSignature) return `${key}: a signature field takes a drawn signature as an overlay, not a value.`
  const lacking = cannotDraw(value, font, given)
  if (lacking) return `${key}: this font cannot draw "${lacking}", so the value was not written.`
  if (field instanceof PDFTextField) {
    const max = field.getMaxLength()
    // A comb's boxes are the form's own rule: a longer value is refused, never cut.
    if (max !== undefined && [...value].length > max) return `${key}: the value has ${[...value].length} characters and the field takes at most ${max}.`
    field.setText(value)
    return null
  }
  if (field instanceof PDFRadioGroup) {
    if (!field.getOptions().includes(value)) return `${key}: "${value}" is not one of its options (${field.getOptions().join(', ')}).`
    field.select(value)
    return null
  }
  if (field instanceof PDFDropdown) {
    if (!field.isEditable() && !field.getOptions().includes(value)) return `${key}: "${value}" is not one of its options.`
    field.select(value)
    return null
  }
  if (field instanceof PDFOptionList) {
    if (!field.getOptions().includes(value)) return `${key}: "${value}" is not one of its options.`
    field.select(value)
    return null
  }
  return `${key}: a button holds no value.`
}

/**
 * Rewrites the appearance of every field that needs it, one field at a time:
 * a value set but not drawn is the trap a viewer shows as blank. A field one
 * font cannot draw (an old value nobody changed) is named, not fatal.
 */
function updateAppearances(form: PDFForm, font: PDFFont, warnings: string[]): void {
  for (const field of form.getFields()) {
    if (!field.needsAppearancesUpdate()) continue
    try {
      field.defaultUpdateAppearances(font)
    } catch (err) {
      warnings.push(`${field.getName()}: its appearance could not be drawn (${err instanceof Error ? err.message : String(err)}).`)
    }
  }
}

const INK = rgb(0.06, 0.09, 0.24)

/** Text inside a box: as tall as the box allows, smaller to fit its width, never under 6 pt. */
function drawTextIn(page: PDFPage, box: Box, text: string, font: PDFFont): string | null {
  const pad = Math.min(2, box.width * 0.05)
  let size = Math.max(6, box.height / font.heightAtSize(1))
  const width = font.widthOfTextAtSize(text, size)
  if (width > box.width - 2 * pad) size = Math.max(6, (size * (box.width - 2 * pad)) / width)
  const fits = font.widthOfTextAtSize(text, size) <= box.width - 2 * pad + 0.01 && font.heightAtSize(size) <= box.height + 0.01
  const height = font.heightAtSize(size)
  const descent = Math.abs(font.heightAtSize(size, { descender: true }) - font.heightAtSize(size, { descender: false }))
  page.drawText(text, { x: box.x + pad, y: box.y + (box.height - height) / 2 + descent, size, font, color: INK })
  return fits ? null : 'does not fit its box at 6 pt; it was drawn and runs past the box'
}

/** An X centred in the box. */
function drawCheck(page: PDFPage, box: Box): void {
  const side = Math.min(box.width, box.height) * 0.7
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const h = side / 2
  const thickness = Math.max(0.6, side * 0.12)
  page.drawLine({ start: { x: cx - h, y: cy - h }, end: { x: cx + h, y: cy + h }, thickness, color: INK })
  page.drawLine({ start: { x: cx - h, y: cy + h }, end: { x: cx + h, y: cy - h }, thickness, color: INK })
}

/** The strokes as vector paths, scaled to fit the box with their aspect kept, bottom-aligned, round caps and joins. */
function drawSignature(page: PDFPage, box: Box, sig: PdfSignature): void {
  const pts = sig.strokes.flat()
  // Fit the ink, not the pad: a pad's empty margins would shrink the signature on a short line.
  let minX = Math.min(...pts.map((p) => p[0]))
  let maxX = Math.max(...pts.map((p) => p[0]))
  let minY = Math.min(...pts.map((p) => p[1]))
  let maxY = Math.max(...pts.map((p) => p[1]))
  if (maxX - minX < 1e-6 && maxY - minY < 1e-6) [minX, maxX, minY, maxY] = [0, sig.width, 0, sig.height]
  const inkW = Math.max(maxX - minX, 1e-6)
  const inkH = Math.max(maxY - minY, 1e-6)
  const lineWidth = Math.max(0.6, Math.min(1.6, box.height * 0.05))
  const inner = { width: Math.max(1, box.width - lineWidth), height: Math.max(1, box.height - lineWidth) }
  const scale = Math.min(inner.width / inkW, inner.height / inkH)
  const left = box.x + lineWidth / 2
  const bottom = box.y + lineWidth / 2
  // Pad y runs down; page y runs up. The ink's lowest point sits on the box's bottom.
  const at = (p: [number, number]): [number, number] => [left + (p[0] - minX) * scale, bottom + (maxY - p[1]) * scale]
  const ops = [pushGraphicsState(), setLineWidth(lineWidth), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round), setStrokingRgbColor(INK.red, INK.green, INK.blue)]
  for (const s of sig.strokes) {
    const [first, ...rest] = s.map(at)
    ops.push(moveTo(...first))
    // A single point is a dot: a zero-length line with a round cap.
    for (const p of rest.length ? rest : [first]) ops.push(lineTo(...p))
    ops.push(stroke())
  }
  ops.push(popGraphicsState())
  page.pushOperators(...ops)
}

type Overlay = WriteInput['overlays'][number]

function drawOverlay(doc: PDFDocument, o: Overlay, i: number, font: PDFFont, given: Uint8Array | undefined): string | null {
  const name = `Overlay ${i + 1}`
  const page = doc.getPages()[o.page - 1]
  if (!page || !Number.isInteger(o.page)) return `${name}: the file has no page ${o.page}.`
  if (!validBox(o.bbox)) return `${name}: its box is not a box on the page.`
  const box = toPoints(o.bbox, page)
  if (o.signature) drawSignature(page, box, o.signature)
  else if (o.check) drawCheck(page, box)
  else if (o.text) {
    const lacking = cannotDraw(o.text, font, given)
    if (lacking) return `${name}: this font cannot draw "${lacking}", so the text was not written.`
    const why = drawTextIn(page, box, o.text, font)
    if (why) return `${name}: "${o.text}" ${why}.`
  }
  return null
}

const text = (s: string): PDFHexString => PDFHexString.fromText(s)

type Mark = WriteInput['marks'][number]

/** A real /Highlight annotation, appended to the page's /Annots, with an appearance of its own. */
function addMark(doc: PDFDocument, m: Mark, now: Date): string | null {
  const page = doc.getPages()[m.page - 1]
  if (!page || !Number.isInteger(m.page)) return `Highlight ${m.name}: the file has no page ${m.page}.`
  const quads = m.quads.filter(validBox).map((q) => toPoints(q, page))
  if (!quads.length) return `Highlight ${m.name}: it has no box on the page.`
  const x0 = Math.min(...quads.map((q) => q.x))
  const y0 = Math.min(...quads.map((q) => q.y))
  const x1 = Math.max(...quads.map((q) => q.x + q.width))
  const y1 = Math.max(...quads.map((q) => q.y + q.height))
  // Acrobat's order for each quad: top-left, top-right, bottom-left, bottom-right.
  const quadPoints = quads.flatMap((q) => [q.x, q.y + q.height, q.x + q.width, q.y + q.height, q.x, q.y, q.x + q.width, q.y])
  const ctx = doc.context
  const appearance = ctx.formXObject(
    [
      pushGraphicsState(),
      setGraphicsState('GS0'),
      setFillingRgbColor(1, 0.9, 0.4),
      ...quads.flatMap((q) => [moveTo(q.x, q.y + q.height), lineTo(q.x + q.width, q.y + q.height), lineTo(q.x + q.width, q.y), lineTo(q.x, q.y), closePath(), fill()]),
      popGraphicsState()
    ],
    // Multiply keeps the words under the colour readable in viewers that draw the appearance as it is.
    { BBox: [x0, y0, x1, y1], Resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: 0.4, ca: 0.4 } } } }
  )
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [x0, y0, x1, y1],
    QuadPoints: quadPoints,
    C: [1, 0.9, 0.4],
    CA: 0.4,
    F: 4,
    P: page.ref,
    AP: { N: ctx.register(appearance) }
  })
  annot.set(PDFName.of('NM'), text(m.name))
  annot.set(PDFName.of('T'), text(m.author))
  annot.set(PDFName.of('Contents'), text(m.note ?? ''))
  annot.set(PDFName.of('M'), PDFString.fromDate(now))
  const ref = ctx.register(annot)
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
  if (annots) annots.push(ref)
  else page.node.set(PDFName.of('Annots'), ctx.obj([ref]))
  return null
}

/** Fills a form, draws overlays and highlights into a copy, and returns its bytes. It writes no file and never changes `bytes`. */
export async function writePdf(bytes: Uint8Array, input: WriteInput): Promise<WriteResult> {
  const doc = await load(bytes)
  const warnings: string[] = []
  const xfaOnly = (acroFormOf(doc)?.has(PDFName.of('XFA')) ?? false) && !hasWidgets(doc)
  doc.registerFontkit(fontkit)
  let font: PDFFont
  if (input.font) {
    try {
      font = await doc.embedFont(input.font, { subset: true })
    } catch {
      throw new PdfFormError('The font given is not a TrueType or OpenType font this can read.')
    }
  } else font = await doc.embedFont(StandardFonts.Helvetica)
  const form = formOf(doc)
  if (xfaOnly && input.values.length) warnings.push('The form is XFA only: it has no fields that can be filled here, so no values were written.')
  else {
    for (const v of input.values) {
      const why = setValue(form, v.key, v.value, font, input.font)
      if (why) warnings.push(why)
    }
  }
  updateAppearances(form, font, warnings)
  if (input.flatten) form.flatten({ updateFieldAppearances: false })
  input.overlays.forEach((o, i) => {
    const why = drawOverlay(doc, o, i, font, input.font)
    if (why) warnings.push(why)
  })
  const now = input.now ?? new Date()
  for (const m of input.marks) {
    const why = addMark(doc, m, now)
    if (why) warnings.push(why)
  }
  return { bytes: await doc.save({ updateFieldAppearances: false }), warnings }
}

/** Whether any page holds a widget annotation. */
function hasWidgets(doc: PDFDocument): boolean {
  return doc.getPages().some((page) => {
    const annots = page.node.Annots()
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const a = annots?.lookup(i)
      if (a instanceof PDFDict && a.get(PDFName.of('Subtype')) === PDFName.of('Widget')) return true
    }
    return false
  })
}
