import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, statSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path'
import type { ChartSpec } from 'work-kit/sheet/xlsx'
import { legacyChartSpec, type OldChartRow } from './patch/charts-legacy'
import { SHEET_NOTES, SHEET_ROW, type SheetMutationJson, type SheetStoreKind, type SheetView } from '@shared/contract-work-sheets'
import { agentPrincipal, canvasSourcePath, type CanvasItem, type Principal } from '@shared/work'
import { refKey } from '@shared/work/files'
import { FenceError } from '../../remote/fence'
import { fetchedFile } from '../canvas/fetch'
import { sharedOf } from '../files/policy'
import { Toolchain } from '../formats/tools'
import { ensureImported, importedHeld, importedOf, isSharedImport, type ImportedFrom } from './formatsIn'
import { sharedCsvCache, sharedCsvReadOnly, throughCsv } from './formatsInCsv'
import { fullEditorHere } from './fullEditor'
import type { Caller, WorkCtx } from '../modules'
import { excelStore } from '../office/excel'
import { excelRefOf, type ExcelRef } from '../office/grid'
import { googleSheetRefOf, googleStore, type GoogleSheetRef } from '../google/grid'
import { gz, tcsheetRev, writeTcsheet } from './host/backends'
import type { HostAnswer, HostAsk, SheetRef } from './host/wire'
import { readCsv } from './writer'
import { cellsOfMutations, PackageStore } from './packages'
import { ChangeStore } from './changes'
import { SuggestionStore } from './suggestions'
import type { SheetJobs } from './workerClient'
import { offersGoogle } from './toGoogleOffer'

/**
 * Where a sheet item lives and how the pillar reaches it
 * (docs/agents/work-sheets.md): an opened package is held here, in main,
 * through the package store and the sheet worker; a LifeOS sheet and a
 * `.tcsheet` file are held by the Work service (host/), which main asks over
 * its socket.
 */

/** `from`: the package is the Excel copy of an .xls, .ods or .tsv (formatsIn.ts), which changes only by his press. */
export type Held = { at: 'package'; path: string; from?: ImportedFrom } | { at: 'service'; ref: SheetRef; csv?: string } | { at: 'excel'; ref: ExcelRef } | { at: 'google'; ref: GoogleSheetRef }

export const PACKAGE_EXT = new Set(['.xlsx', '.xlsm'])

/** The store an item names. */
export function heldOf(item: Pick<CanvasItem, 'source' | 'title'> & Partial<Pick<CanvasItem, 'id' | 'sessionId'>>, dataDir?: string): Held {
  const s = item.source
  // A mail's attachment is the copy the pane fetched into the item's own folder (canvas/fetch.ts), opened as a file of his would be.
  if (s.at === 'mail') {
    if (!dataDir || !item.id || !item.sessionId) throw new Error(`${item.title} has not come from the mail yet.`)
    return heldOf({ source: { at: 'file', host: '', path: fetchedFile(dataDir, item as CanvasItem) }, title: item.title }, dataDir)
  }
  if (s.at === 'lifeos' && s.table === 'sheets') return { at: 'service', ref: { lifeos: s.id } }
  if (s.at === 'file') {
    const ext = extname(s.path).toLowerCase()
    if (PACKAGE_EXT.has(ext)) return { at: 'package', path: s.path }
    if (ext === '.tcsheet') return { at: 'service', ref: { tcsheet: s.path } }
    // A .csv opens as a sheet of our own, read from it once: saving writes it back, or out as .xlsx.
    if (ext === '.csv' && dataDir) return { at: 'service', ref: { tcsheet: csvSheetPath(dataDir, s.path) }, csv: s.path }
    // An .xls, an .ods or a .tsv opens as an Excel copy LibreOffice makes of it: a shared file's copy is its tab's own.
    const copy = dataDir ? importedHeld(dataDir, s.path, sharedCsv(s.path), item.id) : null
    if (copy) return copy
    throw new Error(`${basename(s.path)} is not a workbook this canvas opens (.xlsx, .xlsm, .tcsheet, .csv, .xls, .ods or .tsv).`)
  }
  // A workbook that lives in Excel: Excel is the truth, the office pillar's helper reads and writes it (milestone 28).
  const excel = excelRefOf(s)
  if (excel) return { at: 'excel', ref: excel }
  // A Google spreadsheet: Google is the truth, the google pillar reads and writes it (milestone 30).
  const google = googleSheetRefOf(s)
  if (google) return { at: 'google', ref: { ...google, name: item.title } }
  throw new Error(`${item.title} lives in ${s.at}: its sheet opens there.`)
}

