import { z } from 'zod'
import type { Bbox } from './contract-work-pdf'
import type { Principal } from './work/ids'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The slides pillar's wire (docs/agents/work-slides.md): a deck in the
 * canvas pane. Its methods are `work.slides.<verb>` and its push
 * `work.slides`; src/shared/work/wire.ts has the helpers and the rules.
 *
 * A deck is a .pptx file and stays the truth. The host renders it to a PDF
 * with LibreOffice, which the canvas draws; an agent's revision is a list
 * of edits by slide id, kept beside the file until the owner accepts it.
 */

// ── an agent's edits ─────────────────────────────────────────────────

/** A slide by its id in the deck (`p:sldId/@id`), which a save keeps; a slide's number is its place and moves. */
const slide = z.number().int().positive()
/** A shape on a slide: its id, or its name as PowerPoint's selection pane shows it. */
const shape = z.union([z.number().int().nonnegative(), z.string().min(1).max(200)])
const text = z.string().max(20_000)

export const SlideOpSchema = z.discriminatedUnion('op', [
  /** A shape's words. `paragraphs`: one entry a paragraph; each keeps its first run's look. */
  z.object({ op: z.literal('text'), slide, shape, paragraphs: z.array(text).min(1).max(200) }),
  /** One cell of a table, row and column from 0. */
  z.object({ op: z.literal('cell'), slide, shape, row: z.number().int().min(0), col: z.number().int().min(0), text }),
  /** The slide's speaker notes. */
  z.object({ op: z.literal('notes'), slide, text }),
  /** A chart's data; its look is kept. */
  z.object({
    op: z.literal('chart'),
    slide,
    shape,
    categories: z.array(z.string().max(500)).min(1).max(500),
    series: z.array(z.object({ name: z.string().max(500), values: z.array(z.number().nullable()).max(500) })).min(1).max(50)
  }),
  /** A new slide from one of the deck's own layouts, after slide `after` (0: first). `id` is given by the host. */
  z.object({
    op: z.literal('add'),
    after: z.number().int().min(0),
    layout: z.string().min(1).max(200),
    title: text.optional(),
    /** the body placeholder's paragraphs */
    body: z.array(text).max(200).optional(),
    notes: text.optional(),
    id: slide.optional()
  }),
  z.object({ op: z.literal('remove'), slide }),
  /** Moves a slide to after slide `after` (0: first). */
  z.object({ op: z.literal('move'), slide, after: z.number().int().min(0) })
])
export type SlideOp = z.infer<typeof SlideOpSchema>

// ── a new deck ───────────────────────────────────────────────────────

/** One slide of a deck an agent drafts from nothing: a layout by name and what goes in it. */
export const NewSlideSchema = z.object({
  layout: z.enum(['title', 'bullets', 'table', 'chart', 'section']).default('bullets'),
  title: z.string().max(500),
  /** the title slide's second line */
  subtitle: z.string().max(500).optional(),
  bullets: z.array(z.union([z.string().max(2000), z.object({ text: z.string().max(2000), level: z.number().int().min(0).max(4) })])).max(40).optional(),
  /** rows of cells; the first row is the head */
  table: z.array(z.array(z.string().max(2000)).max(20)).max(60).optional(),
  chart: z
    .object({
      type: z.enum(['bar', 'line', 'pie']).default('bar'),
      categories: z.array(z.string().max(200)).min(1).max(100),
      series: z.array(z.object({ name: z.string().max(200), values: z.array(z.number()).max(100) })).min(1).max(12)
    })
    .optional(),
  notes: z.string().max(20_000).optional()
})
export type NewSlide = z.infer<typeof NewSlideSchema>
export const NewDeckSchema = z.object({
  title: z.string().min(1).max(300),
  /** the deck's look: a dark or a light ground, one accent */
  theme: z.object({ dark: z.boolean().default(false), accent: z.string().regex(/^[0-9a-fA-F]{6}$/).optional() }).optional(),
  slides: z.array(NewSlideSchema).min(1).max(200)
})
export type NewDeck = z.infer<typeof NewDeckSchema>

