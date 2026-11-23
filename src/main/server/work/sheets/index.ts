import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { IWorkbookData } from '@univerjs/core'
import { SHEET_COMPARE_MAX, SHEET_LOAD_MAX, type SheetCellJson, type SheetMutationJson } from '@shared/contract-work-sheets'
import { filesPaneWorkspace, handled, NOT_HANDLED, type CanvasItem, type Principal } from '@shared/work'
import { canvasItemDir } from '../canvas/store'
import { sharedOf, workspaceHere } from '../files/policy'
import { registerFileMaker, registerFileMoved, registerFilePreviewer, registerFileWaiting, type FileMaker } from '../files/hooks'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { fullEditorHere, fullEditorOf, openFull } from './fullEditor'
import { blankWorkbook } from './host/backends'
import type { SheetRef } from './host/wire'
import { writeCsv, writeXlsx, writeXlsxWhole } from './writer'
import { ensureChangeTables } from './changes'
import { afterEdit, ensureCsvSheet, fence, heldOf, host, newId, principalOf, readRange, isSharedCsvSheet, setChart, setSharedPath, sheetsOf, storeKey, viewFor, viewOf, type Held, type Sheets } from './held'
import { sheetFileMoved } from './moved'
import { ensurePackageTables, type Moved } from './packages'
import { dropSharedPreviews, dropSharedPreviewsOf, exportPreview, previewSheet, readSheetPreview, SHEET_PREVIEW_CONVERTERS, sheetFilePreviewer, sweepPreviewScratch } from './preview'
import { mapCell, STRUCTURAL_CONVERTERS } from './structural'
import { ensureSuggestionTables, type Which } from './suggestions'
import { layChange, sheetTools, Unplaced, writeAccepted } from './tools'
import { sheetWaiting } from './waiting'

/**
 * The sheets pillar's server module (docs/agents/work-sheets.md): the sheet
 * kind of canvas item. An opened .xlsx or .xlsm is held here and saved by
 * patching it; a LifeOS sheet or a `.tcsheet` is held by the Work service,
 * which this module asks. Agents read, write and suggest through the tools
 * (tools.ts); on a shared sheet an agent's own idea waits as a suggestion.
 */

/** A workbook in Excel or Google keeps its history there (File → Browse Version History, File → Version history), not here. */
function notExcel<H extends ReturnType<typeof heldOf>>(held: H): Exclude<H, { at: 'excel' | 'google' }> {
  if (held.at === 'excel') throw new Error('Excel keeps this workbook\'s history: open it there with File → Browse Version History.')
  if (held.at === 'google') throw new Error('Google keeps this spreadsheet\'s history: open it there with File → Version history.')
  return held as Exclude<H, { at: 'excel' | 'google' }>
}

function itemOf(ctx: WorkCtx, itemId: string): CanvasItem {
  const item = ctx.canvas.get(itemId)
  if (!item) throw new Error(`There is no canvas item ${itemId}.`)
  if (item.kind !== 'sheet') throw new Error(`${item.title} is not a sheet.`)
  return item
}

/** Something landed on the item's sheet: its canvases catch up (`work.sheets.since`). */
export async function announce(s: Sheets, item: CanvasItem, withView = true): Promise<void> {
  const view = await viewOf(s, item)
  const path = item.source.at === 'file' ? item.source.path : undefined
  // A sheet others can open: what waits on it is his alone to see, and a push goes to every key. It
  // carries no view; each canvas reads its own (`viewFor`).
  const sent = !withView ? {} : view.shared ? { stale: true as const } : { view }
  s.ctx.push({ push: 'work.sheets', sessionId: item.sessionId, itemId: item.id, rev: view.rev, ...sent }, path ? { path } : undefined)
}

