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
/**
 * A colour: a hex with no hash, or one of the deck's theme colours by its slot with Office's tint (above 0
 * lighter, below 0 darker), which stays the theme's when the theme changes.
 */
const colour = z.union([
  z.string().regex(/^[0-9a-fA-F]{6}$/),
  z.object({ slot: z.enum(['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink', 'tx1', 'tx2', 'bg1', 'bg2']), tint: z.number().min(-1).max(1).optional() })
])
export type DeckColour = z.infer<typeof colour>
/** A length on the slide in EMU (914,400 to an inch, 12,700 to a point). */
const emu = z.number().int().min(-60_000_000).max(60_000_000)
/** A shape's box as it lies on the slide before any turn: left, top, width, height, in EMU. */
const box = z.tuple([emu, emu, emu.min(1), emu.min(1)])

/** What he set on a run; what is absent stays as it was. */
const runLook = {
  /** a typeface by its name ("Calibri") */
  font: z.string().min(1).max(100).optional(),
  /** points, as drawn */
  size: z.number().min(1).max(4000).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  color: colour.optional()
}
/** What he set on a paragraph. */
const paraLook = {
  level: z.number().int().min(0).max(8).optional(),
  align: z.enum(['left', 'center', 'right', 'justify']).optional(),
  list: z.enum(['none', 'bullet', 'number']).optional()
}
/** One cell of a table, row and column from 0; absent for a shape's own words. */
const cellAt = { row: z.number().int().min(0).optional(), col: z.number().int().min(0).optional() }
const at = z.tuple([z.number().int().min(0), z.number().int().min(0)])

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
  z.object({ op: z.literal('move'), slide, after: z.number().int().min(0) }),
  /**
   * A shape's (or one cell's) paragraphs as runs. A paragraph `from` an old one keeps its spacing, level and list;
   * a run `from` an old run ([paragraph, run], both from 0, counted as the outline lists them) keeps that run's
   * look, and what the run sets goes on top. A run from nowhere takes its paragraph's first look.
   */
  z.object({
    op: z.literal('runs'),
    slide,
    shape,
    ...cellAt,
    paragraphs: z
      .array(z.object({ from: z.number().int().min(0).optional(), ...paraLook, runs: z.array(z.object({ text, from: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(), ...runLook })).max(400) }))
      .min(1)
      .max(200)
  }),
  /**
   * A look set on a shape's words: on all of them (every cell, for a table), on one cell, or on a `range` of
   * characters ([paragraph, character], both from 0; a line break counts as one character).
   */
  z.object({
    op: z.literal('format'),
    slide,
    shape,
    ...cellAt,
    range: z.object({ from: at, to: at }).optional(),
    set: z.object({ ...runLook, ...paraLook }).refine((v) => Object.keys(v).length > 0, 'set at least one thing')
  }),
  /** Where a shape is, how big, how far turned (degrees clockwise) and whether mirrored. `box` is `DeckShape.own.box`'s form. */
  z.object({ op: z.literal('geometry'), slide, shape, box: box.optional(), rot: z.number().min(-360).max(360).optional(), flipH: z.boolean().optional(), flipV: z.boolean().optional() }),
  /** A shape's place among those it lies over and under. */
  z.object({ op: z.literal('order'), slide, shape, to: z.enum(['front', 'back', 'forward', 'backward']) }),
  /**
   * A new shape on a slide, in its box. `text`: a text box. `shape`: a drawn shape by PowerPoint's name for its
   * outline (`preset`: "rect", "ellipse", "rightArrow"). `picture` and `video`: a file, which the host brings with
   * the edit (`file`: for an agent, an absolute path on the deck's host; for his own edit, what `work.slides.attach`
   * answered). `table`: `rows` by `cols`. `chart`: its data. `id`: the shape id to give it, when the same list edits it.
   */
  z.object({
    op: z.literal('insert'),
    slide,
    what: z.enum(['text', 'shape', 'picture', 'table', 'chart', 'video']),
    box,
    id: z.number().int().positive().max(2_000_000_000).optional(),
    text: text.optional(),
    preset: z.string().regex(/^[A-Za-z0-9]{1,40}$/).optional(),
    file: z.string().min(1).max(1000).optional(),
    rows: z.number().int().min(1).max(50).optional(),
    cols: z.number().int().min(1).max(30).optional(),
    chart: z
      .object({
        type: z.enum(['bar', 'line', 'pie']).default('bar'),
        categories: z.array(z.string().max(500)).min(1).max(500),
        series: z.array(z.object({ name: z.string().max(500), values: z.array(z.number().nullable()).max(500) })).min(1).max(50)
      })
      .optional()
  }),
  /** A shape off its slide, with what only it used: its picture, chart or media, and the effects that played on it. */
  z.object({ op: z.literal('delete'), slide, shape }),
  /** A shape's fill: a colour, or null for none. */
  z.object({ op: z.literal('fill'), slide, shape, color: colour.nullable() }),
  /** A shape's outline: its colour (null: none), its weight in points, its dash. */
  z.object({ op: z.literal('line'), slide, shape, color: colour.nullable().optional(), width: z.number().min(0).max(100).optional(), dash: z.enum(['solid', 'dash', 'dot']).optional() }),
  /** A table's row or column put in before place `at` (from 0; the count puts it last), or the one at `at` taken out. */
  z.object({ op: z.literal('grid'), slide, shape, what: z.enum(['row', 'col']), act: z.enum(['insert', 'delete']), at: z.number().int().min(0).max(1000) }),
  /** A slide left out of the show, or put back in. */
  z.object({ op: z.literal('hide'), slide, hidden: z.boolean() }),
  /** A copy of a slide, right after it. `id` is given by the host. */
  z.object({ op: z.literal('duplicate'), slide, id: slide.optional() }),
  /** The deck's sections: one started at slide `at`, one renamed or taken away by its place in the list (from 0). */
  z.discriminatedUnion('act', [
    z.object({ op: z.literal('section'), act: z.literal('add'), at: slide, name: z.string().min(1).max(200) }),
    z.object({ op: z.literal('section'), act: z.literal('rename'), section: z.number().int().min(0).max(1000), name: z.string().min(1).max(200) }),
    z.object({ op: z.literal('section'), act: z.literal('remove'), section: z.number().int().min(0).max(1000) })
  ]),
  /** Another of the deck's layouts for a slide, by name: only where each of the slide's placeholders has its match there. */
  z.object({ op: z.literal('layout'), slide, layout: z.string().min(1).max(200) }),
  /**
   * How a slide comes in a show: a cut (`none`), a fade or a push from a side; `click` false: a press does not
   * move on; `after`: the seconds after which it moves on by itself (null: never). Replaces what the slide had.
   */
  z.object({ op: z.literal('transition'), slide, kind: z.enum(['none', 'fade', 'push']), dir: z.enum(['l', 'r', 'u', 'd']).optional(), click: z.boolean().optional(), after: z.number().min(0).max(86_400).nullable().optional() }),
  /**
   * The shapes that come in on a press, one a press, in order; none takes the builds away. A slide whose animations
   * are more than that is PowerPoint's, unless `replace`: his confirmed press, which takes every animation it had out first.
   */
  z.object({ op: z.literal('builds'), slide, order: z.array(shape).max(200), replace: z.literal(true).optional() }),
  /** The deck's colours (by Office's twelve names) and its heading and body fonts, into its theme. */
  z.object({
    op: z.literal('theme'),
    colors: z.partialRecord(z.enum(['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']), z.string().regex(/^[0-9a-fA-F]{6}$/)).optional(),
    major: z.string().min(1).max(100).optional(),
    minor: z.string().min(1).max(100).optional()
  })
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

