import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { z } from 'zod'
import { NewSlideSchema, SlideOpSchema, type NewDeck, type SlideOp } from '@shared/contract-work-slides'
import { agentPrincipal, workText, type CanvasItem, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { ToolCtx, WorkTool } from '../modules'
import { paneItem, sourcePath } from '../pdf/file'
import { allocateIds, isNote, slideOfOp, type DeckInfo } from './deck'
import { writeNewDeck } from './newDeck'
import { SlidesStore } from './store'
import { announce, applyTo, deckOf, OWN_FILE, renderPath, scratch, serial, withDeck, writeInto } from './view'

/**
 * The tools a Work thread reads and revises a deck with
 * (docs/agents/work-slides.md "The tools"). Every edit names slides by id.
 * An edit is a suggestion the owner steps through from the bar, unless the
 * item says the agent writes and the reason holds; either way it is
 * checked on a copy before anything is kept.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
const ANSWER_MAX = 60_000
const item = z.string().describe("The id of a deck in this thread's canvas (from `canvas_open` or `slides_new`).")

const deckItem = (ctx: ToolCtx, id: string): CanvasItem => paneItem(ctx, ctx.sessionId, id, 'slides')

/** The outline an agent reads: each slide's place, id, layout, title, shapes and notes. */
export function outlineOf(info: DeckInfo, head: string): string {
  const lines = [head, `Layouts: ${info.layouts.join(', ')}`]
  const starts = new Map(info.sections.filter((s) => s.slideIds.length).map((s) => [s.slideIds[0], s.name]))
  info.slides.forEach((s, i) => {
    if (starts.has(s.id)) lines.push('', `## Section: ${starts.get(s.id)}`)
    lines.push('', `Slide ${i + 1} · id ${s.id} · ${s.layout}${s.hidden ? ' · hidden' : ''}`)
    for (const sh of s.shapes) {
      const tag = `  [${sh.id}] ${JSON.stringify(sh.name)} ${sh.placeholder ? `${sh.placeholder} ` : ''}${sh.kind}`
      if (sh.cells) lines.push(`${tag}:`, ...sh.cells.map((r, n) => `    row ${n}: ${r.map((c) => JSON.stringify(c)).join(' | ')}`))
      else if (sh.chart) lines.push(`${tag}: categories ${JSON.stringify(sh.chart.categories)}`, ...sh.chart.series.map((x) => `    ${JSON.stringify(x.name)}: ${JSON.stringify(x.values)}`))
      else if (sh.text) lines.push(`${tag}: ${JSON.stringify(sh.text)}`)
      else if (sh.kind !== 'other') lines.push(tag)
    }
    if (s.notes) lines.push(`  notes: ${JSON.stringify(s.notes)}`)
  })
  return lines.join('\n')
}

/** Whether the owner typed the quote in this thread. Milestone 6 builds the check; until then it reads as no. */
function ownerSaid(ctx: ToolCtx, quote: string | undefined): boolean {
  if (!quote) return false
  try {
    return ctx.threads.ownerSaid(ctx.sessionId, quote)
  } catch {
    return false
  }
}

/** The sentences for edits that do not go in, numbered as the agent's own list. */
function ownWarnings(warnings: string[], before: number): string[] {
  return warnings.map((w) => {
    const m = /^edit (\d+): (.*)$/s.exec(w)
    if (!m) return w
    const n = Number(m[1]) - before
    return n > 0 ? `edit ${n}: ${m[2]}` : `an earlier suggestion no longer fits the file (${m[2]})`
  })
}

/** The notes on the agent's own edits (a link a remove takes out), numbered as its own list. */
function noteLines(notes: string[], before: number): string {
  const own = notes.flatMap((w) => {
    const m = /^note: edit (\d+): (.*)$/s.exec(w)
    return m && Number(m[1]) > before ? [`Note on edit ${Number(m[1]) - before}: ${m[2]}.`] : []
  })
  return own.length ? `\n${own.join('\n')}` : ''
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

export const slidesTools: WorkTool[] = [
  {
    name: 'slides_read',
    description:
      'Reads a deck in the canvas: each slide\'s number, id, layout and title, every shape\'s id, name and words (a table by rows from 0, a chart\'s data), and the notes. ' +
      'When your suggestions wait, it reads the deck with them in. Edit with `slides_edit`, naming slides by id and shapes by id.',
    input: z.object({ item }),
    readOnly: true,
    run: async (args, ctx) => {
      const a = args as { item: string }
      try {
        const it = deckItem(ctx, a.item)
        const deck = await serial(it.id, () => deckOf(ctx, it, ctx.signal))
        const info = deck.proposed?.info ?? deck.file.info
        const waiting = new Set(deck.pending.map((p) => p.slide)).size
        const head = `${plural(info.slides.length, 'slide')}${waiting ? `, with ${plural(waiting, 'change')} that wait for the person in` : ''}`
        const body = outlineOf(info, head)
        return workText(body.length > ANSWER_MAX ? `${body.slice(0, ANSWER_MAX)}\n\n(Cut here.)` : body)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'slides_image',
    description: 'A picture of one slide of a deck in the canvas, by its number (as `slides_read` gives it). When suggestions wait, it shows the deck with them in.',
    input: z.object({ item, slide: z.number().int().positive() }),
    readOnly: true,
    run: async (args, ctx) => {
      const a = args as { item: string; slide: number }
      try {
        const it = deckItem(ctx, a.item)
        const deck = await serial(it.id, () => deckOf(ctx, it, ctx.signal))
        const which = deck.proposed ? 'proposed' : 'file'
        const count = (deck.proposed ?? deck.file).info.slides.length
        if (a.slide > count) return fail(`The deck has ${plural(count, 'slide')}.`)
        const { path } = await renderPath(ctx, it, which, ctx.signal)
        const done = await ctx.convert({ from: 'pdf', to: 'png', input: path, options: { page: a.slide }, signal: ctx.signal })
        return { content: [{ type: 'image', data: readFileSync(done.output).toString('base64'), mimeType: 'image/png' }] }
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'slides_edit',
    description:
      'Revises a deck in the canvas, by slide id and shape id from `slides_read`: `text` (a shape\'s paragraphs; each keeps its look), `cell` (row and column from 0), `notes`, `chart` (new data, same look), `add` (a slide from one of the deck\'s layouts by name, after a slide id, 0 for first), `remove`, `move`. ' +
      'An `add` is given an id in the answer; give it `id` yourself to edit the new slide in the same list. ' +
      'Each revised slide is a suggestion the person steps through and accepts. When the deck says "Agent writes", the edit goes into the file at once if `because` is `own`, or `asked` with `quote`: the person\'s own words asking for it. ' +
      'The edits are checked first: if one cannot be made, nothing is kept and the answer says why.',
    input: z.object({
      item,
      ops: z.array(SlideOpSchema).min(1).max(200),
      because: z.enum(['asked', 'own']).describe('`asked`: the person asked for this (give `quote`). `own`: your own idea.'),
      quote: z.string().max(2000).optional().describe("The person's words in this thread that ask for the edit."),
      summary: z.string().max(200).optional().describe('One line on what the revision does, shown with it.')
    }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item: string; ops: SlideOp[]; because: 'asked' | 'own'; quote?: string; summary?: string }
      try {
        const it = deckItem(ctx, a.item)
        const store = new SlidesStore(ctx.db)
        const hosted = it.source.at === 'microsoft'
        const said = await serial(it.id, () => withDeck(ctx, it, ctx.signal, async (deck) => {
          // Read on the queue: the owner may have switched the mode while this waited behind a render.
          const writes = store.mode(it.id) === 'writes'
          // With suggestions waiting, what the agent reads is the deck with them in: an edit of that deck waits with them.
          const direct = writes && !deck.pending.length && (a.because === 'own' ? !hosted : ownerSaid(ctx, a.quote))
          const all = allocateIds([...deck.pending.map((p) => p.op), ...a.ops], deck.file.info)
          const fresh = all.slice(deck.pending.length)
          const added = fresh.flatMap((o) => (o.op === 'add' ? [o.id!] : []))
          if (direct) {
            const { notes, ...w } = await writeInto(ctx, it, deck.path, fresh, ctx.signal, deck.hash)
            const text = a.summary ?? `Edited ${plural(new Set(fresh.map(slideOfOp)).size, 'slide')}`
            store.setWritten(it.id, it.sessionId, { id: randomUUID(), text, at: Date.now(), ...w })
            return { added, direct, text: `Wrote ${plural(fresh.length, 'edit')} into the deck. The person can undo it from the bar.${noteLines(notes, 0)}` }
          }
          // Checked as the proposed deck will be drawn: every pending edit, then these.
          const out = await scratch(ctx, it, 'check')
          let warnings: string[]
          try {
            warnings = await applyTo(ctx, deck.copy, all, out, false, ctx.signal)
          } finally {
            rmSync(out, { force: true })
          }
          // Only the agent's own edits decide: an older suggestion the file has outgrown waits for the person to reject it.
          const own = ownWarnings(warnings.filter((w) => !isNote(w)), deck.pending.length).filter((w) => w.startsWith('edit '))
          if (own.length) throw new Error(`Nothing was kept:\n${own.join('\n')}`)
          store.add(it.id, it.sessionId, fresh.map((op) => ({ slide: slideOfOp(op), op })), agentPrincipal(ctx.host, ctx.sessionId))
          const why = !writes ? '' : deck.pending.length ? ' Suggestions already wait on this deck, so this waits with them.' : a.because === 'own' ? ' The deck is shared, so your own idea is a suggestion.' : ' The person\'s words were not found in this thread, so this is a suggestion.'
          return { added, direct: false, text: `Suggested ${plural(new Set(fresh.map(slideOfOp)).size, 'revised slide')}; the person steps through them from the bar.${why}${noteLines(warnings.filter(isNote), deck.pending.length)}` }
        }))
        await announce(ctx, it, ctx.signal)
        return { ...workText(`${said.text}${said.added.length ? `\nNew slide ${said.added.length === 1 ? 'id' : 'ids'}: ${said.added.join(', ')}` : ''}`), structuredContent: { added: said.added, direct: said.direct } }
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'slides_new',
    description:
      'Drafts a new deck from nothing and opens it in the canvas: each slide a layout (`title`, `bullets`, `table`, `chart`, `section`) with its words, a table as rows (the first the head), a native chart, notes. ' +
      '`theme` sets a dark or light ground and one accent colour (hex). `save`: an absolute path for a new .pptx file; without it the deck is the thread\'s own. Revise it after with `slides_edit`.',
    input: z.object({
      title: z.string().min(1).max(300),
      slides: z.array(NewSlideSchema).min(1).max(200),
      theme: z.object({ dark: z.boolean().default(false), accent: z.string().regex(/^[0-9a-fA-F]{6}$/).optional() }).optional(),
      save: z.string().max(4096).optional()
    }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as NewDeck & { save?: string }
      try {
        if (a.save !== undefined) {
          if (!isAbsolute(a.save) || !/\.pptx$/i.test(a.save)) return fail('`save` is an absolute path ending in .pptx.')
          if (existsSync(a.save)) return fail(`There is already a file at ${a.save}.`)
          if (!existsSync(dirname(a.save))) return fail(`There is no folder ${dirname(a.save)}.`)
        }
        const bytes = await writeNewDeck({ title: a.title, slides: a.slides, ...(a.theme ? { theme: a.theme } : {}) })
        let it: CanvasItem
        if (a.save) {
          writeFileSync(a.save, bytes, { flag: 'wx' })
          it = ctx.canvas.open(ctx.sessionId, 'slides', { at: 'file', host: ctx.host, path: a.save }, a.title)
        } else {
          it = ctx.canvas.open(ctx.sessionId, 'slides', { at: 'thread' }, a.title)
          writeFileSync(await sourcePath(ctx, it, OWN_FILE), bytes)
        }
        // The picture is made while the canvas opens; the answer does not wait for it.
        void announce(ctx, it).catch((err) => ctx.log(`slides: ${it.id} did not render: ${errorText(err)}`))
        return { ...workText(`Made ${plural(a.slides.length, 'slide')}${a.save ? ` at ${a.save}` : ''} and opened it in the canvas as item ${it.id}.`), structuredContent: { item: it.id, ...(a.save ? { path: a.save } : {}) } }
      } catch (err) {
        return fail(errorText(err))
      }
    }
  }
]