async function edit(s: Sheets, item: CanvasItem, baseRev: number, mutations: SheetMutationJson[], by: Caller): Promise<{ rev: number } | { conflict: true; rev: number }> {
  const held = heldOf(item, s.ctx.dataDir)
  const who = principalOf(s.ctx, by)
  if (held.at === 'excel') return (await import('../office/grid')).edit(s.ctx, held.ref, baseRev, mutations, who)
  if (held.at === 'google') return (await import('../google/grid')).edit(s.ctx, held.ref, baseRev, mutations, who)
  if (held.at === 'package') {
    // A refusal (NotSaved) is said once over the grid: the edit stays in the grid, and the file keeps what it had.
    const got = await s.packages.edit(held.path, baseRev, mutations, who)
    if ('conflict' in got) return got
    if (got.moved) {
      await followRows(s, held.path, got.moved)
      // Rows, columns or sheets changed: a waiting format or rule may no longer be where the agent saw it.
      s.changes.orphanAll(storeKey(held))
    } else afterEdit(s, storeKey(held), mutations)
    return { rev: got.rev }
  }
  return host(s.ctx, 'apply', { sheet: held.ref, baseRev, mutations, by: who })
}

/**
 * After rows, columns or sheets changed in a package, each suggestion waiting over it moves with its
 * cell (by the sheet's name, since LibreOffice numbers sheets again), or is orphaned when its row,
 * column or sheet went.
 */
async function followRows(s: Sheets, path: string, moved: Moved): Promise<void> {
  const key = `file:${path}`
  const open = s.suggestions.open(key)
  if (!open.length) return
  const after = (await s.packages.open(path)).inspected.sheets
  for (const sug of open) {
    const name = moved.before.get(sug.sheet)
    const to = name === undefined ? null : mapCell(moved.ops, name, sug.row, sug.col)
    const id = to && after.find((x) => x.name === to.sheet)?.id
    if (!to || !id) s.suggestions.mark(key, [sug.id], 'orphaned')
    else s.suggestions.move(key, sug.id, id, to.row, to.col)
  }
}