/** What a shape is, as the hand editor treats it. `frame`: a diagram or an embedded object, drawn and kept, edited in PowerPoint. `other`: a drawn shape with no words. */
export type DeckShapeKind = 'text' | 'table' | 'chart' | 'picture' | 'media' | 'connector' | 'frame' | 'other'

/** A point on the slide as shares of its width and height, origin top-left. */
export type DeckPoint = [x: number, y: number]

/** One run of a paragraph with the look it is drawn in: its own, else what its paragraph, shape, layout, master and the deck's defaults give it. */
export interface DeckRun {
  text: string
  /** a typeface by its Office name ("Calibri"); a theme font is resolved */
  font?: string
  /** points, after the shape's shrink-to-fit */
  size?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** hex, no hash; a theme colour is resolved */
  color?: string
}
export interface DeckParagraph {
  /** list level, from 0 */
  level: number
  align: 'left' | 'center' | 'right' | 'justify'
  list: 'none' | 'bullet' | 'number'
  runs: DeckRun[]
}
/** How a text shape holds its words. */
export interface DeckTextFrame {
  anchor: 'top' | 'middle' | 'bottom'
  /** left, top, right, bottom, in EMU */
  insets: [number, number, number, number]
  /** `shrink`: the text shrinks to the shape; `grow`: the shape grows to the text */
  fit: 'none' | 'shrink' | 'grow'
  wrap: boolean
}

