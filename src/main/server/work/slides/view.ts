import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Bbox } from '@shared/contract-work-pdf'
import type { DeckShape, DeckSlide, DeckView, ShowDeck, SlideChange, SlideOp } from '@shared/contract-work-slides'
import type { CanvasItem } from '@shared/work'
import { errorText } from '@shared/work/ids'
import { sharedOf } from '../files/policy'
import { NoConverterError } from '../formats/jobs'
import type { WorkCtx } from '../modules'
import { copyWhole, hasMagic, itemDir, ItemFileError, pushFor, sourcePath } from '../pdf/file'
import { isNote, type DeckInfo, type ShapeInfo, type SlideInfo } from './deck'
import { DECK_PY } from './deckScript'
import { SlidesStore, type PendingOp } from './store'

/**
 * A deck item as the host serves it (docs/agents/work-slides.md): the
 * file's outline and picture, the proposed deck with every pending edit
 * in, the strip the canvas draws from the two, and the writes into the
 * file. The methods (index.ts) and the tools (tools.ts) both go through
 * here, and every step that reads or writes an item's files runs on that
 * item's one promise chain.
 */

export type Ctx = Pick<WorkCtx, 'db' | 'host' | 'push' | 'convert' | 'dataDir' | 'canvas'>

/** The file's name inside the folder of a deck a thread made. */
export const OWN_FILE = 'deck.pptx'
/** Renders kept per item, newest first; history copies kept. */
const RENDERS_KEPT = 4
const HISTORY_KEPT = 10
/** LibreOffice's PDF export with hidden slides in, so page n is slide n. */
export const RENDER_FILTER = 'impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}'

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
/** Part of every render key: a new deck script or filter makes the kept outlines and pictures again. */
let renderV: string | null = null
const RENDER_V = (): string => (renderV ??= createHash('sha256').update(DECK_PY + RENDER_FILTER).digest('hex').slice(0, 16))
export const hashFile = (path: string): string => sha(readFileSync(path))

// ── one chain per item ───────────────────────────────────────────────

const chains = new Map<string, Promise<unknown>>()
/** Runs `fn` after every earlier step for the item: two opens never render twice, and a write never races a render. */
export function serial<T>(itemId: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(itemId) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => {})
  chains.set(itemId, tail)
  void tail.then(() => {
    if (chains.get(itemId) === tail) chains.delete(itemId)
  })
  return run
}

// ── the file ─────────────────────────────────────────────────────────

/** The deck's path on this host. A deck that lives in PowerPoint on the web, or in Google, is refused with a sentence (sourcePath). */
export async function deckPath(ctx: Ctx, item: CanvasItem): Promise<string> {
  const path = await sourcePath(ctx, item, OWN_FILE)
  if (!existsSync(path)) throw new ItemFileError(`${nameOf(item, path)} is not where it was.`, 'missing')
  if (!hasMagic(path, 'zip')) throw new ItemFileError(`${nameOf(item, path)} is not a PowerPoint deck.`)
  return path
}

export const nameOf = (item: CanvasItem, path: string | null): string => {
  const source = item.source
  if (source.at === 'microsoft') return source.name
  if (source.at === 'mail') return source.name
  if (path && source.at === 'file') return basename(path)
  return /\.pptx$/i.test(item.title) ? item.title : `${item.title}.pptx`
}

/**
 * Whether anyone else can open the deck (work/files/policy.ts `sharedOf`): a deck that lives in PowerPoint, in a
 * Teams or OneDrive library or any cloud folder, on another host. For such a deck an agent's own idea is always
 * a suggestion kept on this host, and no copy of it is carried to another host to be read, drawn or edited.
 */
export const deckShared = (ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, item: CanvasItem): boolean => item.source.at === 'microsoft' || sharedOf(ctx, item.source)
/** The mark a conversion of a shared deck's copy carries: the copy lies under app data, so the runner cannot tell by its path. */
const sharedJob = (ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, item: CanvasItem): { shared?: true } => (deckShared(ctx, item) ? { shared: true } : {})

// ── renders ──────────────────────────────────────────────────────────

/** One version of a deck as the host keeps it: its outline, and its PDF when LibreOffice could make one. */
export interface Built {
  key: string
  info: DeckInfo
  pdf: string | null
  renderError?: string
}

