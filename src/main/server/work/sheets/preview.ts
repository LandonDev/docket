import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IWorkbookData } from '@univerjs/core'
import { PDFDocument } from 'pdf-lib'
import { THUMB_SIZES } from '@shared/contract-work-files'
import { SHEET_LOAD_MAX, SHEET_PREVIEW_PAGES, type SheetExportAnswer, type SheetPreviewAnswer, type SheetPreviewFormat } from '@shared/contract-work-sheets'
import type { CanvasItem, CanvasSource } from '@shared/work'
import { sharedOf } from '../files/policy'
import type { FilePreviewer } from '../files/hooks'
import { libreOffice } from '../formats/index'
import type { Converter } from '../formats/jobs'
import type { WorkCtx } from '../modules'
import { chartsOf, heldOf, host, sharedPreviews, sharedPreviewsRoot, storeKey, type Held, type Sheets } from './held'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { notWorkedOut, unworkedIn } from './jobs'
import { workbookMap } from './patch/patch'
import { readText, readZip, writeZip } from './patch/zip'
import { factsOfPackage, factsOfWorkbook, fitOf, sheetDrops, sheetFor, type BookFacts } from './previewFacts'
import type { SheetRef } from './host/wire'
import { writeXlsxWhole } from './writer'

/**
 * Preview and export for a sheet (docs/agents/work-sheets.md "Preview and
 * export"): the workbook drawn as each format makes it, on the host that
 * holds the file, for the Preview frame. The workbook is the package as its
 * revision stands, or for a sheet the service holds the .xlsx the model
 * writer makes of it. LibreOffice draws it to PDF through the conversion
 * runner; an OpenDocument or Excel 97-2003 picture is drawn from the exported
 * file itself. Renders and exported files are kept by content hash, bounded,
 * and read by range at one `rev`. A file others can open keeps its own in
 * its item's folder alone, which goes with the item, and none of its work
 * leaves this host.
 */

const GONE = 'That preview is gone: draw it again.'
/** Kept renders: at most this many, and this many bytes; the least used go first. */
export const STORE_MAX = { count: 64, bytes: 1024 * 1024 * 1024 }
/** An item's own store (a shared file's) is smaller: it goes with the tab. */
export const ITEM_STORE_MAX = { count: 16, bytes: 256 * 1024 * 1024 }
/** A web page larger than this is not drawn in the frame; exporting it still works. */
const HTML_MAX = 4 * 1024 * 1024
/** What the column says of a draw that stopped at page `to`: the frame's count is of what it holds, plus one, and this is the one fact that count hides. */
export const moreThan = (to: number): string => `Prints on more than ${to.toLocaleString('en-US')} pages`
/** Files' largest thumbnail: at or under it the sheet draws nothing of its own. */
const THUMB_MAX = Math.max(...THUMB_SIZES)
/** A table picture shows this many rows of the sheet. */
export const TABLE_ROWS = 500
/** "Draw all" with no count known: the first ask of a capped forward. */
const ALL_CAPPED_FIRST = 400

const hashOf = (...parts: (string | Uint8Array | number | undefined)[]): string => {
  const h = createHash('sha256')
  for (const p of parts) h.update(p === undefined ? '-' : typeof p === 'number' ? String(p) : p).update('\u0000')
  return h.digest('hex').slice(0, 32)
}

// ── the store ─────────────────────────────────────────────────────────

/** What a kept render says of itself, beside its bytes. `key` is the sheet it was made from: a read names it again. */
interface Meta {
  rev: string
  ext: string
  key: string
  size: number
  pages?: number
  shown?: { from: number; to: number; of: number }
  /** more pages follow the ones drawn, and nobody has counted them */
  uncounted?: true
  name?: string
  /** a drop said for this render alone: a forwarded draw that was cut to fit */
  note?: string
}

/** Renders by rev in one folder, bounded by count and bytes, the least used out first. */
export class PreviewStore {
  constructor(
    readonly dir: string,
    private readonly max = STORE_MAX
  ) {}