// ── what the canvas draws ────────────────────────────────────────────

/** A shape of a slide the canvas can point at: where it is and what it says. */
export interface DeckShape {
  id: number
  name: string
  bbox: Bbox | null
  text: string
}

/** One thumbnail of the strip, in the proposed order. */
export interface DeckSlide {
  /** unique in the list: the slide's id, or `ghost:<id>` for the place a slide leaves */
  key: string
  id: number
  /** its place in the proposed deck, from 1; null for the place a slide leaves */
  number: number | null
  title: string
  notes: string
  /** hidden in a show */
  hidden: boolean
  /** which render holds its picture, and the page in it, from 1 */
  from: 'file' | 'proposed'
  page: number
  /** the pending change it belongs to */
  change: string | null
  /** add: a slide the change adds, rewords or lands. del: the place a slide leaves. */
  tint: 'add' | 'del' | null
  shapes: DeckShape[]
  /** the boxes of the shapes the change touched, to tint on the stage */
  changed: Bbox[]
  /** the heading over this slide in the strip: the section it starts */
  section?: string
}

/** One pending change, as the stepper counts them: a slide reworded, added, removed or moved. */
export interface SlideChange {
  id: string
  kind: 'changed' | 'added' | 'removed' | 'moved'
  slideId: number
  /** the slide's title */
  label: string
  /** What the words were and are, one entry a shape, a cell or the notes. */
  edits: Array<{ where: string; before: string; after: string }>
  by: Principal
}

export type DeckMode = 'suggests' | 'writes'

export interface DeckRender {
  /** changes when the render's bytes do */
  rev: string
  size: number
  pages: number
}

export interface DeckView {
  itemId: string
  sessionId: string
  name: string
  /** changes when the file's bytes do */
  rev: string
  mode: DeckMode
  /** The deck lives in PowerPoint (OneDrive, SharePoint, Teams): the tab row offers the real app. */
  hosted: boolean
  slides: DeckSlide[]
  changes: SlideChange[]
  /** `file`: the deck as it is on disk. `proposed`: with every pending change in; null when nothing is pending. */
  renders: { file: DeckRender | null; proposed: DeckRender | null }
  /** What the agent last wrote directly, for the bar's settled line and its Undo. */
  written?: { id: string; text: string; at: number }
  /** Why there is no picture (LibreOffice is not installed on a host this one can reach). The outline still shows. */
  renderError?: string
}

const itemId = z.string().min(1).max(100)

export const SlidesRequestSchemas = [
  /** → DeckView: reads the deck and renders it (and the proposed deck, when changes wait), which can take seconds the first time */
  request('work.slides.open', z.object({ itemId })),
  /** → { data: base64, size, rev }: bytes of one of the deck's renders, a PDF */
  request('work.slides.read', z.object({ itemId, which: z.enum(['file', 'proposed']), offset: z.number().int().min(0), length: z.number().int().positive().max(4 * 1024 * 1024) })),
  /** → DeckView: accept writes the changes into the file; reject drops them */
  request('work.slides.review', z.object({ itemId, changes: z.union([z.array(z.string()).max(1000), z.literal('all')]), verdict: z.enum(['accept', 'reject']) })),
  /** → DeckView: what the agent does to this deck from now on */
  request('work.slides.mode', z.object({ itemId, mode: z.enum(['suggests', 'writes']) })),
  /** → DeckView: puts the file back as it was before the agent's direct write */
  request('work.slides.undo', z.object({ itemId, writeId: z.string() }))
] as const

/** A deck's view changed: an agent revised it, or a change was accepted or rejected. */
export type SlidesPush = { push: 'work.slides'; sessionId: string; view: DeckView }

export const SLIDES_CAPS = {
  'work.slides.open': 'read',
  'work.slides.read': 'read',
  'work.slides.review': 'operate',
  'work.slides.mode': 'operate',
  'work.slides.undo': 'operate'
} satisfies CapsOf<typeof SlidesRequestSchemas>
export const SLIDES_RELAY = {} satisfies RelayOf<typeof SlidesRequestSchemas>
