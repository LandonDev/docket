import PptxGenJS from 'pptxgenjs'
import { NewDeckSchema, type NewDeck, type NewSlide } from '@shared/contract-work-slides'

/**
 * A deck an agent drafts from nothing (`slides_new`), on pptxgenjs
 * (docs/agents/work-slides.md "A new deck"). Each of our layouts is a
 * real named layout, so python-pptx can add a slide from it by name later,
 * with real title and body placeholders. Sizes and colours are set on the
 * text as well as on the layout: the layout's size does not reach the text
 * in every reader.
 */

/** The layouts a new deck has, by the name PowerPoint lists them under; `slides_edit` adds from these. */
export const NEW_DECK_LAYOUTS: Record<NewSlide['layout'], string> = {
  title: 'Title',
  bullets: 'Title and Content',
  table: 'Table',
  chart: 'Chart',
  section: 'Section Header'
}

const W = 13.333
const FONT = 'Calibri'

interface Look {
  ground: string
  ink: string
  muted: string
  accent: string
}

function lookOf(theme: NewDeck['theme']): Look {
  const dark = theme?.dark ?? false
  const accent = (theme?.accent ?? (dark ? '7AA2FF' : '2F5BEA')).toUpperCase()
  return dark ? { ground: '16181D', ink: 'F2F3F5', muted: '9AA0AA', accent } : { ground: 'FFFFFF', ink: '1F2328', muted: '6B7280', accent }
}

const titleBox = (look: Look) => ({ x: 0.6, y: 0.4, w: W - 1.2, h: 0.9, fontFace: FONT, fontSize: 30, bold: true, color: look.ink })
const bodyBox = (look: Look) => ({ x: 0.6, y: 1.5, w: W - 1.2, h: 5.4, fontFace: FONT, fontSize: 20, color: look.ink })
const bigTitle = (look: Look) => ({ x: 0.8, y: 2.4, w: W - 1.6, h: 1.4, fontFace: FONT, fontSize: 44, bold: true, color: look.ink })
const subBox = (look: Look) => ({ x: 0.8, y: 3.9, w: W - 1.6, h: 0.9, fontFace: FONT, fontSize: 22, color: look.muted })

function defineLayouts(pres: PptxGenJS, look: Look): void {
  const bar = { rect: { x: 0, y: 7.3, w: W, h: 0.2, fill: { color: look.accent } } }
  const master = (layout: NewSlide['layout'], objects: PptxGenJS.SlideMasterProps['objects']): void =>
    pres.defineSlideMaster({
      title: NEW_DECK_LAYOUTS[layout],
      background: { color: look.ground },
      objects: [bar, ...(objects ?? [])],
      slideNumber: { x: W - 0.8, y: 6.9, w: 0.6, h: 0.3, fontFace: FONT, fontSize: 10, color: look.muted }
    })
  const ph = (name: string, type: 'title' | 'body', box: object) => ({ placeholder: { options: { name, type, ...box }, text: '' } })
  master('title', [ph('title', 'title', bigTitle(look)), ph('body', 'body', subBox(look))])
  master('bullets', [ph('title', 'title', titleBox(look)), ph('body', 'body', bodyBox(look))])
  master('table', [ph('title', 'title', titleBox(look))])
  master('chart', [ph('title', 'title', titleBox(look))])
  master('section', [ph('title', 'title', { ...bigTitle(look), color: look.accent }), ph('body', 'body', subBox(look))])
}

const CHART = { bar: 'bar', line: 'line', pie: 'pie' } as const

function addSlide(pres: PptxGenJS, s: NewSlide, look: Look): void {
  const slide = pres.addSlide({ masterName: NEW_DECK_LAYOUTS[s.layout] })
  const big = s.layout === 'title' || s.layout === 'section'
  const { x: _x, y: _y, w: _w, h: _h, ...titleLook } = big ? { ...bigTitle(look), ...(s.layout === 'section' ? { color: look.accent } : {}) } : titleBox(look)
  if (s.title) slide.addText(s.title, { placeholder: 'title', ...titleLook })
  if (big && s.subtitle) {
    const { x: _sx, y: _sy, w: _sw, h: _sh, ...subLook } = subBox(look)
    slide.addText(s.subtitle, { placeholder: 'body', ...subLook })
  }
  if (s.layout === 'bullets' && s.bullets?.length) {
    const { x: _bx, y: _by, w: _bw, h: _bh, ...bodyLook } = bodyBox(look)
    slide.addText(
      s.bullets.map((b) => {
        const { text, level } = typeof b === 'string' ? { text: b, level: 0 } : b
        return { text, options: { bullet: true, breakLine: true, ...(level ? { indentLevel: level } : {}) } }
      }),
      { placeholder: 'body', ...bodyLook }
    )
  }
  if (s.table?.length) {
    const [head, ...rows] = s.table
    const width = Math.max(...s.table.map((r) => r.length))
    const pad = (r: string[]): string[] => [...r, ...Array<string>(width - r.length).fill('')]
    slide.addTable(
      [pad(head).map((text) => ({ text, options: { bold: true, color: 'FFFFFF', fill: { color: look.accent } } })), ...rows.map((r) => pad(r).map((text) => ({ text })))],
      { x: 0.6, y: 1.6, w: W - 1.2, fontFace: FONT, fontSize: 16, color: look.ink, border: { type: 'solid', pt: 0.5, color: look.muted }, rowH: 0.5 }
    )
  }
  if (s.chart) {
    const c = s.chart
    const type = CHART[c.type]
    const series = (type === 'pie' ? c.series.slice(0, 1) : c.series).map((x) => ({ name: x.name, labels: c.categories, values: c.categories.map((_, i) => x.values[i] ?? 0) }))
    slide.addChart(type as PptxGenJS.CHART_NAME, series, {
      x: 0.6,
      y: 1.5,
      w: W - 1.2,
      h: 5.4,
      ...(type === 'bar' ? { barDir: 'col' } : {}),
      showLegend: c.series.length > 1 || type === 'pie',
      legendPos: 'b',
      legendColor: look.ink,
      chartColors: [look.accent, '9DC3E6', 'F2A541', '6CC5A0', 'C77DFF', 'EF6F6C'],
      catAxisLabelColor: look.ink,
      valAxisLabelColor: look.ink,
      catAxisLabelFontFace: FONT,
      valAxisLabelFontFace: FONT
    })
  }
  if (s.notes) slide.addNotes(s.notes)
}

/** The bytes of a new .pptx: one slide per entry, from the deck's own named layouts. */
export async function writeNewDeck(input: NewDeck): Promise<Uint8Array> {
  const deck = NewDeckSchema.parse(input)
  const look = lookOf(deck.theme)
  const pres = new PptxGenJS()
  pres.layout = 'LAYOUT_WIDE'
  pres.title = deck.title
  pres.theme = { headFontFace: FONT, bodyFontFace: FONT }
  defineLayouts(pres, look)
  for (const s of deck.slides) addSlide(pres, s, look)
  const out = await pres.write({ outputType: 'uint8array' })
  return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer)
}
