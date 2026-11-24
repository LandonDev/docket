import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import type { Bbox } from '@shared/contract-work-pdf'
import type { DeckShape, DeckSlide, DeckView, SlideChange, SlideOp } from '@shared/contract-work-slides'
import { canvasSourcePath, type CanvasItem, type CanvasSource } from '@shared/work'
import { importReadOnly, slideImportExt, type SlideImportExt } from '@shared/work/slideFormats'
import { errorText } from '@shared/work/ids'
import { sharedOf } from '../files/policy'
import { fileWritten, workingOn } from '../files/save'
import { cachedSlidesMirror, mirrorUnreached } from '../google/deckMirror'
import { madeFromShared } from '../formats/exporter'
import { NoConverterError } from '../formats/jobs'
import type { WorkCtx } from '../modules'
import { canvasItemDir } from '../canvas/store'
import { copyWhole, hasMagic, ItemFileError, pushFor, sourcePath } from '../pdf/file'
import { sweepAttached, withAttached } from './attach'
import { withBuilds } from './builds'
import { DECK_ITSELF, isNote, type DeckInfo, type ShapeInfo, type SlideInfo } from './deck'
import { DECK_PY } from './deckScript'
import { convertedDeck, isTeamsSnapshot } from './formatsIn'
import { hands, handMoved, handState } from './handLine'
import { deckPicture, pageName, prunePages, splitPdf, type SlideRenderer } from './pictures'
import { stopShow } from './show'
import { rowSession, SlidesStore, type DeckWrite, type PendingOp } from './store'

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
/** One-page pictures kept per deck: enough for a long deck's every slide across a few versions. */
const PAGES_KEPT = 1200
const HISTORY_KEPT = 30
/** LibreOffice's PDF export with hidden slides in, so page n is slide n. */
export const RENDER_FILTER = 'impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}'

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
/** Part of every render key: a new deck script or filter makes the kept outlines and pictures again. */
let renderV: string | null = null
const RENDER_V = (): string => (renderV ??= createHash('sha256').update(DECK_PY + RENDER_FILTER).digest('hex').slice(0, 16))
export const hashFile = (path: string): string => sha(readFileSync(path))

// ── the deck an item shows ───────────────────────────────────────────

const realOf = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    // The file is not there (renamed away, not made yet): its folder's real path and its name, so a deck under a
    // linked folder (a Mac's OneDrive link, /var for /private/var) keeps one key before and after.
    try {
      return join(realpathSync(dirname(path)), basename(path))
    } catch {
      return path
    }
  }
}
/** A file's deck key: one for the file however it is named (a link, a Microsoft file by its path). */
export const fileKey = (path: string): string => `file:${realOf(path)}`
/** The path a source names on this host when it is a plain file there, else null. */
export const filePathOf = (source: CanvasSource): string | null => (source.at === 'file' || (source.at === 'microsoft' && source.ref.kind === 'path') ? canvasSourcePath(source) : null)

/**
 * The source's queue key: `file:<real path>` for a file on this host, or the item's id for a deck only that
 * item holds. Each seat keeps its own mode.
 */
export function deckKey(item: CanvasItem): string {
  const path = filePathOf(item.source)
  return path === null ? item.id : fileKey(path)
}

/** Takes the item's seat on its deck (moving rows kept under the item from before, once) and answers the deck's key. */
export function seatOf(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, item: CanvasItem): string {
  const key = deckKey(item)
  const shared = deckShared(ctx, item)
  new SlidesStore(ctx.db).seat(item.id, item.sessionId, key, shared)
  // A file found to be one others can open keeps nothing by the file: what an earlier seat kept there goes.
  if (shared && key.startsWith('file:')) for (const folder of [deckBase, deckCache]) rmSync(folder(ctx.dataDir, key), { recursive: true, force: true })
  return key
}

/** Where a file's deck keeps its versions when it is his own: by the file, under app data. */
export const deckBase = (dataDir: string, key: string): string => join(dataDir, 'work-slides', sha(key).slice(0, 32))
/** Where it keeps what can be made again (renders, pages, scratch copies): under `.cache`, which the box's backup leaves out. */
export const deckCache = (dataDir: string, key: string): string => join(dataDir, 'work-slides', '.cache', sha(key).slice(0, 32))

/**
 * The folder of one tab on an imported file others can open: its converted snapshot and its pictures, outside the
 * canvas tree a thread move carries to another host, named by the item's id so the sweep can find its tab.
 */
export const tabCache = (dataDir: string, itemId: string): string => join(tabsRoot(dataDir), canvasSafe(itemId))
const tabsRoot = (dataDir: string): string => join(dataDir, 'work-slides', '.cache', 'tabs')
/** The alphabet a canvas item's id is made of (canvas/store.ts): a folder name as it is. */
const canvasSafe = (id: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`slides: bad item id ${JSON.stringify(id)}`)
  return id
}

/**
 * A folder of the deck's. A file of his own keeps its renders, pages and versions by the file (`deckBase`,
 * `deckCache`), so every seat on it shares them and its versions outlive a closed tab. Anything else keeps them in the item's own folder and
 * they go with the item: a deck only the item holds, and a file others can open (the rule for a shared library:
 * nothing made from it outlives its tab).
 */
export async function deckDir(ctx: Ctx, item: CanvasItem, ...sub: string[]): Promise<string> {
  // A closed tab's snapshot of a shared file is gone or going (sweepClosedCopies): nothing makes it again.
  if (tabCopyOf(ctx, item) && ctx.canvas.get(item.id)?.state !== 'open') throw new ItemFileError('This deck is closed.', 'missing')
  const dir = deckFolder(ctx, item, ...sub)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
/** Where a folder of the deck's is, made or not. */
export function deckFolder(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, item: CanvasItem, ...sub: string[]): string {
  const key = deckKey(item)
  if (tabCopyOf(ctx, item)) return join(tabCache(ctx.dataDir, item.id), ...sub)
  if (!key.startsWith('file:') || sharedDeck(ctx, item)) return join(canvasItemDir(ctx.dataDir, item.sessionId, item.id), ...sub)
  // What cannot be made again (his versions, the files a waiting edit brings) is kept by the file; the rest (an
  // import's snapshot too) under `.cache`.
  return join(sub[0] === 'history' || sub[0] === 'attach' ? deckBase(ctx.dataDir, key) : deckCache(ctx.dataDir, key), ...sub)
}

// ── one chain per deck ───────────────────────────────────────────────

const chains = new Map<string, Promise<unknown>>()
/** Runs `fn` after every earlier step for the deck: two opens never render twice, and a write never races a render. */
function chained<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => {})
  chains.set(key, tail)
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })
  return run
}
/** The item's deck's one queue: every seat on a file waits in the same line. */
export function serial<T>(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, item: CanvasItem, fn: () => Promise<T>): Promise<T> {
  const run = chained(seatOf(ctx, item), fn)
  // Files waits for it before it judges a closed tab's copy clean (files/save.ts `workingOn`).
  const path = filePathOf(item.source)
  return path === null ? run : workingOn(path, run)
}