export const sheets: WorkModule = {
  id: 'sheets',
  ensure(db) {
    ensurePackageTables(db)
    ensureSuggestionTables(db)
    ensureChangeTables(db)
    db.exec('CREATE TABLE IF NOT EXISTS work_sheets_charts (store TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (store, id))')
  },
  async handle(req, ctx, by) {
    if (!req.method.startsWith('work.sheets.')) return NOT_HANDLED
    const s = await sheetsOf(ctx)
    const named = (req as { params?: { itemId?: unknown } }).params?.itemId
    const item = typeof named === 'string' ? itemOf(ctx, named) : null
    if (item) {
      fence(ctx, by, item, req.method)
      ensureCsvSheet(heldOf(item, ctx.dataDir), ctx.dataDir)
    }
    switch (req.method) {
      case 'work.sheets.open':
        return handled(viewFor(await viewOf(s, item!), by))
      case 'work.sheets.load': {
        const held = heldOf(item!, ctx.dataDir)
        const { rev, offset, length } = req.params
        if (held.at === 'package') return handled({ ...readRange(s.packages.fileAt(held.path, rev), offset, length), rev, format: 'xlsx' as const })
        if (held.at === 'excel' || held.at === 'google') {
          const all = held.at === 'excel' ? await (await import('../office/grid')).snapshot(ctx, held.ref, rev) : await (await import('../google/grid')).snapshot(ctx, held.ref, rev)
          return handled({ data: all.subarray(offset, offset + length).toString('base64'), size: all.length, rev, format: 'snapshot' as const })
        }
        const got = await host(ctx, 'snapshot', { sheet: held.ref, rev, offset, length })
        return handled({ data: got.data, size: got.size, rev, format: 'snapshot' as const })
      }
      case 'work.sheets.since': {
        const held = heldOf(item!, ctx.dataDir)
        if (held.at === 'excel' || held.at === 'google') {
          const rev = held.at === 'excel' ? (await import('../office/grid')).revOf(held.ref) : (await import('../google/grid')).revOf(held.ref)
          return handled(rev === req.params.rev ? { rev, ops: [] } : { rev, reload: true as const })
        }
        return handled(held.at === 'package' ? s.packages.since(held.path, req.params.rev) : await host(ctx, 'since', { sheet: held.ref, rev: req.params.rev }))
      }
      case 'work.sheets.edit': {
        await approves(s, item!, by)
        const got = await edit(s, item!, req.params.baseRev, req.params.mutations, by)
        if (!('conflict' in got)) await announce(s, item!, false)
        return handled(got)
      }
      case 'work.sheets.review': {
        // Taking a suggestion writes it where others may read it: his press alone, never a thread's call.
        if (by.kind === 'model') throw new Error('Only the owner accepts or rejects a suggestion.')
        const held = heldOf(item!, ctx.dataDir)
        const key = storeKey(held)
        // Taking one writes it: a remote key changes a sheet others can open only with `approve`. Dropping
        // one there is his too: a key that may not see what waits (`viewFor`) decides none of it.
        await approves(s, item!, by)
        // A format or a rule the agent proposed is this host's own row: taken, it is laid as his edit; dropped, it is gone.
        const mine = held.at === 'package' || held.at === 'service' ? await reviewChanges(s, held, key, req.params.which, req.params.verdict, principalOf(ctx, by)) : false
        if (mine === 'only') {
          // (the ids named no cell suggestion)
        } else if (held.at === 'package') await reviewPackage(s, held.path, key, req.params.which, req.params.verdict, principalOf(ctx, by))
        else if (held.at === 'excel') await (await import('../office/grid')).review(ctx, held.ref, req.params.which, req.params.verdict, principalOf(ctx, by))
        // An accepted set goes to Google as one write (google/grid.ts).
        else if (held.at === 'google') await (await import('../google/grid')).review(ctx, held.ref, req.params.which, req.params.verdict)
        else await host(ctx, 'review', { sheet: held.ref, which: req.params.which, verdict: req.params.verdict })
        await announce(s, item!)
        const after = await viewOf(s, item!)
        // A sheet others can open: what he decided leaves this host's database with his press (what still waits stays, as he ruled).
        if (after.shared) {
          s.suggestions.prune(key)
          s.changes.prune(key)
        }
        return handled(viewFor(after, by))
      }
      case 'work.sheets.mode': {
        if (by.kind === 'model') throw new Error('Only the owner sets what an agent may do to a sheet.')
        s.suggestions.setMode(storeKey(heldOf(item!, ctx.dataDir)), req.params.mode)
        await announce(s, item!)
        return handled(viewFor(await viewOf(s, item!), by))
      }
      case 'work.sheets.undo': {
        const held = heldOf(item!, ctx.dataDir)
        if (held.at !== 'package') throw new Error('Take it back with Undo in the sheet, or restore from History.')
        await approves(s, item!, by)
        await s.packages.undo(held.path, req.params.writeId)
        s.suggestions.setWritten(storeKey(held), null)
        await announce(s, item!)
        return handled(viewFor(await viewOf(s, item!), by))
      }
      case 'work.sheets.history': {
        const held = notExcel(heldOf(item!, ctx.dataDir))
        return handled(held.at === 'package' ? { revisions: s.packages.history(held.path) } : await host(ctx, 'history', { sheet: held.ref }))
      }
      case 'work.sheets.compare': {
        const held = notExcel(heldOf(item!, ctx.dataDir))
        const { from, to } = req.params
        return handled(held.at === 'package' ? await s.packages.compare(held.path, from, to, SHEET_COMPARE_MAX) : await host(ctx, 'compare', { sheet: held.ref, from, to, max: SHEET_COMPARE_MAX }))
      }
      case 'work.sheets.restore': {
        const held = notExcel(heldOf(item!, ctx.dataDir))
        await approves(s, item!, by)
        if (held.at === 'package') {
          await s.packages.restore(held.path, req.params.rev, principalOf(ctx, by))
          s.suggestions.orphanAll(storeKey(held))
          s.changes.orphanAll(storeKey(held))
        } else {
          await host(ctx, 'restore', { sheet: held.ref, rev: req.params.rev, by: principalOf(ctx, by) })
          // The sheet is another revision's now: a waiting format or rule may no longer be where the agent saw it.
          s.changes.orphanAll(storeKey(held))
        }
        await announce(s, item!)
        return handled(viewFor(await viewOf(s, item!), by))
      }
      case 'work.sheets.create':
        return handled({ itemId: (await createSheet(s, req.params.sessionId, req.params.title)).id })
      case 'work.sheets.chart': {
        setChart(ctx, storeKey(heldOf(item!, ctx.dataDir)), req.params.chart, req.params.remove)
        await announce(s, item!)
        return handled(viewFor(await viewOf(s, item!), by))
      }
      case 'work.sheets.switch': {
        const held = heldOf(item!, ctx.dataDir)
        if (held.at === 'excel') {
          await (await import('../office/grid')).bringForward(ctx, item!.source)
          return handled({ opened: true as const })
        }
        // Google's own editor, in the system browser.
        if (held.at === 'google') return handled({ opened: true as const, url: await (await import('../google/grid')).webLink(ctx, held.ref) })
        if (held.at !== 'package') throw new Error('This sheet opens only here for now.')
        if (fullEditorHere(ctx.dataDir)) return handled({ opened: true as const, url: await openFull(ctx, item!, held.path, by, req.params.scheme) })
        await openInExcel(held.path)
        return handled({ opened: true as const })
      }
      case 'work.sheets.export':
        return handled(await exportSheet(s, item!, req.params.format, req.params.sheet))
      // Preview and export (preview.ts): a sheet he can only read still previews; nothing here changes the file.
      case 'work.sheets.preview':
        return handled(await previewSheet(s, item!, req.params))
      case 'work.sheets.previewRead':
        return handled(readSheetPreview(ctx, item!, req.params))
      case 'work.sheets.previewExport':
        return handled(await exportPreview(s, item!, req.params))
    }
    return NOT_HANDLED
  },
  // A sheet's file renamed or moved takes what is kept by its path with it (moved.ts); the full editor's docservice stops with Work (fullEditor/).
  start(ctx) {
    // Which file others can open is the host's rule: a .csv that is one opens as a cache that does not last (held.ts).
    setSharedPath((path) => sharedOf(ctx, { at: 'file', host: ctx.host, path }))
    // Files reads the suggestions waiting in a workbook from here: a count in its row, and Home's Waiting on you.
    const offWaiting = registerFileWaiting(sheetWaiting)
    const offMoved = registerFileMoved(sheetFileMoved)
    // An .xlsx is edited in place here, whole: Files seats one from a library in this kind (not in Excel), and New makes one.
    const offMaker = registerFileMaker('sheet', SHEET_MAKER)
    // Files' page picture of a workbook: the first page of its print, drawn as Preview draws it. A crash's scratch goes.
    sweepPreviewScratch(ctx.dataDir)
    const offPreviewer = registerFilePreviewer('sheet', sheetFilePreviewer(ctx))
    const off = (): void => {
      offWaiting()
      offMoved()
      offMaker()
      offPreviewer()
    }
    return () => {
      off()
      void fullEditorOf(ctx).stop('Work is off')
    }
  },
  tools: () => sheetTools,
  convert: [...STRUCTURAL_CONVERTERS, ...SHEET_PREVIEW_CONVERTERS],
  preamble: () =>
    'A sheet in the canvas is read with `sheet_read` and changed with `sheet_write` or `sheet_suggest`, cells in A1. Say why you write: `because: "asked"` with the owner\'s words as `quote` when he asked for exactly this change, `"routine"` when a routine you run was granted it, else `"own"`. On a sheet others share, your own idea waits as a suggestion he steps through cell by cell.',
  // A workbook others can open keeps nothing here past its tab or its thread (packages.ts `release`).
  itemsRemoved(items, ctx) {
    const ids = items.filter((item) => item.kind === 'sheet').map((item) => item.id)
    // What Preview made of a shared workbook goes with its item, at once (preview.ts `storeFor`).
    for (const id of ids) dropSharedPreviews(ctx.dataDir, id)
    if (ids.length) void sheetsOf(ctx).then((s) => s.packages.release({ items: ids })).catch(() => {})
  },
  sessionsRemoved(ids, ctx) {
    // What Preview made of a shared workbook in a deleted thread goes with the thread (preview.ts): the frame says
    // the threads here, not their items.
    dropSharedPreviewsOf(ctx.dataDir, ids)
    if (ids.length) void sheetsOf(ctx).then((s) => s.packages.release({ sessions: ids })).catch(() => {})
  },
  workspaceRemoved() {}
}

