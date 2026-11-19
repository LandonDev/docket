import { describe, expect, it } from 'vitest'
import { BboxSchema, parsePdfCite, PDF_CAPS, PDF_READ_MAX, PdfRequestSchemas, PdfSignatureSchema, pdfCiteHref } from './contract-work-pdf'

describe('pdf citations', () => {
  it('writes a box in thousandths of the page, and a page alone with no box', () => {
    expect(pdfCiteHref({ itemId: 'it_1', page: 6, bbox: [0.118, 0.3, 0.882, 0.341] })).toBe('#pdf:it_1:6:118,300,882,341')
    expect(pdfCiteHref({ itemId: 'it_1', page: 2 })).toBe('#pdf:it_1:2')
    // A box past the page is held to it.
    expect(pdfCiteHref({ itemId: 'a', page: 1, bbox: [-0.2, 0, 1.5, 0.5] })).toBe('#pdf:a:1:0,0,1000,500')
  })

  it('reads back what it writes', () => {
    expect(parsePdfCite('#pdf:it_1:6:118,300,882,341')).toEqual({ itemId: 'it_1', page: 6, bbox: [0.118, 0.3, 0.882, 0.341] })
    expect(parsePdfCite(' #pdf:it_1:2 ')).toEqual({ itemId: 'it_1', page: 2 })
    const cite = { itemId: 'Ab-9_x', page: 140, bbox: [0.05, 0.9, 0.95, 0.99] as [number, number, number, number] }
    expect(parsePdfCite(pdfCiteHref(cite))).toEqual(cite)
  })

  it('takes a box with no area as the page alone, and refuses anything else', () => {
    expect(parsePdfCite('#pdf:a:3:500,500,500,600')).toEqual({ itemId: 'a', page: 3 })
    expect(parsePdfCite('#pdf:a:1:0,0,1200,900')).toEqual({ itemId: 'a', page: 1, bbox: [0, 0, 1, 0.9] })
    for (const bad of [null, undefined, '', '#pdf:a:0', '#pdf:a', 'pdf:a:1', '#pdf:a b:1', '#pdf:a:1:1,2,3', 'https://x.test/#pdf:a:1', '#pdf:a:1:1,2,3,4,5'])
      expect(parsePdfCite(bad), String(bad)).toBeNull()
  })
})

describe('the pdf wire', () => {
  const schema = (method: string) => PdfRequestSchemas.find((s) => s.shape.method.value === method)!
  const parse = (method: string, params: unknown) => schema(method).safeParse({ id: '1', method, params })

  it('gives every method a capability, and signing needs approve', () => {
    expect(Object.keys(PDF_CAPS).sort()).toEqual(PdfRequestSchemas.map((s) => s.shape.method.value).sort())
    expect(PDF_CAPS['work.pdf.sign']).toBe('approve')
    expect(PDF_CAPS['work.pdf.setSignature']).toBe('approve')
    // His drawn strokes too: a lower key learns only PdfView.hasSignature.
    expect(PDF_CAPS['work.pdf.signature']).toBe('approve')
    expect(Object.keys(PDF_CAPS)).not.toContain('work.pdf.list')
  })

  it('reads at most 4 MB a call, from the file unless the export is asked for', () => {
    expect(parse('work.pdf.read', { itemId: 'a', offset: 0, length: PDF_READ_MAX }).success).toBe(true)
    expect(parse('work.pdf.read', { itemId: 'a', offset: 0, length: PDF_READ_MAX + 1 }).success).toBe(false)
    expect(parse('work.pdf.read', { itemId: 'a', offset: -1, length: 10 }).success).toBe(false)
    expect(parse('work.pdf.read', { itemId: 'a', rev: 'abc123', offset: 0, length: 10 }).success).toBe(true)
    expect(parse('work.pdf.read', { itemId: 'a', rev: 'x'.repeat(65), offset: 0, length: 10 }).success).toBe(false)
    const ok = parse('work.pdf.read', { itemId: 'a', offset: 0, length: 10 })
    expect(ok.success && (ok.data.params as { which: string }).which).toBe('file')
  })

  it('holds a box to the page and a signature to its limits', () => {
    expect(BboxSchema.safeParse([0, 0, 1, 1]).success).toBe(true)
    expect(BboxSchema.safeParse([0, 0, 1.01, 1]).success).toBe(false)
    expect(PdfSignatureSchema.safeParse({ width: 300, height: 100, strokes: [[[1, 2]]] }).success).toBe(true)
    expect(PdfSignatureSchema.safeParse({ width: 300, height: 100, strokes: [] }).success).toBe(false)
    expect(PdfSignatureSchema.safeParse({ width: 0, height: 100, strokes: [[[1, 2]]] }).success).toBe(false)
    expect(parse('work.pdf.export', { itemId: 'a' }).success && (parse('work.pdf.export', { itemId: 'a' }) as { data: { params: { flatten: boolean } } }).data.params.flatten).toBe(true)
  })
})