function touch(path: string): void {
  const now = new Date()
  try {
    utimesSync(path, now, now)
  } catch {
    /* gone: built again on the next ask */
  }
}

/** Keeps the newest four versions in `render/`, by key. */
function prune(dir: string): void {
  const byKey = new Map<string, number>()
  for (const f of readdirSync(dir)) {
    const key = f.split('.')[0]
    try {
      byKey.set(key, Math.max(byKey.get(key) ?? 0, statSync(join(dir, f)).mtimeMs))
    } catch {
      /* gone */
    }
  }
  const old = [...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(RENDERS_KEPT).map(([k]) => k)
  for (const f of readdirSync(dir)) if (old.includes(f.split('.')[0])) rmSync(join(dir, f), { force: true })
}

const renderErrorOf = (err: unknown): string =>
  err instanceof NoConverterError ? 'There is no picture of the slides: LibreOffice is not installed on this host or on one it reaches.' : `There is no picture of the slides: ${errorText(err)}`

/** The outline and the PDF of the deck at `input`, kept under `key` (made once, then read). */
async function build(ctx: Ctx, item: CanvasItem, key: string, input: string, signal?: AbortSignal): Promise<Built> {
  const dir = await itemDir(ctx, item, 'render')
  const json = join(dir, `${key}.json`)
  const pdf = join(dir, `${key}.pdf`)
  let info: DeckInfo | null = null
  try {
    info = existsSync(json) ? (JSON.parse(readFileSync(json, 'utf8')) as DeckInfo) : null
  } catch {
    info = null // a file cut short: made again
  }
  if (!info) {
    // Written beside its place, then moved onto it: a job cut short never leaves half an outline under the key.
    const tmp = `${json}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await ctx.convert({ from: 'pptx', to: 'deckinfo', input, output: tmp, ...sharedJob(ctx, item), ...(signal ? { signal } : {}) })
      info = JSON.parse(readFileSync(tmp, 'utf8')) as DeckInfo
      renameSync(tmp, json)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw new ItemFileError(err instanceof NoConverterError ? 'This deck cannot be read: python-pptx is not installed on this host or on one it reaches.' : `This deck cannot be read: ${errorText(err)}`)
    }
  }
  touch(json)
  let renderError: string | undefined
  if (!existsSync(pdf)) {
    try {
      const tmp = `${pdf}.${randomUUID().slice(0, 8)}.tmp`
      try {
        await ctx.convert({ from: 'pptx', to: 'pdf', input, output: tmp, options: { filter: RENDER_FILTER }, ...sharedJob(ctx, item), ...(signal ? { signal } : {}) })
        renameSync(tmp, pdf)
      } finally {
        rmSync(tmp, { force: true })
      }
    } catch (err) {
      if (signal?.aborted) throw err
      renderError = renderErrorOf(err)
    }
  }
  if (existsSync(pdf)) touch(pdf)
  prune(dir)
  return { key, info, pdf: existsSync(pdf) ? pdf : null, ...(renderError ? { renderError } : {}) }
}

/** Applies edits to a copy of the deck: under `strict` any edit that does not go in fails the whole list with its sentences. */
export async function applyTo(ctx: Ctx, item: CanvasItem, input: string, ops: SlideOp[], output: string, strict: boolean, signal?: AbortSignal): Promise<string[]> {
  const done = await ctx.convert({ from: 'pptx', to: 'pptxedit', input, output, options: { ops, strict }, ...sharedJob(ctx, item), ...(signal ? { signal } : {}) })
  return done.warnings
}

/** A scratch file in the item's `tmp/` folder (kept out of `render/`, whose files are counted by key). */
export async function scratch(ctx: Ctx, item: CanvasItem, what: string): Promise<string> {
  return join(await itemDir(ctx, item, 'tmp'), `${what}-${randomUUID()}.pptx`)
}

const proposedKey = (fileHash: string, pending: readonly PendingOp[]): string => sha(RENDER_V() + fileHash + JSON.stringify(pending.map((p) => p.op)))

/** The deck with every pending edit in; null when nothing waits. */
async function proposedBuilt(ctx: Ctx, item: CanvasItem, input: string, fileHash: string, pending: readonly PendingOp[], signal?: AbortSignal): Promise<Built | null> {
  if (!pending.length) return null
  const key = proposedKey(fileHash, pending)
  const dir = await itemDir(ctx, item, 'render')
  const copy = join(dir, `${key}.pptx`)
  // The file may have moved on since the edits were checked: what no longer goes in is left out of the picture.
  if (!existsSync(copy)) {
    const tmp = `${copy}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await applyTo(ctx, item, input, pending.map((p) => p.op), tmp, false, signal)
      renameSync(tmp, copy)
    } finally {
      rmSync(tmp, { force: true })
    }
  }
  touch(copy)
  return build(ctx, item, key, copy, signal)
}

