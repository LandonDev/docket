import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { SlideOpSchema, type DeckParagraph, type DeckPoint, type DeckShapeKind, type DeckTextFrame, type DeckView, type SlideBuilds, type SlideOp, type SlideTransition } from '@shared/contract-work-slides'
import type { Converter, ConvertRun } from '../formats/jobs'
import { tailOf } from '../formats/tools'
import type { TimingNode } from './builds'
import { DeckRefused, DeckResidentUnavailable, deckResidentOf, deckToolHome } from './deckResident'
import { DECK_PY } from './deckScript'

/**
 * Reading and editing a .pptx with python-pptx (docs/agents/work-slides.md).
 * Two converters: `pptx → deckinfo` writes `DeckInfo` as JSON, `pptx →
 * pptxedit` applies `options.ops` and writes the edited deck. The Python is
 * deckScript.ts; after python-pptx saves, it writes the zip itself so every
 * part an edit did not change keeps the input's bytes. An edit is a job of
 * the tool kept running (deckResident.ts); one run of the tool is the
 * fallback for whatever that cannot do, and the way of every other verb.
 */

/** The name a file an edit brings goes by in the job: `f0.png`, `f1.mp4`. */
export const ATTACHED = /^f\d+(\.[A-Za-z0-9]{1,8})?$/

export interface DeckInfo {
  /** the slide's size in EMU */
  width: number
  height: number
  slides: SlideInfo[]
  /** PowerPoint's sections (p14:sectionLst), in order; empty when the deck has none */
  sections: Array<{ name: string; slideIds: number[] }>
  /** the layouts a new slide can be made from, by name, as PowerPoint lists them */
  layouts: string[]
  /** each layout with its master and the placeholders it holds (an outline kept by an older script has none) */
  layoutInfo?: NonNullable<DeckView['layouts']>
  theme?: NonNullable<DeckView['theme']>
  /** one hash of everything the deck's layouts are drawn from (masters, layouts, themes): the layout picker's pictures are kept under it */
  layoutsDraws?: string
}
export interface SlideInfo {
  /** p:sldId/@id: kept by every save, so a slide is paired across revisions by it */
  id: number
  hidden: boolean
  layout: string
  /** the title placeholder's text, else the first text shape's first line, else '' */
  title: string
  notes: string
  /** sha256 (hex) of the slide part's bytes: equal across two files means the slide's XML is byte-identical */
  hash: string
  /**
   * sha256 (hex) of everything the slide's picture is drawn from (its XML, its layout, master and theme, its
   * pictures, charts and media, and its number where one is printed): equal means the same picture, so a picture
   * is kept by it. An outline kept by an older script has none.
   */
  draws?: string
  /** in z-order; a group's children flattened in, each placed through every group above it */
  shapes: ShapeInfo[]
  transition?: SlideTransition
  /** the layouts this slide may be given, by name: its own, and each whose placeholders match the slide's by index and kind (`op_layout`'s test) */
  fits?: string[]
  /** its p:timing as a plain tree (`timing_of`), read by builds.ts */
  timing?: TimingNode
  /** its builds, read from `timing` by the host once the outline is read (builds.ts `withBuilds`) */
  builds?: SlideBuilds
}
export interface ShapeInfo {
  id: number
  name: string
  kind: DeckShapeKind
  /** for a placeholder: 'title' (also a centred title), 'subtitle', 'body' (also a content placeholder), 'date', 'number', 'footer', … */
  placeholder?: string
  /** x0,y0,x1,y1 as shares of the slide, origin top-left, clamped to 0..1: the box around the shape as drawn, its rotation, flips and groups applied; inherited from the layout when the shape has none */
  bbox: [number, number, number, number] | null
  /** its own box's corners as drawn (top-left, top-right, bottom-right, bottom-left), unclamped */
  quad?: [DeckPoint, DeckPoint, DeckPoint, DeckPoint]
  rot?: number
  flip?: boolean
  /** the outermost group it is in */
  group?: number
  shape?: string
  media?: 'video' | 'audio'
  paragraphs?: DeckParagraph[]
  frame?: DeckTextFrame
  /** its own box on the slide before any turn (EMU), its turn and flips: what a `geometry` edit takes */
  own?: { box: [number, number, number, number]; rot: number; flipH: boolean; flipV: boolean }
  /** its own fill (a hex, or `none`) and outline, where it says them itself */
  fill?: string
  line?: { color?: string; width?: number; dash?: string }
  /** every paragraph joined by \n; '' for a shape with no text */
  text: string
  /** a table's cells, row by row */
  cells?: string[][]
  chart?: { categories: string[]; series: Array<{ name: string; values: Array<number | null> }> }
}

