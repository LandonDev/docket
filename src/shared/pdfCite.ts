/**
 * A PDF item's citation link and the box it names (docs/agents/work-pdf.md),
 * apart from the wire's zod schemas: the canvas imports these values, and a
 * lazy chunk that imports a zod schema adds zod code to the first paint's
 * chunk. contract-work-pdf.ts re-exports all of it. Imports no value.
 */

/** A box on a page: x0, y0, x1, y1 as shares of the page's width and height, origin at its top left. */
export type Bbox = [number, number, number, number]

/**
 * A citation of a place in a PDF item, as a link an agent writes in its
 * reply: `[p. 6, clause 7.2](#pdf:<itemId>:6:118,300,882,341)`. The four
 * numbers are the box in thousandths of the page (`Bbox` times 1000); a
 * citation of a whole page leaves them out. The canvas scrolls to the page
 * and marks the box.
 */
export interface PdfCite {
  itemId: string
  page: number
  bbox?: Bbox
}
const CITE = /^#pdf:([A-Za-z0-9_-]{1,100}):(\d{1,6})(?::(\d{1,4}),(\d{1,4}),(\d{1,4}),(\d{1,4}))?$/

export function pdfCiteHref(cite: PdfCite): string {
  const box = cite.bbox ? `:${cite.bbox.map((n) => Math.round(Math.min(1, Math.max(0, n)) * 1000)).join(',')}` : ''
  return `#pdf:${cite.itemId}:${cite.page}${box}`
}

export function parsePdfCite(href: string | null | undefined): PdfCite | null {
  const m = href ? CITE.exec(href.trim()) : null
  if (!m) return null
  const page = Number(m[2])
  if (page < 1) return null
  if (m[3] === undefined) return { itemId: m[1], page }
  const box = [m[3], m[4], m[5], m[6]].map((n) => Math.min(1, Number(n) / 1000)) as Bbox
  // A box with no area marks nothing: the page alone is the citation.
  return box[2] > box[0] && box[3] > box[1] ? { itemId: m[1], page, bbox: box } : { itemId: m[1], page }
}