  private metaPath = (rev: string): string => join(this.dir, `${rev}.json`)
  fileOf = (meta: Pick<Meta, 'rev' | 'ext'>): string => join(this.dir, `${meta.rev}.${meta.ext}`)

  get(rev: string): Meta | null {
    if (!/^[a-f0-9]{32}$/.test(rev)) return null
    try {
      const meta = JSON.parse(readFileSync(this.metaPath(rev), 'utf8')) as Meta
      if (!/^[a-z0-9]{1,8}$/.test(meta.ext) || !existsSync(this.fileOf(meta))) return null
      // A use keeps it: the least used go first.
      const now = new Date()
      utimesSync(this.metaPath(rev), now, now)
      return meta
    } catch {
      return null
    }
  }

  /** Lands `file` (moved in) as `meta.rev`, then drops what is over the bounds. */
  put(meta: Meta, file: string): Meta {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    renameSync(file, this.fileOf(meta))
    const tmp = join(this.dir, `.tmp-${randomUUID()}`)
    writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 })
    // The answer last: a render with its answer is a whole one.
    renameSync(tmp, this.metaPath(meta.rev))
    this.prune(meta.rev)
    return meta
  }

  /** Oldest first out, past the count or the bytes; the one just made stays. */
  prune(keep: string): void {
    const kept: { rev: string; at: number; bytes: number; files: string[] }[] = []
    for (const f of readdirSync(this.dir)) {
      const m = /^([a-f0-9]{32})\.json$/.exec(f)
      if (!m) continue
      const files = readdirSync(this.dir).filter((x) => x.startsWith(`${m[1]}.`))
      let bytes = 0
      for (const x of files) bytes += statSync(join(this.dir, x)).size
      kept.push({ rev: m[1], at: statSync(join(this.dir, f)).mtimeMs, bytes, files })
    }
    kept.sort((a, b) => a.at - b.at)
    let bytes = kept.reduce((sum, k) => sum + k.bytes, 0)
    let count = kept.length
    for (const k of kept) {
      if (count <= this.max.count && bytes <= this.max.bytes) break
      if (k.rev === keep) continue
      for (const x of k.files) rmSync(join(this.dir, x), { force: true })
      count--
      bytes -= k.bytes
    }
  }

  /** Bytes of a render by range, at its rev, for the sheet `key` alone. */
  read(rev: string, key: string, offset: number, length: number): { data: string } {
    const meta = this.get(rev)
    if (!meta || meta.key !== key) throw new Error(GONE)
    let fd: number
    try {
      fd = openSync(this.fileOf(meta), 'r')
    } catch {
      throw new Error(GONE)
    }
    try {
      const size = fstatSync(fd).size
      if (offset >= size) return { data: '' }
      const buf = Buffer.alloc(Math.min(length, size - offset))
      const got = readSync(fd, buf, 0, buf.length, offset)
      return { data: buf.subarray(0, got).toString('base64') }
    } finally {
      closeSync(fd)
    }
  }
}

/** This host's renders of his own files: beside Files' own pictures, which both backups leave out. */
export const previewsDir = (dataDir: string): string => join(dataDir, 'work-files', 'previews', 'sheets')

/** A call's own scratch folder inside a store's (0700): removed when the call ends; a crash's are swept at start. */
const scratchIn = (dir: string): string => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return mkdtempSync(join(dir, '.scratch-'))
}

/** A shared item's renders, exported files and scratch, gone with the item. */
export function dropSharedPreviews(dataDir: string, itemId: string): void {
  try {
    rmSync(sharedPreviews(dataDir, itemId), { recursive: true, force: true })
  } catch {
    // not an id a folder was ever made for
  }
}

/** In a shared item's folder: the thread (or pane) that holds the item, so a deleted thread's folders are found. */
const THREAD_MARK = '.thread'

/**
 * A deleted thread's shared items, gone with it: the frame tells a pillar the threads, not their items
 * (modules.ts `sessionsRemoved`), so each item's folder says whose it is.
 */