/** A shape of a slide the canvas can point at: where it is and what it says. */
export interface DeckShape {
  id: number
  name: string
  /** what it is on its slide, in the person's words ("Title", "Text 2", "Picture"): what a screen reader says, never PowerPoint's name for it */
  label?: string
  /** the box around the shape as drawn (turned and flipped with it and with every group above it), clamped to the slide */
  bbox: Bbox | null
  text: string
  kind?: DeckShapeKind
  /** its own box's four corners as drawn: top-left, top-right, bottom-right, bottom-left. Handles sit on these. */
  quad?: [DeckPoint, DeckPoint, DeckPoint, DeckPoint]
  /** the angle its top edge makes, in degrees clockwise */
  rot?: number
  /** mirrored (an odd number of flips above and in it) */
  flip?: boolean
  /** the outermost group it is in, by that group's shape id */
  group?: number
  /** a preset outline's name as the file has it ("rect", "ellipse", "rightArrow"), or `custom` */
  shape?: string
  media?: 'video' | 'audio'
  /** for a text shape: its paragraphs as runs, and its frame */
  paragraphs?: DeckParagraph[]
  frame?: DeckTextFrame
  /**
   * Its own box as it lies on the slide before any turn (left, top, width, height in EMU), its own turn in
   * degrees and its flips: what a `geometry` edit takes. Absent for a shape in a group that is turned or
   * flipped, which is moved in PowerPoint.
   */
  own?: { box: [number, number, number, number]; rot: number; flipH: boolean; flipV: boolean }
  /** a table's cells, row by row */
  cells?: string[][]
  /** its own fill where it says one: a hex, or `none`. Absent: what its style or theme gives it. */
  fill?: string
  /** its own outline where it says one */
  line?: { color?: string; width?: number; dash?: string }
}

/** A slide's own transition, as the file names it. */
export interface SlideTransition {
  /** `fade`, `push`, or any other name PowerPoint writes (a cut here) */
  kind: string
  /** `l`, `r`, `u`, `d` for a push */
  dir?: string
  ms: number
  /** moves on by itself after this many milliseconds */
  after?: number
  /** false: a press does not advance it */
  click?: boolean
}

/** What a slide does not show at one step of its builds: shapes by id (a group by its own id), and runs of a text shape's paragraphs (from 0, both ends in). */
export interface StepHides {
  shapes: number[]
  paras: Array<{ shape: number; from: number; to: number }>
}

