import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { PDFDocument } from 'pdf-lib'
import type { PreviewAnswer, PreviewFormatId } from '@shared/contract-work-formats'
import type { CanvasSource } from '@shared/work'
import { attachmentDoc, lifeosRow, targetOf, titleOf, type DocTarget } from '../docs/target'
import type { Caller, WorkCtx } from '../modules'
import { madeFromShared, serviceExport } from './exporter'
import { droppedWords, safeName, scratchDir } from './importer'
import { printToPdf } from './print'

/**
 * A document drawn as the file a format makes of it, for the Preview frame
 * (docs/agents/work-formats.md "Preview renders"): PDF is the window's print
 * page printed here; Word, OpenDocument and RTF are the exported file, and
 * the picture is LibreOffice's PDF of that file itself. A render is kept by
 * the hash of what it was made from, so the same document asked again is
 * answered without converting, and read by range.
 */

type PreviewParams = { source: CanvasSource; itemId?: string; format: PreviewFormatId; html?: string; paper?: 'A4' | 'Letter' }
type ReadParams = { source: CanvasSource; itemId?: string; rev: string; offset: number; length: number }

const PART = /^[A-Za-z0-9_.-]{1,80}$/
const FORMATS = new Set(['pdf', 'docx', 'odt', 'rtf'])
const GONE = 'that preview is gone: draw it again'
const DAY = 24 * 60 * 60_000

/** Under a `.cache` folder: the box's backup leaves every one out, so a render never rides it. */
export const previewsRoot = (dataDir: string): string => join(dataDir, 'formats', '.cache', 'preview')

/** A path part as it may be: a name, never a path or a run of dots. */
const part = (name: string): string => {
  if (!PART.test(name) || /^\.+$/.test(name)) throw new Error('not a name a preview is kept under')
  return name
}

/** A source's own name in a path: the caller was let through to this source and to no other. */
export const sourceKey = (source: CanvasSource): string => createHash('sha1').update(JSON.stringify(source)).digest('hex').slice(0, 16)

export const NEEDS_ITEM = 'a preview of a file others can open is kept with its tab: open the file in a tab first'
export const NOT_THIS_ITEM = 'that item does not show this document'

const same = (a: CanvasSource, b: CanvasSource): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Where a source's renders are kept: under its item's thread and id, then
 * the source's own key, so naming an item reads nothing made from another
 * source than the one the caller was let through to (a mail's attachment and
 * the document read from it share an item). A source with no item goes under
 * `_`, swept after a day; one others can open has no such place, since
 * nothing made from it may outlive its tab. This folder is the item's own
 * place for renders: it goes with the item (`itemsRemoved`), with its thread
 * (`sessionsRemoved`), and is out of the backup by its `.cache` name.
 */
function folderOf(ctx: WorkCtx, t: DocTarget, itemId: string | undefined, asked: CanvasSource): string {
  if (itemId === undefined) {
    if (madeFromShared(ctx, t.source) || madeFromShared(ctx, asked)) throw new Error(NEEDS_ITEM)
    return join(previewsRoot(ctx.dataDir), '_', sourceKey(t.source))
  }
  part(itemId)
  const item = ctx.canvas.get(itemId)
  if (!item) throw new Error('that item is not open')
  // The item must be the one that shows this document (or the mail's attachment it was read from): a render goes
  // when its own tab goes, never when some other item does.
  const shows = same(item.source, asked) || same(item.source, t.source) || (t.at === 'file' && attachmentDoc(ctx, item) === t.path)
  if (!shows) throw new Error(NOT_THIS_ITEM)
  return join(previewsRoot(ctx.dataDir), part(item.sessionId), part(item.id), sourceKey(t.source))
}

const revOf = (format: string, ...made: (string | Uint8Array)[]): string => {
  const h = createHash('sha256').update(format).update(Buffer.from([0]))
  for (const m of made) h.update(m)
  return h.digest('hex').slice(0, 32)
}

