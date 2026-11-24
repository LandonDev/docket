import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, sep } from 'node:path'
import { filesPaneWorkspace, type CanvasItem, type CanvasSource } from '@shared/work'
import { splitName } from '@shared/work/files'
import { SHEET_IMPORT_FORMATS, type SheetImportAct, type SheetImportDone, type SheetImported, type SheetImportFormat } from '@shared/work/sheetFormats'
import { NEEDS_APPROVE, sharedOf, workspaceHere } from '../files/policy'
import { saveFile, versionWord } from '../files/save'
import { FileRefused, makeFile, versionOf } from '../files/write'
import type { Caller, WorkCtx } from '../modules'
import { hasMagic } from '../pdf/file'
import { backTarget } from './formatsInBack'
import { delimitedAsCsv, patchCsv, utf8Text } from './formatsInCsv'
import { fileKey, type Sheets } from './held'
import { readZip } from './patch/zip'
import { factsOfPackage, sheetDrops } from './previewFacts'
import { readCsv, writeCsv, writeXlsx } from './writer'

/**
 * The other formats in (docs/agents/work-sheets.md "Other formats in"): an `.xls`, an `.ods` or a
 * `.tsv` opens in the sheet editor as an Excel copy made of it: LibreOffice reads an .xls and an
 * .ods; a .tsv is plain text, read here as a .csv is (numbers as numbers, the rest as text) and
 * written by the model writer. The copy is an opened package like any other (packages.ts holds
 * it, every edit is saved into it), so the grid, the tools and Preview need no second way; what is
 * new is where the copy lies, when it is made again, and how it goes back.
 *
 *  - His own file's copy is kept among the app's files (`sheets/imports/<hash of the path>/`) and
 *    lasts: closing the tab loses nothing.
 *  - A copy of a file others can open (`sharedOf`) lies under Files' preview scratch, in a folder
 *    of its tab's own, converted on this host alone, and goes with the tab and at each start (the
 *    editors plan, "University files"). Nothing of it is ever written beside the file.
 *  - The file itself changes only by his press: Save back writes the copy as the format it was,
 *    through Files' one door for replacing a file, and only while the file is still the one the
 *    copy was made from. An .xls and an .ods are written by LibreOffice with every formula worked
 *    out again (formatsInBack.ts); a .tsv is patched, so a field nobody changed keeps its bytes. Save as Excel writes an .xlsx, never over anything: beside his own file,
 *    in his workspace's own folder for a file others can open.
 */

/** A package that is a copy of another format: where it was read from. */
export interface ImportedFrom {
  path: string
  format: SheetImportFormat
}
/** What `heldOf` answers for such a file: the copy as an opened package, with what it is a copy of. */
export interface ImportedHeld {
  at: 'package'
  path: string
  from: ImportedFrom
}

const EXT = new Map<string, SheetImportFormat>(SHEET_IMPORT_FORMATS.map((format) => [`.${format}`, format]))
/** The format a path's ending names, when the sheet kind opens it as a copy. */
export const importFormatOf = (path: string): SheetImportFormat | undefined => EXT.get(extname(path).toLowerCase())

const hash = (path: string): string => createHash('sha256').update(path).digest('hex').slice(0, 24)
const COPY = 'copy.xlsx'
const STAMP = 'source.json'

/** Where copies of his own files are kept: among the app's files, one folder a path. */
export const ownImports = (dataDir: string): string => join(dataDir, 'sheets', 'imports')
/** Where copies of files others can open are kept: Files' preview scratch (out of both backups, cleared at each start), one folder a tab. */
export const sharedImports = (dataDir: string): string => join(dataDir, 'work-files', 'preview-scratch', 'sheets', 'imports')
/** Whether a package is the copy of a file others can open: the package store keeps nothing of it past its tab either. */
export const isSharedImport = (dataDir: string, path: string): boolean => path.startsWith(sharedImports(dataDir) + sep)
/** Whether a package is a copy this module made, of anyone's file. */
export const isImportCopy = (dataDir: string, path: string): boolean => isSharedImport(dataDir, path) || path.startsWith(ownImports(dataDir) + sep)