/** The key suggestions, the mode and charts are kept under. */
export const storeKey = (h: Held): string =>
  h.at === 'package' ? `file:${h.path}` : h.at === 'excel' ? excelStore(h.ref.book) : h.at === 'google' ? googleStore(h.ref.fileId) : 'lifeos' in h.ref ? `lifeos:${h.ref.lifeos}` : `tcsheet:${h.ref.tcsheet}`

/** A file path an agent names: absolute, a workbook, there. */
export function heldOfPath(path: string, dataDir: string): Exclude<Held, { at: 'excel' | 'google' }> {
  if (!isAbsolute(path)) throw new Error(`${path} is not an absolute path.`)
  if (!existsSync(path)) throw new Error(`There is no file at ${path}.`)
  return heldOf({ source: { at: 'file', host: '', path }, title: basename(path) }, dataDir) as Exclude<Held, { at: 'excel' | 'google' }>
}

/** Where the sheet read from a .csv is kept: one per CSV path, under this host's data. */
export function csvSheetPath(dataDir: string, csv: string): string {
  // His own .csv, and a shared one he had edited here before this rule: the sheet among the app's files, as before.
  if (!sharedCsv(csv) || csvEdited(ownCsvPath(dataDir, csv))) return ownCsvPath(dataDir, csv)
  // A .csv others can open: a cache named for the file as it stood when read, so a co-author's newer file is read
  // again; a file that changed because an edit here was saved through keeps its cache (formatsInCsv.ts).
  return sharedCsvCache(sharedCsvDir(dataDir), csv)
}
const nameOfCsv = (csv: string): string => createHash('sha256').update(csv).digest('hex').slice(0, 24)
/** The sheet a .csv opens as among the app's own files. */
export const ownCsvPath = (dataDir: string, csv: string): string => join(dataDir, 'sheets', 'csv', `${nameOfCsv(csv)}.tcsheet`)
/**
 * Whether a .csv's sheet holds an edit of his (it stands past the revision it was read at): such a sheet is never
 * dropped or made read-only under him. A sheet that is there and cannot be read just now counts as edited: only a
 * read that says revision 0 lets it go. Asked on every request for the file, so the answer is kept by the sheet's
 * size and time.
 */
export function csvEdited(sheet: string): boolean {
  let stamp: string
  try {
    const st = statSync(sheet)
    stamp = `${st.size}:${st.mtimeMs}`
  } catch {
    return false
  }
  const hit = editedSeen.get(sheet)
  if (hit?.stamp === stamp) return hit.edited
  const rev = tcsheetRev(sheet)
  // (an unreadable sheet is not remembered: the next ask reads it again)
  if (rev === null) return true
  editedSeen.set(sheet, { stamp, edited: rev > 0 })
  return rev > 0
}
const editedSeen = new Map<string, { stamp: string; edited: boolean }>()
/**
 * A .csv others can open (the editors plan, "University files"): the sheet it is read into is a cache under
 * Files' scratch (out of the backups, cleared at each start). The cache does not last, so no edit is left in it
 * alone: every change to it is saved through to the file at once (`host`, formatsInCsv.ts `throughCsv`). Which
 * file that is, is the host's rule (`sharedOf`), set once the pillar has its context; before that, and in a test
 * that sets none, no file is.
 */