export function dropSharedPreviewsOf(dataDir: string, sessionIds: readonly string[]): void {
  const root = sharedPreviewsRoot(dataDir)
  if (!sessionIds.length || !existsSync(root)) return
  const gone = new Set(sessionIds)
  for (const name of readdirSync(root)) {
    try {
      if (gone.has(readFileSync(join(root, name, THREAD_MARK), 'utf8'))) rmSync(join(root, name), { recursive: true, force: true })
    } catch {
      // not an item's folder, or one already gone
    }
  }
}

/** What a crash left of a call's scratch in his own files' store: swept at the module's start. */
export function sweepPreviewScratch(dataDir: string): void {
  const dir = previewsDir(dataDir)
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) if (name.startsWith('.scratch') || name.startsWith('.tmp-')) rmSync(join(dir, name), { recursive: true, force: true })
}

/**
 * Files clears its preview scratch at each start, and a shared file's renders live there: a file that went while
 * a draw was being made is no fault of the draw. It is made once more, from the start.
 */
async function again<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err
    return fn()
  }
}

// ── the workbook in hand ──────────────────────────────────────────────

/** The workbook as Preview draws it: the bytes, what they hold, and where what is made of them may go. */
export interface Book {
  bytes: Uint8Array
  kind: 'xlsx' | 'xlsm'
  /** the content hash of `bytes` */
  hash: string
  facts: BookFacts
  /** an opened package: its Excel file is itself */
  package: boolean
  /** what the model writer could not hold, in its words */
  left: string[]
  /** the sheet's store key: a render read back must name it */
  key: string
  /** others can open the file: nothing made from it outlives its item or leaves this host */
  shared: boolean
  /** the file's name without its extension, for an exported file */
  stem: string
  store: PreviewStore
  /** where this call's scratch files go: a folder of its own inside the store's, removed after */
  scratch: string
}

const facts = new Map<string, BookFacts>()
/** Facts by content hash: the same file counted once. */
function factsFor(hash: string, make: () => BookFacts): BookFacts {
  const hit = facts.get(hash)
  if (hit) return hit
  const made = make()
  facts.set(hash, made)
  while (facts.size > 8) facts.delete(facts.keys().next().value!)
  return made
}

