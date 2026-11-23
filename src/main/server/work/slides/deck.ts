import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { SlideOpSchema, type DeckParagraph, type DeckPoint, type DeckShapeKind, type DeckTextFrame, type DeckView, type SlideOp, type SlideTransition } from '@shared/contract-work-slides'
import type { Converter, ConvertRun } from '../formats/jobs'
import { tailOf } from '../formats/tools'
import { DECK_PY } from './deckScript'

/**
 * Reading and editing a .pptx with python-pptx (docs/agents/work-slides.md).
 * Two converters: `pptx → deckinfo` writes `DeckInfo` as JSON, `pptx →
 * pptxedit` applies `options.ops` and writes the edited deck. The Python is
 * deckScript.ts; after python-pptx saves, it writes the zip itself so every
 * part an edit did not change keeps the input's bytes.
 */

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
  /** every paragraph joined by \n; '' for a shape with no text */
  text: string
  /** a table's cells, row by row */
  cells?: string[][]
  chart?: { categories: string[]; series: Array<{ name: string; values: Array<number | null> }> }
}

const TIMEOUT_MS = 5 * 60_000
// Options may come from another host's key: anything but a list of edits is refused.
const EditOptions = z.object({ ops: z.array(SlideOpSchema).min(1).max(500), strict: z.boolean().optional() })

async function runDeck(run: ConvertRun, args: string[]): Promise<void> {
  const py = run.tools.bin('python-pptx')
  if (!py) throw new Error('python-pptx is not installed here')
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
  {
    from: 'pptx',
    to: 'pptxedit',
    needs: 'python-pptx',
    async run(job, run) {
      const parsed = EditOptions.safeParse(job.options ?? {})
      if (!parsed.success) throw new Error('the edits are not a list of slide edits')
      const ops = join(run.tmp, 'ops.json')
      const out = join(run.tmp, 'out.pptx')
      const said = join(run.tmp, 'warnings.json')
      writeFileSync(ops, JSON.stringify(parsed.data.ops))
      await runDeck(run, ['apply', job.input, ops, out, said])
      const warnings = JSON.parse(readFileSync(said, 'utf8')) as string[]
      // Strict: nothing is kept unless every edit went in (the output stays in tmp, which the runner removes).
      if (parsed.data.strict && warnings.some((w) => !isNote(w))) throw new Error(warnings.filter((w) => !isNote(w)).join(' '))
      copyFileSync(out, job.output)
      return { warnings }
    }
  }
]

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
  let high = Math.max(255, ...info.slides.map((s) => s.id), ...ops.map((o) => (o.op === 'add' && o.id !== undefined ? o.id : 0)))
  return ops.map((o) => {
    if (o.op !== 'add' || o.id !== undefined) return o
    // A deck near the ceiling has no room for the gap: the next free id above everything.
    high = high + HOST_ID_GAP + 1 <= ID_MAX ? high + HOST_ID_GAP + 1 : high + 1
    return { ...o, id: high }
  })
}

/** The slide each op belongs to, as the stepper groups them: the op's `slide`, or an add's `id` (0 before allocateIds gives it one). */
export function slideOfOp(op: SlideOp): number {
  return op.op === 'add' ? (op.id ?? 0) : op.slide
}