/**
 * What a Word file holds, for its hash: each entry's name and unpacked bytes
 * in name order, with the times the writer stamps on every export (the zip's
 * own, and `dcterms:created` and `modified` in docProps/core.xml) left out,
 * so the same document is the same render. A file that will not unpack is
 * hashed as it is.
 */
export function wordContent(docx: Buffer): Buffer[] {
  try {
    const end = docx.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (end < 0) return [docx]
    const count = docx.readUInt16LE(end + 10)
    let at = docx.readUInt32LE(end + 16)
    const entries: [string, Buffer][] = []
    for (let i = 0; i < count; i++) {
      if (docx.readUInt32LE(at) !== 0x02014b50) return [docx]
      const method = docx.readUInt16LE(at + 10)
      const packed = docx.readUInt32LE(at + 20)
      const nameLen = docx.readUInt16LE(at + 28)
      const name = docx.toString('utf8', at + 46, at + 46 + nameLen)
      const local = docx.readUInt32LE(at + 42)
      const start = local + 30 + docx.readUInt16LE(local + 26) + docx.readUInt16LE(local + 28)
      const raw = docx.subarray(start, start + packed)
      let body = method === 8 ? inflateRawSync(raw) : raw
      if (name === 'docProps/core.xml') body = Buffer.from(body.toString('utf8').replace(/<dcterms:(created|modified)\b[^>]*>[^<]*<\/dcterms:\1>/g, ''))
      entries.push([name, body])
      at += 46 + nameLen + docx.readUInt16LE(at + 30) + docx.readUInt16LE(at + 32)
    }
    return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).flatMap(([name, body]) => [Buffer.from(`${name}\u0000${body.length}\u0000`), body])
  } catch {
    return [docx]
  }
}

/** Pages by pdf-lib; a PDF it cannot read is counted by its page objects. Never fewer than one. */
async function pagesOf(pdf: Uint8Array): Promise<number> {
  try {
    const doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false })
    return Math.max(1, doc.getPageCount())
  } catch {
    return Math.max(1, Buffer.from(pdf).toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0)
  }
}