/** A service-held sheet's workbook as it stands, read in frames. */
async function workbookOf(ctx: WorkCtx, ref: SheetRef): Promise<IWorkbookData> {
  const { rev } = await host(ctx, 'open', { sheet: ref })
  const parts: Buffer[] = []
  for (let offset = 0, size = Infinity; offset < size; ) {
    const got = await host(ctx, 'snapshot', { sheet: ref, rev, offset, length: SHEET_LOAD_MAX })
    const part = Buffer.from(got.data, 'base64')
    parts.push(part)
    size = got.size
    offset += part.length
    if (!part.length) break
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as IWorkbookData
}

/** The words a model writer's `left` says, as `exportSheet` says them. */
const leftWords = (left: { what: string; sheet?: string }[]): string[] => left.map((l) => (l.sheet ? `${l.what} on ${l.sheet}` : `the ${l.what}`.replace('the the ', 'the ')))

const stemOf = (title: string): string => title.replace(/\.(xlsx|xlsm|tcsheet|csv|xls|ods|tsv)$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim() || 'Sheet'

/**
 * Where an item's renders are kept: for a file others can open, a folder of its item's own under Files' preview
 * scratch (`sharedPreviews`: out of both backups, gone with the item and at Files' start); else this host's store.
 */
export function storeFor(ctx: Pick<WorkCtx, 'dataDir' | 'db' | 'host'>, item: CanvasItem): { store: PreviewStore; shared: boolean } {
  const shared = sharedOf(ctx, item.source)
  return shared ? { store: new PreviewStore(sharedPreviews(ctx.dataDir, item.id), ITEM_STORE_MAX), shared } : { store: new PreviewStore(previewsDir(ctx.dataDir)), shared }
}

function notHeldHere(held: Held, title: string): asserts held is Extract<Held, { at: 'package' | 'service' }> {
  if (held.at === 'excel') throw new Error(`${title} lives in Excel: preview and export it there.`)
  if (held.at === 'google') throw new Error(`${title} lives in Google: download it there with File → Download.`)
}

export async function bookOf(s: Sheets, item: CanvasItem): Promise<Book> {
  const ctx = s.ctx
  const held = heldOf(item, ctx.dataDir)
  notHeldHere(held, item.title)
  const { store, shared } = storeFor(ctx, item)
  const base = { key: storeKey(held), shared, store, scratch: scratchIn(store.dir), stem: stemOf(item.title) }
  const read = async (): Promise<Book> => {
    if (held.at === 'package') {
      const { rev } = await s.packages.open(held.path)
      const bytes = new Uint8Array(readFileSync(s.packages.fileAt(held.path, rev)))
      const hash = hashOf(bytes)
      return { ...base, bytes, hash, kind: held.path.toLowerCase().endsWith('.xlsm') ? 'xlsm' : 'xlsx', facts: factsFor(hash, () => factsOfPackage(bytes)), package: true, left: [] }
    }
    const wb = await workbookOf(ctx, held.ref)
    const made = writeXlsxWhole(wb)
    const hash = hashOf(made.bytes)
    const ours = chartsOf(ctx, base.key).length
    return { ...base, bytes: made.bytes, hash, kind: 'xlsx', facts: { ...factsFor(hash, () => factsOfWorkbook(wb)), ours }, package: false, left: leftWords(made.left) }
  }
  try {
    const book = await read()
    // Whose folder this is, written at every draw: Files may have cleared it since the last.
    if (shared) writeFileSync(join(store.dir, THREAD_MARK), item.sessionId, { mode: 0o600 })
    return book
  } catch (err) {
    // A workbook that could not be read leaves no scratch behind it.
    rmSync(base.scratch, { recursive: true, force: true })
    throw err
  }
}

// ── LibreOffice's part ────────────────────────────────────────────────

/**
 * The render input under "Fit to": a fitted sheet's manual breaks taken out along each side it is fitted on, as
 * Excel ignores them there and LibreOffice does not. A side left automatic ("1 page wide" by as many tall as it
 * takes) keeps its breaks: Excel prints those, and so does LibreOffice. Measured in Excel itself
 * (harness/corpus/print/excel-truth.json): the plan's "no manual breaks under Fit to" held only for a side with a
 * page count. A copy for the render alone; the file keeps its own. Null when nothing is taken out.
 */
export function withoutBreaksUnderFit(bytes: Uint8Array): Uint8Array | null {
  const z = readZip(bytes)
  const replace = new Map<string, Uint8Array>()
  const without = (xml: string, name: 'rowBreaks' | 'colBreaks'): string => xml.replace(new RegExp(`<((?:[\\w.-]+:)?${name})\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/\\1\\s*>)`, 'g'), '')
  for (const s of workbookMap(z).sheets) {
    if (s.kind === 'chartsheet' || !z.byName.has(s.part)) continue
    const xml = readText(z, s.part)
    const fit = fitOf(xml)
    if (!fit) continue
    let out = xml
    if (fit.tall > 0) out = without(out, 'rowBreaks')
    if (fit.wide > 0) out = without(out, 'colBreaks')
    if (out !== xml) replace.set(s.part, new TextEncoder().encode(out))
  }
  return replace.size ? writeZip(z, replace, new Set(), new Map()) : null
}

/** LibreOffice's PDF filter for a page range, 1-based and inclusive. */
export const pageRangeFilter = (from: number, to: number): string => `calc_pdf_Export:{"PageRange":{"type":"string","value":"${from}-${to}"}}`
/**
 * LibreOffice's text filter for one sheet's shown values: the separator (44 a comma, 9 a tab), `"`
 * around text that needs it, UTF-8, cells as shown, no formulas, and the sheet by its 1-based place.
 */
export const textFilter = (separator: 44 | 9, sheet: number): string => `Text - txt - csv (StarCalc):${separator},34,76,1,,0,false,true,true,false,false,${sheet}`

/** A job's output went past what one host sends another: draw fewer pages. */
const overCap = (err: unknown): boolean => err instanceof Error && /(came back|carried back) .*takes at most|that came back is/.test(err.message)

async function pagesIn(pdf: Uint8Array): Promise<number> {
  try {
    return (await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false })).getPageCount()
  } catch {
    return Math.max(1, Buffer.from(pdf).toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0)
  }
}