let sharedPath: ((path: string) => boolean) | null = null
export const setSharedPath = (fn: ((path: string) => boolean) | null): void => {
  sharedPath = fn
}
const sharedCsv = (csv: string): boolean => {
  try {
    return sharedPath?.(csv) ?? false
  } catch {
    return false
  }
}
export const sharedCsvDir = (dataDir: string): string => join(dataDir, 'work-files', 'preview-scratch', 'sheets', 'csv')
/** Whether a sheet the service holds is the cache of a .csv others can open. */
export const isSharedCsvSheet = (dataDir: string, ref: unknown): boolean => typeof (ref as { tcsheet?: unknown } | null)?.tcsheet === 'string' && (ref as { tcsheet: string }).tcsheet.startsWith(sharedCsvDir(dataDir) + sep)

/** Makes the sheet a .csv opens as, the first time: the CSV's cells as its first snapshot. */
export function ensureCsvSheet(held: Held, dataDir?: string): void {
  if (held.at !== 'service' || !held.csv || !('tcsheet' in held.ref)) return
  if (dataDir && isSharedCsvSheet(dataDir, held.ref)) {
    // A cache made among the app's own files before the file counted as shared is not left behind (one he edited is
    // still his sheet: `csvSheetPath` answered it, and this branch is not reached). Caches of the file as it stood go too.
    rmSync(ownCsvPath(dataDir, held.csv), { force: true })
    const mine = basename(held.ref.tcsheet)
    const prefix = `${mine.slice(0, mine.indexOf('-'))}-`
    try {
      for (const name of readdirSync(dirname(held.ref.tcsheet))) if (name.startsWith(prefix) && name !== mine) rmSync(join(dirname(held.ref.tcsheet), name), { force: true })
    } catch {
      /* no cache folder yet */
    }
  }
  if (existsSync(held.ref.tcsheet)) return
  mkdirSync(dirname(held.ref.tcsheet), { recursive: true })
  const title = basename(held.csv)
  const wb = readCsv(readFileSync(held.csv, 'utf8'), 'workbook', title)
  writeTcsheet(held.ref.tcsheet, { meta: { title, rev: 0, snapRev: 0 }, snapshots: new Map([[0, gz(wb)]]), ops: [], suggestions: [] })
}

/** What every caller of the pillar shares: one package store, one suggestion store, one worker. */
export interface Sheets {
  ctx: WorkCtx
  packages: PackageStore
  suggestions: SuggestionStore
  /** formats and rules an agent proposed, waiting for him (changes.ts) */
  changes: ChangeStore
  jobs: SheetJobs
}

const made = new WeakMap<WorkCtx['db'], Sheets>()
let jobsFor: (() => Promise<SheetJobs>) | null = null
/** A test hands its own jobs (the in-process ones). */
export const setJobs = (fn: (() => Promise<SheetJobs>) | null): void => {
  jobsFor = fn
}