const TIMEOUT_MS = 5 * 60_000
// Options may come from another host's key: anything but a list of edits is refused.
/** `files`: the names of the files the edits bring (a picture, a video), in the order they follow the deck in a `pptxplus` input. */
const EditOptions = z.object({ ops: z.array(SlideOpSchema).min(1).max(500), strict: z.boolean().optional(), files: z.array(z.string().regex(ATTACHED)).max(64).optional() })

/**
 * The deck an edit job works on. A `pptxplus` input is the deck and, after it, the files its edits bring, as one
 * file (`joinStep`): the conversion runner carries one file, and a job run on another host must take them along.
 * They are laid out where the deck tool looks: `files/<name>` beside the edits.
 */
function deckIn(job: { from: string; input: string }, run: ConvertRun, files: readonly string[]): string {
  if (job.from !== 'pptxplus') return job.input
  const deck = join(run.tmp, 'in.pptx')
  mkdirSync(join(run.tmp, 'files'), { recursive: true })
  splitStep(job.input, [deck, ...files.map((name) => join(run.tmp, 'files', name))])
  return deck
}

async function runEdit(job: { from: string; input: string; output: string; options?: unknown }, run: ConvertRun): Promise<{ warnings: string[] }> {
  const parsed = EditOptions.safeParse(job.options ?? {})
  if (!parsed.success) throw new Error('the edits are not a list of slide edits')
  const ops = join(run.tmp, 'ops.json')
  const out = join(run.tmp, 'out.pptx')
  const said = join(run.tmp, 'warnings.json')
  writeFileSync(ops, JSON.stringify(parsed.data.ops))
  await runDeck(run, ['apply', deckIn(job, run, parsed.data.files ?? []), ops, out, said])
  const warnings = JSON.parse(readFileSync(said, 'utf8')) as string[]
  // Strict: nothing is kept unless every edit went in (the output stays in tmp, which the runner removes).
  if (parsed.data.strict && warnings.some((w) => !isNote(w))) throw new Error(warnings.filter((w) => !isNote(w)).join(' '))
  copyFileSync(out, job.output)
  return { warnings }
}

// His own edit, in one run of the tool: the edited deck, the pack that turns it back into the input (deckScript.ts
// "undo packs") and the edited deck's outline. Always strict: an edit of his that does not go in whole writes nothing.
async function runStep(job: { from: string; input: string; output: string; options?: unknown }, run: ConvertRun): Promise<{ warnings: string[] }> {
  const parsed = EditOptions.safeParse(job.options ?? {})
  if (!parsed.success) throw new Error('the edits are not a list of slide edits')
  const [ops, out, said, pack, info] = ['ops.json', 'out.pptx', 'warnings.json', 'back.pack', 'info.json'].map((f) => join(run.tmp, f))
  writeFileSync(ops, JSON.stringify(parsed.data.ops))
  await runDeck(run, ['step', deckIn(job, run, parsed.data.files ?? []), ops, out, said, pack, info])
  const warnings = JSON.parse(readFileSync(said, 'utf8')) as string[]
  if (warnings.some((w) => !isNote(w))) throw new Error(warnings.filter((w) => !isNote(w)).join(' '))
  joinStep([out, pack, info], job.output)
  return { warnings }
}