/** The first `count` pages of a PDF, for a draw that asked for one page more than it shows. */
async function firstPages(pdf: Uint8Array, count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false })
  const out = await PDFDocument.create({ updateMetadata: false })
  for (const page of await out.copyPages(doc, Array.from({ length: count }, (_, i) => i))) out.addPage(page)
  return out.save()
}

interface Job {
  ctx: WorkCtx
  book: Book
  signal?: AbortSignal
  /** Files' previewer: run here or nowhere */
  here?: boolean
}

/** One conversion of a scratch file, into a scratch output, marked shared where the source is. */
async function convert(job: Job, from: string, to: string, input: Uint8Array | string, options?: Record<string, unknown>): Promise<string> {
  mkdirSync(job.book.scratch, { recursive: true, mode: 0o700 })
  const name = randomUUID()
  let inPath = input as string
  if (typeof input !== 'string') {
    inPath = join(job.book.scratch, `${name}.in.${from}`)
    writeFileSync(inPath, input, { mode: 0o600 })
  }
  const output = join(job.book.scratch, `${name}.out.${to}`)
  try {
    const done = await job.ctx.convert({ from, to, input: inPath, output, shared: job.book.shared, ...(job.here ? { here: true } : {}), ...(options ? { options } : {}), ...(job.signal ? { signal: job.signal } : {}) })
    return done.output
  } catch (err) {
    rmSync(output, { force: true })
    throw err
  } finally {
    if (typeof input !== 'string') rmSync(inPath, { force: true })
  }
}

/**
 * LibreOffice's PDF of `input` for pages `from` to `to` (no limit when `to` is null). A draw carried
 * to another host whose PDF comes back past what one host sends another is drawn again with half
 * the pages, until it fits; `cut` then says how many came.
 */
async function pdfOf(job: Job, from: string, input: Uint8Array, first: number, to: number | null): Promise<{ path: string; cut?: number }> {
  let last = to
  let cut: number | undefined
  for (;;) {
    try {
      const path = await convert(job, from, 'pdf', input, last === null ? undefined : { filter: pageRangeFilter(first, last) })
      return { path, ...(cut !== undefined ? { cut } : {}) }
    } catch (err) {
      if (job.book.shared || !overCap(err)) throw err
      const count = last === null ? ALL_CAPPED_FIRST : Math.floor((last - first + 1) / 2)
      if (count < 1) throw err
      last = first + count - 1
      cut = count
    }
  }
}

// ── the draws ─────────────────────────────────────────────────────────

const EXT_OF: Record<SheetPreviewFormat, string> = { xlsx: 'xlsx', pdf: 'pdf', ods: 'ods', xls: 'xls', csv: 'csv', tsv: 'tsv', html: 'html' }

/**
 * The file `format` makes of the workbook as it stands, kept by content hash: the package itself (or
 * the model writer's .xlsx), the whole PDF, or LibreOffice's export. CSV and TSV hold one sheet.
 */
