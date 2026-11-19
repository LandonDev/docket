import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { IWorkbookData } from '@univerjs/core'
import { SHEET_COMPARE_MAX, SHEET_LOAD_MAX, type SheetCellJson, type SheetMutationJson } from '@shared/contract-work-sheets'
import { handled, NOT_HANDLED, type CanvasItem, type Principal } from '@shared/work'
import { canvasItemDir } from '../canvas/store'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { fullEditorHere, fullEditorOf, openFull } from './fullEditor'
import type { SheetRef } from './host/wire'
import { writeCsv, writeXlsx } from './writer'
import { afterEdit, ensureCsvSheet, fence, heldOf, host, newId, principalOf, readRange, setChart, sheetsOf, storeKey, viewOf, type Sheets } from './held'
import { ensurePackageTables, type Moved } from './packages'
import { mapCell, STRUCTURAL_CONVERTERS } from './structural'
import { ensureSuggestionTables, type Which } from './suggestions'
import { sheetTools, writeAccepted } from './tools'

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
  s.ctx.push({ push: 'work.sheets', sessionId: item.sessionId, itemId: item.id, rev: view.rev, ...(withView ? { view } : {}) }, path ? { path } : undefined)
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
    if (got.moved) await followRows(s, held.path, got.moved)
    else afterEdit(s, storeKey(held), mutations)
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
    db.exec('CREATE TABLE IF NOT EXISTS work_sheets_charts (store TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (store, id))')
  },
  async handle(req, ctx, by) {
    if (!req.method.startsWith('work.sheets.')) return NOT_HANDLED
    const s = await sheetsOf(ctx)
    const named = (req as { params?: { itemId?: unknown } }).params?.itemId
    const item = typeof named === 'string' ? itemOf(ctx, named) : null
    if (item) {
      fence(ctx, by, item, req.method)
      ensureCsvSheet(heldOf(item, ctx.dataDir))
    }
    switch (req.method) {
      case 'work.sheets.open':
        return handled(await viewOf(s, item!))
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
        const got = await edit(s, item!, req.params.baseRev, req.params.mutations, by)
        if (!('conflict' in got)) await announce(s, item!, false)
        return handled(got)
      }
      case 'work.sheets.review': {
        const held = heldOf(item!, ctx.dataDir)
        const key = storeKey(held)
        if (held.at === 'package') await reviewPackage(s, held.path, key, req.params.which, req.params.verdict, principalOf(ctx, by))
        else if (held.at === 'excel') await (await import('../office/grid')).review(ctx, held.ref, req.params.which, req.params.verdict, principalOf(ctx, by))
        // An accepted set goes to Google as one write (google/grid.ts).
        else if (held.at === 'google') await (await import('../google/grid')).review(ctx, held.ref, req.params.which, req.params.verdict)
        else await host(ctx, 'review', { sheet: held.ref, which: req.params.which, verdict: req.params.verdict })
        await announce(s, item!)
        return handled(await viewOf(s, item!))
      }
      case 'work.sheets.mode': {
        s.suggestions.setMode(storeKey(heldOf(item!, ctx.dataDir)), req.params.mode)
        await announce(s, item!)
        return handled(await viewOf(s, item!))
      }
      case 'work.sheets.undo': {
        const held = heldOf(item!, ctx.dataDir)
        if (held.at !== 'package') throw new Error('Take it back with Undo in the sheet, or restore from History.')
        await s.packages.undo(held.path, req.params.writeId)
        s.suggestions.setWritten(storeKey(held), null)
        await announce(s, item!)
        return handled(await viewOf(s, item!))
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
        if (held.at === 'package') {
          await s.packages.restore(held.path, req.params.rev, principalOf(ctx, by))
          s.suggestions.orphanAll(storeKey(held))
        } else await host(ctx, 'restore', { sheet: held.ref, rev: req.params.rev, by: principalOf(ctx, by) })
        await announce(s, item!)
        return handled(await viewOf(s, item!))
      }
      case 'work.sheets.create':
        return handled({ itemId: (await createSheet(s, req.params.sessionId, req.params.title)).id })
      case 'work.sheets.chart': {
        setChart(ctx, storeKey(heldOf(item!, ctx.dataDir)), req.params.chart, req.params.remove)
        await announce(s, item!)
        return handled(await viewOf(s, item!))
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
        if (fullEditorHere(ctx.dataDir)) return handled({ opened: true as const, url: await openFull(ctx, item!, held.path, by) })
        await openInExcel(held.path)
        return handled({ opened: true as const })
      }
      case 'work.sheets.export':
        return handled({ path: await exportSheet(s, item!, req.params.format, req.params.sheet) })
    }
    return NOT_HANDLED
  },
  // The full editor's docservice stops with Work (fullEditor/).
  start: (ctx) => () => void fullEditorOf(ctx).stop('Work is off'),
  tools: () => sheetTools,
  convert: STRUCTURAL_CONVERTERS,
  preamble: () =>
    'A sheet in the canvas is read with `sheet_read` and changed with `sheet_write` or `sheet_suggest`, cells in A1. Say why you write: `because: "asked"` with the owner\'s words as `quote` when he asked for exactly this change, `"routine"` when a routine you run was granted it, else `"own"`. On a sheet others share, your own idea waits as a suggestion he steps through cell by cell.',
  sessionsRemoved() {},
  workspaceRemoved() {}
}

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
 * gives .csv beside itself; anything else lands among the item's own files.
 */
export async function exportSheet(s: Sheets, item: CanvasItem, format: 'xlsx' | 'csv', sheet?: string): Promise<string> {
  const held = heldOf(item, s.ctx.dataDir)
  const base = item.title.replace(/\.(xlsx|xlsm|tcsheet|csv)$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim() || 'Sheet'
  const own = (): string => {
    const dir = canvasItemDir(s.ctx.dataDir, item.sessionId, item.id)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  if (held.at === 'excel') throw new Error(`${item.title} lives in Excel: save or export it there.`)
  if (held.at === 'google') throw new Error(`${item.title} lives in Google: download it there with File → Download.`)
  if (held.at === 'package') {
    if (format === 'xlsx') throw new Error('This is an Excel file already: every edit is saved into it.')
    const path = free(join(dirname(held.path), `${base}.csv`))
    writeFileSync(path, await s.jobs.csv(held.path, sheet))
    return path
  }
  const wb = await workbookOf(s.ctx, held.ref)
  if (format === 'csv') {
    const path = held.csv ?? join(own(), `${base}.csv`)
    writeFileSync(path, writeCsv(wb, sheet))
    return path
  }
  const path = held.csv ? free(join(dirname(held.csv), `${base}.xlsx`)) : join(own(), `${base}.xlsx`)
  writeFileSync(path, writeXlsx(wb))
  return path
}

/** A new sheet in a thread's canvas: a LifeOS sheet when its workspace has a sector, else a `.tcsheet` among this host's files. */
export async function createSheet(s: Sheets, sessionId: string, title: string): Promise<CanvasItem> {
  const ctx = s.ctx
  const pane = ctx.canvas.paneOf(sessionId)
  const scope = ctx.scopeOf(pane)
  if (!scope) throw new Error('Sheets are made in Work threads.')
  if (scope.sector && ctx.lifeos.connected()) {
    const got = await host(ctx, 'create', { title, at: { lifeos: { sector: scope.sector } } })
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