/** The LibreOffice kept running, where the host has one (set by the module when Work starts; null: every render starts its own). */
let renderer: SlideRenderer | null = null
export const setSlideRenderer = (next: SlideRenderer | null): void => void (renderer = next)
export const slideRenderer = (): SlideRenderer | null => renderer
/** What this host draws with, as the module reads it (the toolchain as installed: a new LibreOffice or font pack is a new word). */
let engine: () => string = () => ''
export const setSlideEngine = (next: (() => string) | null): void => void (engine = next ?? (() => ''))
/** Part of every kept page's name: a new deck script, filter or toolchain draws every slide again. */
const pictureSalt = (): string => `${RENDER_V()}:${engine()}`

/** Told whenever a deck is opened or told again (show.ts makes the show's pictures then, off the deck's queue). */
let opened: ((ctx: Ctx, item: CanvasItem, deck: Deck) => void) | null = null
export const onDeckOpened = (fn: typeof opened): void => void (opened = fn)

// ── the file ─────────────────────────────────────────────────────────

/** The imported format an item's file is in (`.ppt`, `.pps`, `.ppsx`, `.odp`, `.key`), if it is one. */
export const slideImportOf = (item: CanvasItem): SlideImportExt | undefined => slideImportExt(filePathOf(item.source) ?? (item.source.at === 'mail' ? item.source.name : ''))
/** An imported file others can open: each tab draws from its own snapshot, kept on this host and gone with the tab. */
export const tabCopyOf = (ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, item: CanvasItem): boolean => !!slideImportOf(item) && sharedDeck(ctx, item)

export const GOOGLE_DECK_READ_ONLY = 'This Google deck is read only here. Make a copy to edit.'
/**
 * Why nobody may change this deck here, or null: an imported format is a converted picture of itself and a Google
 * deck a mirror of Drive's, so his hand, an agent and every write method refuse it with this one sentence.
 */
export function readOnlyWhy(item: CanvasItem): string | null {
  if (item.source.at === 'google') return GOOGLE_DECK_READ_ONLY
  const ext = slideImportOf(item)
  return ext ? importReadOnly(ext) : null
}

/** The deck's path on this host. First conversion runs on the source's queue. */
export async function deckPath(ctx: Ctx, item: CanvasItem, signal?: AbortSignal): Promise<string> {
  if (item.source.at === 'google') return cachedSlidesMirror(ctx, item.source)
  const path = await sourcePath(ctx, item, OWN_FILE)
  if (!existsSync(path)) throw new ItemFileError(`${nameOf(item, path)} is not where it was.`, 'missing')
  const from = slideImportOf(item)
  if (from) return convertedDeck(ctx, path, await deckDir(ctx, item, 'converted'), from, sharedJob(ctx, item), signal)
  if (!hasMagic(path, 'zip')) throw new ItemFileError(`${nameOf(item, path)} is not a PowerPoint deck.`)
  return path
}

export const nameOf = (item: CanvasItem, path: string | null): string => {
  const source = item.source
  if (source.at === 'google') return item.title
  if (source.at === 'microsoft') return source.name
  if (source.at === 'mail') return source.name
  if (path && source.at === 'file') return basename(source.path)
  return /\.pptx$/i.test(item.title) ? item.title : `${item.title}.pptx`
}

/**
 * Whether anyone else can open the deck (work/files/policy.ts `sharedOf`): a deck that lives in PowerPoint, in a
 * Teams or OneDrive library or any cloud folder, on another host. For such a deck an agent's own idea is always
 * a suggestion kept on this host, and no copy of it is carried to another host to be read, drawn or edited.
 */
export const deckShared = (ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, item: CanvasItem): boolean => item.source.at === 'microsoft' || sharedOf(ctx, item.source) || isTeamsSnapshot(ctx.dataDir, item.source)
/**
 * Whether the item's deck is one others can open, as the deck itself: this item's source says so, or any other
 * seat's on the same file does. The deck's state belongs to the file, so two seats that name it differently (a
 * path in a library and the same path as a plain file) must not disagree: the stricter word holds for both.
 */