export interface Deck {
  path: string
  hash: string
  file: Built
  proposed: Built | null
  pending: PendingOp[]
}

/** The file and the proposed deck, built (or read from the cache). Call on the item's chain. */
export async function deckOf(ctx: Ctx, item: CanvasItem, signal?: AbortSignal): Promise<Deck> {
  return withDeck(ctx, item, signal, async (deck) => deck)
}

/**
 * Builds the deck from a copy of the file taken first, and runs `fn` while
 * that copy (`deck.copy`, whose sha256 is `deck.hash`) still exists: a save
 * while the tools run never lands under the old key, and a check runs on
 * the bytes that were hashed. Call on the item's chain.
 */
export async function withDeck<T>(ctx: Ctx, item: CanvasItem, signal: AbortSignal | undefined, fn: (deck: Deck & { copy: string }) => Promise<T>): Promise<T> {
  const path = await deckPath(ctx, item)
  const copy = await scratch(ctx, item, 'live')
  copyWhole(path, copy)
  try {
    const hash = hashFile(copy)
    const file = await build(ctx, item, sha(RENDER_V() + hash), copy, signal)
    const pending = new SlidesStore(ctx.db).pending(item.id)
    return await fn({ path, hash, file, proposed: await proposedBuilt(ctx, item, copy, hash, pending, signal), pending, copy })
  } finally {
    rmSync(copy, { force: true })
  }
}

// ── the strip ────────────────────────────────────────────────────────

/** A change is a slide's pending edits: the stepper counts one per slide. */
export const changeIdOf = (slideId: number): string => `slide-${slideId}`

const bboxOf = (s: ShapeInfo): Bbox | null => s.bbox
const shapeText = (s: ShapeInfo): string => (s.cells ? s.cells.map((r) => r.join('\t')).join('\n') : s.chart ? chartText(s.chart) : s.text)
const chartText = (c: NonNullable<ShapeInfo['chart']>): string =>
  c.series.map((s) => `${s.name}: ${c.categories.map((cat, i) => `${cat} ${s.values[i] ?? '–'}`).join(', ')}`).join('\n')
const deckShape = (s: ShapeInfo): DeckShape => ({ id: s.id, name: s.name, bbox: bboxOf(s), text: shapeText(s) })

/** A part of a slide in the person's words, by what it is ("Title", "Text"), never PowerPoint's shape name ("Title 1"). */
const ROLE_WORDS: Record<string, string> = {
  title: 'Title',
  subtitle: 'Subtitle',
  body: 'Text',
  date: 'Date',
  number: 'Slide number',
  footer: 'Footer',
  header: 'Header',
  picture: 'Picture',
  chart: 'Chart',
  table: 'Table',
  diagram: 'Diagram',
  media: 'Media'
}
const KIND_WORDS: Record<ShapeInfo['kind'], string> = { text: 'Text', table: 'Table', chart: 'Chart', picture: 'Picture', other: 'Shape' }
const roleOf = (s: ShapeInfo): string => (s.placeholder ? (ROLE_WORDS[s.placeholder] ?? KIND_WORDS[s.kind]) : KIND_WORDS[s.kind])

/** Each shape's label on its slide: its role, numbered in the slide's order only where the slide has more than one of it ("Text 1", "Text 2"). */
export function partNames(shapes: readonly ShapeInfo[]): Map<number, string> {
  const roles = shapes.map(roleOf)
  const counts = new Map<string, number>()
  for (const role of roles) counts.set(role, (counts.get(role) ?? 0) + 1)
  const seen = new Map<string, number>()
  return new Map(
    shapes.map((s, i) => {
      const role = roles[i]
      if ((counts.get(role) ?? 0) < 2) return [s.id, role]
      const n = (seen.get(role) ?? 0) + 1
      seen.set(role, n)
      return [s.id, `${role} ${n}`]
    })
  )
}