/**
 * What the sheet kind tells Files it writes and then edits in place (files/hooks.ts): an .xlsx. A blank one is a
 * workbook of one empty sheet in Excel's own default font, written by the model writer.
 */
export const SHEET_MAKER: FileMaker = {
  forms: ['xlsx'],
  async blank(target) {
    const wb = blankWorkbook('workbook', 'Sheet1')
    wb.custom = { ...(wb.custom ?? {}), defaults: { family: 'Calibri', size: 11 } }
    writeFileSync(target.path, writeXlsx(wb))
  }
}

/**
 * A change to a sheet others can open, made with a remote key: only a key that may approve, as Files' door asks of any
 * change in such a place (files/policy.ts). His own window and another host of his are not held here.
 */
export const NEEDS_APPROVE = 'Others can open this sheet: this key may not change it.'
async function approves(s: Sheets, item: CanvasItem, by: Caller): Promise<void> {
  if (by.kind !== 'remote' || by.peer || by.caps.includes('approve')) return
  if ((await viewOf(s, item)).shared) throw new Error(NEEDS_APPROVE)
}

/**
 * Takes or drops the formats and rules an agent proposed (changes.ts). Taken, each is laid as the
 * owner's own edit on the sheet as the agent saw it (`rev`), which its store moves through what
 * landed since; where rows, columns or sheets changed in between it cannot be, and the change
 * turns `orphaned`, for him to drop; so does one the sheet has no place for now (its tab renamed,
 * its name taken since), and an accept of many goes on past it. `only`: the ids named these and no
 * cell suggestion.
 */