/**
 * A slide's builds as the show plays them (docs/agents/work-slides.md "Builds"): one step a press, the first the
 * slide as it comes up (after what starts by itself). Read from the slide's timing only where the reader is sure;
 * else the slide is one step, shown whole, and `whole` says why.
 */
export interface SlideBuilds {
  steps: StepHides[]
  /** effects in the file the show plays otherwise (a fade for a fly-in) or leaves out */
  changed: number
  whole?: string
  /**
   * The shapes that come in on a press, in order, when that is all the slide's timing holds (each press one whole
   * shape outside any group, by Appear; nothing by itself, no media, no trigger): exactly what a `builds` edit writes
   * back. Absent: a `builds` edit would change more than the order, so it is PowerPoint's (or a confirmed `replace`).
   */
  order?: number[]
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
  /**
   * Its own picture, a one-page PDF read with `work.slides.slide`: `rev` changes only when this slide's picture
   * does, so a client keeps it across an edit elsewhere in the deck. Absent where the host has no picture of it.
   */
  pic?: { rev: string; size: number }
  /** the layout it is made from, by name */
  layout?: string
  transition?: SlideTransition
  /** the layouts this slide may be given, by name (the host's own test for a `layout` edit): its own first among them */
  layoutsFit?: string[]
  /** its builds, when its timing has any */
  builds?: SlideBuilds
  /** the boxes of the shapes the change touched, to tint on the stage */
  changed: Bbox[]
  /** the boxes of the shapes the change takes off the slide, as they lay before it: tinted as removed */
  removed?: Bbox[]
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
  /** What an agent may do from this tab; absent on a deck that is read only here. */
  mode?: DeckMode
  /**
   * Read only here: an imported format (`.ppt`, `.pps`, `.ppsx`, `.odp`, `.key`) shown as a converted picture of
   * itself, or a Google deck's mirror. Such a view has no `hand`, no `mode` and no changes. `offline`: Drive could
   * not be reached, so the copy read before is shown.
   */
  readOnly?: { from: 'google' | 'ppt' | 'pps' | 'ppsx' | 'odp' | 'key'; offline?: true }
  /** Save to Google Slides is offered: his own saved .pptx. */
  canUpload?: true
  /** The deck lives in PowerPoint (OneDrive, SharePoint, Teams): the tab row offers the real app. */
  hosted: boolean
  slides: DeckSlide[]
  changes: SlideChange[]
  /** `file`: the deck as it is on disk. `proposed`: with every pending change in; null when nothing is pending. */
  renders: { file: DeckRender | null; proposed: DeckRender | null }
  /**
   * The revision of the changes that wait, whether or not a picture of them could be made (with one, it is
   * `renders.proposed.rev`); absent when nothing is pending. A review's `rev` is checked against it.
   */
  changesRev?: string
  /** What the agent last wrote directly, for the bar's settled line and its Undo. */
  written?: { id: string; text: string; at: number }
  /** Why there is no picture (LibreOffice is not installed on a host this one can reach). The outline still shows. */
  renderError?: string
  /** the slide's size in EMU (914,400 to an inch) */
  size?: { width: number; height: number }
  /** each layout a slide can take: its name and the placeholders it holds */
  layouts?: Array<{ name: string; master: number; holds: Array<{ kind: string; idx: number }> }>
  /**
   * A picture of the layouts, where the host has one: a PDF read with `work.slides.read {which: 'layouts'}`, page n
   * the nth entry of `layouts`. `rev` changes only when a layout, a master or the theme does.
   */
  layoutsPic?: { rev: string; size: number }
  /** the deck's theme: twelve colours as hex by Office's names (dk1, lt1, accent1 …), and its heading and body fonts */
  theme?: { colors: Record<string, string>; major: string; minor: string }
  /**
   * Present where he can edit the deck by hand (a .pptx on this host): whether one of his own edits can be taken
   * back or put back now. Both are false once anything else changed the file.
   */
  hand?: { undo: boolean; redo: boolean }
}

