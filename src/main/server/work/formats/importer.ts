import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { fileDocName } from 'work-kit/collab-server'
import type { Block, Imported } from 'work-kit/formats'
import type { ExportAnswer, ImportAnswer } from '@shared/contract-work-formats'
import { canvasSourcePath, paneWorkspace, type CanvasSource } from '@shared/work'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import { ensureThreadTables } from '../docs/threads'
import { canonicalPath } from '../service/ctx'
import { ensureFetched, fetchedPath } from '../canvas/fetch'
import { attachmentDocPathOf } from '../docs/target'
import { importFolderOf } from '../files/imports'
import { sharedOf, workspaceHere } from '../files/policy'

/**
 * A file in as a document (docs/agents/work-formats.md "Import and export"):
 * Word with its comments and tracked changes, OpenDocument and RTF through
 * LibreOffice to Word and then the same reader, markdown, a PDF through
 * pymupdf4llm, and HTML the window already read. The document is a `.tcdoc`
 * beside the original, which stays as it was, or under this host's data when
 * others can open the original's place (files/imports.ts); Word's comment threads go to
 * the docs pillar's thread store and each author's tracked changes wait in a
 * branch of their own (work-kit/formats/tcdoc).
 */

export type ImportParams = {
  sessionId?: string
  itemId?: string
  from: { at: 'source'; source: CanvasSource } | { at: 'bytes'; name: string; data: string } | { at: 'blocks'; name: string; blocks: unknown[] }
}

const METHOD = 'work.formats.import'
const VIA_LIBREOFFICE = new Set(['odt', 'rtf', 'doc'])
const MARKDOWN = new Set(['md', 'markdown', 'txt'])

/** What the reader could not keep, in a person's words. */
const DROPPED: Record<string, (n: number) => string> = {
  imageInCell: (n) => `${n} ${n === 1 ? 'picture' : 'pictures'} inside a table cell left out`,
  listInCell: (n) => `${n} list ${n === 1 ? 'item' : 'items'} inside table cells kept as text`,
  nestedTable: (n) => `${n} ${n === 1 ? 'table' : 'tables'} inside a table kept as text`,
  image: (n) => `${n} ${n === 1 ? 'picture' : 'pictures'} that could not be read left out`,
  unsafeLink: (n) => `${n} ${n === 1 ? 'link' : 'links'} to somewhere other than the web or mail kept as text`,
  paragraphJoin: (n) => `${n} tracked ${n === 1 ? 'join' : 'joins'} of two paragraphs not kept`,
  paragraphFormatChange: (n) => `${n} tracked ${n === 1 ? 'change' : 'changes'} to paragraph formatting not kept`,
  overlappingChange: (n) => `${n} ${n === 1 ? 'suggestion' : 'suggestions'} on a paragraph another suggestion changes left out`,
  blockFormatChange: (n) => `${n} ${n === 1 ? 'change' : 'changes'} of a block's kind or look written as they stand`,
  move: (n) => `${n} moved ${n === 1 ? 'block' : 'blocks'} written in ${n === 1 ? 'its' : 'their'} new place`,
  tableChange: (n) => `${n} suggested ${n === 1 ? 'change' : 'changes'} to a table's shape written as ${n === 1 ? 'it stands' : 'they stand'}`
}
export const droppedWords = (dropped: Record<string, number>): string[] =>
  Object.entries(dropped)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => DROPPED[k]?.(n) ?? `${n} × ${k} not kept`)