async function reviewChanges(s: Sheets, held: Extract<Held, { at: 'package' | 'service' }>, key: string, which: Which, verdict: 'accept' | 'reject', by: Principal): Promise<'only' | 'some' | false> {
  const picked = s.changes.pick(key, which)
  if (!picked.length) return false
  const only = which !== 'all' && 'ids' in which && which.ids.every((id) => picked.some((p) => p.id === id))
  if (verdict === 'reject') {
    s.changes.mark(key, picked.map((p) => p.id), 'rejected')
    return only ? 'only' : 'some'
  }
  for (const change of picked) {
    if (change.state !== 'pending') {
      if (only) throw new Error(MOVED_SINCE)
      continue
    }
    let why = MOVED_SINCE
    const landed = await layChange(s, held, change.ask, by, change.words, change.rev).catch((err: unknown) => {
      if (!(err instanceof Unplaced)) throw err
      why = err.message
      return false
    })
    if (landed) s.changes.mark(key, [change.id], 'accepted')
    else {
      s.changes.mark(key, [change.id], 'orphaned')
      if (only) throw new Error(why)
    }
  }
  return only ? 'only' : 'some'
}
const MOVED_SINCE = 'Rows or columns changed since the agent suggested this: reject it, or make the change yourself.'

/**
 * Takes or drops suggestions over a package. An accepted cell is written only while it still holds
 * what the agent saw (a cell changed since, here or in Excel, turns `conflict`), and is marked
 * accepted only once the file has it: a save that fails leaves it waiting.
 */