/** One kept copy of the deck from before a change (docs/agents/work-slides.md "Versions"). */
export interface DeckVersion {
  id: string
  /** when it was kept, ms */
  at: number
  size: number
  /** the deck as it was before TempCode first changed it: kept for good */
  first: boolean
}

/**
 * One slide of a show (docs/agents/work-slides.md "The show"): the file's own, in the file's order. A show
 * presents the deck as it is on disk, never a suggestion that still waits.
 */
export interface ShowSlide {
  id: number
  /** its place in the file, from 1 */
  number: number
  /** its page in the file's render, from 1 (hidden slides are in the render too) */
  page: number
  title: string
  notes: string
  /** skipped by Next and Previous; a jump by number or from the strip still shows it */
  hidden: boolean
  /** its builds, one entry a press (the first the slide as it comes); absent: one press, its page */
  steps?: ShowStep[]
  /** played between slides when it is a fade or a push; `after` moves the show on by itself */
  transition?: SlideTransition
  /** each video or sound on it, played over its shape */
  media?: ShowMedia[]
}

/** One step of a slide's builds in a show. */
export interface ShowStep {
  /** its own picture (a one-page PDF read with `work.slides.build`); absent while it is being made, or where it is the slide's own page */
  pic?: { rev: string; size: number }
  /** the shapes not seen at this step, a video's among them */
  hides: number[]
}

/** A video or a sound on a slide of a show, read by range with `work.slides.media`. */
export interface ShowMedia {
  shape: number
  kind: 'video' | 'audio'
  /** its box's corners on the slide, as `DeckShape.quad` */
  quad: [DeckPoint, DeckPoint, DeckPoint, DeckPoint]
  /** absent while the host is still taking it out of the deck (or making it an .mp4 the app can play) */
  file?: { rev: string; size: number; type: string }
}

/** What a show draws from: the file's slides and its render. */
export interface ShowDeck {
  itemId: string
  name: string
  /** changes when the file's bytes do */
  rev: string
  /** read by range with `work.slides.read {which: 'file'}`; null with `renderError` */
  render: DeckRender | null
  slides: ShowSlide[]
  renderError?: string
  /** how many effects and transitions in the file this show plays otherwise or leaves out */
  changed?: number
}

// ── preview and export (docs/agents/work-slides.md "Preview and export") ──

/** What a deck holds that a format may drop, counted from the file (not the suggestions that wait on it). */
export interface DeckFacts {
  slides: number
  hidden: number
  /** slides with speaker notes */
  notes: number
  /** slides with builds or other effects */
  animated: number
  /** slides with a transition */
  transitions: number
  videos: number
  sounds: number
  /** slides an agent's waiting suggestions change */
  pending: number
}

/** What `work.slides.preview` answers: one finished file of a format, read by `rev` with `work.slides.previewRead`. */
export interface DeckOut {
  /** the file the format makes (a .pptx, .pdf, .zip, .mp4 or .odp) */
  file: { rev: string; size: number; name: string }
  /** its pages, for a format drawn as pages: the file itself for a PDF, LibreOffice's or PowerPoint's picture of it otherwise */
  pdf?: { rev: string; size: number; pages: number }
  drawnBy: 'tempcode' | 'libreoffice' | 'powerpoint'
  /** pictures: each file's name in the zip and a small JPEG of it as a `data:` URL */
  thumbs?: Array<{ name: string; thumb: string }>
  /** a video: its length, its first frame as a `data:` URL, its height */
  video?: { seconds: number; poster: string; height: number }
  facts: DeckFacts
}

/** Whether PowerPoint can draw this deck from here: its PDF, and its video. */
export interface DeckReach {
  pdf: 'ready' | 'asleep' | 'not open' | 'none'
  video: 'ready' | 'asleep' | 'not open' | 'none'
}

