import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { z } from 'zod'
import { NewSlideSchema, SlideOpSchema, type NewDeck, type SlideOp } from '@shared/contract-work-slides'
import { agentPrincipal, workText, type CanvasItem, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import { sharedOf } from '../files/policy'
import type { ToolCtx, WorkTool } from '../modules'
import { paneItem, sourcePath } from '../pdf/file'
import { allocateIds, isNote, slideOfOp, type DeckInfo, type ShapeInfo } from './deck'
import { writeNewDeck } from './newDeck'
import { attachFile } from './attach'
import { rowSession, SlidesStore } from './store'
import { announce, applyTo, deckDir, deckKey, deckOf, OWN_FILE, readOnlyWhy, renderPath, scratch, serial, sharedDeck, withDeck, writeInto, comesAs } from './view'

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

const lookOf = (r: NonNullable<ShapeInfo['paragraphs']>[number]['runs'][number]): string =>
  [r.font, r.size ? `${r.size} pt` : '', r.bold ? 'bold' : '', r.italic ? 'italic' : '', r.underline ? 'underlined' : '', r.color ? `#${r.color}` : ''].filter(Boolean).join(', ')

/**
 * One slide as an agent needs it to change a look or a place: each shape's box (left, top, width, height in EMU,
 * what a `geometry` edit takes), its turn, fill and outline, and its words run by run, each named `[paragraph, run]`
 * as a `runs` edit's `from` names it; then how the slide comes and builds.
 */
export function slideDetail(info: DeckInfo, slideId: number): string | null {
  const s = info.slides.find((x) => x.id === slideId)
  if (!s) return null
  const lines = [`Slide id ${s.id} · ${s.layout}${s.hidden ? ' · hidden' : ''} · the slide is ${info.width} by ${info.height} EMU (12,700 to a point)`]
  for (const sh of s.shapes) {
    const place = sh.own ? `box ${JSON.stringify(sh.own.box)}${sh.own.rot ? `, turned ${sh.own.rot}°` : ''}${sh.own.flipH ? ', flipped across' : ''}${sh.own.flipV ? ', flipped down' : ''}` : 'in a turned group: move it in PowerPoint'
    const paint = [sh.fill ? `fill ${sh.fill === 'none' ? 'none' : `#${sh.fill}`}` : '', sh.line ? `outline ${[sh.line.color === 'none' ? 'none' : sh.line.color ? `#${sh.line.color}` : '', sh.line.width !== undefined ? `${sh.line.width} pt` : '', sh.line.dash ?? ''].filter(Boolean).join(' ')}` : ''].filter(Boolean).join(', ')
    lines.push(`  [${sh.id}] ${JSON.stringify(sh.name)} ${sh.placeholder ? `${sh.placeholder} ` : ''}${sh.kind}${sh.shape && sh.kind === 'other' ? ` (${sh.shape})` : ''} · ${place}${paint ? ` · ${paint}` : ''}`)
    sh.paragraphs?.forEach((para, p) => {
      lines.push(`    paragraph ${p}: ${para.align}${para.list !== 'none' ? `, ${para.list} list` : ''}${para.level ? `, level ${para.level}` : ''}`)
      para.runs.forEach((run, r) => lines.push(`      [${p}, ${r}] ${JSON.stringify(run.text)}${lookOf(run) ? ` (${lookOf(run)})` : ''}`))
    })
    if (sh.cells) lines.push(...sh.cells.map((row, n) => `    row ${n}: ${row.map((c) => JSON.stringify(c)).join(' | ')}`))
  }
  lines.push(`  transition: ${comesAs(s.transition)}`)
  if (s.builds) lines.push(`  builds: ${s.builds.whole ? `shown whole in TempCode's show (${s.builds.whole})` : `${Math.max(0, s.builds.steps.length - 1)} presses${s.builds.order ? ` (order ${s.builds.order.join(', ')}${s.builds.fade ? `; fade ${s.builds.fade.join(', ')}` : ''})` : ''}`}`)
  if (info.theme) lines.push(`  theme: fonts ${info.theme.major} and ${info.theme.minor}; colours ${Object.entries(info.theme.colors).map(([slot, hex]) => `${slot} #${hex}`).join(', ')}`)
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

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth']
/** Words as letters and digits alone, one space between: a title is found whole, never inside another word. */
const wordsOf = (text: string): string => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `

/**
 * The slides, by id, a person's words name: by number ("slide 3", "slides 2 and 4", "slides 2-5"), by place ("the
 * third slide", "the 2nd slide", "the last slide"), or by a title of three letters or more said whole.
 */
export function slidesNamed(info: Pick<DeckInfo, 'slides'>, quote: string): Set<number> {
  const q = quote.toLowerCase()
  const count = info.slides.length
  const places = new Set<number>()
  for (const m of q.matchAll(/\bslides?\s+(?:no\.?\s*|number\s+)?(\d+(?:\s*(?:,|and|&|or|-|–|to|through)\s*\d+)*)/g)) {
    const parts = m[1].split(/\s*(,|and|&|or|-|–|to|through)\s*/)
    for (let i = 0; i < parts.length; i += 2) {
      const n = Number(parts[i])
      const from = i > 0 && /^(-|–|to|through)$/.test(parts[i - 1]) ? Number(parts[i - 2]) : n
      for (let k = Math.min(from, n); k <= Math.min(n, count); k++) places.add(k)
    }
  }
  for (const m of q.matchAll(new RegExp(`\\b(${ORDINALS.join('|')}|last|(\\d+)(?:st|nd|rd|th))\\s+slide\\b`, 'g'))) places.add(m[2] ? Number(m[2]) : m[1] === 'last' ? count : ORDINALS.indexOf(m[1]) + 1)
  const said = wordsOf(quote)
  return new Set(info.slides.flatMap((s, i) => (places.has(i + 1) || (wordsOf(s.title).trim().length >= 3 && said.includes(wordsOf(s.title))) ? [s.id] : [])))
}

/**
 * Whether the person's words name every slide a batch changes (`slidesNamed`): an add by the slide it goes after, a
 * copy by the slide it copies, and an edit of a slide the batch adds by that add. An edit of the deck as a whole (its
 * theme, a section taken away or renamed) is named by no slide.
 */
export function quoteNames(info: Pick<DeckInfo, 'slides'>, quote: string, ops: readonly SlideOp[]): boolean {
  const named = slidesNamed(info, quote)
  for (const op of ops) {
    const on = op.op === 'add' ? op.after : op.op === 'theme' ? null : op.op === 'section' ? (op.act === 'add' ? op.at : null) : op.slide
    if (on === null || !named.has(on)) return false
    if ((op.op === 'add' || op.op === 'duplicate') && op.id !== undefined) named.add(op.id)
  }
  return true
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
      'With `slide` (an id), reads that one slide in full: each shape\'s box in EMU, turn, fill and outline, its words run by run with each run\'s font, size and colour, and how the slide comes and builds. ' +
      'When your suggestions wait, it reads the deck with them in. Edit with `slides_edit`, naming slides by id and shapes by id.',
    input: z.object({ item, slide: z.number().int().positive().optional().describe('A slide id: read this slide alone, in full.') }),
    readOnly: true,
    run: async (args, ctx) => {
      const a = args as { item: string; slide?: number }
      try {
        const it = deckItem(ctx, a.item)
        const deck = await serial(ctx, it, () => deckOf(ctx, it, ctx.signal))
        const info = deck.proposed?.info ?? deck.file.info
        if (a.slide !== undefined) {
          const one = slideDetail(info, a.slide)
          return one === null ? fail(`The deck has no slide ${a.slide}. Its slide ids are ${info.slides.map((s) => s.id).join(', ')}.`) : workText(one.length > ANSWER_MAX ? `${one.slice(0, ANSWER_MAX)}\n\n(Cut here.)` : one)
        }
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
        const deck = await serial(ctx, it, () => deckOf(ctx, it, ctx.signal))
        const which = deck.proposed ? 'proposed' : 'file'
        const count = (deck.proposed ?? deck.file).info.slides.length
        if (a.slide > count) return fail(`The deck has ${plural(count, 'slide')}.`)
        const { path } = await renderPath(ctx, it, which, ctx.signal)
        const done = await ctx.convert({ from: 'pdf', to: 'png', input: path, options: { page: a.slide }, ...(sharedDeck(ctx, it) ? { shared: true } : {}), signal: ctx.signal })
        return { content: [{ type: 'image', data: readFileSync(done.output).toString('base64'), mimeType: 'image/png' }] }
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'slides_edit',
    description:
      'Revises a deck in the canvas, by slide id and shape id from `slides_read`: `text` (a shape\'s paragraphs; each keeps its look), `cell` (row and column from 0), `notes`, `chart` (new data, same look), `add` (a slide from one of the deck\'s layouts by name, after a slide id, 0 for first), `remove`, `move`, `runs` (a shape\'s paragraphs as runs: each `from` the run whose look it keeps, with a font, size, bold, italic, underline or colour set on top) and `format` (a look on a whole shape, or on a `range` of its characters); a shape\'s place and size in EMU (`geometry`), its `order`, `fill` and `line`; `insert` (a text box, a shape, a picture or video by its path on this host, a table, a chart) and `delete`; a table\'s rows and columns (`grid`); a slide hidden (`hide`), copied (`duplicate`) or given another `layout`; the deck\'s `section`s and `theme`; how a slide comes in a show (`transition`: a cut, a fade or a push, and the seconds after which it moves on) and what comes in on each press (`builds`: the shapes in `order`, those also named in `fade` by Fade, the rest by Appear). Read one slide in full with `slides_read` and `slide` before you change a look or a place. ' +
      'An `add` is given an id in the answer; give it `id` yourself to edit the new slide in the same list. ' +
      'Each revised slide is a suggestion the person steps through and accepts. When the deck says "Agent writes", the edit goes into the file at once if `because` is `own`, or `asked` with `quote`: the person\'s own words asking for it. ' +
      'The edits are checked first: if one cannot be made, nothing is kept and the answer says why. A Google deck, or one opened from a .ppt, .pps, .ppsx, .odp or .key file, is read only here: the person makes a copy to edit.',
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
      // Taking a slide's every animation out is the person's own confirmed press in the Animate tab, never an agent's.
      if (a.ops.some((op) => op.op === 'builds' && op.replace)) return fail('A builds edit cannot take a slide\'s other animations out: leave out `replace`; the person removes them in the Animate tab.')
      try {
        const it = deckItem(ctx, a.item)
        // An imported format or a Google deck is read only here: the person makes a copy to edit.
        const readOnly = readOnlyWhy(it)
        if (readOnly) return fail(readOnly)
        const store = new SlidesStore(ctx.db)
        // A picture or a video an edit adds is a file on this host the agent names by its path: copied beside the
        // deck now, so the edit still has it when it is accepted, and named from here on by the host's own token.
        const attach = a.ops.some((op) => op.op === 'insert' && op.file !== undefined) ? await deckDir(ctx, it, 'attach') : null
        if (attach) a.ops = a.ops.map((op) => (op.op === 'insert' && op.file !== undefined ? { ...op, file: attachFile(attach, op.file) } : op))
        // Others can open it (a deck in PowerPoint, a Teams or OneDrive library, a cloud folder): nothing an agent
        // thought of itself reaches the file, and so their screens, until the person accepts it.
        const shared = sharedDeck(ctx, it)
        const key = deckKey(it)
        const said = await serial(ctx, it, () => withDeck(ctx, it, ctx.signal, async (deck) => {
          // Read on the queue: the owner may have switched the mode while this waited behind a render.
          const writes = store.mode(it.id) === 'writes'
          const all = allocateIds([...deck.pending.map((p) => p.op), ...a.ops], deck.file.info)
          const fresh = all.slice(deck.pending.length)
          // His words write at once; on a deck others can open, only what they name (`quoteNames`), the rest waits for his press.
          const asked = a.because === 'asked' && ownerSaid(ctx, a.quote)
          const named = asked && (!shared || quoteNames(deck.file.info, a.quote!, fresh))
          // With suggestions waiting, what the agent reads is the deck with them in: an edit of that deck waits with them.
          const direct = writes && !deck.pending.length && (a.because === 'own' ? !shared : named)
          const added = fresh.flatMap((o) => (o.op === 'add' ? [o.id!] : []))
          if (direct) {
            const { notes, ...w } = await writeInto(ctx, it, deck.path, fresh, ctx.signal, deck.hash)
            const text = a.summary ?? `Edited ${plural(new Set(fresh.map(slideOfOp)).size, 'slide')}`
            store.setWritten(key, rowSession(key, it.sessionId), { id: randomUUID(), text, at: Date.now(), ...w, item: it.id })
            return { added, direct, text: `Wrote ${plural(fresh.length, 'edit')} into the deck. The person can undo it from the bar.${noteLines(notes, 0)}` }
          }
          // Checked as the proposed deck will be drawn: every pending edit, then these.
          const out = await scratch(ctx, it, 'check')
          let warnings: string[]
          try {
            warnings = await applyTo(ctx, it, deck.copy, all, out, false, ctx.signal)
          } finally {
            rmSync(out, { force: true })
          }
          // Only the agent's own edits decide: an older suggestion the file has outgrown waits for the person to reject it.
          const own = ownWarnings(warnings.filter((w) => !isNote(w)), deck.pending.length).filter((w) => w.startsWith('edit '))
          if (own.length) throw new Error(`Nothing was kept:\n${own.join('\n')}`)
          store.add(key, rowSession(key, it.sessionId), fresh.map((op) => ({ slide: slideOfOp(op), op })), agentPrincipal(ctx.host, ctx.sessionId))
          const why = !writes
            ? ''
            : deck.pending.length
              ? ' Suggestions already wait on this deck, so this waits with them.'
              : a.because === 'own'
                ? ' The deck is shared, so your own idea is a suggestion.'
                : asked
                  ? ' The deck is shared, and the person\'s words do not name every slide this changes, so this is a suggestion.'
                  : ' The person\'s words were not found in this thread, so this is a suggestion.'
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
          // A new file in a library shows on every teammate's screen the moment it syncs: that is the person's to put there.
          if (sharedOf(ctx, { at: 'file', host: ctx.host, path: a.save }))
            return fail(`${dirname(a.save)} is a place other people can open, and an agent does not put a new deck there. Leave out \`save\` to make it in this thread; the person can move it.`)
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