export const sharedDeck = (ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, item: CanvasItem): boolean => deckShared(ctx, item) || new SlidesStore(ctx.db).sharedDeck(deckKey(item))
/** The mark a conversion of a shared deck's copy carries: the copy lies under app data, so the runner cannot tell by its path. */
export const sharedJob = (ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, item: CanvasItem): { shared?: true } => (sharedDeck(ctx, item) ? { shared: true } : {})

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
  // The layouts' pictures are few and outlive many versions of the slides: the newest two stay, by their own count.
  const looks = readdirSync(dir)
    .filter((f) => f.startsWith(LAYOUTS_PREFIX))
    .map((f) => {
      try {
        return { f, at: statSync(join(dir, f)).mtimeMs }
      } catch {
        return { f, at: 0 }
      }
    })
    .sort((a, b) => b.at - a.at)
  for (const { f } of looks.slice(2)) rmSync(join(dir, f), { force: true })
  for (const f of readdirSync(dir)) {
    if (f.startsWith(LAYOUTS_PREFIX)) continue
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

/** Draws the PDF of the deck at `input` to `pdf`, slide by slide where it can (pictures.ts). */
async function drawPdf(ctx: Ctx, item: CanvasItem, input: string, info: DeckInfo, pdf: string, signal?: AbortSignal): Promise<void> {
  // Only the slides whose picture changed are drawn, by the LibreOffice kept running; a whole export the
  // toolchain's own way when there is none or it fails.
  const pages = await deckDir(ctx, item, 'pages')
  await deckPicture(
    {
      dir: pages,
      salt: pictureSalt(),
      renderer,
      whole: async (from, to, sig) => void (await ctx.convert({ from: 'pptx', to: 'pdf', input: from, output: to, options: { filter: RENDER_FILTER }, ...sharedJob(ctx, item), ...(sig ? { signal: sig } : {}) })),
      log: (line) => console.warn(line)
    },
    input,
    info.slides,
    pdf,
    signal
  )
  prunePages(pages, PAGES_KEPT)
}

/**
 * The outline and the PDF of the deck at `input`, kept under `key` (made once, then read). With `draw` false a
 * PDF that is not kept yet is left undrawn (`pdf` null, no `renderError`): `predraw` draws it beside the queue.
 */
async function build(ctx: Ctx, item: CanvasItem, key: string, input: string, signal?: AbortSignal, draw = true): Promise<Built> {
  const dir = await deckDir(ctx, item, 'render')
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
  withBuilds(info)
  let renderError: string | undefined
  if (draw && !existsSync(pdf)) {
    try {
      await drawPdf(ctx, item, input, info, pdf, signal)
    } catch (err) {
      if (signal?.aborted) throw err
      renderError = renderErrorOf(err)
    }
  }
  if (existsSync(pdf)) touch(pdf)
  prune(dir)
  return { key, info, pdf: existsSync(pdf) ? pdf : null, ...(renderError ? { renderError } : {}) }
}

/**
 * Keeps an outline the deck tool already read of the file whose bytes hash to `fileHash` (his own edit reads it
 * in the same run), under the key `build` looks for. One that is not an outline is dropped: `build` reads it again.
 */
export async function keepOutline(ctx: Ctx, item: CanvasItem, fileHash: string, from: string): Promise<void> {
  try {
    const info = JSON.parse(readFileSync(from, 'utf8')) as DeckInfo
    if (!Array.isArray(info.slides)) return
    const json = join(await deckDir(ctx, item, 'render'), `${sha(RENDER_V() + fileHash)}.json`)
    const tmp = `${json}.${randomUUID().slice(0, 8)}.tmp`
    copyFileSync(from, tmp)
    renameSync(tmp, json)
  } catch {
    /* no outline to keep: read again when asked */
  }
}

/** Applies edits to a copy of the deck: under `strict` any edit that does not go in fails the whole list with its sentences. */
export async function applyTo(ctx: Ctx, item: CanvasItem, input: string, ops: SlideOp[], output: string, strict: boolean, signal?: AbortSignal): Promise<string[]> {
  // The files the edits bring (a picture, a video) ride with the deck as one input (attach.ts).
  const job = withAttached(await deckDir(ctx, item, 'attach'), await scratch(ctx, item, 'plus'), input, ops)
  try {
    const done = await ctx.convert({ from: job.from, to: 'pptxedit', input: job.input, output, options: { ops: job.ops, strict, ...(job.files.length ? { files: job.files } : {}) }, ...sharedJob(ctx, item), ...(signal ? { signal } : {}) })
    return done.warnings
  } finally {
    job.done()
  }
}

/** A scratch file in the item's `tmp/` folder (kept out of `render/`, whose files are counted by key). */
export async function scratch(ctx: Ctx, item: CanvasItem, what: string): Promise<string> {
  return join(await deckDir(ctx, item, 'tmp'), `${what}-${randomUUID()}.pptx`)
}

const proposedKey = (fileHash: string, pending: readonly PendingOp[]): string => sha(RENDER_V() + fileHash + JSON.stringify(pending.map((p) => p.op)))

/** The deck with every pending edit in; null when nothing waits. */
async function proposedBuilt(ctx: Ctx, item: CanvasItem, input: string, fileHash: string, pending: readonly PendingOp[], signal?: AbortSignal, draw = true): Promise<Built | null> {
  if (!pending.length) return null
  const key = proposedKey(fileHash, pending)
  const dir = await deckDir(ctx, item, 'render')
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
  return build(ctx, item, key, copy, signal, draw)
}

// ── the layouts' picture ─────────────────────────────────────────────

const LAYOUTS_PREFIX = 'layouts-'

/** Where the picture of a deck's layouts is kept: named by what the layouts are drawn from and what draws them. Null for an outline that has no hash of them. */
function layoutsPdf(dir: string, info: DeckInfo): { path: string; rev: string } | null {
  if (!info.layoutsDraws) return null
  const name = pageName(pictureSalt(), `layouts:${info.layoutsDraws}`)
  return { path: join(dir, `${LAYOUTS_PREFIX}${name.slice(0, 32)}.pdf`), rev: name.slice(0, 16) }
}

/**
 * Draws the layout picker's picture: a deck of one slide per layout of `input` (the deck tool makes it, each
 * placeholder saying what it is), drawn as any deck is. Made once for a deck's layouts, whatever its slides do.
 */
async function drawLayouts(ctx: Ctx, item: CanvasItem, input: string, pdf: string, signal?: AbortSignal): Promise<void> {
  const deck = await scratch(ctx, item, 'layouts')
  const tmp = `${pdf}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await ctx.convert({ from: 'pptx', to: 'pptxlayouts', input, output: deck, ...sharedJob(ctx, item), ...(signal ? { signal } : {}) })
    let drawn = false
    if (renderer && renderer.here?.() !== false) {
      try {
        await renderer.deck(deck, tmp, signal)
        drawn = true
      } catch (err) {
        if (signal?.aborted) throw err
      }
    }
    if (!drawn) await ctx.convert({ from: 'pptx', to: 'pdf', input: deck, output: tmp, options: { filter: RENDER_FILTER }, ...sharedJob(ctx, item), ...(signal ? { signal } : {}) })
    renameSync(tmp, pdf)
  } finally {
    rmSync(deck, { force: true })
    rmSync(tmp, { force: true })
  }
}

/** The layouts' picture as the view names it, where it is kept. */
function layoutsPic(dir: string, info: DeckInfo): DeckView['layoutsPic'] | undefined {
  const at = layoutsPdf(dir, info)
  if (!at) return undefined
  try {
    const size = statSync(at.path).size
    touch(at.path)
    return { rev: at.rev, size }
  } catch {
    return undefined
  }
}

// ── pictures beside the queue ────────────────────────────────────────

/** The pictures being drawn beside the deck's queue, by the PDF each makes. */
const drawing = new Map<string, Promise<void>>()
/** PDFs a draw beside the queue failed at: left to the queue's own build, which says why, and not tried twice a read. */
const gaveUp = new Set<string>()

/**
 * Draws the pictures the deck's view is about to need, beside the deck's queue: a render never holds up a write.
 * On the queue it reads only what is cheap (the outlines, and which PDFs are not kept yet); the drawing itself
 * runs off it, once for a PDF however many ask. A picture that turns out stale (the file moved on meanwhile) is
 * kept under its own key and harms nothing; one that fails is drawn again on the queue, which then says why.
 */
async function predraw(ctx: Ctx, item: CanvasItem, signal?: AbortSignal): Promise<void> {
  const todo = await serial(ctx, item, async () => {
    const path = await deckPath(ctx, item, signal)
    const copy = await scratch(ctx, item, 'live')
    copyWhole(path, copy)
    try {
      const hash = hashFile(copy)
      const dir = await deckDir(ctx, item, 'render')
      const out: Array<{ pdf: string; input: string; info: DeckInfo; scratch: boolean; layouts?: true }> = []
      const file = await build(ctx, item, sha(RENDER_V() + hash), copy, signal, false)
      if (!file.pdf) {
        // The file's copy for the drawing: its own, since the one read here goes when this step ends.
        const input = await scratch(ctx, item, 'draw')
        copyWhole(copy, input)
        out.push({ pdf: join(dir, `${file.key}.pdf`), input, info: file.info, scratch: true })
      }
      const pending = readOnlyWhy(item) ? [] : new SlidesStore(ctx.db).pending(deckKey(item))
      const proposed = await proposedBuilt(ctx, item, copy, hash, pending, signal, false)
      if (proposed && !proposed.pdf) out.push({ pdf: join(dir, `${proposed.key}.pdf`), input: join(dir, `${proposed.key}.pptx`), info: proposed.info, scratch: false })
      // The layout picker's picture, where the deck has a picture at all: made once for these layouts.
      const looks = layoutsPdf(dir, file.info)
      if (!readOnlyWhy(item) && looks && !existsSync(looks.path) && !gaveUp.has(looks.path) && !drawing.has(looks.path)) {
        const input = await scratch(ctx, item, 'draw')
        copyWhole(copy, input)
        out.push({ pdf: looks.path, input, info: file.info, scratch: true, layouts: true })
      }
      return out
    } finally {
      rmSync(copy, { force: true })
    }
  })
  await Promise.all(
    todo.map((job) => {
      let run = drawing.get(job.pdf)
      if (!run && gaveUp.has(job.pdf)) {
        if (job.scratch) rmSync(job.input, { force: true })
        return undefined
      }
      if (!run) {
        run = (job.layouts ? drawLayouts(ctx, item, job.input, job.pdf) : drawPdf(ctx, item, job.input, job.info, job.pdf))
          .catch(() => {
            if (gaveUp.size > 500) gaveUp.clear()
            gaveUp.add(job.pdf)
          })
          .finally(() => {
            drawing.delete(job.pdf)
            if (job.scratch) rmSync(job.input, { force: true })
          })
        drawing.set(job.pdf, run)
      } else if (job.scratch) rmSync(job.input, { force: true })
      return run
    })
  )
}
/** `predraw`, never the reason a read fails: the queue's own build draws what is still missing and says why. */
export const drawAhead = (ctx: Ctx, item: CanvasItem, signal?: AbortSignal): Promise<void> => predraw(ctx, item, signal).catch(() => {})

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
  const path = await deckPath(ctx, item, signal)
  const copy = await scratch(ctx, item, 'live')
  copyWhole(path, copy)
  try {
    const hash = hashFile(copy)
    const file = await build(ctx, item, sha(RENDER_V() + hash), copy, signal)
    const pending = readOnlyWhy(item) ? [] : new SlidesStore(ctx.db).pending(deckKey(item))
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
const deckShape = (s: ShapeInfo, label?: string): DeckShape => ({
  id: s.id,
  name: s.name,
  ...(label ? { label } : {}),
  bbox: bboxOf(s),
  text: shapeText(s),
  kind: s.kind,
  ...(s.quad ? { quad: s.quad } : {}),
  ...(s.rot ? { rot: s.rot } : {}),
  ...(s.flip ? { flip: true } : {}),
  ...(s.group !== undefined ? { group: s.group } : {}),
  ...(s.shape ? { shape: s.shape } : {}),
  ...(s.media ? { media: s.media } : {}),
  ...(s.paragraphs ? { paragraphs: s.paragraphs } : {}),
  ...(s.frame ? { frame: s.frame } : {}),
  ...(s.cells ? { cells: s.cells } : {}),
  ...(s.own ? { own: s.own } : {}),
  ...(s.fill ? { fill: s.fill } : {}),
  ...(s.line ? { line: s.line } : {})
})

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
const KIND_WORDS: Record<ShapeInfo['kind'], string> = { text: 'Text', table: 'Table', chart: 'Chart', picture: 'Picture', media: 'Media', connector: 'Line', frame: 'Object', other: 'Shape' }
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

/** One of a few values in words: the one all share, "some x" where only some have it, nothing where none does. */
const shared = <T,>(values: readonly T[], say: (v: T) => string, mixed: string): string => {
  const kinds = [...new Set(values)]
  return kinds.length === 0 ? '' : kinds.length === 1 ? say(kinds[0]) : mixed
}
const ALIGN_WORDS = { left: 'left', center: 'centred', right: 'right', justify: 'justified' } as const
const LIST_WORDS = { none: '', bullet: 'bullets', number: 'numbers' } as const

/** A shape's look in a few words ("Calibri, 28 pt, bold, centred"), for a change that reworded nothing. */
export function lookWords(paragraphs: ShapeInfo['paragraphs']): string {
  if (!paragraphs?.length) return ''
  const runs = paragraphs.flatMap((p) => p.runs.filter((r) => r.text.trim() !== ''))
  const flag = (on: (r: (typeof runs)[number]) => boolean, word: string): string => (runs.length === 0 || !runs.some(on) ? '' : runs.every(on) ? word : `some ${word}`)
  return [
    shared(runs.flatMap((r) => (r.font ? [r.font] : [])), (v) => v, 'mixed fonts'),
    shared(runs.flatMap((r) => (r.size ? [r.size] : [])), (v) => `${v} pt`, 'mixed sizes'),
    flag((r) => !!r.bold, 'bold'),
    flag((r) => !!r.italic, 'italic'),
    flag((r) => !!r.underline, 'underlined'),
    shared(runs.flatMap((r) => (r.color ? [r.color] : [])), (v) => `#${v}`, 'mixed colours'),
    shared(paragraphs.map((p) => p.align), (v) => ALIGN_WORDS[v], 'mixed alignment'),
    shared(paragraphs.map((p) => p.list), (v) => LIST_WORDS[v], 'some in a list')
  ]
    .filter(Boolean)
    .join(', ')
}