export async function fileOf(job: Job, format: SheetPreviewFormat, sheet?: string): Promise<Meta> {
  const { book } = job
  const tab = format === 'csv' || format === 'tsv' ? sheetFor(book.facts, sheet) : undefined
  if ((format === 'csv' || format === 'tsv') && !tab) throw new Error('The workbook has no sheet of cells.')
  const at = tab ? book.facts.sheets.indexOf(tab) + 1 : undefined
  const ext = format === 'xlsx' ? book.kind : EXT_OF[format]
  const rev = hashOf('file', format, book.hash, tab?.name)
  const kept = book.store.get(rev)
  if (kept) return kept
  let made: string
  if (format === 'xlsx') {
    mkdirSync(book.scratch, { recursive: true, mode: 0o700 })
    made = join(book.scratch, `${randomUUID()}.${ext}`)
    writeFileSync(made, book.bytes, { mode: 0o600 })
  } else if (format === 'pdf') made = (await pdfOf(job, book.kind, withoutBreaksUnderFit(book.bytes) ?? book.bytes, 1, null)).path
  else if (format === 'csv' || format === 'tsv') {
    // LibreOffice writes the values an opened Excel file keeps beside its formulas and works none out again: a sheet
    // whose kept values cannot be trusted (none, or the file asks to be calculated on load) is refused, as its Save
    // back and Export are (jobs.ts `packageCsv`), never drawn or written with an empty or an old field.
    const cell = book.package ? unworkedIn(importXlsx(book.bytes).workbook, () => book.bytes, tab!.name) : null
    if (cell) throw new Error(notWorkedOut(cell))
    made = await convert(job, book.kind, format === 'csv' ? 'csv' : 'tsv', book.bytes, { filter: textFilter(format === 'csv' ? 44 : 9, at!) })
  }
  else made = await convert(job, book.kind, format, book.bytes)
  const name = `${book.stem}${tab && book.facts.sheets.filter((s) => !s.chart).length > 1 ? ` - ${tab.name}` : ''}.${ext}`.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
  return book.store.put({ rev, ext, key: book.key, size: statSync(made).size, name }, made)
}

/**
 * A paged picture: LibreOffice's PDF of the workbook (Excel, PDF and Print), with its Fit-to breaks
 * taken out, or of the exported OpenDocument or Excel 97-2003 file. `pages` absent draws the first
 * 50; one page more is drawn to learn whether the whole is longer, and the PDF kept holds the 50.
 */
export async function drawPaged(job: Job, format: 'xlsx' | 'pdf' | 'ods' | 'xls', pages?: [number, number]): Promise<Meta> {
  const { book } = job
  const first = pages ? pages[0] : 1
  const all = pages ? pages[1] >= Number.MAX_SAFE_INTEGER / 2 : false
  const last = pages ? (all ? null : pages[1]) : SHEET_PREVIEW_PAGES
  let from: string = book.kind
  let input = withoutBreaksUnderFit(book.bytes) ?? book.bytes
  if (format === 'ods' || format === 'xls') {
    const file = await fileOf(job, format)
    from = format
    input = new Uint8Array(readFileSync(book.store.fileOf(file)))
  }
  const rev = hashOf('pdf', from, hashOf(input), first, last ?? 'all')
  const kept = book.store.get(rev)
  if (kept) return kept
  // One page past the range: whether the whole goes on.
  const drawn = await pdfOf(job, from, input, first, last === null ? null : last + 1)
  try {
    let bytes: Uint8Array = new Uint8Array(readFileSync(drawn.path))
    let count = await pagesIn(bytes)
    const asked = last === null ? Infinity : last - first + 1
    const more = count > asked || drawn.cut !== undefined
    if (count > asked) {
      bytes = await firstPages(bytes, asked)
      count = asked
      writeFileSync(drawn.path, bytes)
    }
    // The whole is not counted until it is drawn: where more follow, the frame is told one page more than it holds, and
    // the column says so in words. No estimate is shown as a count.
    const shown = more || first > 1 ? { from: first, to: first + count - 1, of: first + count - (more ? 0 : 1) } : undefined
    const note = drawn.cut !== undefined ? `Drawn on another computer: only the first ${count.toLocaleString('en-US')} pages could be sent` : more ? moreThan(first + count - 1) : undefined
    return book.store.put({ rev, ext: 'pdf', key: book.key, size: bytes.byteLength, pages: count, ...(shown ? { shown } : {}), ...(more ? { uncounted: true as const } : {}), ...(note ? { note } : {}) }, drawn.path)
  } finally {
    rmSync(drawn.path, { force: true })
  }
}

/** One field of a CSV or a TSV line, read as RFC 4180 reads it: quotes around a field that holds the separator. */
export function readDelimited(text: string, separator: string, max: number): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length && rows.length < max; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === separator) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if ((field !== '' || row.length) && rows.length < max) rows.push([...row, field])
  return rows
}

export interface PreviewParams {
  format: SheetPreviewFormat
  pages?: [number, number]
  sheet?: string
  by?: 'office'
}

