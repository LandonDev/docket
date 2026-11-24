import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { IWorkbookData } from '@univerjs/core'
import { SHEET_LOAD_MAX } from '@shared/contract-work-sheets'
import { saveFile, versionWord } from '../files/save'
import type { WorkCtx } from '../modules'
import { fileKey } from './held'
import { readTcsheet, ungz } from './host/backends'
import { readCsv, writeCsv } from './writer'

/**
 * A `.csv` others can open, edited (docs/agents/work-sheets.md "A `.csv` others can open"). It is
 * read into a cache under Files' preview scratch, which does not last; so that an edit is never
 * only in that cache, every change to the cache is written through to the file at once, by Files'
 * one door for replacing a file where it lies (`saveFile`: its lock, one whole replace, and only
 * while the file is still the one that was read). The file is patched, not written again: a field
 * nobody changed keeps its own bytes, so one edit is one field in a co-author's diff.
 */

const nameOf = (csv: string): string => createHash('sha256').update(csv).digest('hex').slice(0, 24)
/** The file as it stands, in a few characters: the cache made of it is named for this. */
function stampOf(csv: string): string {
  try {
    const st = statSync(csv)
    return createHash('sha256').update(`${st.size}:${st.mtimeMs}`).digest('hex').slice(0, 8)
  } catch {
    return 'gone'
  }
}

/** The cache each shared .csv is held in during this run, and the file's stamp that cache agrees with. */
const caches = new Map<string, { sheet: string; stamp: string }>()
const csvOfSheet = new Map<string, string>()

/**
 * The cache a shared .csv opens as (`csvSheetPath` asks, with `sharedCsvDir`). Named for the file
 * as it stood when it was read, so a co-author's newer file is read into a new one; but a file
 * that changed because this host saved an edit through keeps the cache it had, with its revisions,
 * so the grid that made the edit goes on from where it was.
 */
export function sharedCsvCache(dir: string, csv: string): string {
  const stamp = stampOf(csv)
  const hit = caches.get(csv)
  if (hit && hit.stamp === stamp) return hit.sheet
  const sheet = join(dir, `${nameOf(csv)}-${stamp}.tcsheet`)
  caches.set(csv, { sheet, stamp })
  csvOfSheet.set(sheet, csv)
  return sheet
}

/** For a test: what this run remembers of the caches. */
export function forgetCsvCaches(): void {
  caches.clear()
  csvOfSheet.clear()
  whySeen.clear()
}

export const CSV_NOT_UTF8 = 'This .csv is not UTF-8 text, so it opens here to read: an edit saved from here would change its other characters.'
export const CSV_TOO_BIG = 'This .csv is too large to edit in a folder others can open: it opens here to read.'
export const CSV_NO_WRITE = 'You can only read this folder, so this .csv opens here to read.'
/** The most a shared .csv may hold and still be edited: each edit reads and writes it whole. */
export const CSV_THROUGH_MAX = 32 * 1024 * 1024

const whySeen = new Map<string, { stamp: string; why: string | null }>()
/** Why a shared .csv opens to read, when it does: bytes that are not UTF-8 would not survive a save, and neither would a file read in parts. */
export function sharedCsvReadOnly(csv: string): string | null {
  const stamp = stampOf(csv)
  const hit = whySeen.get(csv)
  if (hit?.stamp === stamp) return hit.why
  let why: string | null = null
  try {
    if (statSync(csv).size > CSV_THROUGH_MAX) why = CSV_TOO_BIG
    else if (!writable(csv)) why = CSV_NO_WRITE
    else decode(readFileSync(csv))
  } catch {
    why ??= CSV_NOT_UTF8
  }
  whySeen.set(csv, { stamp, why })
  return why
}
/** Whether a save could replace the file: the door writes beside it and renames over it. */
function writable(csv: string): boolean {
  try {
    accessSync(csv, constants.W_OK)
    accessSync(dirname(csv), constants.W_OK)
    return true
  } catch {
    return false
  }
}
/** The file's text with its byte-order mark kept; throws on bytes that are not UTF-8. */
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)

const changed = (csv: string): string => `${basename(csv)} changed in its folder, so this edit was not saved. Open it again to edit the newer file.`