const TRANSITION_WORDS: Record<string, string> = { none: 'Cut', fade: 'Fade', push: 'Push' }
/** How a slide comes in a show, in a few words: "Fade", "Push, moves on after 5 s", "None". */
export function comesAs(t: SlideInfo['transition']): string {
  if (!t) return 'None'
  const kind = TRANSITION_WORDS[t.kind] ?? `${t.kind.charAt(0).toUpperCase()}${t.kind.slice(1)}`
  return [kind, t.after !== undefined ? `moves on after ${Number((t.after / 1000).toFixed(1))} s` : '', t.click === false ? 'no press' : ''].filter(Boolean).join(', ')
}
/** The presses a slide's builds take in a show: its steps past the first, which is the slide as it comes up. */
const pressesOf = (s: SlideInfo): number => Math.max(0, (s.builds?.steps.length ?? 1) - 1)
const pressWords = (n: number): string => (n === 0 ? 'None' : n === 1 ? '1 press' : `${n} presses`)

/** What the words were and are on one slide, shape by shape, cell by cell, then the notes. */
export function editsOf(before: SlideInfo | undefined, after: SlideInfo | undefined): { edits: SlideChange['edits']; boxes: Bbox[]; gone: Bbox[] } {
  const edits: SlideChange['edits'] = []
  const boxes: Bbox[] = []
  // Where the shapes the change takes off the slide lay.
  const gone: Bbox[] = []
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
    } else if (!old) {
      // A shape the change adds with no words of its own (a picture, a drawn shape, an empty text box).
      edits.push({ where, before: '', after: 'Added' })
      moved = true
    } else if (old && JSON.stringify(old.paragraphs ?? null) !== JSON.stringify(s.paragraphs ?? null)) {
      // The same words in another look (a `format` or a `runs` edit): said in words, so the stepper never shows a change with nothing in it.
      const [before, after] = [lookWords(old.paragraphs), lookWords(s.paragraphs)]
      edits.push({ where: `${where}, look`, before: before === after ? 'As it was' : before, after: before === after ? 'Changed within the text' : after })
      moved = true
    }
    // The same shape somewhere else, another size, turned, in another colour or behind other shapes: said in a few words.
    if (old) {
      const placed = (x: ShapeInfo): string => JSON.stringify([x.quad ?? x.bbox, x.rot ?? 0, !!x.flip])
      const paint = (x: ShapeInfo): string => [x.fill ? (x.fill === 'none' ? 'no fill' : `fill #${x.fill}`) : '', x.line ? `outline ${[x.line.color === 'none' ? 'none' : x.line.color ? `#${x.line.color}` : '', x.line.width !== undefined ? `${x.line.width} pt` : '', x.line.dash ?? ''].filter(Boolean).join(' ')}` : ''].filter(Boolean).join(', ')
      const said: Array<[string, string]> = []
      if (placed(old) !== placed(s)) said.push(['Where it was', 'Moved or resized'])
      if (paint(old) !== paint(s)) said.push([paint(old) || 'Its style\'s colours', paint(s) || 'Its style\'s colours'])
      if (said.length) {
        edits.push({ where: `${where}, look`, before: said.map((x) => x[0]).join('; '), after: said.map((x) => x[1]).join('; ') })
        if (s.bbox && !moved) boxes.push(s.bbox)
      }
    }
    if (moved && s.bbox) boxes.push(s.bbox)
  }
  // Shapes the change takes off the slide, by what each was.
  if (before && after) {
    const still = new Set(after.shapes.map((s) => s.id))
    const wasNames = partNames(before.shapes)
    for (const s of before.shapes) {
      if (still.has(s.id)) continue
      edits.push({ where: wasNames.get(s.id) ?? roleOf(s), before: shapeText(s) || 'There', after: 'Removed' })
      if (s.bbox) gone.push(s.bbox)
    }
    // The order the shapes that stay lie in, front to back.
    const order = (x: SlideInfo, keep: Set<number>): string => x.shapes.filter((s) => keep.has(s.id)).map((s) => s.id).join(',')
    const both = new Set(before.shapes.filter((s) => still.has(s.id)).map((s) => s.id))
    if (order(before, both) !== order(after, both)) edits.push({ where: 'Order', before: 'As it was', after: 'Shapes brought forward or sent back' })
    if (before.hidden !== after.hidden) edits.push({ where: 'In the show', before: before.hidden ? 'Hidden' : 'Shown', after: after.hidden ? 'Hidden' : 'Shown' })
    if (before.layout !== after.layout) edits.push({ where: 'Layout', before: before.layout, after: after.layout })
    if (comesAs(before.transition) !== comesAs(after.transition)) edits.push({ where: 'Transition', before: comesAs(before.transition), after: comesAs(after.transition) })
    if (pressesOf(before) !== pressesOf(after)) edits.push({ where: 'Builds', before: pressWords(pressesOf(before)), after: pressWords(pressesOf(after)) })
    // The same presses in another order, or by another effect: said by what comes in, in turn ("Title, Picture (Fade)" then "Picture (Fade), Title").
    else if (JSON.stringify([before.builds?.steps, before.builds?.fade]) !== JSON.stringify([after.builds?.steps, after.builds?.fade])) {
      const turn = (x: SlideInfo, names: Map<number, string>): string => x.builds?.order?.map((id) => `${names.get(id) ?? 'Shape'}${x.builds?.fade?.includes(id) ? ' (Fade)' : ''}`).join(', ') || 'Another order'
      edits.push({ where: 'Builds', before: turn(before, wasNames), after: turn(after, names) })
    }
  }
  if ((before?.notes ?? '') !== (after?.notes ?? '')) edits.push({ where: 'Notes', before: before?.notes ?? '', after: after?.notes ?? '' })
  return { edits, boxes, gone }
}