export const NEEDS_A_TAB = 'is in a folder others can open, so its copy lasts only as long as its tab: open it in the canvas first.'

/**
 * The store of a file of one of these formats (`heldOf` asks): its copy, as a package. A file
 * others can open has a copy for each tab, so one asked for by its path alone, with no item, is
 * refused in words.
 */
export function importedHeld(dataDir: string, path: string, shared: boolean, itemId?: string): ImportedHeld | null {
  const format = importFormatOf(path)
  if (!format) return null
  const from = { path, format }
  if (!shared) return { at: 'package', path: join(ownImports(dataDir), hash(path), COPY), from }
  if (!itemId || !/^[A-Za-z0-9_-]{1,100}$/.test(itemId)) throw new Error(`${basename(path)} ${NEEDS_A_TAB}`)
  return { at: 'package', path: join(sharedImports(dataDir), itemId, COPY), from }
}

/** What a copy was made from, and how the copy stood when it last agreed with that file. */
interface Stamp {
  /** the file's path then (a renamed file is still the same file) */
  path: string
  size: number
  mtimeMs: number
  /** the file's version as Files' door words it (`versionWord`): what a save back expects to find */
  version: string
  copy: { size: number; mtimeMs: number }
}

const stamps = new Map<string, Stamp>()
/** A copy kept though its file changed (it holds his edits), by the file as it then stood: not judged again until the file changes once more. */
const keptStale = new Map<string, string>()
const sha = (word: string): string => word.split(':')[2] ?? ''
function stampOf(copy: string): Stamp | null {
  const hit = stamps.get(copy)
  if (hit) return hit
  try {
    const s = JSON.parse(readFileSync(join(dirname(copy), STAMP), 'utf8')) as Stamp
    if (typeof s.size !== 'number' || typeof s.mtimeMs !== 'number' || typeof s.version !== 'string' || typeof s.copy?.size !== 'number') return null
    stamps.set(copy, s)
    return s
  } catch {
    return null
  }
}
function keepStamp(copy: string, stamp: Stamp): void {
  const path = join(dirname(copy), STAMP)
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`
  writeFileSync(tmp, JSON.stringify(stamp), { mode: 0o600 })
  renameSync(tmp, path)
  stamps.set(copy, stamp)
}
const statOf = (path: string): { size: number; mtimeMs: number } | null => {
  try {
    const st = statSync(path)
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
  } catch {
    return null
  }
}
/** Whether the copy holds an edit of his: it no longer stands as it did when it last agreed with the file. */
const edited = (copy: string, stamp: Stamp): boolean => {
  const now = statOf(copy)
  return !!now && (now.size !== stamp.copy.size || now.mtimeMs !== stamp.copy.mtimeMs)
}

/** One conversion or save of a copy at a time. */
const chains = new Map<string, Promise<unknown>>()
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => {})
  chains.set(key, tail)
  void tail.then(() => chains.get(key) === tail && chains.delete(key))
  return run
}

type ConvertCtx = Pick<WorkCtx, 'convert' | 'dataDir'>

/**
 * Makes the copy, the first time and whenever the file changed and the copy holds nothing of his.
 * A copy he has edited is never made again under him: it is kept, and its view says the file
 * changed (`importedOf`). Asked on every request for the item, so the common answer costs two
 * stats.
 */
export function ensureImported(ctx: ConvertCtx, held: { at: string; path?: string; from?: ImportedFrom }, signal?: AbortSignal): Promise<void> {
  if (held.at !== 'package' || !held.from || !held.path) return Promise.resolve()
  const copy = held.path
  const from = held.from
  const now = statOf(from.path)
  const kept = existsSync(copy) ? stampOf(copy) : null
  if (kept && (!now || (kept.size === now.size && kept.mtimeMs === now.mtimeMs) || keptStale.get(copy) === `${now.size}:${now.mtimeMs}`)) return Promise.resolve()
  return serial(copy, () => convert(ctx, copy, from, false, signal))
}

async function convert(ctx: ConvertCtx, copy: string, from: ImportedFrom, force: boolean, signal?: AbortSignal): Promise<void> {
  const now = statOf(from.path)
  const kept = existsSync(copy) ? stampOf(copy) : null
  // The file is gone: a copy made of it still opens (its view says where the file was); with none there is nothing to show.
  if (!now) {
    if (kept) return
    throw new Error(`There is no file at ${from.path}.`)
  }
  const version = await versionOf(from.path)
  if (kept && !force) {
    if (kept.size === now.size && kept.mtimeMs === now.mtimeMs) return
    // Touched, renamed or synced again with the same bytes: the same file.
    if (version.sha256 !== undefined && version.sha256 === sha(kept.version)) return keepStamp(copy, { ...kept, path: from.path, size: now.size, mtimeMs: now.mtimeMs, version: versionWord(version) })
    if (edited(copy, kept)) {
      keptStale.set(copy, `${now.size}:${now.mtimeMs}`)
      return
    }
  }
  keptStale.delete(copy)
  const shared = isSharedImport(ctx.dataDir, copy)
  const dir = dirname(copy)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // A copy made among the app's own files before the file counted as one others can open is not left where a backup reads.
  if (shared) rmSync(join(ownImports(ctx.dataDir), hash(from.path)), { recursive: true, force: true })
  const tmp = join(dir, `${randomUUID()}.xlsx`)
  try {
    if (from.format === 'tsv') writeFileSync(tmp, writeXlsx(tsvBook(from.path)), { mode: 0o600 })
    // (a shared library's file is marked so by the runner itself and never carried to another host: formats/jobs.ts `sharedJob`)
    else await ctx.convert({ from: from.format, to: 'xlsx', input: from.path, output: tmp, ...(shared ? { shared: true } : {}), ...(signal ? { signal } : {}) })
    if (!hasMagic(tmp, 'zip')) throw new Error(`${basename(from.path)} could not be read as a workbook.`)
    signal?.throwIfAborted()
    renameSync(tmp, copy)
    // Stamped with the file as it stood before the conversion began: a change made meanwhile converts again.
    keepStamp(copy, { path: from.path, size: now.size, mtimeMs: now.mtimeMs, version: versionWord(version), copy: statOf(copy)! })
  } finally {
    rmSync(tmp, { force: true })
  }
}

export const TSV_MAX = 32 * 1024 * 1024
/** A .tsv's text: UTF-8, and no more than is read and written whole at each save. */
function tsvText(path: string): string {
  const name = basename(path)
  if (statSync(path).size > TSV_MAX) throw new Error(`${name} is too large to open as a sheet here.`)
  try {
    return utf8Text(readFileSync(path))
  } catch {
    throw new Error(`${name} is not UTF-8 text, so it cannot be opened as a sheet here.`)
  }
}
/** A .tsv as a workbook of one sheet named for the file, read as a .csv is: tabs split it, and a quoted field is one field. */
function tsvBook(path: string): ReturnType<typeof readCsv> {
  const sheet = splitName(basename(path)).stem.replace(/[\\/?*:[\]]/g, ' ').trim() || 'Sheet1'
  return readCsv(delimitedAsCsv(tsvText(path), '\t'), 'workbook', sheet)
}

/** What the view says of a copy: the file it is a copy of, whether that file moved on under his edits, and why it cannot go back. */
export function importedOf(held: { at: string; path?: string; from?: ImportedFrom }): SheetImported | undefined {
  if (held.at !== 'package' || !held.from || !held.path) return undefined
  const stamp = stampOf(held.path)
  const now = statOf(held.from.path)
  const stale = !!stamp && !!now && (stamp.size !== now.size || stamp.mtimeMs !== now.mtimeMs)
  const noBack = noBackOf(held.from)
  return { format: held.from.format, name: basename(held.from.path), ...(stale ? { stale: true as const } : {}), ...(noBack ? { noBack } : {}) }
}

// ── what a copy cannot carry back ─────────────────────────────────────

const VBA = Buffer.from('_VBA_PROJECT', 'utf16le')
const macroSeen = new Map<string, { stamp: string; value: boolean }>()
/**
 * Whether the file holds macros. The copy is an .xlsx, which keeps none, so writing it back would
 * take them out of his file: such a file is never written back. An .xls names its VBA storage in
 * its directory (UTF-16); an .ods keeps Basic and scripts as folders of its zip.
 */
export function holdsMacros(from: ImportedFrom): boolean {
  if (from.format === 'tsv') return false
  const st = statOf(from.path)
  if (!st) return false
  const stamp = `${st.size}:${st.mtimeMs}`
  const hit = macroSeen.get(from.path)
  if (hit?.stamp === stamp) return hit.value
  let value = false
  try {
    if (from.format === 'xls') value = fileIncludes(from.path, VBA)
    else value = [...readZip(new Uint8Array(readFileSync(from.path))).byName.keys()].some((name) => /^(Basic|Scripts)\/./.test(name))
  } catch {
    // A file that cannot be read says nothing here: the conversion says why.
  }
  macroSeen.set(from.path, { stamp, value })
  return value
}
function fileIncludes(path: string, needle: Buffer): boolean {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    // Each read starts where the last one's tail could still hold the start of a match.
    for (let at = 0; ; ) {
      const n = readSync(fd, buf, 0, buf.length, at)
      if (buf.subarray(0, n).includes(needle)) return true
      if (n < buf.length) return false
      at += n - needle.length
    }
  } finally {
    closeSync(fd)
  }
}
/** Why the copy cannot go back as the format it was, as the start of a sentence the view's line and a refused press each end. */
export const HOLDS_MACROS = 'This file holds macros, which an Excel copy does not keep'
const noBackOf = (from: ImportedFrom): string | undefined => (holdsMacros(from) ? HOLDS_MACROS : undefined)

// ── his presses ───────────────────────────────────────────────────────

export const IMPORT_HIS_PRESS = 'Only the owner saves a copy back or out, from his own window.'
export const NOT_A_COPY = 'This sheet is not a copy of another format.'
const changedWords = (name: string): string => `${name} changed since this copy was made. Save as Excel to keep your edits.`
const goneWords = (name: string): string => `${name} is no longer where it was. Save as Excel to keep your edits.`

/**
 * `work.sheets.imported`: what he does with a copy. His press only (his window here or one of his
 * own remote windows; never a thread, never another host's call), and for a file others can open a
 * remote key needs `approve`, as Files' door asks of any change there.
 */
export async function importAct(s: Sheets, by: Caller, item: CanvasItem, held: { at: string; path?: string; from?: ImportedFrom }, act: SheetImportAct): Promise<SheetImportDone> {
  if (held.at !== 'package' || !held.from || !held.path) throw new Error(NOT_A_COPY)
  if (by.kind === 'model' || (by.kind === 'remote' && by.peer)) throw new Error(IMPORT_HIS_PRESS)
  const ctx = s.ctx
  const copy = held.path
  const from = held.from
  if (by.kind === 'remote' && sharedOf(ctx, item.source) && !by.caps.includes('approve')) throw new Error(NEEDS_APPROVE)
  // Every edit of his is in the copy before it is read: the package store saves in the order asked.
  await s.packages.idle()
  if (act === 'again') {
    if (!statOf(from.path)) throw new Error(`${basename(from.path)} is no longer where it was.`)
    await serial(copy, () => convert(ctx, copy, from, true))
    return {}
  }
  // A file only touched or synced again since is still the one the copy was made from.
  await ensureImported(ctx, held)
  // No edit of his lands in the copy while it is converted and stamped: the stamp says which copy went back.
  if (act === 'back') return serial(copy, () => s.packages.holding(copy, () => saveBack(s, copy, from)))
  const done = await saveAsExcel(ctx, item, copy, from)
  // A Files tab that became the .xlsx no longer holds the copy of a file others can open: what the package store kept of it goes too.
  if (done.itemId !== item.id && isSharedImport(ctx.dataDir, copy) && !existsSync(copy)) s.packages.release({ items: [item.id] })
  return done
}

/** The copy written as the format it was, over the file it was made from, while that file is still the one. */
async function saveBack(s: Sheets, copy: string, from: ImportedFrom): Promise<SheetImportDone> {
  const ctx = s.ctx
  const name = basename(from.path)
  const why = noBackOf(from)
  if (why) throw new Error(`${why}. Save as Excel instead.`)
  const stamp = stampOf(copy)
  if (!stamp || !existsSync(copy)) throw new Error('Open the sheet first.')
  if (!statOf(from.path)) throw new Error(goneWords(name))
  const bytes = new Uint8Array(readFileSync(copy))
  const made = from.format === 'tsv' ? await tsvBack(s, copy, from, stamp) : await officeBack(ctx, copy, from.format)
  const got = await saveFile({ roots: [dirname(from.path)] }, await fileKey(ctx, from.path), from.path, made, stamp.version)
  if ('conflict' in got) throw new Error('gone' in got.conflict ? goneWords(name) : changedWords(name))
  const now = statOf(from.path)!
  keepStamp(copy, { path: from.path, size: now.size, mtimeMs: now.mtimeMs, version: got.version, copy: statOf(copy)! })
  return { path: from.path, ...dropsOf(from.format, bytes) }
}

/** An .xls or .ods of the copy: LibreOffice loads it, works every formula out again and stores it (formatsInBack.ts). */
async function officeBack(ctx: WorkCtx, copy: string, format: 'xls' | 'ods'): Promise<Uint8Array> {
  // Made in the OS temp folder, which no backup reads, and removed as the save ends.
  const dir = mkdtempSync(join(tmpdir(), 'tc-sheet-back-'))
  try {
    const done = await ctx.convert({
      from: 'xlsx',
      to: backTarget(format),
      input: copy,
      output: join(dir, `out.${format}`),
      // The copy of a file others can open is as private as the file: the job runs here or fails.
      ...(isSharedImport(ctx.dataDir, copy) ? { shared: true } : {})
    })
    return new Uint8Array(readFileSync(done.output))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A .tsv of the copy's first sheet, as a patch of the file: where a cell still holds what the file
 * gave it, the file's own field stays byte for byte (formatsInCsv.ts `patchCsv`). The file read
 * here must be the one the copy was made from; the door checks the same again as it writes.
 */
async function tsvBack(s: Sheets, copy: string, from: ImportedFrom, stamp: Stamp): Promise<Uint8Array> {
  const original = tsvText(from.path)
  const version = await versionOf(from.path)
  if (version.sha256 === undefined || version.sha256 !== sha(stamp.version)) throw new Error(changedWords(basename(from.path)))
  // (a formula of his with no value worked out is refused there, and the file keeps its bytes)
  const next = await s.jobs.csv(copy).catch((err: unknown) => {
    throw new Error(`${err instanceof Error ? err.message : String(err)} Save as Excel to keep your edits.`)
  })
  return new TextEncoder().encode(patchCsv(original, next, writeCsv(tsvBook(from.path)), '\t'))
}

/** What the format left behind of this workbook, counted from the copy as it was written ("2 tables become plain ranges"). */
function dropsOf(format: SheetImportFormat, bytes: Uint8Array): { drops?: string[] } {
  try {
    const drops = sheetDrops(format, factsOfPackage(bytes), { package: true })
    return drops.length ? { drops } : {}
  } catch {
    return {}
  }
}

/**
 * The copy written out as an .xlsx he can see in Files, and opened: in the same tab in the Files
 * place, beside the copy in a thread. Beside his own file; for a file others can open, or one that
 * lies among the app's files (a mail's attachment), in his workspace's own folder. Never over a
 * file: a taken name tries "Budget 2.xlsx".
 */
async function saveAsExcel(ctx: WorkCtx, item: CanvasItem, copy: string, from: ImportedFrom): Promise<SheetImportDone> {
  if (!existsSync(copy)) throw new Error('Open the sheet first.')
  const shared = sharedOf(ctx, item.source)
  const inApp = from.path.startsWith(ctx.dataDir + sep)
  const dir = shared || inApp ? ownFolder(ctx, item.sessionId) : dirname(from.path)
  const stem = splitName(basename(from.path)).stem.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim().slice(0, 120) || 'Sheet'
  const path = await writeFresh(dir, `${stem}.xlsx`, copy)
  const source: CanvasSource = { at: 'file', host: ctx.host, path }
  const pane = filesPaneWorkspace(item.sessionId) !== null
  const next = pane ? ctx.canvas.replace(item.sessionId, item.id, 'sheet', source, basename(path)) : ctx.canvas.open(item.sessionId, 'sheet', source, basename(path))
  // The tab shows the .xlsx now: the copy has no reader, and the first file opens as itself the next time.
  if (pane) dropCopy(copy)
  return { path, itemId: next.id }
}

async function writeFresh(dir: string, name: string, from: string): Promise<string> {
  const { stem, ext } = splitName(name)
  for (let n = 1; n < 1000; n++) {
    try {
      return await makeFile({ roots: [dir] }, dir, n === 1 ? name : `${stem} ${n}${ext}`, { from })
    } catch (err) {
      if (!(err instanceof FileRefused) || err.code !== 'taken') throw err
    }
  }
  throw new Error(`No free name for ${name} in that folder.`)
}

export const NO_FOLDER = 'Others can open this file, and there is no folder of your own here to write a copy into. Copy the file in Files first.'
/** His own folder for what he takes out of a place others can open: the workspace's, of the Files pane or the thread the item is in. */
function ownFolder(ctx: WorkCtx, owner: string): string {
  const ws = filesPaneWorkspace(owner) ?? ctx.scopeOf(owner)?.workspaceId ?? null
  const folder = ws ? (workspaceHere(ctx.db, ws)?.path ?? null) : null
  if (!folder || sharedOf(ctx, { at: 'file', host: ctx.host, path: join(folder, 'x') })) throw new Error(NO_FOLDER)
  return folder
}

// ── what goes, and what follows a moved file ──────────────────────────

function dropCopy(copy: string): void {
  stamps.delete(copy)
  keptStale.delete(copy)
  rmSync(dirname(copy), { recursive: true, force: true })
}

/** A tab closed for good: the copy made for it of a file others can open goes with it, at once (`itemsRemoved`). */
export function dropSharedImports(dataDir: string, itemId: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(itemId)) return
  const dir = join(sharedImports(dataDir), itemId)
  stamps.delete(join(dir, COPY))
  rmSync(dir, { recursive: true, force: true })
}

/**
 * His own file was renamed or moved (moved.ts): its copy follows it, with the edits it holds.
 * Answers the copy's old and new paths, which the package store's rows are moved between as an
 * opened Excel file's are; null when there was no copy, or the file is no longer one of these.
 */
export function importMoved(dataDir: string, from: string, to: string): { from: string; to: string } | null {
  if (!importFormatOf(from)) return null
  const was = join(ownImports(dataDir), hash(from))
  if (!existsSync(was)) return null
  const old = join(was, COPY)
  stamps.delete(old)
  if (!importFormatOf(to)) {
    rmSync(was, { recursive: true, force: true })
    return null
  }
  const now = join(ownImports(dataDir), hash(to))
  rmSync(now, { recursive: true, force: true })
  renameSync(was, now)
  const copy = join(now, COPY)
  const stamp = stampOf(copy)
  if (stamp) keepStamp(copy, { ...stamp, path: to })
  return { from: old, to: copy }
}
