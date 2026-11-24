import { readFileSync, rmSync } from 'node:fs'
import { SlideOpSchema, type SlideOp } from '@shared/contract-work-slides'
import { fieldMatches, fillText } from '@shared/work/templates'
import type { WorkCtx } from '../modules'
import { deckCellRuns, fillRuns, type DeckParagraph } from './ooxml'

/**
 * A deck's fields, filled by the slides pillar's own edit
 * (docs/agents/work-templates.md "The fill"). Nothing here writes a
 * `.pptx`: the deck is read through `pptx → deckinfo`, which names each
 * slide and shape as `slides_read` does, and written through `pptx →
 * pptxedit` with one `runs` op for each shape that holds a field: every
 * run of the shape is named by where it was read, so each keeps its own
 * look and link, and only the runs a field lay in change their words (as
 * Word's fill does, ooxml.ts `fillRuns`). A table's cell takes the same
 * op, by its row and column, from its runs read in the deck's own XML
 * (`deckCellRuns`); a cell whose runs cannot be read is left, its fields
 * named, since the plain cell edit would give each paragraph its first
 * run's look. A shape read without its runs takes a `text` op. Every edit
 * is held to the slides pillar's own schema before it is sent: one that
 * would be refused (a value that makes a run too long) is left, and the
 * rest of the batch goes in.
 */

/** A deck as `pptx → deckinfo` answers it: only what the fill reads. A line break is a run of its own, `\n`. */
export interface DeckRead {
  slides: Array<{ id: number; shapes: Array<{ id: number; text: string; cells?: string[][]; paragraphs?: DeckParagraph[]; cellRuns?: DeckParagraph[][][] }> }>
}

/** What the slides pillar's read and edit carry at most: a shape past these is left as it is. */
const TEXT_MAX = 20_000
const PARAGRAPHS_MAX = 200
const OPS_MAX = 500
/** The read stops at this many runs in a shape (deckScript.ts `RUN_CAP`): a shape read at it may be cut short. */
const RUNS_MAX = 400

type Paragraphs = NonNullable<DeckRead['slides'][number]['shapes'][number]['paragraphs']>

/**
 * A shape's paragraphs with its fields filled run by run, each run `from` the one it was read as; null when no
 * field there has a value, or when the read may be cut short and writing it back would lose its end.
 */
function filledRuns(paragraphs: Paragraphs, values: ReadonlyMap<string, string>): Extract<SlideOp, { op: 'runs' }>['paragraphs'] | null {
  const runs = paragraphs.reduce((n, p) => n + p.runs.length, 0)
  if (runs >= RUNS_MAX || paragraphs.length > PARAGRAPHS_MAX || paragraphs.some((p) => p.runs.some((r) => r.text.length >= TEXT_MAX))) return null
  let changed = false
  const out = paragraphs.map((p, i) => {
    const texts = p.runs.map((r) => r.text)
    // A line break is a gap he sees: no field is filled across one.
    let at = 0
    for (let j = 0; j <= texts.length; j++) {
      if (j < texts.length && texts[j] !== '\n') continue
      const filled = fillRuns(texts.slice(at, j), values)
      if (filled) {
        texts.splice(at, j - at, ...filled.next)
        changed = true
      }
      at = j + 1
    }
    return { from: i, runs: texts.map((text, j) => ({ text, from: [i, j] as [number, number] })) }
  })
  return changed ? out : null
}

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
            // A cell read at the cap may be cut short: writing it back would lose its end. One read without its runs is left.
            if (cell.length >= TEXT_MAX || !holds(cell, flat)) return
            const runs = shape.cellRuns?.[r]?.[c]
            const paragraphs = runs ? filledRuns(runs, flat) : null
            if (paragraphs) ops.push({ op: 'runs', slide: slide.id, shape: shape.id, row: r, col: c, paragraphs })
          })
        )
        continue
      }
      if (shape.text.length >= TEXT_MAX || !holds(shape.text, flat)) continue
      if (shape.paragraphs) {
        const paragraphs = filledRuns(shape.paragraphs, flat)
        if (paragraphs) ops.push({ op: 'runs', slide: slide.id, shape: shape.id, paragraphs })
        continue
      }
      const paragraphs = fillText(shape.text, flat).split('\n')
      if (paragraphs.length <= PARAGRAPHS_MAX && paragraphs.every((p) => p.length <= TEXT_MAX)) ops.push({ op: 'text', slide: slide.id, shape: shape.id, paragraphs })
    }
  }
  // The edit refuses its whole batch for one op past its schema: such an op is left, and its fields stay named.
  return ops.filter((op) => SlideOpSchema.safeParse(op).success)
}

/** A deck file's table cells, run by run; none when the file cannot be read, so every cell is left. */
function cellRunsOf(path: string): ReturnType<typeof deckCellRuns> {
  try {
    return deckCellRuns(new Uint8Array(readFileSync(path)))
  } catch {
    return new Map()
  }
}

/**
 * Fills the deck at `input` into `output` (a path that does not exist).
 * Answers false, and writes nothing, when the deck holds no field the
 * values reach: the caller's copy is then the file. An edit that did not
 * go in is left as it was and said in `warnings`; what is still a field
 * afterwards is the caller's to name (`scanOffice`).
 */
export async function fillDeck(ctx: Pick<WorkCtx, 'convert'>, input: string, output: string, values: ReadonlyMap<string, string>, signal?: AbortSignal, shared = false): Promise<{ filled: boolean; warnings: string[] }> {
  // The input is a scratch copy, which says nothing of where its deck came from: a shared source's copy is said shared
  // on every job, so the runner never carries it to another host (formats/jobs.ts `sharedJob`).
  const where = shared ? { shared: true } : {}
  const read = `${output}.read.json`
  let deck: DeckRead
  try {
    await ctx.convert({ from: 'pptx', to: 'deckinfo', input, output: read, ...where, ...(signal ? { signal } : {}) })
    deck = JSON.parse(readFileSync(read, 'utf8')) as DeckRead
  } finally {
    rmSync(read, { force: true })
  }
  // A table cell's runs, which the read does not give, from the deck's own XML.
  const cells = cellRunsOf(input)
  for (const slide of deck.slides)
    for (const shape of slide.shapes) {
      const runs = shape.cells ? cells.get(`${slide.id}/${shape.id}`) : undefined
      if (runs) shape.cellRuns = runs
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
      const done = await ctx.convert({ from: 'pptx', to: 'pptxedit', input: from, output: to, options: { ops: ops.slice(at, at + OPS_MAX), strict: false }, ...where, ...(signal ? { signal } : {}) })
      warnings.push(...done.warnings.filter((w) => !w.startsWith('note: ')))
      from = to
    }
  } finally {
    for (const step of steps) rmSync(step, { force: true })
  }
  return { filled: true, warnings }
}