/** What an edit of the deck as a whole changed: its theme's colours and fonts, its sections. */
function deckEdits(file: DeckInfo, proposed: DeckInfo | null): SlideChange['edits'] {
  if (!proposed) return []
  const edits: SlideChange['edits'] = []
  const fonts = (t: DeckInfo['theme']): string => (t ? [t.major, t.minor].filter(Boolean).join(' and ') : '')
  const colours = (t: DeckInfo['theme']): string => (t ? Object.entries(t.colors).map(([slot, hex]) => `${slot} #${hex}`).join(', ') : '')
  if (fonts(file.theme) !== fonts(proposed.theme)) edits.push({ where: 'Theme fonts', before: fonts(file.theme), after: fonts(proposed.theme) })
  if (colours(file.theme) !== colours(proposed.theme)) {
    const changed = Object.keys(proposed.theme?.colors ?? {}).filter((slot) => file.theme?.colors[slot] !== proposed.theme?.colors[slot])
    edits.push({ where: 'Theme colours', before: changed.map((slot) => `${slot} #${file.theme?.colors[slot] ?? ''}`).join(', '), after: changed.map((slot) => `${slot} #${proposed.theme?.colors[slot] ?? ''}`).join(', ') })
  }
  const names = (d: DeckInfo): string => d.sections.map((s) => s.name).join(', ')
  if (names(file) !== names(proposed)) edits.push({ where: 'Sections', before: names(file) || 'None', after: names(proposed) || 'None' })
  return edits
}

/** The pending changes, one per slide, in the order their first edit was made. */
export function changesOf(file: DeckInfo, proposed: DeckInfo | null, pending: readonly PendingOp[]): SlideChange[] {
  const groups = new Map<number, PendingOp[]>()
  for (const p of pending) groups.set(p.slide, [...(groups.get(p.slide) ?? []), p])
  const inFile = new Map(file.slides.map((s) => [s.id, s]))
  const inProposed = new Map((proposed?.slides ?? []).map((s) => [s.id, s]))
  return [...groups.entries()].map(([slideId, ops]) => {
    const kinds = new Set(ops.map((o) => o.op.op))
    // A slide moved and nothing else is a move; a slide made (from a layout, or as a copy) is added; any other edit changes it.
    const kind: SlideChange['kind'] = kinds.has('add') || kinds.has('duplicate') ? 'added' : kinds.has('remove') ? 'removed' : [...kinds].every((k) => k === 'move') ? 'moved' : 'changed'
    const before = inFile.get(slideId)
    const after = inProposed.get(slideId)
    if (slideId === DECK_ITSELF) return { id: changeIdOf(slideId), kind: 'changed', slideId, label: 'The deck', edits: deckEdits(file, proposed), by: ops[0].by }
    const label = (after ?? before)?.title || `Slide ${slideId}`
    return { id: changeIdOf(slideId), kind, slideId, label, edits: kind === 'removed' || kind === 'moved' ? [] : editsOf(before, after).edits, by: ops[0].by }
  })
}

function sectionStarts(info: DeckInfo): Map<number, string> {
  return new Map(info.sections.filter((s) => s.slideIds.length).map((s) => [s.slideIds[0], s.name]))
}

/** A slide's own picture where the host keeps one: by which deck (the file or the proposed one) and the slide. */
export type PicOf = (from: 'file' | 'proposed', s: SlideInfo) => DeckSlide['pic'] | undefined

const slideOf = (s: SlideInfo, o: Pick<DeckSlide, 'key' | 'number' | 'from' | 'page' | 'change' | 'tint' | 'changed' | 'removed'>, section?: string, pic?: DeckSlide['pic']): DeckSlide => ({
  ...o,
  ...(pic ? { pic } : {}),
  id: s.id,
  title: s.title,
  notes: s.notes,
  hidden: s.hidden,
  shapes: ((names) => s.shapes.map((shape) => deckShape(shape, names.get(shape.id))))(partNames(s.shapes)),
  layout: s.layout,
  ...(s.fits ? { layoutsFit: s.fits } : {}),
  ...(s.transition ? { transition: s.transition } : {}),
  ...(s.builds ? { builds: s.builds } : {}),
  ...(section ? { section } : {})
})

/**
 * The strip in the proposed order. A removed slide, and the place a moved
 * slide leaves, are ghosts from the file's render, each after the nearest
 * earlier slide of the file that is in both decks and stays where it was.
 */
