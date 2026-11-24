import { createHash, randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'
import type { FilePreview } from '@shared/contract-work-files'
import { canvasSourcePath, type CanvasSource } from '@shared/work'
import { extOf, kindOfEntry, refKey } from '@shared/work/files'
import { NoConverterError, NotReadyError, type Converter } from '../formats/jobs'
import { runTool } from '../formats/tools'
import { frameArgs, stillArgs } from '../media/encode'
import type { Caller, WorkCtx } from '../modules'
import { isGuestPath } from '../office/vm/files'
import { filePreviewerFor } from './hooks'
import { bytesHere } from './places/disk'
import { librariesHere } from './places/libraries'
import { locate, sharedOf } from './policy'
import { gridPage, pngSize, textPage, type Sketch } from './sketch'
import { zipEntry } from './zipdir'

/**
 * Previews and thumbnails of files (docs/agents/work-files.md "Previews"): `work.files.preview` (one page at a
 * width) and `work.files.thumbs` (a small picture of each file), PNGs made on the file's own host.
 *
 * Who gets one: a file is located for its caller (`locate`) before a render and again before the answer, so a
 * file that moved out of reach meanwhile answers nothing. A thread gets nothing, ever. A file whose bytes are
 * in the cloud is never read. A shared library's file (one others can open) is drawn only for his window on
 * this host, only in memory, and its scratch files go when the render ends; his own places' pictures are kept
 * on disk under `<userData>/work-files/previews/`, which no backup takes. A file on another computer or in
 * the Windows VM answers a plain tile: `{ none }`, null in `thumbs`.
 *
 * Where a picture comes from, cheapest first (a kind's registered previewer before all): a picture scaled; an
 * Office file's own thumbnail from its zip; the Mac's thumbnailer; a PDF's page (the pdf pillar's pypdfium2);
 * an Office or OpenDocument file through LibreOffice to PDF, on this host only; a video's frame (ffmpeg); a
 * text file's head, a `.tcdoc`'s first lines and a `.tcsheet`'s first cells, drawn here (sketch.ts).
 */

/** The wire's bounds ("The wire": 2 MB a picture, 20 pages, 40 asks waiting per caller). */
export const PREVIEW_PNG_MAX = 2 * 1024 * 1024
export const PREVIEW_PAGES_MAX = 20
export const WAITING_MAX = 40
export const RENDERS_AT_ONCE = 2
/** His own places' pictures on disk: kept 30 days since last used, 2 GB at most, least used first out. */
export const CACHE_DAYS = 30
export const CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024
/** A shared library's pictures, in memory only. */
export const MEMORY_MAX_BYTES = 256 * 1024 * 1024
/** The most of a file read in this process for a picture to scale, a text's head, a zip's entry. */
const DECODE_MAX = 64 * 1024 * 1024
const TEXT_HEAD = 16 * 1024
const DAY = 24 * 60 * 60 * 1000

export const previewsDir = (dataDir: string): string => join(dataDir, 'work-files', 'previews')
/** Each render's scratch folder lies under this one, and goes when the render ends; whatever a dead process left goes at the module's start. */
export const previewScratch = (dataDir: string): string => join(dataDir, 'work-files', 'preview-scratch')

/** The one sentence a tile shows where there is no picture. */
export const NO_PREVIEW = {
  thread: 'Threads get no previews.',
  elsewhere: 'It is on another computer.',
  vm: 'It is in the Windows VM.',
  cloud: 'It is kept in the cloud.',
  sharedHere: 'A shared file is previewed only on its own computer.',
  none: 'There is no preview of this file.',
  tool: 'This computer has no tool to draw it.',
  big: 'Its preview is too large.',
  busy: 'Too many previews are waiting.',
  gone: 'It is not there any more.',
  changed: 'It changed while it was drawn.',
  reach: 'It is out of reach.',
  folder: 'A folder has no preview.',
  page: (n: number): string => `It has no page ${n}.`
} as const

/**
 * What a test stands in for (as write.ts's `writeSeams`): `scale` decodes a PNG or JPEG and fits it in a square
 * (Electron's `nativeImage` in the app); `quickLook` is the Mac's `qlmanage -t`; `platform` says which system
 * this is; `rendered` runs after a render, before the second look at the file.
 */
export const previewSeams: {
  scale?: (bytes: Buffer, edge: number) => Promise<Sketch | null>
  quickLook?: (path: string, edge: number, dir: string, signal?: AbortSignal) => Promise<Buffer | null>
  platform?: string
  rendered?: (path: string) => Promise<void> | void
} = {}

export type Want = { thumb: number } | { page: number; width: number }
export interface Rendered {
  png: Buffer
  pages: number
  width: number
  height: number
  /** which source drew it (not on the wire) */
  via: string
  /** the file's version it is of (`previewOne`'s answer only; not kept with the picture) */
  version?: string
}
type None = { none: string }
const isNone = (r: unknown): r is None => typeof r === 'object' && r !== null && 'none' in r

/** A file located for its caller, with what decides where its picture is kept. */
interface Target {
  path: string
  name: string
  source: CanvasSource
  key: string
  /** size, change time and inode: a changed file is a new version, and renders again */
  version: string
  /** others can open it: memory only, his window only */
  shared: boolean
  /** the library it lies in, so its pictures go when the library is turned off */
  library: string | null
}

// ── who asks, and what ─────────────────────────────────────────────────

/** Locates a file for a caller and says whether a picture of it may be made here, reading none of its bytes. */
async function targetOf(ctx: WorkCtx, by: Caller, workspaceId: string, ref: CanvasSource, method: string): Promise<Target | None> {
  if (by.kind === 'model') return { none: NO_PREVIEW.thread }
  const named = canvasSourcePath(ref)
  if (named === null) return { none: NO_PREVIEW.none }
  if ((ref as { host: string }).host !== ctx.host) return { none: NO_PREVIEW.elsewhere }
  if (isGuestPath(named) && process.platform !== 'win32') return { none: NO_PREVIEW.vm }
  let at: ReturnType<typeof locate>
  try {
    at = locate(ctx, by, workspaceId, ref, method)
  } catch (err) {
    return { none: err instanceof Error && / is not there any more\.$/.test(err.message) ? NO_PREVIEW.gone : NO_PREVIEW.reach }
  }
  if (at.in === 'place' || at.in === 'drive') return { none: NO_PREVIEW.none }
  if (at.in === 'library' && at.library.vm) return { none: NO_PREVIEW.vm }
  const source: CanvasSource = { at: 'file', host: ctx.host, path: at.path }
  const shared = at.in === 'library' || sharedOf(ctx, source)
  // A shared file's picture goes to his own window on this host alone: never a remote key, the phone or another host.
  if (shared && by.kind !== 'local') return { none: NO_PREVIEW.sharedHere }
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(at.path)
  } catch {
    return { none: NO_PREVIEW.gone }
  }
  if (info.isDirectory()) return { none: NO_PREVIEW.folder }
  if (!info.isFile()) return { none: NO_PREVIEW.none }
  // Reading a cloud-only file would download it: nothing of it is read.
  if (!bytesHere(info)) return { none: NO_PREVIEW.cloud }
  return {
    path: at.path,
    name: basename(at.path),
    source,
    key: refKey(source),
    version: `${info.size}:${Math.round(info.mtimeMs)}:${info.ino}`,
    shared,
    library: at.in === 'library' ? at.library.id : null
  }
}