/** `work.sheets.preview`: the picture of `format`, with what it drops. */
export async function previewSheet(s: Sheets, item: CanvasItem, params: PreviewParams, signal?: AbortSignal): Promise<SheetPreviewAnswer> {
  // "Check in Excel" (`by: 'office'`) is checkExcel.ts's, and the module answers it before this is called: a draw
  // here is LibreOffice's, and is never handed back under Excel's name.
  if (params.by === 'office') throw new Error('Excel is not in reach from here yet.')
  return again(async () => {
    const book = await bookOf(s, item)
    const job: Job = { ctx: s.ctx, book, ...(signal ? { signal } : {}) }
    try {
      const { format } = params
      const drops = (extra: (string | undefined)[] = []): string[] => [...new Set([...sheetDrops(format, book.facts, { package: book.package, left: book.left, ...(params.sheet ? { sheet: params.sheet } : {}) }), ...extra.filter((x): x is string => !!x)])]
      if (format === 'csv' || format === 'tsv') {
        const file = await fileOf(job, format, params.sheet)
        const text = readFileSync(book.store.fileOf(file), 'utf8').replace(/^\uFEFF/, '')
        const tab = sheetFor(book.facts, params.sheet)!
        return { kind: 'table', name: tab.name, rows: readDelimited(text, format === 'csv' ? ',' : '\t', TABLE_ROWS), sheets: book.facts.sheets.filter((x) => !x.chart).map((x) => x.name), drops: drops() }
      }
      if (format === 'html') {
        const file = await fileOf(job, 'html')
        if (file.size > HTML_MAX) throw new Error(`This web page is ${Math.round(file.size / 1024 / 1024)} MB, too large to draw here.`)
        return { kind: 'html', html: readFileSync(book.store.fileOf(file), 'utf8'), drops: drops() }
      }
      const meta = await drawPaged(job, format, params.pages)
      return { kind: 'paged', rev: meta.rev, size: meta.size, pages: meta.pages ?? 1, ...(meta.shown ? { shown: meta.shown } : {}), ...(meta.uncounted ? { uncounted: true as const } : {}), drawnBy: 'libreoffice', drops: drops([meta.note]), ...(meta.note ? { notes: [meta.note] } : {}) }
    } finally {
      rmSync(book.scratch, { recursive: true, force: true })
    }
  })
}

/**
 * `work.sheets.previewExport`: the file in `format` made from the workbook as it stands now, to be read by range.
 * The window reads it and hands its bytes to the system's save dialog, so a copy of a file others can open goes
 * where he saves it, and lies here only in its item's scratch.
 */
export async function exportPreview(s: Sheets, item: CanvasItem, params: { format: SheetPreviewFormat; sheet?: string }): Promise<SheetExportAnswer> {
  return again(async () => {
    const book = await bookOf(s, item)
    try {
      const meta = await fileOf({ ctx: s.ctx, book }, params.format, params.sheet)
      return { rev: meta.rev, size: meta.size, name: meta.name ?? `${book.stem}.${meta.ext}`, drops: sheetDrops(params.format, book.facts, { package: book.package, left: book.left, ...(params.sheet ? { sheet: params.sheet } : {}) }) }
    } finally {
      rmSync(book.scratch, { recursive: true, force: true })
    }
  })
}

/** `work.sheets.previewRead`: bytes of one kept render, for the sheet the item names alone. */
export function readSheetPreview(ctx: WorkCtx, item: CanvasItem, params: { rev: string; offset: number; length: number }): { data: string } {
  const held = heldOf(item, ctx.dataDir)
  notHeldHere(held, item.title)
  return storeFor(ctx, item).store.read(params.rev, storeKey(held), params.offset, params.length)
}

// ── Files' page picture ───────────────────────────────────────────────

/**
 * The first page of a workbook's print as a PNG, for Files (`registerFilePreviewer('sheet')`): the
 * render above, drawn here alone (`here`), and for a file others can open, in a scratch folder that
 * goes when the picture is made, never kept. LibreOffice draws the page; the pdf pillar's pypdfium2
 * makes it a PNG, as Files' own previewers do.
 */