/** What the words were and are on one slide, shape by shape, cell by cell, then the notes. */
export function editsOf(before: SlideInfo | undefined, after: SlideInfo | undefined): { edits: SlideChange['edits']; boxes: Bbox[] } {
  const edits: SlideChange['edits'] = []
  const boxes: Bbox[] = []
  const was = new Map((before?.shapes ?? []).map((s) => [s.id, s]))
  const names = partNames(after?.shapes ?? [])
  for (const s of after?.shapes ?? []) {
    const old = was.get(s.id)
    const where = names.get(s.id) ?? roleOf(s)
    let moved = false
    if (s.cells) {
      s.cells.forEach((row, r) =>
        row.forEach((cell, c) => {
          const prev = old?.cells?.[r]?.[c] ?? ''
          if (prev !== cell) {
            edits.push({ where: `${where}, row ${r + 1}, column ${c + 1}`, before: prev, after: cell })
            moved = true
          }
        })
      )
    } else if (s.chart || old?.chart) {
      const [a, b] = [old?.chart ? chartText(old.chart) : '', s.chart ? chartText(s.chart) : '']
      if (a !== b) {
        edits.push({ where, before: a, after: b })
        moved = true
      }
    } else if ((old?.text ?? '') !== s.text) {
      edits.push({ where, before: old?.text ?? '', after: s.text })
      moved = true
    }
    if (moved && s.bbox) boxes.push(s.bbox)
  }
  if ((before?.notes ?? '') !== (after?.notes ?? '')) edits.push({ where: 'Notes', before: before?.notes ?? '', after: after?.notes ?? '' })
  return { edits, boxes }
}

/** The pending changes, one per slide, in the order their first edit was made. */
export function changesOf(file: DeckInfo, proposed: DeckInfo | null, pending: readonly PendingOp[]): SlideChange[] {
  const groups = new Map<number, PendingOp[]>()
  for (const p of pending) groups.set(p.slide, [...(groups.get(p.slide) ?? []), p])
  const inFile = new Map(file.slides.map((s) => [s.id, s]))
  const inProposed = new Map((proposed?.slides ?? []).map((s) => [s.id, s]))
  return [...groups.entries()].map(([slideId, ops]) => {
    const kinds = new Set(ops.map((o) => o.op.op))
    const kind: SlideChange['kind'] = kinds.has('add') ? 'added' : kinds.has('remove') ? 'removed' : ['text', 'cell', 'notes', 'chart'].some((k) => kinds.has(k as SlideOp['op'])) ? 'changed' : 'moved'
    const before = inFile.get(slideId)
    const after = inProposed.get(slideId)
    const label = (after ?? before)?.title || `Slide ${slideId}`
    return { id: changeIdOf(slideId), kind, slideId, label, edits: kind === 'removed' || kind === 'moved' ? [] : editsOf(before, after).edits, by: ops[0].by }
  })
}

function sectionStarts(info: DeckInfo): Map<number, string> {
  return new Map(info.sections.filter((s) => s.slideIds.length).map((s) => [s.slideIds[0], s.name]))
}

const slideOf = (s: SlideInfo, o: Pick<DeckSlide, 'key' | 'number' | 'from' | 'page' | 'change' | 'tint' | 'changed'>, section?: string): DeckSlide => ({
  ...o,
  id: s.id,
  title: s.title,
  notes: s.notes,
  hidden: s.hidden,
  shapes: s.shapes.map(deckShape),
  ...(section ? { section } : {})
})

/**
 * The strip in the proposed order. A removed slide, and the place a moved
 * slide leaves, are ghosts from the file's render, each after the nearest
 * earlier slide of the file that is in both decks and stays where it was.
 */