/**
 * The verbs an edit is made of: these go to the tool kept running first. `TEMP_CODE_DECK_TOOL=once` sends none
 * there: every job is one run of the tool, to rule the resident out of a fault or to time it against.
 * (`TEMP_CODE_DECK_TOOL=alone` is the other value: deckResident.ts `slideAlone`.)
 */
const EDIT_VERBS = new Set(['apply', 'step', 'unstep'])
const kept = (verb: string): boolean => EDIT_VERBS.has(verb) && process.env.TEMP_CODE_DECK_TOOL !== 'once'

async function runDeck(run: ConvertRun, args: string[]): Promise<void> {
  const py = run.tools.bin('python-pptx')
  if (!py) throw new Error('python-pptx is not installed here')
  const home = deckToolHome()
  if (home && kept(args[0]!)) {
    try {
      return void (await deckResidentOf(home, () => run.tools.bin('python-pptx')).run(args, run.signal))
    } catch (err) {
      // The tool's own refusal is the answer a run would give; anything else of the resident's, and the job is run the old way.
      if (err instanceof DeckRefused) throw new Error(tailOf(err.message))
      if (!(err instanceof DeckResidentUnavailable)) throw err
    }
  }
  const script = join(run.tmp, 'deck.py')
  writeFileSync(script, DECK_PY)
  const r = await run.run(py, ['-I', script, ...args], { timeoutMs: TIMEOUT_MS, cwd: run.tmp })
  if (r.code !== 0) throw new Error(tailOf(r.out) || `the deck tool stopped (exit ${r.code})`)
}

export const SLIDES_CONVERTERS: Converter[] = [
  {
    from: 'pptx',
    to: 'deckinfo',
    needs: 'python-pptx',
    async run(job, run) {
      await runDeck(run, ['inspect', job.input, job.output])
      return {}
    }
  },
  // A deck of one slide per layout of the input, for the layout picker's pictures (view.ts "the layouts' picture").
  {
    from: 'pptx',
    to: 'pptxlayouts',
    needs: 'python-pptx',
    async run(job, run) {
      await runDeck(run, ['layouts', job.input, job.output])
      return {}
    }
  },
  { from: 'pptx', to: 'pptxedit', needs: 'python-pptx', run: runEdit },
  // The same, with the files the edits bring carried in the input (a picture, a video).
  { from: 'pptxplus', to: 'pptxedit', needs: 'python-pptx', run: runEdit },
  { from: 'pptx', to: 'pptxstep', needs: 'python-pptx', run: runStep },
  { from: 'pptxplus', to: 'pptxstep', needs: 'python-pptx', run: runStep },
  // An edit taken back or put back: a deck and the pack to apply to it in; the deck after, the pack back and its outline out.
  {
    from: 'pptxstep',
    to: 'pptxstep',
    needs: 'python-pptx',
    async run(job, run) {
      const [now, pack, out, back, info] = ['now.pptx', 'in.pack', 'out.pptx', 'back.pack', 'info.json'].map((f) => join(run.tmp, f))
      splitStep(job.input, [now, pack])
      await runDeck(run, ['unstep', now, pack, out, back, info])
      joinStep([out, back, info], job.output)
      return {}
    }
  }
]

const CHUNK = 1 << 20
function copyInto(fd: number, from: string, start = 0, length = statSync(from).size - start): void {
  const src = openSync(from, 'r')
  try {
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, length)))
    let left = length
    let at = start
    while (left > 0) {
      const got = readSync(src, buf, 0, Math.min(buf.length, left), at)
      if (got <= 0) throw new Error('the file ended early')
      writeSync(fd, buf, 0, got)
      left -= got
      at += got
    }
  } finally {
    closeSync(src)
  }
}

const NOT_STEP = 'not a deck with its pack'

/**
 * Several files as one, since the conversion runner carries one file each way (a deck, the pack that reverses an
 * edit, the deck's outline): how many, eight bytes of each one's length, then each in turn.
 */