/** Whose queue an ask waits in: his window, one key, one other host. */
const callerKey = (by: Caller): string => (by.kind === 'local' ? 'local' : by.peer ? `peer:${by.peer}` : `key:${by.keyId ?? 'remote'}`)

// ── the queue: two renders at a time, 40 asks waiting per caller ──────

const DROPPED = Symbol('dropped')
type Ask = { caller: string; go: () => void; drop: () => void }

export class RenderQueue {
  private running = 0
  private readonly waiting: Ask[] = []
  constructor(
    private readonly atOnce = RENDERS_AT_ONCE,
    private readonly perCaller = WAITING_MAX
  ) {}

  /** Runs `fn` when a slot is free; an ask pushed out by a caller's newer ones, or cancelled while it waits, answers `DROPPED`. */
  async run<T>(caller: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T | typeof DROPPED> {
    if (signal?.aborted) return DROPPED
    if (this.running < this.atOnce) this.running++
    else {
      const got = await new Promise<boolean>((resolve) => {
        const ask: Ask = { caller, go: () => resolve(true), drop: () => resolve(false) }
        const mine = this.waiting.filter((w) => w.caller === caller)
        // The caller's oldest waiting ask makes room: the rows he scrolled past are the ones he no longer sees.
        if (mine.length >= this.perCaller) this.drop(mine[0]!)
        this.waiting.push(ask)
        signal?.addEventListener('abort', () => this.drop(ask), { once: true })
      })
      if (!got) return DROPPED
    }
    try {
      return await fn()
    } finally {
      const next = this.waiting.shift()
      if (next) next.go()
      else this.running--
    }
  }

  private drop(ask: Ask): void {
    const i = this.waiting.indexOf(ask)
    if (i < 0) return
    this.waiting.splice(i, 1)
    ask.drop()
  }

  /** How many run and wait now, for a test. */
  get load(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length }
  }
}