export function stripOf(file: DeckInfo, proposed: DeckInfo | null, changes: readonly SlideChange[], moved: ReadonlySet<number> = new Set()): DeckSlide[] {
  if (!proposed) {
    const starts = sectionStarts(file)
    return file.slides.map((s, i) => slideOf(s, { key: String(s.id), number: i + 1, from: 'file', page: i + 1, change: null, tint: null, changed: [] }, starts.get(s.id)))
  }
  const byId = new Map(changes.map((c) => [c.slideId, c]))
  const inFile = new Map(file.slides.map((s) => [s.id, s]))
  const starts = sectionStarts(proposed)
  const out: DeckSlide[] = proposed.slides.map((s, i) => {
    const c = byId.get(s.id)
    const changed = c && c.kind !== 'moved' ? editsOf(inFile.get(s.id), s).boxes : []
    return slideOf(s, { key: String(s.id), number: i + 1, from: 'proposed', page: i + 1, change: c?.id ?? null, tint: c ? 'add' : null, changed }, starts.get(s.id))
  })
  const kept = new Set(proposed.slides.map((s) => s.id))
  const stays = (id: number): boolean => kept.has(id) && !moved.has(id)
  file.slides.forEach((s, i) => {
    const c = byId.get(s.id)
    if (stays(s.id)) return
    const ghost = slideOf(s, { key: `ghost:${s.id}`, number: null, from: 'file', page: i + 1, change: c?.id ?? null, tint: 'del', changed: [] })
    let anchor = -1
    for (let j = i - 1; j >= 0; j--) {
      if (stays(file.slides[j].id)) {
        anchor = out.findIndex((d) => d.key === String(file.slides[j].id))
        break
      }
    }
    // After the anchor and the ghosts already put after it, so ghosts keep the file's order.
    let at = anchor + 1
    while (at < out.length && out[at].key.startsWith('ghost:')) at++
    out.splice(at, 0, ghost)
  })
  return out
}

const renderOf = (b: Built | null): DeckView['renders']['file'] => (b?.pdf ? { rev: b.key.slice(0, 16), size: statSync(b.pdf).size, pages: b.info.slides.length } : null)

export function viewFrom(ctx: Pick<WorkCtx, 'db'>, item: CanvasItem, deck: Deck): DeckView {
  const store = new SlidesStore(ctx.db)
  const changes = changesOf(deck.file.info, deck.proposed?.info ?? null, deck.pending)
  const written = store.written(item.id)
  const renderError = deck.file.renderError ?? deck.proposed?.renderError
  const changesRev = proposedRev(deck)
  return {
    itemId: item.id,
    sessionId: item.sessionId,
    name: nameOf(item, deck.path),
    rev: deck.hash.slice(0, 16),
    mode: store.mode(item.id),
    hosted: item.source.at === 'microsoft',
    slides: stripOf(deck.file.info, deck.proposed?.info ?? null, changes, new Set(deck.pending.flatMap((p) => (p.op.op === 'move' ? [p.op.slide] : [])))),
    changes,
    renders: { file: renderOf(deck.file), proposed: renderOf(deck.proposed) },
    // The changes' own revision, with a picture of them or without (LibreOffice out of reach): a review is checked on it.
    ...(changesRev ? { changesRev } : {}),
    ...(written ? { written: { id: written.id, text: written.text, at: written.at } } : {}),
    ...(renderError ? { renderError } : {})
  }
}

export async function viewOf(ctx: Ctx, item: CanvasItem, signal?: AbortSignal): Promise<DeckView> {
  return serial(item.id, async () => viewFrom(ctx, item, await deckOf(ctx, item, signal)))
}

/** What a show draws from: the file as it is, in its own order, whatever suggestions wait. */
export async function showOf(ctx: Ctx, item: CanvasItem, signal?: AbortSignal): Promise<ShowDeck> {
  return serial(item.id, async () => {
    const { path, hash, file } = await deckOf(ctx, item, signal)
    return {
      itemId: item.id,
      name: nameOf(item, path),
      rev: hash.slice(0, 16),
      render: renderOf(file),
      slides: file.info.slides.map((s, i) => ({ id: s.id, number: i + 1, page: i + 1, title: s.title, notes: s.notes, hidden: s.hidden })),
      ...(file.renderError ? { renderError: file.renderError } : {})
    }
  })
}

/** Tells every client what the deck is now, and answers it. */
export async function announce(ctx: Ctx, item: CanvasItem, signal?: AbortSignal): Promise<DeckView> {
  const view = await viewOf(ctx, item, signal)
  // A deck outside the remote roots: only a socket holding admin (this host's own window holds every capability)
  // hears of it. The push API narrows by capability alone, so an admin key still does; see work-slides.md.
  ctx.push({ push: 'work.slides', sessionId: item.sessionId, view }, pushFor(item))
  return view
}