export async function sheetsOf(ctx: WorkCtx): Promise<Sheets> {
  const hit = made.get(ctx.db)
  if (hit) return hit
  setSharedPath((path) => sharedOf(ctx, { at: 'file', host: ctx.host, path }))
  // The built app forks the sheet worker; a test, or a proof that bundled the server itself, runs the jobs in this process.
  const jobs =
    (jobsFor ? await jobsFor() : null) ??
    (process.versions.electron ? (await import('./spawnWorker')).appJobs() : null) ??
    (await (await import('./workerClient')).localJobs())
  const tools = new Toolchain(ctx.dataDir)
  const suggestions = new SuggestionStore(ctx.db)
  const changes = new ChangeStore(ctx.db)
  const s: Sheets = {
    ctx,
    // A change from outside moves cells we cannot follow: every open suggestion over the file is orphaned.
    packages: new PackageStore(
      ctx.db,
      jobs,
      join(ctx.dataDir, 'sheets', 'files'),
      () => tools.dir('ironcalc'),
      Date.now,
      (path) => {
        suggestions.orphanAll(`file:${path}`)
        changes.orphanAll(`file:${path}`)
      },
      // LibreOffice runs where it is installed: a host without it forwards the job (formats/jobs.ts).
      async (input, ops, kind) => {
        const dir = mkdtempSync(join(tmpdir(), 'tc-sheet-ops-'))
        const done = await ctx.convert({ from: kind, to: `${kind}+ops`, input, output: join(dir, `out.${kind}`), options: { ops } })
        return done.output
      },
      (path) => fileKey(ctx, path),
      // (the copy made of an .xls, .ods or .tsv others can open is as private as that file: formatsIn.ts)
      { root: sharedCopies(ctx.dataDir), is: (path) => isSharedImport(ctx.dataDir, path) || sharedOf(ctx, { at: 'file', host: ctx.host, path }) }
    ),
    suggestions,
    changes,
    jobs
  }
  made.set(ctx.db, s)
  // What was kept of a shared workbook before this rule is moved and emptied now, not only when it is next opened.
  setImmediate(() => {
    try {
      s.packages.sweep()
    } catch (err) {
      ctx.log(`sheets: shared workbooks' kept things were not swept: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  return s
}

/**
 * Where a workbook others can open keeps its working copies (the editors plan, "University files"): under Files'
 * own preview scratch (files/preview.ts `previewScratch`; library.test.ts holds the two equal), which both backups
 * leave out and Files clears at each start. Nothing made from such a file outlives its tab or thread.
 */
export const sharedCopies = (dataDir: string): string => join(dataDir, 'work-files', 'preview-scratch', 'sheets', 'files')

/**
 * Where Preview keeps what it makes of a workbook others can open (preview.ts): its renders, exported files and
 * scratch, one folder an item, under the same preview scratch. Gone with the item (index.ts `itemsRemoved`) and at
 * Files' start; a draw that finds it gone draws again.
 */
export const sharedPreviewsRoot = (dataDir: string): string => join(dataDir, 'work-files', 'preview-scratch', 'sheets', 'previews')
export const sharedPreviews = (dataDir: string, itemId: string): string => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(itemId)) throw new Error('not an item id')
  return join(sharedPreviewsRoot(dataDir), itemId)
}

/**
 * The key Files itself locks a file of this host under while it saves or changes it (files/handle.ts): a library's
 * file by its place and the path inside it, any other by its host and path. A save here takes the same key, so it
 * and a change made in Files take turns. Files' own code makes the key (`doorPlace`, `libraryKey`), read as his
 * own window would be: the lock is the file's, whoever saves.
 */
export async function fileKey(ctx: WorkCtx, path: string): Promise<string> {
  const { libraryOf } = await import('../office/files/library')
  const { librariesHere } = await import('../files/places/libraries')
  const found = libraryOf(librariesHere(ctx), path)
  if (!found) return refKey({ at: 'file', host: ctx.host, path })
  const { doorPlace } = await import('../files/handle')
  const { libraryKey } = await import('../files/places/teams')
  const { library } = doorPlace(ctx, { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }, { in: 'library', ...found })
  return library ? libraryKey(library, found.path) : refKey({ at: 'file', host: ctx.host, path })
}

/** One call to the Work service's sheet host. */
export async function host<A extends HostAsk['op']>(ctx: WorkCtx, op: A, body: Omit<Extract<HostAsk, { op: A }>, 'op'>): Promise<HostAnswer<A>> {
  const ask = async (): Promise<HostAnswer<A>> => (await ctx.service.internal(`/internal/sheet/${op}`, body)) as HostAnswer<A>
  // The cache of a .csv others can open does not last: a change to it, whoever makes it, is saved through to the file (or refused).
  const sheet = (body as { sheet?: unknown }).sheet
  if (WRITES.has(op) && isSharedCsvSheet(ctx.dataDir, sheet)) return throughCsv(ctx, (sheet as { tcsheet: string }).tcsheet, ask)
  return ask()
}
const WRITES: ReadonlySet<string> = new Set(['apply', 'cells', 'review', 'restore'])

/** A remote key reaches a file item only where it could name the file itself. */
export function fence(ctx: WorkCtx, by: Caller, item: CanvasItem, method: string): void {
  const path = canvasSourcePath(item.source)
  if (path !== null && !ctx.reaches(by, path)) throw new FenceError(method)
}

/** Who did it, as a principal: the owner at a screen, else the thread whose call it is. */
export const principalOf = (ctx: WorkCtx, by: Caller): Principal => (by.kind === 'model' && by.sessionId ? agentPrincipal(ctx.host, by.sessionId) : 'owner')

export function chartsOf(ctx: WorkCtx, store: string): OldChartRow[] {
  const rows = ctx.db.prepare('SELECT json FROM work_sheets_charts WHERE store = ? ORDER BY rowid').all(store) as { json: string }[]
  return rows.map((r) => JSON.parse(r.json) as OldChartRow)
}

/** An old chart row gone: it became a chart in the file. */
export function dropChart(ctx: WorkCtx, store: string, id: string): void {
  ctx.db.prepare('DELETE FROM work_sheets_charts WHERE store = ? AND id = ?').run(store, id)
}

/** The view a canvas draws: the store's state, with this host's suggestions, mode, written line and charts. */
export async function viewOf(s: Sheets, item: CanvasItem): Promise<SheetView> {
  const held = heldOf(item, s.ctx.dataDir)
  ensureCsvSheet(held, s.ctx.dataDir)
  await ensureImported(s.ctx, held)
  const key = storeKey(held)
  // A Files tab's owner is no thread and has no scope: what others can open is read from the source itself.
  const scope = s.ctx.scopeOf(item.sessionId)
  const shared = sharedOf(s.ctx, item.source) || (scope?.shared(item.source) ?? false)
  const base = { itemId: item.id, sessionId: item.sessionId, mode: s.suggestions.mode(key), ...(offersGoogle(s.ctx, held, item.source) ? { canUpload: true as const } : {}) }
  // Our old charts (`work_sheets_charts`, plain bars kept beside a sheet before it kept charts of its own) as the charts they
  // become: drawn on the grid, and kept with the sheet at the next change to that tab's charts (index.ts ends the row then).
  const rows = chartsOf(s.ctx, key)
  const legacyOf = (sheets: readonly { id: string; name: string }[]): { legacyCharts?: ChartSpec[] } => {
    const specs = rows.flatMap((row) => {
      const tab = sheets.find((x) => x.id === row.sheet)?.name
      const spec = tab === undefined ? undefined : legacyChartSpec(row, tab)
      return spec ? [spec] : []
    })
    return specs.length ? { legacyCharts: specs } : {}
  }
  const written = s.suggestions.written(key)
  if (held.at === 'package') {
    const st = await s.packages.open(held.path)
    // A workbook others can open is held by this tab: its copies go when the tab does (index.ts `itemsRemoved`).
    s.packages.hold(held.path, item.id, item.sessionId)
    const imported = importedOf(held)
    return {
      ...base,
      // (written into the file with his next change to that tab's charts, never before)
      ...legacyOf(st.inspected.sheets),
      // A copy of another format goes by the name of the file it was made from.
      name: imported?.name ?? basename(held.path),
      ...(imported ? { imported } : {}),
      store: 'package',
      ...(SHEET_ROW.package.length ? { row: [...SHEET_ROW.package] } : {}),
      ...(SHEET_NOTES.package.length ? { notes: [...SHEET_NOTES.package] } : {}),
      // moved cells go through LibreOffice, as an insert does: a host with none forwards the job
      moves: true,
      rev: st.rev,
      shared,
      suggestions: s.suggestions.open(key),
      ...changesOf(s, key),
      ...(written ? { written } : {}),
      // The switch goes to the full editor where this host runs it (the box), else to desktop Excel.
      ...(st.inspected.reach ? { reach: { ...st.inspected.reach, to: fullEditorHere(s.ctx.dataDir) ? 'full' : 'excel' } } : {}),
      ...(st.inspected.readOnly ? { readOnly: st.inspected.readOnly } : {}),
      ...(st.inspected.date1904 ? { date1904: true } : {}),
      ...(st.saveError ? { saveError: st.saveError } : {}),
      ...(st.missing ? { missing: true } : {})
    }
  }
  if (held.at === 'excel') {
    const grid = await import('../office/grid')
    return {
      ...base,
      name: held.ref.name,
      // In the canvas it is a file whose cell contents save and nothing else, as an opened package.
      store: 'package',
      rev: grid.follow(s.ctx, held.ref, item.id, () => void import('./index').then((m) => m.announce(s, item))),
      shared,
      suggestions: s.suggestions.open(key),
      ...(written ? { written } : {}),
      reach: { parts: ['formatting', 'inserting rows and columns'], to: 'excel' }
    }
  }
  if (held.at === 'google') {
    const grid = await import('../google/grid')
    return {
      ...base,
      name: held.ref.name,
      // As an Excel workbook: cell contents save, and the switch opens the spreadsheet in Google.
      store: 'package',
      rev: grid.follow(held.ref, item.id, () => void import('./index').then((m) => m.announce(s, item))),
      shared,
      suggestions: s.suggestions.open(key),
      ...(written ? { written } : {}),
      reach: { parts: ['formatting', 'inserting rows and columns'], to: 'google' }
    }
  }
  const st = await host(s.ctx, 'open', { sheet: held.ref })
  const store: SheetStoreKind = 'lifeos' in held.ref ? 'lifeos' : held.csv ? 'csv' : 'tcsheet'
  return {
    ...base,
    ...(store === 'csv' ? {} : legacyOf(st.sheets)),
    name: st.title,
    store,
    // The format row's controls: the ones this store keeps (rowMatrix.test.ts).
    ...(SHEET_ROW[store].length ? { row: [...SHEET_ROW[store]] } : {}),
    ...(SHEET_NOTES[store].length ? { notes: [...SHEET_NOTES[store]] } : {}),
    rev: st.rev,
    shared: shared || st.shared,
    suggestions: st.suggestions,
    ...changesOf(s, key),
    ...(written ? { written } : {}),
    // A .csv others can open saves each edit through to its file; one a save would damage opens to read.
    ...(held.csv && isSharedCsvSheet(s.ctx.dataDir, held.ref) && sharedCsvReadOnly(held.csv) ? { readOnly: sharedCsvReadOnly(held.csv)! } : {}),
    ...(st.missing ? { missing: true } : {})
  }
}

/** Whether the caller is he who decides what waits on a sheet: at a screen of this host or of another host of his, or a key that could take it. */
export const reviews = (by: Caller): boolean => by.kind === 'local' || (by.kind === 'remote' && (!!by.peer || by.caps.includes('approve')))

/**
 * A view for one caller. On a sheet others can open, what an agent suggested is his alone to see
 * until he takes it (the owner's ruling): any other key that can see the item, and a thread, gets
 * the sheet as it stands and nothing that waits.
 */
export function viewFor(view: SheetView, by: Caller): SheetView {
  if (!view.shared || reviews(by)) return view
  const { changes: _waiting, ...rest } = view
  return { ...rest, suggestions: [] }
}

/** The formats and rules an agent proposed on a sheet, for its view: this host's own rows, said in words. */
function changesOf(s: Sheets, key: string): { changes?: SheetView['changes'] } {
  const changes = s.changes.open(key)
  return changes.length ? { changes } : {}
}

/** Bytes of a file by range. */
export function readRange(path: string, offset: number, length: number): { data: string; size: number } {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)))
    readSync(fd, buf, 0, buf.length, offset)
    return { data: buf.toString('base64'), size }
  } finally {
    closeSync(fd)
  }
}

/** The owner's edits landed: a suggestion over a cell they changed no longer holds. */
export function afterEdit(s: Sheets, key: string, mutations: readonly SheetMutationJson[]): void {
  s.suggestions.conflictOn(key, cellsOfMutations(mutations))
}

export const newId = (): string => randomUUID()
