import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFSignature, PDFString, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { fontCovers, labelFields, PdfFormError, readForm, writePdf, type FormField, type WriteInput } from './form'

/**
 * form.ts against the IRS W-9 (fixtures/fw9.pdf, a US government work): an
 * XFA and AcroForm hybrid with 23 widgets and no tooltips. Each case is a
 * trap the PDF research measured; a fill is checked by flatten and extract,
 * never by /V alone.
 */
const W9 = new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures/fw9.pdf')))
const LIBERATION = new Uint8Array(readFileSync(join(import.meta.dirname, '../../../../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')))
const P1 = 'topmostSubform[0].Page1[0].'
const K = {
  name: `${P1}f1_01[0]`,
  address: `${P1}Address_ReadOrder[0].f1_07[0]`,
  city: `${P1}Address_ReadOrder[0].f1_08[0]`,
  ssn1: `${P1}f1_11[0]`,
  ssn2: `${P1}f1_12[0]`,
  ssn3: `${P1}f1_13[0]`,
  individual: `${P1}Boxes3a-b_ReadOrder[0].c1_1[0]`
}
const TYPED = [
  { key: K.name, value: 'Ada Exampleton' },
  { key: K.address, value: '123 Example Street' },
  { key: K.city, value: 'Springfield, IL 62701' },
  { key: K.ssn1, value: '123' },
  { key: K.ssn2, value: '45' },
  { key: K.ssn3, value: '6789' }
]
const NOW = new Date('2026-11-19T12:00:00Z')
const input = (over: Partial<WriteInput>): WriteInput => ({ values: [], overlays: [], marks: [], flatten: false, now: NOW, ...over })

/** Page 1's text as pdf.js reads it, the way a viewer's search or copy would. */
async function pageText(bytes: Uint8Array, page = 1): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // pdf.js takes ownership of the buffer it is given: a copy keeps the test's own.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 })
  const doc = await task.promise
  try {
    const content = await (await doc.getPage(page)).getTextContent()
    return content.items.map((i) => ('str' in i ? i.str : '')).join(' ')
  } finally {
    await task.destroy()
  }
}
const squash = (s: string): string => s.replace(/\s+/g, '')
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

describe('readForm', () => {
  it('lists the W-9\'s 23 fields on page 1 with their rects normalised and flipped', async () => {
    const r = await readForm(W9)
    expect(r.fields).toHaveLength(23)
    expect(r.fields.every((f) => f.page === 1)).toBe(true)
    // The W-9's MediaBox is 611.976 by 791.968, a hair under Letter.
    expect(r.pages[0].width).toBeCloseTo(612, 0)
    expect(r.pages[0].height).toBeCloseTo(792, 0)
    expect(r).toMatchObject({ xfa: true, xfaOnly: false })
    const name = r.fields.find((f) => f.key === K.name)!
    // [58.6, 660.0, 576.0, 674.0] on 612×792, bottom-left → top-left
    expect(name.bbox).toEqual([0.0958, 0.149, 0.9412, 0.1667])
    expect(name).toMatchObject({ type: 'text', label: '', value: null, readOnly: false })
    expect(r.fields.find((f) => f.key === K.ssn1)?.maxLength).toBe(3)
    expect(r.fields.filter((f) => f.type === 'checkbox')).toHaveLength(8)
  })

  it('reads a radio group as one choice field with its options', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([400, 400])
    const radio = doc.getForm().createRadioGroup('kind')
    radio.addOptionToPage('person', page, { x: 20, y: 300, width: 12, height: 12 })
    radio.addOptionToPage('company', page, { x: 60, y: 300, width: 12, height: 12 })
    const bytes = await doc.save()
    const r = await readForm(bytes)
    expect(r.fields).toEqual([expect.objectContaining({ key: 'kind', type: 'choice', options: ['person', 'company'], value: null, page: 1 })])
    const out = await writePdf(bytes, input({ values: [{ key: 'kind', value: 'company' }, { key: 'kind', value: 'trust' }] }))
    expect((await readForm(out.bytes)).fields[0].value).toBe('company')
    expect(out.warnings).toEqual([expect.stringContaining('"trust" is not one of its options')])
  })

  it('refuses an encrypted file with a plain sentence', async () => {
    const doc = await PDFDocument.create()
    doc.addPage()
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 2, R: 3 }))
    const encrypted = await doc.save({ useObjectStreams: false })
    await expect(readForm(encrypted)).rejects.toThrow(PdfFormError)
    await expect(readForm(encrypted)).rejects.toThrow('This PDF is encrypted, so its form cannot be read or filled here.')
    await expect(writePdf(encrypted, input({}))).rejects.toThrow(PdfFormError)
  })

  it('refuses a file that is not a PDF', async () => {
    await expect(readForm(new TextEncoder().encode('not a pdf at all'))).rejects.toThrow(PdfFormError)
  })

  it('says a form is XFA only when it has no widget, and writes no values into it', async () => {
    const doc = await PDFDocument.create()
    doc.addPage()
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [], XFA: [PDFString.of('template'), doc.context.register(doc.context.stream('<template/>'))] }))
    const bytes = await doc.save()
    expect(await readForm(bytes)).toMatchObject({ xfa: true, xfaOnly: true, fields: [] })
    const out = await writePdf(bytes, input({ values: [{ key: 'name', value: 'Ada' }] }))
    expect(out.warnings).toEqual(['The form is XFA only: it has no fields that can be filled here, so no values were written.'])
  })
})