/** The render a read is served from: built if it is not yet. */
export async function renderPath(ctx: Ctx, item: CanvasItem, which: 'file' | 'proposed', signal?: AbortSignal): Promise<{ path: string; rev: string }> {
  const deck = await serial(item.id, () => deckOf(ctx, item, signal))
  const b = which === 'file' ? deck.file : deck.proposed
  if (!b) throw new ItemFileError('No changes wait on this deck.', 'missing')
  if (!b.pdf) throw new ItemFileError(b.renderError ?? 'There is no picture of the slides.', 'not-here')
  return { path: b.pdf, rev: b.key.slice(0, 16) }
}

// ── writes ───────────────────────────────────────────────────────────

/** Keeps the file as it is before a write, as `history/<time>.pptx` (the newest ten); answers its name. */
async function keepHistory(ctx: Ctx, item: CanvasItem, path: string): Promise<string> {
  const dir = await itemDir(ctx, item, 'history')
  const name = `${Date.now().toString().padStart(15, '0')}-${randomUUID().slice(0, 4)}.pptx`
  copyWhole(path, join(dir, name))
  const all = readdirSync(dir).filter((f) => f.endsWith('.pptx')).sort()
  for (const old of all.slice(0, Math.max(0, all.length - HISTORY_KEPT))) rmSync(join(dir, old), { force: true })
  return name
}

/** Writes edits into the file: checked under strict on a copy first, the file before kept in history. Call on the item's chain. */
export async function writeInto(ctx: Ctx, item: CanvasItem, path: string, ops: SlideOp[], signal?: AbortSignal, expect?: string): Promise<{ before: string; after: string; notes: string[] }> {
  const out = await scratch(ctx, item, 'write')
  const base = await scratch(ctx, item, 'base')
  try {
    copyWhole(path, base)
    const was = hashFile(base)
    if (expect && was !== expect) throw new Error('The deck changed while this was being made. Nothing was written; look at it again.')
    const notes = (await applyTo(ctx, item, base, ops, out, true, signal)).filter(isNote)
    // The copy from before is kept first: a write that fails after it leaves the file as it was and no stray copy.
    const before = await keepHistory(ctx, item, base)
    try {
      replaceKeeping(path, out, was)
    } catch (err) {
      rmSync(join(await itemDir(ctx, item, 'history'), before), { force: true })
      throw err
    }
    return { before, after: hashFile(path), notes }
  } finally {
    rmSync(out, { force: true })
    rmSync(base, { force: true })
  }
}

/**
 * Puts `from` in the place of the file at `path`, whole, only while the file
 * is still what was read (`was`): a save the owner made meanwhile is never
 * overwritten. A link is followed, so its target is written, and the
 * file's mode is kept.
 */
function replaceKeeping(path: string, from: string, was: string): void {
  const real = realpathSync(path)
  if (hashFile(real) !== was) throw new Error('The deck changed while this was being made. Nothing was written; look at it again.')
  chmodSync(from, statSync(real).mode & 0o7777)
  copyWhole(from, real)
}

/** Why changes could not be accepted: each by its title and slide, the rest were written. */
export class StaleChangesError extends Error {}

/**
 * A press made on one preview of the suggestions, refused because they moved on since (another
 * window, the agent's next edit to the same slide): an accept or a reject is always on what he saw.
 */
export class ChangedSinceError extends Error {}
export const CHANGED_SINCE = 'The suggestions changed since this preview. Nothing was accepted or rejected; look at them again.'

/**
 * The changes' revision (`DeckView.changesRev`): the proposed build's key, made from the file and the pending
 * edits, so it moves whenever either does, picture or none. With a picture it is `renders.proposed.rev` too.
 * Null when no change waits.
 */
const proposedRev = (deck: Deck): string | null => (deck.proposed ? deck.proposed.key.slice(0, 16) : null)

/** Refuses a press whose `rev` is not the changes' revision now; a press with none (an older phone build) is not checked. */
function checkRev(deck: Deck, rev: string | undefined): void {
  if (rev !== undefined && proposedRev(deck) !== rev) throw new ChangedSinceError(CHANGED_SINCE)
}