/** Written under a temp name and renamed: a reader sees the whole file or none of it. */
const land = (path: string, data: Uint8Array | string): void => {
  const tmp = join(dirname(path), `.tmp-${randomUUID()}`)
  try {
    writeFileSync(tmp, data, { mode: 0o600 })
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

function keptRender(dir: string, format: string, rev: string): PreviewAnswer | null {
  const meta = join(dir, `${format}.${rev}.json`)
  if (!existsSync(meta) || !existsSync(join(dir, `${format}.${rev}.pdf`))) return null
  try {
    return JSON.parse(readFileSync(meta, 'utf8')) as PreviewAnswer
  } catch {
    return null
  }
}

/** The render lands, then the format's older ones go. */
async function keep(dir: string, format: string, rev: string, picture: Uint8Array, name: string, drawnBy: PreviewAnswer['drawnBy'], warnings: string[]): Promise<PreviewAnswer> {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const answer: PreviewAnswer = { rev, size: picture.byteLength, pages: await pagesOf(picture), drawnBy, name, warnings }
  land(join(dir, `${format}.${rev}.pdf`), picture)
  // The answer last: a render with its answer is a whole one.
  land(join(dir, `${format}.${rev}.json`), JSON.stringify(answer))
  for (const f of readdirSync(dir)) {
    const [fmt, r] = f.split('.')
    if (fmt === format && r !== rev) rmSync(join(dir, f), { force: true })
  }
  return answer
}

export async function previewDoc(ctx: WorkCtx, by: Caller, params: PreviewParams): Promise<PreviewAnswer> {
  const t = await targetOf(ctx, by, 'work.formats.preview', params.source)
  const dir = folderOf(ctx, t, params.itemId, params.source)
  const format = params.format
  if (format === 'pdf') {
    if (params.html === undefined) throw new Error('a PDF preview needs its print page')
    const paper = params.paper ?? 'A4'
    const rev = revOf(format, params.html, '\u0000', paper)
    const kept = keptRender(dir, format, rev)
    if (kept) return kept
    const title = titleOf(t, await lifeosRow(ctx, t))
    const { pdf, warnings } = await printToPdf(params.html, { paper, dir: scratchDir(ctx) })
    return keep(dir, format, rev, pdf, `${safeName(title)}.pdf`, 'tempcode', warnings)
  }
  // Word, OpenDocument and RTF: LibreOffice's picture of the file Export writes (`exportDoc`, which needs no renderer for Word).
  const got = await serviceExport(ctx, t, 'docx')
  const docx = Buffer.from(got.data ?? '', 'base64')
  const rev = revOf(format, ...wordContent(docx))
  const kept = keptRender(dir, format, rev)
  if (kept) return kept
  const shared = madeFromShared(ctx, params.source)
  const warnings = new Set(droppedWords(got.dropped ?? {}))
  const scratch: string[] = []
  try {
    const input = join(scratchDir(ctx), `${randomUUID()}.docx`)
    scratch.push(input)
    writeFileSync(input, docx)
    let file = input
    if (format !== 'docx') {
      const done = await ctx.convert({ from: 'docx', to: format, input, shared })
      scratch.push(done.output)
      done.warnings.forEach((w) => warnings.add(w))
      file = done.output
    }
    const drawn = await ctx.convert({ from: format, to: 'pdf', input: file, shared })
    scratch.push(drawn.output)
    drawn.warnings.forEach((w) => warnings.add(w))
    return await keep(dir, format, rev, readFileSync(drawn.output), `${safeName(got.title)}.${format}`, 'libreoffice', [...warnings])
  } finally {
    for (const f of scratch) rmSync(f, { force: true })
  }
}

export async function readPreview(ctx: WorkCtx, by: Caller, params: ReadParams): Promise<{ data: string }> {
  const t = await targetOf(ctx, by, 'work.formats.previewRead', params.source)
  const dir = folderOf(ctx, t, params.itemId, params.source)
  if (!/^[a-f0-9]{32}$/.test(params.rev)) throw new Error(GONE)
  const picture = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(`.${params.rev}.pdf`) && FORMATS.has(f.split('.')[0])) : undefined
  if (!picture) throw new Error(GONE)
  let fd: number
  try {
    fd = openSync(join(dir, picture), 'r')
  } catch {
    throw new Error(GONE)
  }
  try {
    const size = fstatSync(fd).size
    if (params.offset >= size) return { data: '' }
    const buf = Buffer.alloc(Math.min(params.length, size - params.offset))
    const n = readSync(fd, buf, 0, buf.length, params.offset)
    return { data: buf.subarray(0, n).toString('base64') }
  } finally {
    closeSync(fd)
  }
}

/** The renders of deleted threads and of deleted items go with them. */
export function dropPreviews(dataDir: string, where: { owners?: string[]; items?: { sessionId: string; id: string }[] }): void {
  const root = previewsRoot(dataDir)
  const drop = (...parts: string[]): void => {
    try {
      rmSync(join(root, ...parts.map(part)), { recursive: true, force: true })
    } catch {
      // a name that was never a folder here has nothing to drop
    }
  }
  for (const owner of where.owners ?? []) drop(owner)
  for (const item of where.items ?? []) drop(item.sessionId, item.id)
}

/** Renders of no item (no thread's delete reaches them) go a day after they were last drawn. */
export function sweepPreviews(dataDir: string, now = Date.now()): void {
  const loose = join(previewsRoot(dataDir), '_')
  if (!existsSync(loose)) return
  for (const name of readdirSync(loose)) {
    const dir = join(loose, name)
    try {
      const newest = Math.max(statSync(dir).mtimeMs, ...readdirSync(dir).map((f) => statSync(join(dir, f)).mtimeMs))
      if (now - newest > DAY) rmSync(dir, { recursive: true, force: true })
    } catch {
      // gone already, or not a folder: the next sweep sees
    }
  }
}