// ── what is kept ───────────────────────────────────────────────────────

interface Remembered {
  png: Buffer
  pages: number
  width: number
  height: number
  library: string | null
}
interface PreviewState {
  queue: RenderQueue
  /** a shared library's pictures, least used first (a Map keeps its order: a hit goes to the end) */
  memory: Map<string, Remembered>
  memoryBytes: number
  /** renders under way, by what they make: a second ask for the same picture waits for the first */
  inflight: Map<string, Promise<Rendered | None | typeof DROPPED>>
  /** a PDF's page count by file and version */
  pages: Map<string, number>
  /** what the disk cache holds, as last summed; a prune runs when a write takes it past the cap */
  diskBytes: number | null
}
const states = new WeakMap<DatabaseSync, PreviewState>()
function stateOf(db: DatabaseSync): PreviewState {
  let s = states.get(db)
  if (!s) states.set(db, (s = { queue: new RenderQueue(), memory: new Map(), memoryBytes: 0, inflight: new Map(), pages: new Map(), diskBytes: null }))
  return s
}

/** What memory holds now, for a test and the log. */
export function previewMemory(db: DatabaseSync): { count: number; bytes: number; libraries: (string | null)[] } {
  const s = stateOf(db)
  return { count: s.memory.size, bytes: s.memoryBytes, libraries: [...s.memory.values()].map((m) => m.library) }
}
export const previewQueue = (db: DatabaseSync): RenderQueue => stateOf(db).queue

function forget(s: PreviewState, key: string): void {
  const was = s.memory.get(key)
  if (!was) return
  s.memory.delete(key)
  s.memoryBytes -= was.png.length
}

/** A library he turned off (or that left this host) takes its pictures with it; `libraryId` drops one library's at once. */
export function dropLibraryPreviews(ctx: Pick<WorkCtx, 'db' | 'host'>, libraryId?: string): void {
  const s = stateOf(ctx.db)
  if (!s.memory.size) return
  const on = libraryId === undefined ? new Set(librariesHere(ctx).map((l) => l.id)) : null
  for (const [key, m] of s.memory) if (m.library !== null && (libraryId !== undefined ? m.library === libraryId : !on!.has(m.library))) forget(s, key)
}

function remember(s: PreviewState, key: string, r: Rendered, library: string | null): void {
  if (r.png.length > MEMORY_MAX_BYTES) return
  forget(s, key)
  s.memory.set(key, { png: r.png, pages: r.pages, width: r.width, height: r.height, library })
  s.memoryBytes += r.png.length
  for (const [old] of s.memory) {
    if (s.memoryBytes <= MEMORY_MAX_BYTES) break
    forget(s, old)
  }
}

const hash = (...parts: string[]): string => createHash('sha256').update(parts.join('\0')).digest('hex')
/** A kept picture is two bytes of its page count, then the PNG. */
const cacheFile = (dataDir: string, key: string): string => join(previewsDir(dataDir), `${key}.png`)

async function fromDisk(dataDir: string, key: string): Promise<Rendered | null> {
  const file = cacheFile(dataDir, key)
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch {
    return null
  }
  const png = bytes.subarray(2)
  const size = pngSize(png)
  if (!size) return null
  // Its use is its time: the prune takes the least used first.
  const now = new Date()
  await utimes(file, now, now).catch(() => {})
  return { png, pages: bytes.readUInt16BE(0), ...size, via: 'cache' }
}