/**
 * Accepts changes and writes them into the file. Taking every waiting
 * change replays the edits as they were made, which is how the proposed
 * deck was drawn. Taking some: an `add` or `move` goes after the nearest
 * slide before it in the proposed order that is in the file (or lands in
 * this accept), so it lands where the strip showed it. A change one of whose
 * edits no longer fits the file is left waiting, the others are written, and
 * a `StaleChangesError` names it.
 */
export async function accept(ctx: Ctx, item: CanvasItem, ids: readonly string[] | 'all', signal?: AbortSignal, rev?: string): Promise<void> {
  const stale = await serial(item.id, () =>
    withDeck(ctx, item, signal, async (deck) => {
      checkRev(deck, rev)
      let chosen = deck.pending.filter((p) => ids === 'all' || ids.includes(changeIdOf(p.slide)))
      if (!chosen.length) return []
      const whole = chosen.length === deck.pending.length
      const fileOrder = deck.file.info.slides.map((s) => s.id)
      const order = (deck.proposed?.info.slides ?? []).map((s) => s.id)
      const titles = new Map([...deck.file.info.slides, ...(deck.proposed?.info.slides ?? [])].map((s) => [s.id, s.title]))
      const opsOf = (list: PendingOp[]): SlideOp[] => {
        const inFile = new Set(fileOrder)
        const landed = new Set<number>()
        const here = (id: number): boolean => inFile.has(id) || landed.has(id)
        return list.map((p) => {
          let op = p.op
          if (op.op === 'add' || op.op === 'move') {
            const self = op.op === 'add' ? op.id! : op.slide
            const at = order.indexOf(self)
            let after = op.after
            if (!whole && at >= 0) {
              after = 0
              for (let j = at - 1; j >= 0; j--) if (order[j] !== self && here(order[j])) { after = order[j]; break }
            } else if (after !== 0 && !here(after)) {
              const list2 = order.includes(after) ? order : fileOrder
              after = 0
              for (let j = list2.indexOf(op.after) - 1; j >= 0; j--) if (here(list2[j])) { after = list2[j]; break }
            }
            op = { ...op, after }
          }
          if (op.op === 'add') landed.add(op.id!)
          return op
        })
      }
      // Changes whose edits no longer fit are set aside, one round at a time (dropping one can strand another).
      const left: Array<{ id: string; label: string; why: string }> = []
      for (let round = 0; round < 50 && chosen.length; round++) {
        const out = await scratch(ctx, item, 'trial')
        let warnings: string[]
        const ops = opsOf(chosen)
        try {
          warnings = await applyTo(ctx, item, deck.copy, ops, out, false, signal)
        } finally {
          rmSync(out, { force: true })
        }
        // A note (a link the remove took out) is no failure.
        warnings = warnings.filter((w) => !isNote(w))
        if (!warnings.length) break
        const bad = new Map<number, string>()
        for (const w of warnings) {
          const m = /^edit (\d+): (.*)$/s.exec(w)
          const p = m ? chosen[Number(m[1]) - 1] : undefined
          if (p && !bad.has(p.slide)) {
            const inChange = chosen.filter((c) => c.slide === p.slide)
            bad.set(p.slide, `its edit ${inChange.indexOf(p) + 1} of ${inChange.length}: ${m![2]}`)
          }
        }
        if (!bad.size) throw new Error(warnings.join(' '))
        for (const [slide, why] of bad) {
          // An add is named by its own title: the file's slide of that id, if one came, is someone else's.
          const add = chosen.find((c) => c.slide === slide && c.op.op === 'add')?.op
          const label = (add?.op === 'add' ? add.title : undefined) || titles.get(slide) || `Slide ${slide}`
          left.push({ id: changeIdOf(slide), label, why })
        }
        chosen = chosen.filter((p) => !bad.has(p.slide))
      }
      if (chosen.length) {
        const ops = opsOf(chosen)
        await writeInto(ctx, item, deck.path, ops, signal, deck.hash)
        const store = new SlidesStore(ctx.db)
        store.drop(item.id, chosen.map((p) => p.id))
        const removed = new Set(ops.flatMap((o) => (o.op === 'remove' ? [o.slide] : [])))
        if (!whole) {
          // What still waits is anchored again on the order the strip showed, so the next accept lands there too.
          const now = new Set([...fileOrder, ...ops.flatMap((o) => (o.op === 'add' ? [o.id!] : []))].filter((id) => !removed.has(id)))
          const rest = store.pending(item.id)
          store.rewrite(
            item.id,
            rest.flatMap((p) => {
              const op = p.op
              if (op.op === 'add') now.add(op.id!)
              if (op.op !== 'add' && op.op !== 'move') return []
              const self = op.op === 'add' ? op.id! : op.slide
              const at = order.indexOf(self)
              if (at < 0) return []
              let after = 0
              for (let j = at - 1; j >= 0; j--) if (order[j] !== self && now.has(order[j])) { after = order[j]; break }
              return after === op.after ? [] : [{ ...p, op: { ...op, after } }]
            })
          )
        }
        // An edit left waiting that was anchored on a slide this removed takes the nearest earlier slide still there.
        if (removed.size) {
          const kept = new Set([...fileOrder, ...ops.flatMap((o) => (o.op === 'add' ? [o.id!] : []))])
          const still = (id: number): boolean => !removed.has(id) && kept.has(id)
          const nearest = (after: number): number => {
            for (let j = fileOrder.indexOf(after) - 1; j >= 0; j--) if (still(fileOrder[j])) return fileOrder[j]
            return 0
          }
          store.rewrite(
            item.id,
            store.pending(item.id).flatMap((p) => ((p.op.op === 'add' || p.op.op === 'move') && removed.has(p.op.after) ? [{ ...p, op: { ...p.op, after: nearest(p.op.after) } }] : []))
          )
        }
      }
      return left
    })
  )
  if (stale.length) {
    throw new StaleChangesError(
      `${stale.length === 1 ? 'One change' : `${stale.length} changes`} could not be accepted and still ${stale.length === 1 ? 'waits' : 'wait'}; the rest went in. ${stale.map((c) => `“${c.label}”: ${c.why}.`).join(' ')}`
    )
  }
}