describe('writePdf', () => {
  it('rewrites the appearance of every field it fills, and the values are not page text until flattened', async () => {
    const before = await PDFDocument.load(W9)
    // pdf-lib may hold /AP /N as a reference or as the stream itself: read it either way, and compare by content.
    const apOf = (doc: PDFDocument, key: string): string | undefined => {
      const n = doc.getForm().getField(key).acroField.getWidgets()[0].getAppearances()?.normal
      const stream = n instanceof PDFRef ? doc.context.lookup(n) : n
      return stream instanceof PDFRawStream ? new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode()) : undefined
    }
    const out = await writePdf(W9, input({ values: TYPED }))
    expect(out.warnings).toEqual([])
    const after = await PDFDocument.load(out.bytes)
    const enc = (s: string): string => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    for (const { key, value } of TYPED) {
      const drawn = apOf(after, key)?.toLowerCase()
      expect(drawn, key).toBeDefined()
      expect(drawn).not.toBe(apOf(before, key)?.toLowerCase())
      // Helvetica draws WinAnsi bytes as a hex string: a comb draws one character at a time.
      for (const ch of value.replace(/\s/g, '')) expect(drawn, key).toContain(enc(ch))
    }
    const text = squash(await pageText(out.bytes))
    for (const { value } of TYPED.slice(0, 3)) expect(text).not.toContain(squash(value))
  })

  it('flattens to a file with no fields whose page text carries the typed values', async () => {
    const out = await writePdf(W9, input({ values: TYPED, flatten: true }))
    expect(out.warnings).toEqual([])
    expect((await readForm(out.bytes)).fields).toHaveLength(0)
    const text = squash(await pageText(out.bytes))
    for (const { value } of TYPED) expect(text).toContain(squash(value))
  })

  it('fills and flattens Unicode with a font given, and refuses what that font lacks', async () => {
    const out = await writePdf(W9, input({ values: [{ key: K.city, value: 'Łódź, Česká 12' }, { key: K.name, value: '東京' }], flatten: true, font: LIBERATION }))
    expect(out.warnings).toEqual([`${K.name}: this font cannot draw "東京", so the value was not written.`])
    expect(squash(await pageText(out.bytes))).toContain(squash('Łódź, Česká 12'))
  })

  it('without a font, names a value Helvetica cannot draw and still writes the rest', async () => {
    const out = await writePdf(W9, input({ values: [{ key: K.city, value: 'Łódź' }, { key: K.name, value: 'Ada Exampleton' }], flatten: true }))
    expect(out.warnings).toEqual([`${K.city}: this font cannot draw "Łź", so the value was not written.`])
    const text = squash(await pageText(out.bytes))
    expect(text).toContain('AdaExampleton')
    expect(text).not.toContain('dź')
  })

  it('keeps the AcroForm values once pdf-lib has dropped the XFA part', async () => {
    const out = await writePdf(W9, input({ values: TYPED }))
    const r = await readForm(out.bytes)
    expect(r.xfa).toBe(false)
    expect(r.fields.find((f) => f.key === K.name)?.value).toBe('Ada Exampleton')
    expect(r.fields.find((f) => f.key === K.ssn3)?.value).toBe('6789')
  })

  it('checks and unchecks a checkbox', async () => {
    const on = await writePdf(W9, input({ values: [{ key: K.individual, value: true }] }))
    expect((await readForm(on.bytes)).fields.find((f) => f.key === K.individual)?.value).toBe(true)
    const off = await writePdf(on.bytes, input({ values: [{ key: K.individual, value: false }] }))
    expect((await readForm(off.bytes)).fields.find((f) => f.key === K.individual)?.value).toBe(false)
    const wrong = await writePdf(W9, input({ values: [{ key: K.individual, value: 'yes' }] }))
    expect(wrong.warnings).toEqual([`${K.individual}: a checkbox takes true or false.`])
  })

  it('refuses a value longer than a comb field takes, rather than cutting it', async () => {
    const out = await writePdf(W9, input({ values: [{ key: K.ssn1, value: '1234' }, { key: 'nope', value: 'x' }] }))
    expect(out.warnings).toEqual([`${K.ssn1}: the value has 4 characters and the field takes at most 3.`, 'nope: the form has no field by that name.'])
    expect((await readForm(out.bytes)).fields.find((f) => f.key === K.ssn1)?.value).toBeNull()
  })

  it('draws a signature into the page as vector strokes, not a /Sig field', async () => {
    const signature = { width: 300, height: 100, strokes: [[[10, 80], [60, 20], [110, 70], [160, 30]], [[200, 50]]] as Array<Array<[number, number]>> }
    const plain = await PDFDocument.load(W9)
    const opsBefore = plain.getPages()[0].node.Contents()
    const out = await writePdf(W9, input({ overlays: [{ page: 1, bbox: [0.2, 0.735, 0.55, 0.765], signature }, { page: 1, bbox: [0.65, 0.745, 0.9, 0.765], text: 'November 19, 2026' }], flatten: true }))
    expect(out.warnings).toEqual([])
    const doc = await PDFDocument.load(out.bytes)
    const contents = doc.getPages()[0].node.Contents()
    expect(contents).toBeInstanceOf(PDFArray)
    const streams = (contents as PDFArray).asArray().map((r) => new TextDecoder('latin1').decode(decodePDFRawStream(doc.context.lookup(r) as PDFRawStream).decode()))
    const drawn = streams.join('\n')
    expect(drawn).toMatch(/1 J\s+1 j/) // round caps and joins
    expect(drawn.match(/ l\n/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
    expect(contents).not.toBe(opsBefore)
    expect(doc.getForm().getFields().some((f) => f instanceof PDFSignature)).toBe(false)
    expect(squash(await pageText(out.bytes))).toContain('November19,2026')
  })

  it('names an overlay whose text does not fit even at 6 pt, and draws it anyway', async () => {
    const out = await writePdf(W9, input({ overlays: [{ page: 1, bbox: [0.1, 0.8, 0.12, 0.81], text: 'a long line of words' }, { page: 9, bbox: [0, 0, 1, 1], check: true }] }))
    expect(out.warnings).toEqual(['Overlay 1: "a long line of words" does not fit its box at 6 pt; it was drawn and runs past the box.', 'Overlay 2: the file has no page 9.'])
    expect(squash(await pageText(out.bytes))).toContain('alonglineofwords')
  })

  it('writes highlights as real /Highlight annotations that survive flattening', async () => {
    const marks = [{ name: 'tc:thread1:mark1', page: 1, quads: [[0.1, 0.15, 0.5, 0.17], [0.1, 0.18, 0.3, 0.2]] as Array<[number, number, number, number]>, note: 'Check the legal name', author: 'Ada (owner)' }]
    for (const flatten of [false, true]) {
      const out = await writePdf(W9, input({ values: TYPED, marks, flatten }))
      expect(out.warnings).toEqual([])
      const doc = await PDFDocument.load(out.bytes)
      const annots = doc.getPages()[0].node.Annots()!.asArray().map((r) => doc.context.lookup(r, PDFDict))
      const text = (d: PDFDict, k: string): string => (d.lookup(PDFName.of(k)) as PDFHexString).decodeText()
      const mark = annots.find((a) => a.has(PDFName.of('NM')) && text(a, 'NM') === 'tc:thread1:mark1')!
      expect(mark, `flatten ${flatten}`).toBeDefined()
      expect(mark.get(PDFName.of('Subtype'))).toBe(PDFName.of('Highlight'))
      expect(mark.lookup(PDFName.of('QuadPoints'), PDFArray).size()).toBe(16)
      expect(text(mark, 'T')).toBe('Ada (owner)')
      expect(text(mark, 'Contents')).toBe('Check the legal name')
      expect((mark.lookup(PDFName.of('F')) as PDFNumber).asNumber()).toBe(4)
      // the first quad's top-left: x 0.1 of 612, y (1 - 0.15) of 792
      const q = mark.lookup(PDFName.of('QuadPoints'), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber())
      expect(q.slice(0, 4).map((n) => Math.round(n * 10) / 10)).toEqual([61.2, 673.2, 306, 673.2])
      expect(mark.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'))).toBeInstanceOf(PDFRef)
      if (flatten) expect(doc.getForm().getFields()).toHaveLength(0)
    }
  })

  it('never changes its input and gives the same bytes for the same input', async () => {
    const before = sha(W9)
    const a = await writePdf(W9, input({ values: TYPED, marks: [{ name: 'm', page: 1, quads: [[0.1, 0.1, 0.2, 0.12]], author: 'A' }] }))
    const b = await writePdf(W9, input({ values: TYPED, marks: [{ name: 'm', page: 1, quads: [[0.1, 0.1, 0.2, 0.12]], author: 'A' }] }))
    expect(sha(W9)).toBe(before)
    expect(sha(a.bytes)).toBe(sha(b.bytes))
  })
})

describe('fontCovers', () => {
  it('knows what a font can draw', () => {
    expect(fontCovers(LIBERATION, 'Łódź, Česká 12')).toBe(true)
    expect(fontCovers(LIBERATION, '東京')).toBe(false)
    expect(fontCovers(LIBERATION, 'two\nlines')).toBe(true)
  })
})

describe('labelFields', () => {
  const field = (key: string, bbox: FormField['bbox'], label = ''): FormField => ({ key, label, type: 'text', page: 1, bbox, value: null, readOnly: false })
  it('takes the nearest line to the left on the row, else the one just above, and keeps a label it has', () => {
    const lines = [
      { page: 1, bbox: [0.05, 0.1, 0.2, 0.12] as FormField['bbox'], text: 'Name ' },
      { page: 1, bbox: [0.3, 0.2, 0.6, 0.22] as FormField['bbox'], text: 'City, state, and ZIP code' },
      { page: 2, bbox: [0.05, 0.3, 0.2, 0.32] as FormField['bbox'], text: 'Other page' }
    ]
    const out = labelFields([field('a', [0.22, 0.095, 0.8, 0.125]), field('b', [0.3, 0.225, 0.7, 0.25]), field('c', [0.22, 0.3, 0.5, 0.32]), field('d', [0.22, 0.095, 0.8, 0.125], 'Kept')], lines)
    expect(out.map((f) => f.label)).toEqual(['Name', 'City, state, and ZIP code', '', 'Kept'])
  })
})