async function toDisk(dataDir: string, s: PreviewState, key: string, r: Rendered): Promise<void> {
  const dir = previewsDir(dataDir)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const head = Buffer.alloc(2)
  head.writeUInt16BE(Math.min(r.pages, 0xffff), 0)
  const temp = join(dir, `.${key}.${randomUUID()}.tmp`)
  await writeFile(temp, Buffer.concat([head, r.png]), { mode: 0o600 })
  await rename(temp, cacheFile(dataDir, key))
  if (s.diskBytes !== null) s.diskBytes += r.png.length + 2
  if (s.diskBytes === null || s.diskBytes > CACHE_MAX_BYTES) s.diskBytes = (await prunePreviews(dataDir)).bytes
}

/**
 * The disk cache pruned: what was not used in 30 days goes, then the least used until it holds 2 GB at most.
 * Run at the module's start, once a day, and when a write takes it past the cap.
 */
export async function prunePreviews(dataDir: string, o: { now?: number; max?: number; days?: number } = {}): Promise<{ removed: number; bytes: number }> {
  const dir = previewsDir(dataDir)
  const now = o.now ?? Date.now()
  const max = o.max ?? CACHE_MAX_BYTES
  const oldest = now - (o.days ?? CACHE_DAYS) * DAY
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { removed: 0, bytes: 0 }
  }
  const files: { path: string; used: number; size: number }[] = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      const s = await stat(path)
      if (s.isFile()) files.push({ path, used: s.mtimeMs, size: s.size })
    } catch {
      // Gone already.
    }
  }
  files.sort((a, b) => a.used - b.used)
  let bytes = files.reduce((n, f) => n + f.size, 0)
  let removed = 0
  for (const f of files) {
    if (f.used >= oldest && bytes <= max) break
    await unlink(f.path).catch(() => {})
    bytes -= f.size
    removed++
  }
  return { removed, bytes }
}

/** What a dead process left in the scratch folder goes. */
export const clearPreviewScratch = async (dataDir: string): Promise<void> => rm(previewScratch(dataDir), { recursive: true, force: true })

// ── the sources ────────────────────────────────────────────────────────

interface Render {
  ctx: WorkCtx
  t: Target
  want: Want
  /** this render's own scratch folder */
  dir: string
  signal?: AbortSignal
  /** a converter this host lacks was needed: a plain tile says so */
  noTool: boolean
}
type Drawn = Rendered | None | null

const pageOf = (want: Want): number => ('page' in want ? want.page : 1)
/** A picture's longest edge, or a page's width. */
const edgeOf = (want: Want): number => ('thumb' in want ? want.thumb : want.width)

