import { describe, expect, it } from 'vitest'
import { BAND, contentBox, gridOf, paperHtml, sheetsOf, type Box, type PaperSetup } from './handouts'

const LETTER: PaperSetup = { width: 612, height: 792, margins: { top: 36, right: 36, bottom: 36, left: 36 }, header: false, footer: true }
const WIDE = 16 / 9

const inside = (b: Box, room: Box): boolean => b.x >= room.x - 1e-6 && b.y >= room.y - 1e-6 && b.x + b.w <= room.x + room.w + 1e-6 && b.y + b.h <= room.y + room.h + 1e-6
const apart = (a: Box, b: Box): boolean => a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6 || a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6

describe("a deck on paper: the page maths", () => {
  it('takes as many sheets as the layout holds a page', () => {
    for (const [layout, sheets] of [
      ['notes', 12],
      [{ handouts: 2 }, 6],
      [{ handouts: 3 }, 4],
      [{ handouts: 4 }, 3],
      [{ handouts: 6 }, 2]
    ] as const)
      expect(sheetsOf(layout, 12, LETTER, WIDE)).toHaveLength(sheets)
    // A last sheet holds what is left: 13 slides at six a page are three sheets, the last with one slide.
    const thirteen = sheetsOf({ handouts: 6 }, 13, LETTER, WIDE)
    expect(thirteen.map((s) => s.slides.length)).toEqual([6, 6, 1])
    expect(thirteen.flatMap((s) => s.slides.map((x) => x.at))).toEqual([...Array(13).keys()])
  })

  it("keeps every slide inside the margins, in the slide's shape, one size a layout, none over another", () => {
    for (const paper of [LETTER, { ...LETTER, width: 792, height: 612 }, { ...LETTER, header: true }]) {
      const room = contentBox(paper)
      for (const layout of ['notes', { handouts: 2 }, { handouts: 3 }, { handouts: 4 }, { handouts: 6 }] as const) {
        for (const aspect of [WIDE, 4 / 3]) {
          const sheets = sheetsOf(layout, 12, paper, aspect)
          const boxes = sheets.flatMap((s) => s.slides.map((x) => x.box))
          for (const b of boxes) {
            expect(inside(b, room)).toBe(true)
            expect(b.w / b.h).toBeCloseTo(aspect, 6)
            expect(b.w).toBeCloseTo(boxes[0]!.w, 6)
          }
          for (const s of sheets) {
            const own = s.slides.map((x) => x.box)
            for (let i = 0; i < own.length; i++) for (let j = i + 1; j < own.length; j++) expect(apart(own[i]!, own[j]!)).toBe(true)
            // Rules to write on never cross a slide, and stay on the page.
            for (const l of s.lines) {
              expect(inside(l, room)).toBe(true)
              for (const b of own) expect(apart({ ...l, h: 0.01 }, b)).toBe(true)
            }
          }
        }
      }
    }
  })

  it('lays a notes page as the slide over its notes, and six a page in rows of two filled across', () => {
    const [notes] = sheetsOf('notes', 1, LETTER, WIDE)
    const room = contentBox(LETTER)
    const slide = notes!.slides[0]!
    expect(slide.box.w).toBeCloseTo(room.w)
    expect(slide.notes!.y).toBeGreaterThan(slide.box.y + slide.box.h)
    expect(slide.notes!.y + slide.notes!.h).toBeCloseTo(room.y + room.h)
    const six = sheetsOf({ handouts: 6 }, 6, LETTER, WIDE)[0]!.slides.map((x) => x.box)
    expect(six[0]!.y).toBeCloseTo(six[1]!.y)
    expect(six[1]!.x).toBeGreaterThan(six[0]!.x)
    expect(six[2]!.y).toBeGreaterThan(six[0]!.y)
    expect(gridOf(6, false)).toEqual({ cols: 2, rows: 3 })
    expect(gridOf(6, true)).toEqual({ cols: 3, rows: 2 })
    // Three a page: rules beside each slide, as PowerPoint gives them.
    const three = sheetsOf({ handouts: 3 }, 3, LETTER, WIDE)[0]!
    expect(three.lines.length).toBeGreaterThanOrEqual(9)
    expect(three.lines.every((l) => l.x > three.slides[0]!.box.x + three.slides[0]!.box.w)).toBe(true)
  })

  it('makes room for the name and the page number only when they are on', () => {
    expect(contentBox(LETTER).h).toBe(792 - 72 - BAND)
    expect(contentBox({ ...LETTER, footer: false }).h).toBe(792 - 72)
    expect(contentBox({ ...LETTER, header: true }).y).toBe(36 + BAND)
  })

  it('writes one page a sheet at the paper size, the notes as text, nothing it names but its own pictures', () => {
    const sheets = sheetsOf('notes', 2, LETTER, WIDE)
    const html = paperHtml({ sheets, paper: LETTER, pictures: ['data:image/jpeg;base64,AA', 'data:image/jpeg;base64,BB'], notes: ['Say <hi> & bye', ''], title: 'Talk' })
    expect(html).toContain('@page{size:612pt 792pt;margin:0}')
    expect(html.match(/<section class="p">/g)).toHaveLength(2)
    expect(html).toContain('Say &lt;hi&gt; &amp; bye')
    expect(html.match(/class="n"/g)).toHaveLength(1)
    expect(html).toContain('>1 of 2<')
    expect(html.match(/src="([^"]*)"/g)!.every((m) => m.startsWith('src="data:'))).toBe(true)
  })
})