export function stripOf(file: DeckInfo, proposed: DeckInfo | null, changes: readonly SlideChange[], moved: ReadonlySet<number> = new Set(), picOf: PicOf = () => undefined): DeckSlide[] {
  if (!proposed) {
    const starts = sectionStarts(file)
    return file.slides.map((s, i) => slideOf(s, { key: String(s.id), number: i + 1, from: 'file', page: i + 1, change: null, tint: null, changed: [] }, starts.get(s.id), picOf('file', s)))
  }
  const byId = new Map(changes.map((c) => [c.slideId, c]))
  const inFile = new Map(file.slides.map((s) => [s.id, s]))
  const starts = sectionStarts(proposed)
  const out: DeckSlide[] = proposed.slides.map((s, i) => {
    const c = byId.get(s.id)
    const diff = c && c.kind !== 'moved' ? editsOf(inFile.get(s.id), s) : null
    return slideOf(s, { key: String(s.id), number: i + 1, from: 'proposed', page: i + 1, change: c?.id ?? null, tint: c ? 'add' : null, changed: diff?.boxes ?? [], ...(diff?.gone.length ? { removed: diff.gone } : {}) }, starts.get(s.id), picOf('proposed', s))
  })
  const kept = new Set(proposed.slides.map((s) => s.id))
  const stays = (id: number): boolean => kept.has(id) && !moved.has(id)
  file.slides.forEach((s, i) => {
    const c = byId.get(s.id)
    if (stays(s.id)) return
    const ghost = slideOf(s, { key: `ghost:${s.id}`, number: null, from: 'file', page: i + 1, change: c?.id ?? null, tint: 'del', changed: [] }, undefined, picOf('file', s))
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

export const renderOf = (b: Built | null): DeckView['renders']['file'] => (b?.pdf ? { rev: b.key.slice(0, 16), size: statSync(b.pdf).size, pages: b.info.slides.length } : null)

/**
 * The deck's last direct write as this seat may take it back: the deck's own, except on a file others can open,
 * where the copy from before lies in the folder of the item that wrote and only that item offers Undo.
 */
function writtenFor(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, item: CanvasItem): DeckWrite | null {
  const w = new SlidesStore(ctx.db).written(deckKey(item))
  return w && w.item && w.item !== item.id && sharedDeck(ctx, item) ? null : w
}

/** A read-only deck says what it is: the format it was converted from, or Google (and whether Drive answered). */
function readOnlyOf(item: CanvasItem): Pick<DeckView, 'readOnly'> {
  if (item.source.at === 'google') return { readOnly: { from: 'google', ...(mirrorUnreached(item.source) ? { offline: true as const } : {}) } }
  const from = slideImportOf(item)
  return from ? { readOnly: { from } } : {}
}

/** What differs seat by seat in one deck's view: whose item it is, its mode, and the Undo it may offer. */
function seatFields(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, item: CanvasItem): Pick<DeckView, 'itemId' | 'sessionId' | 'mode' | 'hosted'> & { written?: DeckView['written'] } {
  if (readOnlyWhy(item)) return { itemId: item.id, sessionId: item.sessionId, hosted: false }
  const written = writtenFor(ctx, item)
  return {
    itemId: item.id,
    sessionId: item.sessionId,
    mode: new SlidesStore(ctx.db).mode(item.id),
    hosted: item.source.at === 'microsoft',
    ...(written ? { written: { id: written.id, text: written.text, at: written.at } } : {})
  }
}

export function viewFrom(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, item: CanvasItem, deck: Deck, picOf?: PicOf): DeckView {
  const changes = changesOf(deck.file.info, deck.proposed?.info ?? null, deck.pending)
  const renderError = deck.file.renderError ?? deck.proposed?.renderError
  const changesRev = proposedRev(deck)
  const shownInfo = deck.proposed?.info ?? deck.file.info
  return {
    ...seatFields(ctx, item),
    ...((item.source.at === 'file' || item.source.at === 'thread') && !sharedDeck(ctx, item) && !madeFromShared(ctx, item.source) ? { canUpload: true } : {}),
    ...readOnlyOf(item),
    name: nameOf(item, deck.path),
    rev: deck.hash.slice(0, 16),
    slides: stripOf(deck.file.info, deck.proposed?.info ?? null, changes, new Set(deck.pending.flatMap((p) => (p.op.op === 'move' ? [p.op.slide] : []))), picOf),
    changes,
    renders: { file: renderOf(deck.file), proposed: renderOf(deck.proposed) },
    // The changes' own revision, with a picture of them or without (LibreOffice out of reach): a review is checked on it.
    ...(changesRev ? { changesRev } : {}),
    ...(renderError ? { renderError } : {}),
    // The deck as it would be with the changes in, when some wait: its size, layouts and theme.
    size: { width: shownInfo.width, height: shownInfo.height },
    ...(shownInfo.layoutInfo ? { layouts: shownInfo.layoutInfo } : {}),
    ...(shownInfo.theme ? { theme: shownInfo.theme } : {}),
    ...(readOnlyWhy(item) ? {} : { hand: handState(deckKey(item), deck.hash) })
  }
}

/** The one-page picture kept for a slide (pictures.ts), when the deck has one: its place and what a client names it by. */
function pageOf(pages: string, built: Built | null, s: SlideInfo): { path: string; rev: string; size: number } | null {
  if (!built?.pdf || !s.draws) return null
  const name = pageName(pictureSalt(), s.draws)
  const path = join(pages, `${name}.pdf`)
  try {
    return { path, rev: name.slice(0, 16), size: statSync(path).size }
  } catch {
    return null
  }
}

export async function viewOf(ctx: Ctx, item: CanvasItem, signal?: AbortSignal): Promise<DeckView> {
  // Off the way: a closed tab's snapshot waits on its own file's queue, never on this deck's.
  void sweepClosedCopies(ctx).catch((err: unknown) => console.warn(`slides: could not clear closed copies: ${errorText(err)}`))
  await drawAhead(ctx, item, signal)
  return serial(ctx, item, async () => {
    const deck = await deckOf(ctx, item, signal)
    opened?.(ctx, item, deck)
    const pages = await deckDir(ctx, item, 'pages')
    const view = viewFrom(ctx, item, deck, (from, s) => {
      const page = pageOf(pages, from === 'file' ? deck.file : deck.proposed, s)
      return page ? { rev: page.rev, size: page.size } : undefined
    })
    // The file's own layouts: a suggested theme shows on the slides it would change, not in the picker.
    const looks = readOnlyWhy(item) ? undefined : layoutsPic(await deckDir(ctx, item, 'render'), deck.file.info)
    return looks ? { ...view, layoutsPic: looks } : view
  })
}

/**
 * One slide's own picture, by its id in the file or in the proposed deck: the page kept for it, made from the
 * deck's PDF when it is not (a deck drawn before pages were kept one by one).
 */
export async function slidePath(ctx: Ctx, item: CanvasItem, which: 'file' | 'proposed', slideId: number, signal?: AbortSignal): Promise<{ path: string; rev: string }> {
  await drawAhead(ctx, item, signal)
  return serial(ctx, item, async () => {
    const deck = await deckOf(ctx, item, signal)
    const built = which === 'file' ? deck.file : deck.proposed
    if (!built) throw new ItemFileError('No changes wait on this deck.', 'missing')
    if (!built.pdf) throw new ItemFileError(built.renderError ?? 'There is no picture of the slides.', 'not-here')
    const at = built.info.slides.findIndex((s) => s.id === slideId)
    if (at < 0) throw new ItemFileError(`The deck has no slide ${slideId}.`, 'missing')
    const slide = built.info.slides[at]
    const pages = await deckDir(ctx, item, 'pages')
    // An outline with no picture hash (kept by an older script) names its page by the deck and its place.
    const name = pageName(pictureSalt(), slide.draws ?? `${built.key}:${at}`)
    const path = join(pages, `${name}.pdf`)
    if (!existsSync(path)) await splitPdf(built.pdf, built.info.slides.map((_, i) => (i === at ? path : null)))
    return { path, rev: name.slice(0, 16) }
  })
}

/** Tells every client what the deck is now, and answers it. */
export async function announce(ctx: Ctx, item: CanvasItem, signal?: AbortSignal): Promise<DeckView> {
  const view = await viewOf(ctx, item, signal)
  // After any change: the files no waiting edit names any more go (an hour after they came, so one he is adding now stays).
  const attach = deckFolder(ctx, item, 'attach')
  if (existsSync(attach)) sweepAttached(attach, new SlidesStore(ctx.db).pending(deckKey(item)).map((p) => p.op))
  // A deck outside the remote roots: only a socket holding admin (this host's own window holds every capability)
  // hears of it. The push API narrows by capability alone, so an admin key still does; see work-slides.md.
  ctx.push({ push: 'work.slides', sessionId: item.sessionId, view }, pushFor(item))
  // Every other seat on the same deck (a Files tab beside a thread's canvas) is told the same deck as its own item.
  for (const seat of new SlidesStore(ctx.db).seats(deckKey(item))) {
    if (seat.itemId === item.id) continue
    const other = ctx.canvas.get(seat.itemId)
    if (!other) continue
    const { written: _mine, ...rest } = view
    ctx.push({ push: 'work.slides', sessionId: other.sessionId, view: { ...rest, name: nameOf(other, filePathOf(other.source)), ...seatFields(ctx, other) } }, pushFor(other))
  }
  return view
}

/** The render a read is served from: built if it is not yet. */
export async function renderPath(ctx: Ctx, item: CanvasItem, which: 'file' | 'proposed' | 'layouts', signal?: AbortSignal): Promise<{ path: string; rev: string }> {
  await drawAhead(ctx, item, signal)
  if (which === 'layouts') {
    return serial(ctx, item, async () => {
      const deck = await deckOf(ctx, item, signal)
      const at = layoutsPdf(await deckDir(ctx, item, 'render'), deck.file.info)
      if (!at) throw new ItemFileError('There is no picture of the layouts.', 'not-here')
      // Drawn beside the queue when the deck opened; here only where that did not happen (it failed, or was let go).
      if (!existsSync(at.path)) {
        const input = await scratch(ctx, item, 'draw')
        try {
          copyWhole(deck.path, input)
          await drawLayouts(ctx, item, input, at.path, signal)
        } catch (err) {
          if (signal?.aborted) throw err
          throw new ItemFileError(renderErrorOf(err), 'not-here')
        } finally {
          rmSync(input, { force: true })
        }
      }
      touch(at.path)
      return at
    })
  }
  const deck = await serial(ctx, item, () => deckOf(ctx, item, signal))
  const b = which === 'file' ? deck.file : deck.proposed
  if (!b) throw new ItemFileError('No changes wait on this deck.', 'missing')
  if (!b.pdf) throw new ItemFileError(b.renderError ?? 'There is no picture of the slides.', 'not-here')
  return { path: b.pdf, rev: b.key.slice(0, 16) }
}

// ── writes ───────────────────────────────────────────────────────────

/** A kept copy's name: its time, so names sort by age; the deck as it was before TempCode first changed it ends `.first.pptx`. */
const versionName = (first: boolean): string => `${Date.now().toString().padStart(15, '0')}-${randomUUID().slice(0, 4)}${first ? '.first' : ''}.pptx`
export const versionAt = (name: string): number => Number(name.slice(0, 15)) || 0
export const isFirstVersion = (name: string): boolean => name.endsWith('.first.pptx')
/** His own edits keep one copy a minute; an agent's write always keeps its own, for its Undo. */
export const VERSION_EVERY_MS = 60_000

/**
 * Keeps the file as it is before a write, in `history/` (docs/agents/work-slides.md "Versions"): the newest
 * thirty, the first ever for good, and never the one an agent's Undo still points at. `hand`: one of his own
 * edits, which keeps a copy only when the newest is a minute old. Answers the copy's name, or null when none
 * was kept.
 */
export async function keepHistory(ctx: Ctx, item: CanvasItem, path: string, hand = false): Promise<string | null> {
  const dir = await deckDir(ctx, item, 'history')
  const all = readdirSync(dir).filter((f) => f.endsWith('.pptx')).sort()
  if (hand && all.length && Date.now() - versionAt(all[all.length - 1]) < VERSION_EVERY_MS) return null
  const name = versionName(all.length === 0)
  copyWhole(path, join(dir, name))
  const held = new SlidesStore(ctx.db).written(deckKey(item))?.before
  const loose = [...all, name].filter((f) => !isFirstVersion(f) && f !== held)
  for (const old of loose.slice(0, Math.max(0, loose.length - HISTORY_KEPT))) rmSync(join(dir, old), { force: true })
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
    const before = (await keepHistory(ctx, item, base))!
    try {
      replaceKeeping(path, out, was)
    } catch (err) {
      rmSync(join(await deckDir(ctx, item, 'history'), before), { force: true })
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
export function replaceKeeping(path: string, from: string, was: string): void {
  const real = realpathSync(path)
  if (hashFile(real) !== was) throw new Error('The deck changed while this was being made. Nothing was written; look at it again.')
  chmodSync(from, statSync(real).mode & 0o7777)
  copyWhole(from, real)
  // A Files tab's copy of another computer's deck is sent to its file now, with no ask of his window (files/copies.ts).
  fileWritten(real)
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
  const stale = await serial(ctx, item, () =>
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
        store.drop(deckKey(item), chosen.map((p) => p.id))
        const removed = new Set(ops.flatMap((o) => (o.op === 'remove' ? [o.slide] : [])))
        if (!whole) {
          // What still waits is anchored again on the order the strip showed, so the next accept lands there too.
          const now = new Set([...fileOrder, ...ops.flatMap((o) => (o.op === 'add' ? [o.id!] : []))].filter((id) => !removed.has(id)))
          const rest = store.pending(deckKey(item))
          store.rewrite(
            deckKey(item),
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
            deckKey(item),
            store.pending(deckKey(item)).flatMap((p) => ((p.op.op === 'add' || p.op.op === 'move') && removed.has(p.op.after) ? [{ ...p, op: { ...p.op, after: nearest(p.op.after) } }] : []))
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
  await serial(ctx, item, async () => {
    // Checked on the deck's queue, against the deck as it is now, so no edit lands between the check and the drop.
    if (rev !== undefined) checkRev(await deckOf(ctx, item, signal), rev)
    const store = new SlidesStore(ctx.db)
    const pending = store.pending(deckKey(item))
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
    store.rewrite(deckKey(item), moved)
    store.drop(deckKey(item), [...dropped])
  })
}

/** Puts the file back as it was before the agent's direct write, while the file is still what that write left. */
export async function undo(ctx: Ctx, item: CanvasItem, writeId: string): Promise<void> {
  await serial(ctx, item, async () => {
    const store = new SlidesStore(ctx.db)
    const w = writtenFor(ctx, item)
    if (!w || w.id !== writeId) throw new Error('That write can no longer be taken back.')
    const path = await deckPath(ctx, item)
    if (hashFile(path) !== w.after) throw new Error('The deck has changed since that write, so it can no longer be taken back.')
    const copy = join(await deckDir(ctx, item, 'history'), w.before)
    if (!existsSync(copy)) throw new Error('The copy from before that write is gone.')
    replaceKeeping(path, copy, w.after)
    store.setWritten(deckKey(item), rowSession(deckKey(item), item.sessionId), null)
  })
}

// ── seats that leave, files that move ────────────────────────────────

/**
 * What a deck with no seat left must not keep. A file others can open keeps nothing: its waiting edits and its
 * last write go. A file of his own keeps its waiting edits and its versions for the next time it is opened; only
 * its pictures, which can be drawn again, go, after whatever is still drawing them.
 */
function lastSeatLeft(ctx: Pick<WorkCtx, 'db' | 'dataDir'>, key: string, shared: boolean): void {
  if (!key.startsWith('file:')) return
  if (shared) new SlidesStore(ctx.db).removeDeck(key)
  void chained(key, async () => {
    // A seat taken meanwhile keeps its pictures.
    if (new SlidesStore(ctx.db).seats(key).length === 0) rmSync(deckCache(ctx.dataDir, key), { recursive: true, force: true })
  })
}

/**
 * Items were deleted (a Files tab closed, a deleted workspace's panes). Each leaves its seat, and its mode goes
 * with it. A deck only that item held goes with it. On a file others can open, the Undo of a write made from
 * the item goes too: the copy from before was in the item's folder.
 */
export function itemsGone(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, items: readonly CanvasItem[]): void {
  const store = new SlidesStore(ctx.db)
  for (const item of items) {
    if (item.kind !== 'slides') continue
    const shared = deckShared(ctx, item)
    // An item that never took a seat (never opened since decks were kept by the file) leaves the deck's other seats as they are.
    const left = store.unseat(item.id) ?? { deck: deckKey(item), left: store.seats(deckKey(item)).length, shared: shared || store.sharedDeck(deckKey(item)) }
    const key = left.deck
    // Rows still under the item's own id (kept from before decks were kept by the file, and never opened since) go with it.
    store.removeDeck(item.id)
    void dropTabCopy(ctx, item.id, key, () => false)
    if (!key.startsWith('file:')) {
      store.removeDeck(key)
      hands.delete(key)
      stopShow(key)
      continue
    }
    if (store.written(key)?.item === item.id && (shared || left.shared)) store.setWritten(key, '', null)
    if (left.left === 0) lastSeatLeft(ctx, key, shared || left.shared)
  }
}

/**
 * The snapshot of a shared import a tab drew from goes with the tab, on its file's queue (so no conversion is half
 * way into it) and after every picture still being drawn into it: `open` is asked again on the queue, since a tab
 * may open again while this waited.
 */
function dropTabCopy(ctx: Pick<WorkCtx, 'dataDir'>, itemId: string, key: string, open: () => boolean): Promise<void> {
  const dir = tabCache(ctx.dataDir, itemId)
  if (!existsSync(dir)) return Promise.resolve()
  return chained(key, async () => {
    if (open()) return
    stopShow(itemId)
    await Promise.all([...drawing].filter(([pdf]) => pdf.startsWith(`${dir}${sep}`)).map(([, run]) => run.catch(() => {})))
    rmSync(dir, { recursive: true, force: true })
  })
}

/** A thread's tab closes softly (its item stays, closed): the snapshots of closed tabs go when a deck next opens, and when Work starts. */
export async function sweepClosedCopies(ctx: Pick<WorkCtx, 'dataDir' | 'canvas'>): Promise<void> {
  let ids: string[]
  try {
    ids = readdirSync(tabsRoot(ctx.dataDir))
  } catch {
    return
  }
  const open = (id: string): boolean => ctx.canvas.get(id)?.state === 'open'
  await Promise.all(
    ids.filter((id) => !open(id)).map((id) => {
      const item = ctx.canvas.get(id)
      return dropTabCopy(ctx, id, item ? deckKey(item) : id, () => open(id))
    })
  )
}

/**
 * Threads were deleted. A deleted thread's items are not said through `itemsRemoved`, so the seats they held
 * are let go here, by the same rules: the frame deletes the thread's canvas folder itself.
 */
export function sessionsGone(ctx: Pick<WorkCtx, 'db' | 'dataDir'>, sessionIds: readonly string[]): void {
  const store = new SlidesStore(ctx.db)
  const seats = ctx.db.prepare(`SELECT item_id, deck FROM work_slides_seats WHERE session_id IN (${sessionIds.map(() => '?').join(',') || "''"})`).all(...sessionIds) as unknown as Array<{ item_id: string; deck: string }>
  const items = new Set(seats.map((r) => r.item_id))
  for (const seat of seats) void dropTabCopy(ctx, seat.item_id, seat.deck, () => false)
  for (const lost of store.removeSessions(sessionIds)) {
    const w = store.written(lost.deck)
    if (w?.item && items.has(w.item) && lost.shared) store.setWritten(lost.deck, '', null)
    if (lost.left !== 0) continue
    if (!lost.deck.startsWith('file:')) {
      // A deck only its item held (a thread's own, a mail's file): its Undo line and its show's jobs go too.
      store.removeDeck(lost.deck)
      hands.delete(lost.deck)
      stopShow(lost.deck)
    } else lastSeatLeft(ctx, lost.deck, lost.shared)
  }
}

/**
 * A file was renamed or moved under its deck (the files pillar's `registerFileMoved`, inside the rename's own
 * savepoint): the deck's rows and seats take the new path's key and its folder of renders and versions goes with
 * them, so the waiting edits, the mode, Undo and the versions are still the deck's under its new name.
 */
export function fileMoved(from: CanvasSource, to: CanvasSource, at: { db: WorkCtx['db']; dataDir: string }): void {
  const [a, b] = [filePathOf(from), filePathOf(to)]
  if (a === null || b === null) return
  // The file is already at its new place or still at its old one: either way the key is of the path as named.
  const [was, now] = [`file:${a}`, fileKey(b)]
  const keys = new Set([was, fileKey(a)])
  const store = new SlidesStore(at.db)
  for (const key of keys) {
    if (key === now) continue
    store.rekey(key, now)
    handMoved(key, now)
    for (const folder of [deckBase, deckCache]) {
      const [old, next] = [folder(at.dataDir, key), folder(at.dataDir, now)]
      if (existsSync(old) && !existsSync(next)) renameSync(old, next)
    }
  }
}