const margin = z.number().min(0).max(288)
/** How a deck goes out: the format and what he picked for it. Anything a format does not use is left out of its file's name. */
export const DeckOutSchema = z.object({
  format: z.enum(['pptx', 'pdf', 'print', 'pics', 'video', 'odp']),
  layout: z.union([z.enum(['slides', 'notes']), z.object({ handouts: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(6)]) })]).optional(),
  /** hidden slides in the PDF, the pictures and the video */
  hidden: z.boolean().optional(),
  page: z
    .object({
      paper: z.enum(['Letter', 'A4', 'Legal', 'Tabloid', 'A3', 'A5']),
      orientation: z.enum(['portrait', 'landscape']),
      margins: z.object({ top: margin, right: margin, bottom: margin, left: margin }),
      header: z.boolean(),
      footer: z.boolean()
    })
    .optional(),
  picture: z.object({ type: z.enum(['png', 'jpeg']), width: z.union([z.literal(1280), z.literal(1920), z.literal(3840)]) }).optional(),
  video: z.object({ seconds: z.union([z.literal(3), z.literal(5), z.literal(10)]), height: z.union([z.literal(720), z.literal(1080)]), by: z.enum(['tempcode', 'powerpoint']).optional() }).optional(),
  /** "Check in PowerPoint": PowerPoint's own PDF of the file, on his press */
  office: z.boolean().optional()
})
export type DeckOutAsk = z.infer<typeof DeckOutSchema>

const itemId = z.string().min(1).max(100)
/**
 * His own edits as a request carries them: checked by `SlideOpSchema` as they come in, and typed here by the
 * edits' own name rather than by the schema's whole shape. The wire's one union of every request is what the
 * compiler works through for each request; the edits' schema, spelt out inside it, was more than it would take.
 */
const opsOnWire = z.array(SlideOpSchema).min(1).max(100) as unknown as z.ZodType<SlideOp[]>

