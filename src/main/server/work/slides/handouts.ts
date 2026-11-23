/**
 * A deck on paper (docs/agents/work-slides.md "Preview and export"): notes pages and handouts of 2, 3, 4 or 6 a
 * page, laid out here from the slide pictures and printed by Chromium the way a document's PDF is
 * (formats/print.ts). The page maths is pure and in points (1/72 inch, origin at the top left), so the page
 * Chromium prints is the page tested.
 */

export type Handouts = 2 | 3 | 4 | 6
export type PaperLayout = 'notes' | { handouts: Handouts }

/** The papers the page set-up offers, portrait, in points (as the window's `PAPER_POINTS`). */
export const PAPER_SIZES = {
  Letter: { width: 612, height: 792 },
  A4: { width: 595.3, height: 841.9 },
  Legal: { width: 612, height: 1008 },
  Tabloid: { width: 792, height: 1224 },
  A3: { width: 841.9, height: 1190.55 },
  A5: { width: 419.55, height: 595.3 }
} as const
export type PaperName = keyof typeof PAPER_SIZES

export interface PaperSetup {
  /** the page as it lies, in points */
  width: number
  height: number
  margins: { top: number; right: number; bottom: number; left: number }
  /** the deck's name over each page */
  header: boolean
  /** the page's number under it */
  footer: boolean
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** One sheet of paper: its slides (by their place in the list printed, from 0), the notes under a slide, the rules to write on. */
export interface Sheet {
  slides: Array<{ at: number; box: Box; notes?: Box }>
  lines: Box[]
}

/** Room the deck's name and the page number take, each in its own band inside the margins. */
export const BAND = 20
/** Between two slides, and between a slide and its notes or rules. */
export const GAP = 18
/** Between two rules to write on. */
export const RULE = 22

/** The room inside the margins and the bands. */
export function contentBox(p: PaperSetup): Box {
  const top = p.margins.top + (p.header ? BAND : 0)
  const bottom = p.margins.bottom + (p.footer ? BAND : 0)
  return { x: p.margins.left, y: top, w: Math.max(1, p.width - p.margins.left - p.margins.right), h: Math.max(1, p.height - top - bottom) }
}

/** The largest box of the slide's shape (`aspect` is width over height) inside `cell`, centred across and at its top. */
function fit(cell: Box, aspect: number, middle = true): Box {
  const w = Math.min(cell.w, cell.h * aspect)
  const h = w / aspect
  return { x: cell.x + (cell.w - w) / 2, y: middle ? cell.y + (cell.h - h) / 2 : cell.y, w, h }
}

/** Columns and rows of a handout: the way PowerPoint sets them, turned with the paper. */
export function gridOf(n: Handouts, landscape: boolean): { cols: number; rows: number } {
  const portrait = { 2: [1, 2], 3: [1, 3], 4: [2, 2], 6: [2, 3] }[n]
  const [cols, rows] = landscape ? [portrait[1], portrait[0]] : portrait
  return { cols, rows }
}

/** Rules down a box, `RULE` apart, the first one rule in. */
function rules(box: Box): Box[] {
  const out: Box[] = []
  for (let y = box.y + RULE; y <= box.y + box.h + 0.01; y += RULE) out.push({ x: box.x, y, w: box.w, h: 0 })
  return out
}

/**
 * The sheets `count` slides take in a layout. Notes pages: one slide a page, as wide as the room allows in its
 * upper half, its notes under it. Handouts: a grid filled row by row; three a page keep half of each row (or
 * column, landscape) for rules to write on, as PowerPoint's do.
 */
export function sheetsOf(layout: PaperLayout, count: number, paper: PaperSetup, aspect: number): Sheet[] {
  const room = contentBox(paper)
  const sheets: Sheet[] = []
  if (layout === 'notes') {
    for (let at = 0; at < count; at++) {
      const box = fit({ x: room.x, y: room.y, w: room.w, h: room.h * 0.45 }, aspect, false)
      const top = box.y + box.h + GAP
      sheets.push({ slides: [{ at, box, notes: { x: room.x, y: top, w: room.w, h: Math.max(0, room.y + room.h - top) } }], lines: [] })
    }
    return sheets
  }
  const n = layout.handouts
  const landscape = paper.width > paper.height
  const { cols, rows } = gridOf(n, landscape)
  const cw = (room.w - GAP * (cols - 1)) / cols
  const ch = (room.h - GAP * (rows - 1)) / rows
  for (let first = 0; first < count; first += n) {
    const sheet: Sheet = { slides: [], lines: [] }
    for (let k = 0; k < n && first + k < count; k++) {
      const cell = { x: room.x + (k % cols) * (cw + GAP), y: room.y + Math.floor(k / cols) * (ch + GAP), w: cw, h: ch }
      if (n !== 3) {
        sheet.slides.push({ at: first + k, box: fit(cell, aspect) })
        continue
      }
      // Three a page: the slide in the first half of its cell, rules in the other.
      const half = landscape ? { ...cell, h: (cell.h - GAP) / 2 } : { ...cell, w: (cell.w - GAP) / 2 }
      const box = fit(half, aspect, landscape)
      sheet.slides.push({ at: first + k, box })
      sheet.lines.push(...rules(landscape ? { x: cell.x, y: box.y + box.h + GAP, w: cell.w, h: cell.y + cell.h - (box.y + box.h + GAP) } : { x: half.x + half.w + GAP, y: box.y - RULE, w: half.w, h: box.h }))
    }
    sheets.push(sheet)
  }
  return sheets
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const pt = (n: number): string => `${Math.round(n * 100) / 100}pt`
const at = (b: Box): string => `left:${pt(b.x)};top:${pt(b.y)};width:${pt(b.w)};height:${pt(b.h)}`

/**
 * The page Chromium prints: each sheet absolutely placed in points on a page of the paper's size, each slide its
 * picture (a `data:` URL: the print window loads nothing else) in a hairline, notes in the page's own type.
 */
export function paperHtml(o: { sheets: readonly Sheet[]; paper: PaperSetup; pictures: readonly string[]; notes: readonly string[]; title: string }): string {
  const { paper } = o
  const total = o.sheets.length
  const pages = o.sheets.map((sheet, i) => {
    const parts: string[] = []
    if (paper.header) parts.push(`<div class="h" style="left:${pt(paper.margins.left)};top:${pt(paper.margins.top)};width:${pt(paper.width - paper.margins.left - paper.margins.right)}">${esc(o.title)}</div>`)
    for (const s of sheet.slides) {
      parts.push(`<img class="s" alt="" src="${o.pictures[s.at] ?? ''}" style="${at(s.box)}">`)
      const words = o.notes[s.at]?.trim()
      if (s.notes && words) parts.push(`<div class="n" style="${at(s.notes)}">${esc(words)}</div>`)
    }
    for (const l of sheet.lines) parts.push(`<div class="r" style="${at(l)}"></div>`)
    if (paper.footer) parts.push(`<div class="f" style="left:${pt(paper.margins.left)};bottom:${pt(paper.margins.bottom)};width:${pt(paper.width - paper.margins.left - paper.margins.right)}">${i + 1}${total > 1 ? ` of ${total}` : ''}</div>`)
    return `<section class="p">${parts.join('')}</section>`
  })
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.title)}</title><style>
@page{size:${pt(paper.width)} ${pt(paper.height)};margin:0}
html,body{margin:0;padding:0;background:#fff}
.p{position:relative;width:${pt(paper.width)};height:${pt(paper.height)};overflow:hidden;break-after:page}
.p:last-child{break-after:auto}
.s{position:absolute;display:block;outline:0.75pt solid #c3c8cf}
.n{position:absolute;overflow:hidden;font:11pt/1.45 Carlito,Calibri,"Liberation Sans",Arial,sans-serif;color:#1d2129;white-space:pre-wrap}
.r{position:absolute;border-top:0.5pt solid #c3c8cf}
.h,.f{position:absolute;font:9pt/${pt(BAND)} Carlito,Calibri,"Liberation Sans",Arial,sans-serif;color:#5b6270}
.h{height:${pt(BAND)}}
.f{height:${pt(BAND)};text-align:right}
</style></head><body>${pages.join('')}</body></html>`
}
