import { readFileSync, rmSync } from 'node:fs'
import type { SlideOp } from '@shared/contract-work-slides'
import { fieldMatches, fillText } from '@shared/work/templates'
import type { WorkCtx } from '../modules'

/**
 * A deck's fields, filled by the slides pillar's own edit
 * (docs/agents/work-templates.md "The fill"). Nothing here writes a
 * `.pptx`: the deck is read through `pptx → deckinfo`, which names each
 * slide and shape as `slides_read` does, and written through `pptx →
 * pptxedit` with one `text` op for each shape that holds a field (a
 * table's cell: one `cell` op). The edit replaces a paragraph's runs, so a
 * filled paragraph takes its first run's look.
 */

/** A deck as `pptx → deckinfo` answers it: only what the fill reads. */
export interface DeckRead {
  slides: Array<{ id: number; shapes: Array<{ id: number; text: string; cells?: string[][] }> }>
}

/** What the slides pillar's read and edit carry at most: a shape past these is left as it is. */
const TEXT_MAX = 20_000
const PARAGRAPHS_MAX = 200
const OPS_MAX = 500

const holds = (text: string, values: ReadonlyMap<string, string>): boolean => text.includes('{{') && fieldMatches(text).some((m) => values.has(m.key))
/** A value in a deck stays in its paragraph: a line break in it would make a second one. */
const oneLine = (values: ReadonlyMap<string, string>): Map<string, string> => new Map([...values].map(([k, v]) => [k, v.replace(/\s*[\r\n\v]+\s*/g, ' ')]))

/** The edits that fill a deck's fields: none for a deck that holds no field with a value. */
export function deckOps(deck: DeckRead, values: ReadonlyMap<string, string>): SlideOp[] {
  const flat = oneLine(values)
  const ops: SlideOp[] = []
  for (const slide of deck.slides) {
    for (const shape of slide.shapes) {
      if (shape.cells) {
        shape.cells.forEach((row, r) =>
          row.forEach((cell, c) => {
            // A cell read at the cap may be cut short: writing it back would lose its end.
            if (cell.length < TEXT_MAX && holds(cell, flat)) ops.push({ op: 'cell', slide: slide.id, shape: shape.id, row: r, col: c, text: fillText(cell, flat) })
          })
        )
        continue
      }
      if (shape.text.length >= TEXT_MAX || !holds(shape.text, flat)) continue
      const paragraphs = fillText(shape.text, flat).split('\n')
      if (paragraphs.length <= PARAGRAPHS_MAX && paragraphs.every((p) => p.length <= TEXT_MAX)) ops.push({ op: 'text', slide: slide.id, shape: shape.id, paragraphs })
    }
  }
  return ops
}

/**
 * Fills the deck at `input` into `output` (a path that does not exist).
 * Answers false, and writes nothing, when the deck holds no field the
 * values reach: the caller's copy is then the file. An edit that did not
 * go in is left as it was and said in `warnings`; what is still a field
 * afterwards is the caller's to name (`scanOffice`).
 */
export async function fillDeck(ctx: Pick<WorkCtx, 'convert'>, input: string, output: string, values: ReadonlyMap<string, string>, signal?: AbortSignal): Promise<{ filled: boolean; warnings: string[] }> {
  const read = `${output}.read.json`
  let deck: DeckRead
  try {
    await ctx.convert({ from: 'pptx', to: 'deckinfo', input, output: read, ...(signal ? { signal } : {}) })
    deck = JSON.parse(readFileSync(read, 'utf8')) as DeckRead
  } finally {
    rmSync(read, { force: true })
  }
  const ops = deckOps(deck, values)
  if (!ops.length) return { filled: false, warnings: [] }
  const warnings: string[] = []
  let from = input
  const steps: string[] = []
  try {
    for (let at = 0; at < ops.length; at += OPS_MAX) {
      const last = at + OPS_MAX >= ops.length
      const to = last ? output : `${output}.step${steps.length}.pptx`
      if (!last) steps.push(to)
      const done = await ctx.convert({ from: 'pptx', to: 'pptxedit', input: from, output: to, options: { ops: ops.slice(at, at + OPS_MAX), strict: false }, ...(signal ? { signal } : {}) })
      warnings.push(...done.warnings.filter((w) => !w.startsWith('note: ')))
      from = to
    }
  } finally {
    for (const step of steps) rmSync(step, { force: true })
  }
  return { filled: true, warnings }
}