export const SlidesRequestSchemas = [
  /** → DeckView: reads the deck and renders it (and the proposed deck, when changes wait), which can take seconds the first time */
  request('work.slides.open', z.object({ itemId })),
  /** → { itemId }: his press only. Writes a .pptx of a read-only deck (an import, a Google deck) he can see in Files, never over a file, and opens it in the same seat. */
  request('work.slides.copyToEdit', z.object({ itemId })),
  /** → { data: base64, size, rev }: bytes of one of the deck's renders, a PDF. `layouts`: one page per entry of `DeckView.layouts`, each layout as an empty slide that says what goes where (`DeckView.layoutsPic`). */
  request('work.slides.read', z.object({ itemId, which: z.enum(['file', 'proposed', 'layouts']), offset: z.number().int().min(0), length: z.number().int().positive().max(4 * 1024 * 1024) })),
  /** → { data: base64, size, rev }: bytes of one slide's own picture (a one-page PDF), by the slide's id in the file or in the proposed deck; `rev` is the slide's `pic.rev` */
  request('work.slides.slide', z.object({ itemId, which: z.enum(['file', 'proposed']), slide, offset: z.number().int().min(0), length: z.number().int().positive().max(4 * 1024 * 1024) })),
  /** → DeckView: accept writes the changes into the file; reject drops them */
  request(
    'work.slides.review',
    z.object({
      itemId,
      changes: z.union([z.array(z.string()).max(1000), z.literal('all')]),
      verdict: z.enum(['accept', 'reject']),
      /** the changes the press was made on (`DeckView.changesRev`, which is `renders.proposed.rev` when there is a picture): with it, a press on changes that moved on since is refused, never applied to what he did not see; an older client that sends none is not checked */
      rev: z.string().max(64).optional()
    })
  ),
  /** → ShowDeck: the file's slides in its own order and its render, for a show; pending suggestions are not in it */
  request('work.slides.show', z.object({ itemId })),
  /** → { data: base64, size, rev }: bytes of one step's picture (a one-page PDF), by its `ShowStep.pic.rev` */
  request('work.slides.build', z.object({ itemId, rev: z.string().regex(/^[0-9a-f]{16}$/), offset: z.number().int().min(0), length: z.number().int().positive().max(4 * 1024 * 1024) })),
  /** → { data: base64, size, rev }: bytes of a slide's video or sound as the app plays it, by its `ShowMedia.file.rev` */
  request('work.slides.media', z.object({ itemId, rev: z.string().regex(/^[0-9a-f]{16}$/), offset: z.number().int().min(0), length: z.number().int().positive().max(4 * 1024 * 1024) })),
  /** → DeckView: what the agent does to this deck from now on */
  request('work.slides.mode', z.object({ itemId, mode: z.enum(['suggests', 'writes']) })),
  /** → DeckView: puts the file back as it was before the agent's direct write */
  request('work.slides.undo', z.object({ itemId, writeId: z.string() })),
  /** → DeckView: his own edits, written into the file at once. Refused for a thread: an agent edits through `slides_edit`, under the hold. */
  request('work.slides.edit', z.object({ itemId, ops: opsOnWire })),
  /** → DeckView: takes his last edit back, or puts back the one he took back */
  request('work.slides.step', z.object({ itemId, dir: z.enum(['undo', 'redo']) })),
  /** → DeckVersion[]: the kept copies, newest first */
  request('work.slides.versions', z.object({ itemId })),
  /** → DeckView: puts a kept copy in the file's place; the deck as it is now is kept first */
  request('work.slides.restore', z.object({ itemId, version: z.string().min(1).max(100) })),
  /**
   * → { token }: one piece of a picture or a video he is adding by hand, at most 4 MB of it. The first piece names
   * the file and is answered its token; each next piece gives the token and follows on. An `insert` edit then names
   * the file by that token (`file`). Refused for a thread: an agent's edit names a path on the deck's host.
   */
  request('work.slides.attach', z.object({ itemId, name: z.string().min(1).max(300), token: z.string().max(100).optional(), data: z.string().max(5_600_000) })),
  /** → DeckOut: the deck as a format will hold it, made from the file as it is now (kept by revision, so asking again costs nothing) */
  request('work.slides.preview', DeckOutSchema.extend({ itemId })),
  /** → { data: base64, size, rev }: bytes of a file `work.slides.preview` made, by its rev */
  request('work.slides.previewRead', z.object({ itemId, rev: z.string().regex(/^[0-9a-f]{32}$/), offset: z.number().int().min(0), length: z.number().int().positive().max(4 * 1024 * 1024) })),
  /** → DeckReach: whether PowerPoint can draw this deck from here */
  request('work.slides.reach', z.object({ itemId }))
] as const

/** A deck's view changed: an agent revised it, or a change was accepted or rejected. */
export type SlidesPush = { push: 'work.slides'; sessionId: string; view: DeckView }
/** More of a deck's show is ready (a step's picture, a video made playable): a show of file revision `rev` reads it again. */
export type SlidesReadyPush = { push: 'work.slides.ready'; sessionId: string; itemId: string; rev: string }

export const SLIDES_CAPS = {
  'work.slides.open': 'read',
  'work.slides.copyToEdit': 'operate',
  'work.slides.read': 'read',
  'work.slides.show': 'read',
  'work.slides.slide': 'read',
  'work.slides.build': 'read',
  'work.slides.media': 'read',
  'work.slides.review': 'operate',
  'work.slides.mode': 'operate',
  'work.slides.undo': 'operate',
  'work.slides.edit': 'operate',
  'work.slides.step': 'operate',
  'work.slides.versions': 'read',
  'work.slides.restore': 'operate',
  'work.slides.attach': 'operate',
  'work.slides.preview': 'operate',
  'work.slides.previewRead': 'read',
  'work.slides.reach': 'read'
} satisfies CapsOf<typeof SlidesRequestSchemas>
export const SLIDES_RELAY = {} satisfies RelayOf<typeof SlidesRequestSchemas>