/** Rejects changes: their rows go; an edit anchored on a slide a rejected add would have made takes that add's own anchor. */
export async function reject(ctx: Ctx, item: CanvasItem, ids: readonly string[] | 'all', rev?: string, signal?: AbortSignal): Promise<void> {
  await serial(item.id, async () => {
    // Checked on the item's queue, against the deck as it is now, so no edit lands between the check and the drop.
    if (rev !== undefined) checkRev(await deckOf(ctx, item, signal), rev)
    const store = new SlidesStore(ctx.db)
    const pending = store.pending(item.id)
    const chosen = pending.filter((p) => ids === 'all' || ids.includes(changeIdOf(p.slide)))
    const gone = new Map<number, number>()
    for (const p of chosen) if (p.op.op === 'add' && p.op.id) gone.set(p.op.id, p.op.after)
    const resolve = (after: number): number => {
      const seen = new Set<number>()
      while (gone.has(after) && !seen.has(after)) {
        seen.add(after)
        after = gone.get(after)!
      }
      return after
    }
    const dropped = new Set(chosen.map((p) => p.id))
    const moved = pending.flatMap((p) => (!dropped.has(p.id) && (p.op.op === 'add' || p.op.op === 'move') && gone.has(p.op.after) ? [{ ...p, op: { ...p.op, after: resolve(p.op.after) } }] : []))
    store.rewrite(item.id, moved)
    store.drop(item.id, [...dropped])
  })
}

/** Puts the file back as it was before the agent's direct write, while the file is still what that write left. */
export async function undo(ctx: Ctx, item: CanvasItem, writeId: string): Promise<void> {
  await serial(item.id, async () => {
    const store = new SlidesStore(ctx.db)
    const w = store.written(item.id)
    if (!w || w.id !== writeId) throw new Error('That write can no longer be taken back.')
    const path = await deckPath(ctx, item)
    if (hashFile(path) !== w.after) throw new Error('The deck has changed since that write, so it can no longer be taken back.')
    const copy = join(await itemDir(ctx, item, 'history'), w.before)
    if (!existsSync(copy)) throw new Error('The copy from before that write is gone.')
    replaceKeeping(path, copy, w.after)
    store.setWritten(item.id, item.sessionId, null)
  })
}