export function sheetFilePreviewer(ctx: WorkCtx): FilePreviewer {
  return async (source: CanvasSource, opts) => {
    // A thumbnail is drawn by Files' own cheaper sources: LibreOffice starts only for a page-size picture.
    if (opts.width <= THUMB_MAX) return null
    if (opts.page !== 1 || source.at !== 'file' || !/\.(xlsx|xlsm)$/i.test(source.path) || !existsSync(source.path)) return null
    const shared = sharedOf(ctx, source)
    const bytes = new Uint8Array(readFileSync(source.path))
    const hash = hashOf(bytes)
    // A shared file's work is done in a folder of its own under Files' preview scratch and removed before the answer.
    const dir = shared ? scratchIn(join(sharedPreviewsRoot(ctx.dataDir), '.pictures')) : previewsDir(ctx.dataDir)
    const store = new PreviewStore(dir)
    const book: Book = {
      bytes,
      hash,
      kind: source.path.toLowerCase().endsWith('.xlsm') ? 'xlsm' : 'xlsx',
      facts: shared ? factsOfPackage(bytes) : factsFor(hash, () => factsOfPackage(bytes)),
      package: true,
      left: [],
      key: `file:${source.path}`,
      shared,
      stem: 'page',
      store,
      scratch: shared ? join(dir, 'work') : scratchIn(dir)
    }
    const job: Job = { ctx, book, here: true, ...(opts.signal ? { signal: opts.signal } : {}) }
    try {
      const meta = await again(() => drawPaged(job, 'xlsx', [1, 1]))
      const png = await convert(job, 'pdf', 'png', store.fileOf(meta), { page: 1, width: opts.width })
      return new Uint8Array(readFileSync(png))
    } finally {
      rmSync(shared ? dir : book.scratch, { recursive: true, force: true })
    }
  }
}

// ── the pairs the toolchain lacks ─────────────────────────────────────

/** A TSV's lines as a CSV's, so LibreOffice reads it with its plain CSV import. */
export function tsvToCsv(text: string): string {
  return text
    .replace(/^﻿/, '')
    .split(/\r\n|\n|\r/)
    .map((line) => line.split('\t').map((f) => (/[",\r\n]|^\s|\s$/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(','))
    .join('\r\n')
}

/**
 * The pairs this pillar adds to the runner (`WorkModule.convert`): a macro workbook to PDF and to
 * LibreOffice's other sheet formats, a workbook to a web page and to TSV, and a TSV in. TSV out is
 * LibreOffice's text export with a tab (`options.sheet`, 1-based, picks the sheet); TSV in is read
 * as the CSV it becomes. All run where LibreOffice is installed and follow the runner's rules (a
 * shared library's file is never carried to another host).
 */
function tsvOut(from: 'xlsx' | 'xlsm'): Converter {
  const inner = libreOffice(from, 'csv')
  return {
    ...inner,
    to: 'tsv',
    run(job, run) {
      // The filter is ours: only a sheet's place comes from the job.
      const at = job.options?.sheet
      const sheet = typeof at === 'number' && Number.isInteger(at) && at >= 1 && at <= 10_000 ? at : 1
      const named = typeof job.options?.filter === 'string' && /^Text - txt - csv \(StarCalc\):9,/.test(job.options.filter) ? job.options.filter : textFilter(9, sheet)
      return inner.run({ ...job, options: { ...job.options, filter: named } }, run)
    }
  }
}

const tsvIn: Converter = {
  ...libreOffice('csv', 'xlsx'),
  from: 'tsv',
  async run(job, run) {
    const csv = join(run.tmp, 'tab.csv')
    writeFileSync(csv, tsvToCsv(readFileSync(job.input, 'utf8')))
    return libreOffice('csv', 'xlsx').run({ ...job, from: 'csv', input: csv }, run)
  }
}

export const SHEET_PREVIEW_CONVERTERS: Converter[] = [
  ...['pdf', 'ods', 'xls', 'csv', 'html'].map((to) => libreOffice('xlsm', to)),
  libreOffice('xlsx', 'html'),
  tsvOut('xlsx'),
  tsvOut('xlsm'),
  tsvIn
]