async function reviewPackage(s: Sheets, path: string, key: string, which: Which, verdict: 'accept' | 'reject', by: Principal): Promise<void> {
  const picked = s.suggestions.pick(key, which)
  if (verdict === 'reject') return s.suggestions.mark(key, picked.map((p) => p.id), 'rejected')
  const one = which !== 'all' && 'ids' in which
  const pending = picked.filter((p) => p.state === 'pending')
  const now = await s.packages.cellsAt(path, pending)
  const stale = pending.filter((p, i) => !sameCell(now[i].cell, p.base))
  s.suggestions.mark(key, stale.map((p) => p.id), 'conflict')
  const ok = pending.filter((p) => !stale.includes(p))
  if (ok.length) {
    await writeAccepted(s, path, ok, by)
    s.suggestions.mark(key, ok.map((p) => p.id), 'accepted')
  }
  if (one && ok.length < picked.length) throw new Error('That cell changed since the agent saw it: reject it, or edit the cell yourself.')
}

const sameCell = (a: SheetCellJson | null, b: SheetCellJson | null): boolean => (a?.f ?? null) === (b?.f ?? null) && (a?.f ? true : (a?.v ?? null) === (b?.v ?? null))

/** A name not yet taken in its folder: `Budget.xlsx`, then `Budget (2).xlsx`. */
function free(path: string): string {
  const ext = extname(path)
  let out = path
  for (let i = 2; existsSync(out); i++) out = `${path.slice(0, -ext.length)} (${i})${ext}`
  return out
}

/** The workbook a service-held sheet stands at now, read in frames. */
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

/**
 * Writes a sheet out (the model writer, writer.ts): a held sheet to a new .xlsx, or one of its sheets
 * to .csv. A sheet read from a .csv saves back over it as .csv, and as .xlsx beside it; a package
 * gives .csv beside itself; anything else lands among the item's own files. `left`: the lists of rules
 * the .xlsx could not hold, in words.
 */