/** One write to a file at a time, in the order asked. */
const chains = new Map<string, Promise<unknown>>()
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => {})
  chains.set(key, tail)
  void tail.then(() => chains.get(key) === tail && chains.delete(key))
  return run
}

type ServiceCtx = Pick<WorkCtx, 'service' | 'db' | 'host' | 'dataDir'>

/**
 * A change to the cache of a shared .csv (`host` runs every `apply`, `cells`, `review` and
 * `restore` for one through here): refused before it is made when the file is no longer the one
 * the cache was read from, or cannot be saved from here; made; then the file takes it. A change
 * that leaves the cells as they were (a suggestion that waits, a format) writes nothing.
 */
export function throughCsv<T>(ctx: ServiceCtx, sheet: string, write: () => Promise<T>): Promise<T> {
  const csv = csvOfSheet.get(sheet)
  if (!csv) return Promise.reject(new Error('Open the .csv again: its sheet here is from an earlier run.'))
  return serial(csv, async () => {
    const why = sharedCsvReadOnly(csv)
    if (why) throw new Error(why)
    const held = caches.get(csv)
    // The file as the cache agrees with it is read before the change is made, and is the version the save must find: a
    // co-author's save while the change is made (the service's wait) is not patched over with the cache's older fields.
    const bytes = existsSync(csv) ? readFileSync(csv) : null
    const before = bytes ? statSync(csv) : null
    if (!held || held.sheet !== sheet || held.stamp !== stampOf(csv) || !bytes || !before) throw new Error(changed(csv))
    const out = await write()
    if (out && typeof out === 'object' && 'conflict' in out) return out
    const original = decode(bytes)
    const expect = versionWord({ size: bytes.length, mtimeMs: before.mtimeMs, sha256: createHash('sha256').update(bytes).digest('hex') })
    const title = basename(csv)
    const next = patchCsv(original, writeCsv(await workbookOf(ctx, sheet)), writeCsv(readCsv(original, 'workbook', title)))
    if (next === original) return out
    const got = await saveFile({ roots: [dirname(csv)] }, await fileKey(ctx as WorkCtx, csv), csv, new TextEncoder().encode(next), expect).catch((err: unknown) => {
      // Never the door's own hidden path in his words.
      const code = (err as { code?: string } | null)?.code
      throw new Error(`${title} could not be saved: ${code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'this folder is read only' : code === 'ENOSPC' || code === 'EDQUOT' ? 'the disk is full' : 'the folder did not take it'}. The edit is still in this tab.`)
    })
    if ('conflict' in got) throw new Error(changed(csv))
    // The cache goes on as this file's: it is what the file now holds.
    caches.set(csv, { sheet, stamp: stampOf(csv) })
    return out
  })
}

/** The workbook the cache stands at now, read from the Work service in frames. */
async function workbookOf(ctx: ServiceCtx, tcsheet: string): Promise<IWorkbookData> {
  const ask = (op: string, body: Record<string, unknown>): Promise<unknown> => ctx.service.internal(`/internal/sheet/${op}`, { sheet: { tcsheet }, ...body })
  const { rev } = (await ask('open', {})) as { rev: number }
  const parts: Buffer[] = []
  for (let offset = 0, size = Infinity; offset < size; ) {
    const got = (await ask('snapshot', { rev, offset, length: SHEET_LOAD_MAX })) as { data: string; size: number }
    const part = Buffer.from(got.data, 'base64')
    parts.push(part)
    size = got.size
    offset += part.length
    if (!part.length) break
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as IWorkbookData
}

// ── the patch ─────────────────────────────────────────────────────────

interface Row {
  /** each field as the file has it, quotes and all */
  raw: string[]
  /** each field's text */
  value: string[]
  /** the line break that ended the row; '' when the text ended first */
  eol: string
}

/** A CSV's rows with each field's own bytes, split as `readCsv` splits them (RFC 4180 quoting, any line break); `delimiter` a tab for a TSV. */
export function csvRows(text: string, delimiter = ','): Row[] {
  const rows: Row[] = []
  let row: Row = { raw: [], value: [], eol: '' }
  let field = ''
  let start = 0
  let quoted = false
  const end = (at: number): void => {
    row.raw.push(text.slice(start, at))
    row.value.push(field)
    field = ''
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) {
      end(i)
      start = i + 1
    } else if (ch === '\n' || ch === '\r') {
      end(i)
      const eol = ch === '\r' && text[i + 1] === '\n' ? '\r\n' : ch
      rows.push({ ...row, eol })
      row = { raw: [], value: [], eol: '' }
      i += eol.length - 1
      start = i + 1
    } else field += ch
  }
  if (start < text.length || row.raw.length) {
    end(text.length)
    rows.push(row)
  }
  return rows
}