export function joinStep(parts: readonly string[], out: string): void {
  const fd = openSync(out, 'w', 0o600)
  try {
    const head = Buffer.alloc(4 + 8 * parts.length)
    head.writeUInt32BE(parts.length)
    parts.forEach((part, i) => head.writeBigUInt64BE(BigInt(statSync(part).size), 4 + 8 * i))
    writeSync(fd, head)
    for (const part of parts) copyInto(fd, part)
  } finally {
    closeSync(fd)
  }
}

/** The files of one `joinStep` made, the first `outs.length` of them, each written to its path. */
export function splitStep(file: string, outs: readonly string[]): void {
  const size = statSync(file).size
  const src = openSync(file, 'r')
  let lengths: number[]
  try {
    const count = Buffer.alloc(4)
    if (readSync(src, count, 0, 4, 0) !== 4) throw new Error(NOT_STEP)
    const n = count.readUInt32BE()
    if (n < outs.length || n > 16) throw new Error(NOT_STEP)
    const head = Buffer.alloc(8 * n)
    if (readSync(src, head, 0, head.length, 4) !== head.length) throw new Error(NOT_STEP)
    lengths = Array.from({ length: n }, (_, i) => Number(head.readBigUInt64BE(8 * i)))
    if (lengths.some((l) => !Number.isSafeInteger(l) || l < 0) || 4 + 8 * n + lengths.reduce((a, l) => a + l, 0) !== size) throw new Error(NOT_STEP)
  } finally {
    closeSync(src)
  }
  let at = 4 + 8 * lengths.length
  outs.forEach((to, i) => {
    const fd = openSync(to, 'w', 0o600)
    try {
      copyInto(fd, file, at, lengths[i])
    } finally {
      closeSync(fd)
    }
    at += lengths[i]
  })
}

/** A note the deck tool adds about an edit that went in ("note: edit N: …", a link it took out): never a failure. */
export const isNote = (w: string): boolean => w.startsWith('note: ')

/**
 * How far above the deck's highest id the host starts: PowerPoint gives a
 * slide the owner adds the next id, so an id the host gave a waiting add
 * must not be that one.
 */
export const HOST_ID_GAP = 10_000
const ID_MAX = 2_147_483_647

/**
 * Ids for the `add` ops that have none, each its own, returned with the ops.
 * Each is the gap above the highest id in the deck and every id given
 * before it, the waiting adds' included: once some are accepted into the
 * file, the id PowerPoint gives his next slide (the highest plus one) is
 * still none a waiting add holds.
 */
export function allocateIds(ops: SlideOp[], info: DeckInfo): SlideOp[] {
  let high = Math.max(255, ...info.slides.map((s) => s.id), ...ops.map((o) => (makesSlide(o) && o.id !== undefined ? o.id : 0)))
  return ops.map((o) => {
    if (!makesSlide(o) || o.id !== undefined) return o
    // A deck near the ceiling has no room for the gap: the next free id above everything.
    high = high + HOST_ID_GAP + 1 <= ID_MAX ? high + HOST_ID_GAP + 1 : high + 1
    return { ...o, id: high }
  })
}

/** An edit that makes a new slide, whose id the host gives: a slide from a layout, or a copy of one. */
const makesSlide = (op: SlideOp): op is Extract<SlideOp, { op: 'add' | 'duplicate' }> => op.op === 'add' || op.op === 'duplicate'

/** The slide number the stepper counts an edit of the deck itself under (its theme, a section renamed or taken away): no slide's. */
export const DECK_ITSELF = 0

/**
 * The slide each op belongs to, as the stepper groups them: the op's `slide`; the `id` of the slide an add or a
 * copy makes (0 before allocateIds gives it one); the slide a new section starts at; `DECK_ITSELF` for an edit of
 * the deck as a whole.
 */
export function slideOfOp(op: SlideOp): number {
  if (makesSlide(op)) return op.id ?? 0
  if (op.op === 'theme') return DECK_ITSELF
  if (op.op === 'section') return op.act === 'add' ? op.at : DECK_ITSELF
  return op.slide
}