export async function exportSheet(s: Sheets, item: CanvasItem, format: 'xlsx' | 'csv', sheet?: string): Promise<{ path: string; left?: string[] }> {
  const held = heldOf(item, s.ctx.dataDir)
  const base = item.title.replace(/\.(xlsx|xlsm|tcsheet|csv)$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim() || 'Sheet'
  // What he writes out of a sheet others can open is a copy he takes: it lands in his own workspace's folder, never
  // beside the file (a library would sync it to the team) and never among what the app keeps for him.
  const shared = sharedOf(s.ctx, item.source)
  const own = (): string => {
    const dir = shared ? ownFolderOf(s.ctx, item.sessionId) : canvasItemDir(s.ctx.dataDir, item.sessionId, item.id)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const beside = (near: string, name: string): string => (shared ? free(join(own(), name)) : free(join(dirname(near), name)))
  if (held.at === 'excel') throw new Error(`${item.title} lives in Excel: save or export it there.`)
  if (held.at === 'google') throw new Error(`${item.title} lives in Google: download it there with File → Download.`)
  if (held.at === 'package') {
    if (format === 'xlsx') throw new Error('This is an Excel file already: every edit is saved into it.')
    const path = beside(held.path, `${base}.csv`)
    writeFileSync(path, await s.jobs.csv(held.path, sheet))
    return { path }
  }
  const wb = await workbookOf(s.ctx, held.ref)
  if (format === 'csv') {
    // A .csv others can open opens to read and is not written over from here; one he was already editing here is still saved back.
    const back = held.csv && !isSharedCsvSheet(s.ctx.dataDir, held.ref) ? held.csv : null
    const path = back ?? (shared ? free(join(own(), `${base}.csv`)) : join(own(), `${base}.csv`))
    const text = writeCsv(wb, sheet)
    // Saved back over a file others can open: through Files' one door for replacing a file where it lies (its lock, one whole replace), as an Excel file's save is.
    if (back && shared) {
      const { saveFile, versionWord } = await import('../files/save')
      const { versionOf } = await import('../files/write')
      const { fileKey } = await import('./held')
      const got = await saveFile({ roots: [dirname(back)] }, await fileKey(s.ctx, back), back, new TextEncoder().encode(text), versionWord(await versionOf(back)))
      if ('conflict' in got) throw new Error('The file changed as it was saved: try again.')
    } else writeFileSync(path, text)
    return { path }
  }
  const path = held.csv ? beside(held.csv, `${base}.xlsx`) : shared ? free(join(own(), `${base}.xlsx`)) : join(own(), `${base}.xlsx`)
  // A list of rules the file cannot hold is left out, and said: "the names", "conditional formats on Q1".
  const { bytes, left } = writeXlsxWhole(wb)
  writeFileSync(path, bytes)
  return { path, ...(left.length ? { left: left.map((l) => (l.sheet ? `${l.what} on ${l.sheet}` : `the ${l.what}`.replace('the the ', 'the '))) } : {}) }
}

/**
 * His own folder for a copy he takes of a sheet others can open: the workspace's, of the Files pane or the thread the
 * item is in. Refused in words where there is none, or where that folder is itself one others can open.
 */
function ownFolderOf(ctx: WorkCtx, owner: string): string {
  const ws = filesPaneWorkspace(owner) ?? ctx.scopeOf(owner)?.workspaceId ?? null
  const folder = ws ? (workspaceHere(ctx.db, ws)?.path ?? null) : null
  if (!folder || sharedOf(ctx, { at: 'file', host: ctx.host, path: join(folder, 'x') })) throw new Error('Others can open this sheet, and there is no folder of your own here to write a copy into. Copy the file in Files first.')
  return folder
}

/** A new sheet in a thread's canvas: a LifeOS sheet when its workspace has a sector, else a `.tcsheet` among this host's files. */
/** The sector a sheet is made in: a thread's, or a Files pane's workspace's on this host; undefined for any other owner. */
export function sectorOf(ctx: WorkCtx, owner: string): string | null | undefined {
  const scope = ctx.scopeOf(owner)
  if (scope) return scope.sector
  const ws = filesPaneWorkspace(owner)
  const row = ws ? workspaceHere(ctx.db, ws) : null
  return row ? row.sector : undefined
}

export async function createSheet(s: Sheets, sessionId: string, title: string): Promise<CanvasItem> {
  const ctx = s.ctx
  const pane = ctx.canvas.paneOf(sessionId)
  const sector = sectorOf(ctx, pane)
  if (sector === undefined) throw new Error('Sheets are made in Work threads or the Files place.')
  if (sector && ctx.lifeos.connected()) {
    const got = await host(ctx, 'create', { title, at: { lifeos: { sector } } })
    if (!('lifeos' in got.sheet)) throw new Error('LifeOS did not make the sheet.')
    return ctx.canvas.open(pane, 'sheet', { at: 'lifeos', table: 'sheets', id: got.sheet.lifeos }, title)
  }
  const dir = join(ctx.dataDir, 'sheets', 'made', newId())
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim() || 'Sheet'}.tcsheet`)
  await host(ctx, 'create', { title, at: { tcsheet: path } })
  return ctx.canvas.open(pane, 'sheet', { at: 'file', host: ctx.host, path }, title)
}

/** Desktop Excel, brought forward with the file. Only where Excel is installed: the Mac and Windows. */
function openInExcel(path: string): Promise<void> {
  statSync(path)
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', ['-a', 'Microsoft Excel', path]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', 'excel', path]] : [null, []]
  if (!cmd) return Promise.reject(new Error('Excel is not on this host.'))
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args as string[], { stdio: 'ignore' })
    child.on('error', () => reject(new Error('Excel is not on this host.')))
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('Excel did not open the file.'))))
  })
}