/** One job on this host's runner, never forwarded to another (`here`); a shared file's job says so too. False where it made nothing. */
async function convertHere(r: Render, job: { from: string; to: string; input: string; output: string; options?: Record<string, unknown> }): Promise<boolean> {
  try {
    await r.ctx.convert({ ...job, here: true, ...(r.t.shared ? { shared: true } : {}), ...(r.signal ? { signal: r.signal } : {}) })
  } catch (err) {
    if (err instanceof NoConverterError || err instanceof NotReadyError) r.noTool = true
    else r.ctx.log(`files: a preview of ${r.t.name} could not be drawn: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
  return existsSync(job.output)
}

const asRendered = (png: Buffer, pages: number, via: string): Rendered | null => {
  const size = pngSize(png)
  return size ? { png, pages, ...size, via } : null
}

/** Up to `max` bytes from a file's start, never through a link. */
async function readHead(path: string, max: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const buf = Buffer.alloc(max)
    const { bytesRead } = await file.read(buf, 0, max, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

const SCALED_HERE = new Set(['png', 'jpg', 'jpeg'])
/** What LibreOffice turns into a PDF (the formats pillar's families). */
const LIBREOFFICE = new Set(['docx', 'odt', 'rtf', 'doc', 'pptx', 'odp', 'ppt', 'xlsx', 'ods', 'xls', 'csv'])
/** Where an Office or OpenDocument file keeps its own small picture. */
const OWN_THUMB: Record<string, string> = Object.fromEntries([
  ...['docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm'].map((ext) => [ext, 'docProps/thumbnail.jpeg']),
  ...['odt', 'ods', 'odp'].map((ext) => [ext, 'Thumbnails/thumbnail.png'])
])

interface Source {
  name: string
  /** draws any page at any width: a preview asks these first, and the small pictures a file carries only for its first page when none drew */
  pages: boolean
  applies(t: Target): boolean
  draw(r: Render): Promise<Drawn>
}

const kindOf = (t: Target): string => kindOfEntry(t.name).kind

const picture: Source = {
  name: 'picture',
  pages: true,
  applies: (t) => kindOf(t) === 'picture',
  async draw(r) {
    if (pageOf(r.want) > 1) return { none: NO_PREVIEW.page(pageOf(r.want)) }
    const ext = extOf(r.t.name)
    if (SCALED_HERE.has(ext) && previewSeams.scale) {
      const info = await stat(r.t.path)
      if (info.size <= DECODE_MAX) {
        const scaled = await previewSeams.scale(await readHead(r.t.path, DECODE_MAX), edgeOf(r.want))
        if (scaled) return { ...scaled, pages: 1, via: 'picture' }
      }
    }
    // Every other picture (and one Electron could not decode) is scaled by ffmpeg, a separate process.
    const out = join(r.dir, 'scaled.png')
    if (!(await convertHere(r, { from: 'image', to: 'scaled.png', input: r.t.path, output: out, options: { edge: edgeOf(r.want) } }))) return null
    return asRendered(await readFile(out), 1, 'picture')
  }
}

const ownThumb: Source = {
  name: 'zip-thumbnail',
  pages: false,
  applies: (t) => extOf(t.name) in OWN_THUMB,
  async draw(r) {
    const bytes = await zipEntry(r.t.path, OWN_THUMB[extOf(r.t.name)]!, PREVIEW_PNG_MAX)
    if (!bytes) return null
    const scaled = previewSeams.scale ? await previewSeams.scale(bytes, edgeOf(r.want)) : null
    if (scaled) return { ...scaled, pages: 1, via: 'zip-thumbnail' }
    // An OpenDocument thumbnail is a PNG already; a JPEG needs the decoder.
    return asRendered(bytes, 1, 'zip-thumbnail')
  }
}

const quickLook: Source = {
  name: 'quicklook',
  pages: false,
  // Never for a shared file: the Mac's thumbnail service may keep its own picture of it on disk.
  applies: (t) => (previewSeams.platform ?? process.platform) === 'darwin' && kindOf(t) !== 'text' && !t.shared,
  async draw(r) {
    const look = previewSeams.quickLook ?? qlmanage
    const png = await look(r.t.path, edgeOf(r.want), r.dir, r.signal)
    return png ? asRendered(png, 1, 'quicklook') : null
  }
}

async function qlmanage(path: string, edge: number, dir: string, signal?: AbortSignal): Promise<Buffer | null> {
  const out = join(dir, 'ql')
  await mkdir(out, { recursive: true })
  const r = await runTool('/usr/bin/qlmanage', ['-t', '-s', String(edge), '-o', out, path], { timeoutMs: 30_000, gentle: true, ...(signal ? { signal } : {}) })
  const made = join(out, `${basename(path)}.png`)
  return r.code === 0 && existsSync(made) ? readFile(made) : null
}

/** A PDF's page through the pdf pillar's pypdfium2, with the page count a preview needs (kept by file and version). */
async function pdfPage(r: Render, input: string, via: string): Promise<Drawn> {
  const page = pageOf(r.want)
  let pages = 1
  if ('page' in r.want) {
    const s = stateOf(r.ctx.db)
    const known = hash(r.t.key, r.t.version, 'pages')
    let count = s.pages.get(known)
    if (count === undefined) {
      const out = join(r.dir, 'count.json')
      if (!(await convertHere(r, { from: 'pdf', to: 'extract', input, output: out, options: { pages: '1', tables: false, maxPages: 1 } }))) return null
      count = Number((JSON.parse(await readFile(out, 'utf8')) as { pages?: number }).pages) || 0
      if (s.pages.size > 2000) s.pages.delete(s.pages.keys().next().value!)
      s.pages.set(known, count)
    }
    pages = Math.min(count, PREVIEW_PAGES_MAX)
    if (page > pages) return { none: NO_PREVIEW.page(page) }
  }
  const out = join(r.dir, `page-${page}.png`)
  if (!(await convertHere(r, { from: 'pdf', to: 'png', input, output: out, options: { page, width: edgeOf(r.want) } }))) return null
  return asRendered(await readFile(out), pages, via)
}

const pdf: Source = {
  name: 'pdf',
  pages: true,
  applies: (t) => extOf(t.name) === 'pdf',
  draw: (r) => pdfPage(r, r.t.path, 'pdf')
}

const office: Source = {
  name: 'libreoffice',
  pages: true,
  applies: (t) => LIBREOFFICE.has(extOf(t.name)),
  async draw(r) {
    // His own file's PDF is kept beside its pictures, so its next page is one draw; a shared file's is scratch.
    const kept = r.t.shared ? null : join(previewsDir(r.ctx.dataDir), `${hash(r.t.key, r.t.version, 'pdf')}.pdf`)
    let input = kept && existsSync(kept) ? kept : null
    if (!input) {
      const out = join(r.dir, 'converted.pdf')
      if (!(await convertHere(r, { from: extOf(r.t.name), to: 'pdf', input: r.t.path, output: out }))) return null
      input = out
      if (kept) {
        await mkdir(previewsDir(r.ctx.dataDir), { recursive: true, mode: 0o700 })
        await rename(out, kept).then(
          () => void (input = kept),
          () => {}
        )
      }
    }
    return pdfPage(r, input, 'libreoffice')
  }
}

const video: Source = {
  name: 'video',
  pages: true,
  applies: (t) => kindOf(t) === 'video',
  async draw(r) {
    if (pageOf(r.want) > 1) return { none: NO_PREVIEW.page(pageOf(r.want)) }
    const out = join(r.dir, 'frame.png')
    if (!(await convertHere(r, { from: 'video', to: 'frame.png', input: r.t.path, output: out, options: { at: 1, edge: edgeOf(r.want) } }))) return null
    return asRendered(await readFile(out), 1, 'video')
  }
}

const text: Source = {
  name: 'text',
  pages: true,
  applies: (t) => kindOf(t) === 'text',
  async draw(r) {
    if (pageOf(r.want) > 1) return { none: NO_PREVIEW.page(pageOf(r.want)) }
    const head = await readHead(r.t.path, TEXT_HEAD)
    // A NUL is no text: it is drawn as nothing rather than as noise.
    if (head.includes(0)) return null
    return { ...textPage(head.toString('utf8'), edgeOf(r.want)), pages: 1, via: 'text' }
  }
}

const tcdoc: Source = {
  name: 'tcdoc',
  pages: true,
  applies: (t) => extOf(t.name) === 'tcdoc',
  async draw(r) {
    if (pageOf(r.want) > 1) return { none: NO_PREVIEW.page(pageOf(r.want)) }
    // The documents service keeps the words as markdown beside the document's state: its first lines are the page.
    const md = await zipEntry(r.t.path, 'preview.md', 256 * 1024)
    return { ...textPage(md?.toString('utf8') ?? '', edgeOf(r.want), { title: true }), pages: 1, via: 'tcdoc' }
  }
}

const tcsheet: Source = {
  name: 'tcsheet',
  pages: true,
  applies: (t) => extOf(t.name) === 'tcsheet',
  async draw(r) {
    if (pageOf(r.want) > 1) return { none: NO_PREVIEW.page(pageOf(r.want)) }
    return { ...gridPage(await sheetCells(r.t.path), edgeOf(r.want)), pages: 1, via: 'tcsheet' }
  }
}

/** A `.tcsheet`'s first sheet's top left cells, from its last snapshot: `meta.json` names it, `snapshots/<rev>.json.gz` holds it. */
export async function sheetCells(path: string, rows = 40, cols = 6): Promise<(string | number | null)[][]> {
  try {
    const meta = JSON.parse((await zipEntry(path, 'meta.json', 64 * 1024))?.toString('utf8') ?? '{}') as { snapRev?: number }
    const gz = await zipEntry(path, `snapshots/${Number(meta.snapRev) || 0}.json.gz`, DECODE_MAX)
    if (!gz) return []
    const book = JSON.parse(gunzipSync(gz, { maxOutputLength: DECODE_MAX }).toString('utf8')) as { sheetOrder?: string[]; sheets?: Record<string, { cellData?: Record<string, Record<string, { v?: unknown }>> }> }
    const first = book.sheetOrder?.[0]
    const data = (first && book.sheets?.[first]?.cellData) || {}
    return Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => {
        const v = data[r]?.[c]?.v
        return typeof v === 'number' || typeof v === 'string' ? v : v === undefined || v === null ? null : String(v)
      })
    )
  } catch {
    return []
  }
}

/** Every source, cheapest first. */
export const PREVIEW_SOURCES: readonly Source[] = [picture, ownThumb, quickLook, pdf, office, video, text, tcdoc, tcsheet]

/** A kind's registered previewer (`registerFilePreviewer`), asked before every source of ours. */
async function registered(r: Render): Promise<Drawn> {
  const canvas = kindOfEntry(r.t.name).canvas
  const fn = canvas ? filePreviewerFor(canvas) : null
  if (!fn) return null
  const got = await fn(r.t.source, { page: pageOf(r.want), width: edgeOf(r.want), ...(r.signal ? { signal: r.signal } : {}) })
  if (!got) return null
  const png = Buffer.from(got instanceof Uint8Array ? got : got.png)
  return asRendered(png, got instanceof Uint8Array ? 1 : Math.min(got.pages, PREVIEW_PAGES_MAX), 'registered')
}

/** The sources in the order this ask tries them: a thumbnail cheapest first; a page from the sources that draw pages, then the small pictures a file carries for its first page. */
export function sourcesFor(t: Target | { name: string }, want: Want): Source[] {
  const all = PREVIEW_SOURCES.filter((s) => s.applies(t as Target))
  if ('thumb' in want) return all
  return [...all.filter((s) => s.pages), ...(want.page === 1 ? all.filter((s) => !s.pages) : [])]
}

async function draw(ctx: WorkCtx, t: Target, want: Want, signal?: AbortSignal): Promise<Rendered | None> {
  const dir = join(previewScratch(ctx.dataDir), randomUUID())
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const r: Render = { ctx, t, want, dir, noTool: false, ...(signal ? { signal } : {}) }
  try {
    const first = await registered(r)
    if (first) return first
    for (const source of sourcesFor(t, want)) {
      if (signal?.aborted) return { none: NO_PREVIEW.busy }
      let got: Drawn = null
      try {
        got = await source.draw(r)
      } catch (err) {
        ctx.log(`files: ${source.name} could not draw ${t.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (got) return got
    }
    return { none: r.noTool ? NO_PREVIEW.tool : NO_PREVIEW.none }
  } finally {
    // Scratch goes when the render ends, whatever it made: a shared file leaves nothing on disk.
    await rm(dir, { recursive: true, force: true })
  }
}

// ── the asks ───────────────────────────────────────────────────────────

const variantOf = (want: Want): string => ('thumb' in want ? `t${want.thumb}` : `p${want.page}w${want.width}`)

/** One picture of one file for one caller: located, drawn or found, located again, then answered. */
export async function previewOne(ctx: WorkCtx, by: Caller, workspaceId: string, ref: CanvasSource, want: Want, method: string, signal?: AbortSignal): Promise<Rendered | None> {
  const s = stateOf(ctx.db)
  dropLibraryPreviews(ctx)
  const t = await targetOf(ctx, by, workspaceId, ref, method)
  if (isNone(t)) return t
  // A kind that registers its own previewer draws again: what our sources drew before is another picture.
  const canvas = kindOfEntry(t.name).canvas
  const key = hash(t.key, t.version, variantOf(want), canvas && filePreviewerFor(canvas) ? 'registered' : '')
  let got: Rendered | None | typeof DROPPED | null = null
  const kept = t.shared ? s.memory.get(key) : null
  if (kept) {
    // Used: to the end of the order, so the least used goes first.
    s.memory.delete(key)
    s.memory.set(key, kept)
    got = { ...kept, via: 'memory' }
  } else if (!t.shared) got = await fromDisk(ctx.dataDir, key)
  let fresh = false
  if (!got) {
    let job = s.inflight.get(key)
    if (!job) {
      job = s.queue.run(callerKey(by), () => draw(ctx, t, want, signal), signal)
      s.inflight.set(key, job)
      void job.finally(() => s.inflight.delete(key)).catch(() => {})
    }
    got = await job
    fresh = true
  }
  if (got === DROPPED) return { none: NO_PREVIEW.busy }
  if (isNone(got)) return got
  if (got.png.length > PREVIEW_PNG_MAX) return { none: NO_PREVIEW.big }
  await previewSeams.rendered?.(t.path)
  // The second look: a file that moved out of this caller's reach during the render answers nothing, and is kept nowhere.
  const again = await targetOf(ctx, by, workspaceId, ref, method)
  if (isNone(again) || again.path !== t.path) return { none: NO_PREVIEW.reach }
  // A file whose bytes or sharing changed during the render: the picture is of what it was, answered to no one and
  // kept nowhere (a file now shared must leave nothing on disk).
  if (again.version !== t.version || again.shared !== t.shared) return { none: NO_PREVIEW.changed }
  if (fresh) {
    if (t.shared) remember(s, key, got, t.library)
    else await toDisk(ctx.dataDir, s, key, got).catch((err) => ctx.log(`files: a preview could not be kept: ${err instanceof Error ? err.message : String(err)}`))
  }
  return { ...got, version: t.version }
}

/** `work.files.preview`: one page of a file at a width. */
export async function previewOf(ctx: WorkCtx, by: Caller, p: { workspaceId: string; ref: CanvasSource; page?: number; width: number }, method: string, signal?: AbortSignal): Promise<FilePreview> {
  const got = await previewOne(ctx, by, p.workspaceId, p.ref, { page: p.page ?? 1, width: p.width }, method, signal)
  // The version, as a digest: a pager pins it, and a page of another version (saved between two reads) starts it over.
  return isNone(got) ? got : { png: got.png.toString('base64'), pages: got.pages, width: got.width, height: got.height, ...(got.version ? { version: hash(got.version).slice(0, 16) } : {}) }
}

/** `work.files.thumbs`: a small picture of each file, null where there is none to show. */
export async function thumbsOf(ctx: WorkCtx, by: Caller, p: { workspaceId: string; refs: CanvasSource[]; size: number }, method: string, signal?: AbortSignal): Promise<{ thumbs: (string | null)[] }> {
  const got = await Promise.all(p.refs.map((ref) => previewOne(ctx, by, p.workspaceId, ref, { thumb: p.size }, method, signal).catch(() => null)))
  return { thumbs: got.map((g) => (g && !isNone(g) ? g.png.toString('base64') : null)) }
}

// ── the converters Files registers (`WorkModule.convert`) ─────────────

const edgeOption = (v: unknown): number => Math.max(16, Math.min(2048, Math.round(Number(v) || 256)))

/**
 * ffmpeg's two jobs for a preview, each a separate process on the runner: a video's frame a second in (its
 * first frame when it is shorter), and a picture this process cannot decode scaled to fit. PNG out.
 */
export const PREVIEW_CONVERTERS: Converter[] = [
  {
    from: 'video',
    to: 'frame.png',
    needs: 'ffmpeg',
    threads: 2,
    async run(job, run) {
      const ffmpeg = run.tools.bin('ffmpeg')!
      const maxSide = edgeOption(job.options?.edge)
      const at = Math.max(0, Math.min(86_400, Number(job.options?.at) || 0))
      let r = await run.run(ffmpeg, frameArgs({ input: job.input, output: job.output, at, maxSide }), { timeoutMs: 60_000, gentle: true })
      if (r.code !== 0 || !existsSync(job.output)) r = await run.run(ffmpeg, stillArgs({ input: job.input, output: job.output, threads: run.threads, maxSide }), { timeoutMs: 60_000, gentle: true })
      if (r.code !== 0 || !existsSync(job.output)) throw new Error('ffmpeg could not take a frame')
      return {}
    }
  },
  {
    from: 'image',
    to: 'scaled.png',
    needs: 'ffmpeg',
    threads: 1,
    async run(job, run) {
      const r = await run.run(run.tools.bin('ffmpeg')!, stillArgs({ input: job.input, output: job.output, threads: run.threads, maxSide: edgeOption(job.options?.edge) }), { timeoutMs: 60_000, gentle: true })
      if (r.code !== 0 || !existsSync(job.output)) throw new Error('ffmpeg could not scale the picture')
      return {}
    }
  }
]

/** Electron's own decoder, in this process: a PNG or JPEG fitted in a square of `edge`, never enlarged. Null where it cannot decode. */
export async function electronScale(bytes: Buffer, edge: number): Promise<Sketch | null> {
  try {
    const electron = (await import('electron')) as unknown as { nativeImage?: typeof import('electron').nativeImage }
    const native = electron.nativeImage
    if (!native) return null
    let img = native.createFromBuffer(bytes)
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    const k = Math.min(1, edge / Math.max(width, height))
    if (k < 1) img = img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: 'good' })
    return { png: img.toPNG(), ...img.getSize() }
  } catch {
    return null
  }
}
previewSeams.scale = electronScale