/**
 * The file's text with the sheet's cells in it. `next` is the sheet as our writer words it now and
 * `asRead` the file as our writer would word it untouched (`writeCsv(readCsv(original))`): where
 * the two agree on a cell, the file's own field is kept byte for byte (its quotes, `1.50`, `1e5`);
 * where they differ, the field is the sheet's. Each row keeps its own line break and its own
 * count of fields unless a cell past it was filled; the byte-order mark, the blank lines at the
 * end and whether the last line ends with a break stay as they were. `delimiter` is the file's own (a
 * tab for a TSV); `next` and `asRead` are always our writer's CSV.
 */
export function patchCsv(original: string, next: string, asRead: string, delimiter = ','): string {
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : ''
  const was = csvRows(original.slice(bom.length), delimiter)
  // A changed field is worded for the file's delimiter: our writer's own quoting for a comma, else quoted only where it must be.
  const worded = (row: Row, c: number): string => (delimiter === ',' ? (row.raw[c] ?? '') : fieldFor(row.value[c] ?? '', delimiter))
  const read = csvRows(asRead)
  const now = csvRows(next)
  const eol = was.find((r) => r.eol)?.eol ?? '\n'
  const closed = was.length === 0 || was[was.length - 1].eol !== ''
  const lines: string[][] = []
  const breaks: string[] = []
  now.forEach((row, r) => {
    const own = was[r]
    let width = own?.raw.length ?? 0
    row.value.forEach((v, c) => {
      if (v !== '') width = Math.max(width, c + 1)
    })
    const fields: string[] = []
    for (let c = 0; c < width; c++) {
      const kept = own?.raw[c]
      fields.push(kept !== undefined && (read[r]?.value[c] ?? '') === (row.value[c] ?? '') ? kept : worded(row, c))
    }
    lines.push(fields)
    breaks.push(own?.eol || eol)
  })
  // Blank lines after the last row of cells are his file's own: they stay.
  for (let r = Math.max(now.length, read.length); r < was.length; r++) {
    lines.push(was[r].raw)
    breaks.push(was[r].eol || eol)
  }
  if (!lines.length) return bom
  if (!closed) breaks[breaks.length - 1] = ''
  return bom + lines.map((fields, i) => fields.join(delimiter) + breaks[i]).join('')
}

/** One field in a file that splits on `delimiter`: quoted when it holds the delimiter, a quote or a line break. */
const fieldFor = (value: string, delimiter: string): string => (value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/** A delimited text's cells as the CSV `readCsv` reads: a TSV's tabs become commas, with our writer's quoting. */
export function delimitedAsCsv(text: string, delimiter: string): string {
  return csvRows(text.replace(/^\uFEFF/, ''), delimiter)
    .map((row) => row.value.map((v) => (/[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(','))
    .join('\r\n')
}

/** A file's text with its byte-order mark kept; throws on bytes that are not UTF-8. */
export const utf8Text = (bytes: Uint8Array): string => decode(bytes)

/**
 * A sheet of his made among the app's files from a .csv that others can open now (made before that rule): the file's
 * contents it last agreed with, kept beside it at each save back from here. Its Save as CSV writes only over a file
 * that still holds them, or, never saved back, over one that still reads as the sheet's first snapshot.
 */
const baseOf = (sheet: string): string => `${sheet}.base`
export function legacyCsvAgrees(csv: string, sheet: string, text: string, sha256: string): boolean {
  try {
    return readFileSync(baseOf(sheet), 'utf8') === sha256
  } catch {
    const first = readTcsheet(sheet).snapshots.get(0)
    return !!first && writeCsv(ungz(first)) === writeCsv(readCsv(text, 'workbook', basename(csv)))
  }
}
export function keepLegacyCsvBase(sheet: string, sha256: string): void {
  writeFileSync(baseOf(sheet), sha256, { mode: 0o600 })
}