/** A file name with nothing a path could make of it. */
export const safeName = (name: string): string =>
  basename(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'Document'

/** `<dir>/<stem><ext>`, or `<stem> 2<ext>` and on, whichever is free. */
export function freePath(dir: string, stem: string, ext: string): string {
  for (let n = 1; ; n++) {
    const p = join(dir, `${stem}${n === 1 ? '' : ` ${n}`}${ext}`)
    if (!existsSync(p)) return p
  }
}

/** The Work workspace an owner imports into: a thread's, or a pane's (the Files place's or the Mail view's) when that is a Work workspace here; undefined for an owner that is neither. */
function workspaceOfOwner(ctx: WorkCtx, sessionId: string): string | null | undefined {
  const scope = ctx.scopeOf(sessionId)
  if (scope) return scope.workspaceId
  const pane = paneWorkspace(sessionId)
  return pane && workspaceHere(ctx.db, pane) ? pane : undefined
}

/** Where a dropped file and its document go: the owner's Work workspace folder, or Work's own imports folder for a Work Chat. */
function folderFor(ctx: WorkCtx, sessionId: string | undefined): string {
  const workspaceId = sessionId ? workspaceOfOwner(ctx, sessionId) : null
  const row = workspaceId ? (ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(workspaceId) as { path?: string } | undefined) : undefined
  const dir = row?.path && existsSync(row.path) ? row.path : join(ctx.dataDir, 'attachments', 'work-imports')
  mkdirSync(dir, { recursive: true })
  // The path a document is opened by (and its threads are kept under) is the real one, links resolved.
  return canonicalPath(dir)
}

/** Scratch files for a job, under the formats pillar's own folder. */
export const scratchDir = (ctx: WorkCtx): string => {
  const dir = join(ctx.dataDir, 'formats', 'scratch')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A file on this host as blocks and a sidecar, by its extension; the warnings a conversion gave. */
export async function readFile(ctx: WorkCtx, path: string, ext: string): Promise<{ imported: Imported; warnings: string[] }> {
  if (ext === 'docx') {
    const { readDocx } = await import('work-kit/formats/docx')
    return { imported: readDocx(new Uint8Array(readFileSync(path))), warnings: [] }
  }
  if (VIA_LIBREOFFICE.has(ext)) {
    const done = await ctx.convert({ from: ext, to: 'docx', input: path })
    const { readDocx } = await import('work-kit/formats/docx')
    return { imported: readDocx(new Uint8Array(readFileSync(done.output))), warnings: done.warnings }
  }
  if (MARKDOWN.has(ext)) {
    const { readMarkdown } = await import('work-kit/formats/markdown')
    return { imported: readMarkdown(readFileSync(path, 'utf8')), warnings: [] }
  }
  if (ext === 'pdf') {
    const done = await ctx.convert({ from: 'pdf', to: 'md', input: path })
    const { readMarkdown } = await import('work-kit/formats/markdown')
    return { imported: readMarkdown(readFileSync(done.output, 'utf8')), warnings: done.warnings }
  }
  if (ext === 'html' || ext === 'htm') throw new Error('HTML is read in the window: drop the file on a document')
  throw new Error(`a .${ext || '?'} file is not one a document can be made from`)
}

export async function importFile(ctx: WorkCtx, by: Caller, params: ImportParams): Promise<ImportAnswer> {
  const from = params.from
  let name: string
  let folder: string
  let original: string | null = null
  if (from.at === 'source' && from.source.at === 'mail') return importAttachment(ctx, params)
  if (from.at === 'source') {
    const path = canvasSourcePath(from.source)
    if (!path) throw new Error('only a file can be imported')
    const host = from.source.at === 'file' || from.source.at === 'microsoft' ? from.source.host : ctx.host
    if (host !== ctx.host && !existsSync(path)) throw new Error('that file is on another host; import it there')
    if (!ctx.reaches(by, path)) throw new FenceError(METHOD)
    if (!existsSync(path)) throw new Error('that file is not there any more')
    original = canonicalPath(path)
    // Never beside a file others can open: the document would sync to them. It goes under this host's data instead.
    if (sharedOf(ctx, { at: 'file', host: ctx.host, path: original })) {
      folder = importFolderOf(ctx.dataDir, { host: ctx.host, path: original })
      mkdirSync(folder, { recursive: true, mode: 0o700 })
    } else folder = dirname(original)
    name = basename(original)
  } else {
    if (params.sessionId && workspaceOfOwner(ctx, params.sessionId) === undefined) throw new Error('import into a Work thread or the Files place')
    folder = folderFor(ctx, params.sessionId)
    name = safeName(from.name)
    if (from.at === 'bytes') {
      original = freePath(folder, safeName(name.slice(0, name.length - extname(name).length)), extname(name).toLowerCase())
      writeFileSync(original, Buffer.from(from.data, 'base64'))
    }
  }
  const ext = extname(name).slice(1).toLowerCase()
  const stem = safeName(basename(name, extname(name)))
  const read =
    from.at === 'blocks' ? { imported: { blocks: from.blocks as Block[], sidecar: (await import('work-kit/formats')).emptySidecar() }, warnings: [] } : await readFile(ctx, original!, ext)
  read.imported.sidecar.source = { name, format: from.at === 'blocks' ? 'html' : ext, importedAt: Date.now() }
  const target = freePath(folder, stem, '.tcdoc')
  const { writeImportedTcdoc } = await import('work-kit/formats/tcdoc')
  const made = await writeImportedTcdoc(target, read.imported, { principal: 'owner' })
  // Always written, an empty list too: a row a deleted file left under this name is never inherited.
  ensureThreadTables(ctx.db)
  ctx.db.prepare('INSERT OR REPLACE INTO work_docs_threads (doc, rows) VALUES (?, ?)').run(fileDocName(target), JSON.stringify(made.threads))
  const source: CanvasSource = { at: 'file', host: ctx.host, path: target }
  const warnings = [...read.warnings, ...droppedWords(read.imported.sidecar.dropped)]
  if (made.unplaced) warnings.push(`${made.unplaced} ${made.unplaced === 1 ? 'comment is' : 'comments are'} on suggested words, so ${made.unplaced === 1 ? 'it has' : 'they have'} no place in the text`)
  let itemId: string | undefined
  // The document takes the place of the item it was made of, only in the same pane: a caller cannot close another
  // thread's items. A Files tab showing the old item follows to the new one.
  if (params.sessionId) itemId = ctx.canvas.replace(ctx.canvas.paneOf(params.sessionId), params.itemId, 'document', source, stem).id
  ctx.log(`formats: imported ${name} as ${basename(target)} (${made.threads.length} threads, ${made.branches.length} authors of changes)`)
  return { source, title: stem, ...(itemId ? { itemId } : {}), warnings, outsiders: made.outsiders }
}

/**
 * A mail's attachment read as a document (work-mail.md "Attachments"): the fetched copy in the item's own folder
 * becomes `<name>.tcdoc` beside it, once, and the item stays the attachment, which the document kind shows read only
 * (docs/index.ts `roleOf`). Nothing opens or closes here: keeping it as his own is an import of the copy saved to the
 * workspace (`work.canvas.keep`, then an import from that file).
 */
async function importAttachment(ctx: WorkCtx, params: ImportParams): Promise<ImportAnswer> {
  const item = params.itemId ? ctx.canvas.get(params.itemId) : null
  const source = params.from.at === 'source' ? params.from.source : null
  if (!item || !source || JSON.stringify(item.source) !== JSON.stringify(source)) throw new Error("that attachment is not this item's")
  await ensureFetched(ctx, item)
  const original = fetchedPath(ctx.dataDir, item)
  const target = attachmentDocPathOf(ctx.dataDir, item)
  const made: CanvasSource = { at: 'file', host: ctx.host, path: target }
  const title = basename(target, '.tcdoc')
  if (existsSync(target)) return { source: made, title, warnings: [], outsiders: false }
  const name = basename(original)
  const read = await readFile(ctx, original, extname(name).slice(1).toLowerCase())
  read.imported.sidecar.source = { name, format: extname(name).slice(1).toLowerCase(), importedAt: Date.now() }
  const { writeImportedTcdoc } = await import('work-kit/formats/tcdoc')
  const written = await writeImportedTcdoc(target, read.imported, { principal: 'owner' })
  ensureThreadTables(ctx.db)
  ctx.db.prepare('INSERT OR REPLACE INTO work_docs_threads (doc, rows) VALUES (?, ?)').run(fileDocName(target), JSON.stringify(written.threads))
  return { source: made, title, warnings: [...read.warnings, ...droppedWords(read.imported.sidecar.dropped)], outsiders: written.outsiders }
}

export type { ExportAnswer }
