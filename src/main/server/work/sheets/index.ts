import { spawn } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SHEET_COMPARE_MAX, type SheetMutationJson } from '@shared/contract-work-sheets'
import { handled, NOT_HANDLED, type CanvasItem } from '@shared/work'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { afterEdit, fence, heldOf, host, newId, principalOf, readRange, setChart, sheetsOf, storeKey, viewOf, type Sheets } from './held'
import { ensurePackageTables } from './packages'
import { ensureSuggestionTables } from './suggestions'
import { sheetTools, writeAccepted } from './tools'

/**
 * The sheets pillar's server module (docs/agents/work-sheets.md): the sheet
 * kind of canvas item. An opened .xlsx or .xlsm is held here and saved by
 * patching it; a LifeOS sheet or a `.tcsheet` is held by the Work service,
 * which this module asks. Agents read, write and suggest through the tools
 * (tools.ts); on a shared sheet an agent's own idea waits as a suggestion.
 */

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
  const held = heldOf(item)
  const who = principalOf(s.ctx, by)
  if (held.at === 'package') {
    // A refusal (NotSaved) is said once over the grid: the edit stays in the grid, and the file keeps what it had.
    const got = await s.packages.edit(held.path, baseRev, mutations, who)
    if (!('conflict' in got)) afterEdit(s, storeKey(held), mutations)
    return got
  }
  return host(s.ctx, 'apply', { sheet: held.ref, baseRev, mutations, by: who })
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
    if (item) fence(ctx, by, item, req.method)
    switch (req.method) {
      case 'work.sheets.open':
        return handled(await viewOf(s, item!))
      case 'work.sheets.load': {
        const held = heldOf(item!)
        const { rev, offset, length } = req.params
        if (held.at === 'package') return handled({ ...readRange(s.packages.fileAt(held.path, rev), offset, length), rev, format: 'xlsx' as const })
        const key = storeKey(held)
        let snap = s.snapshots.get(key)
        if (!snap || snap.rev !== rev || offset === 0) {
          const got = await host(ctx, 'snapshot', { sheet: held.ref })
          if (got.rev !== rev) throw new Error('The sheet moved on since it was opened: open it again.')
          snap = { rev, bytes: Buffer.from(got.json, 'utf8') }
          s.snapshots.set(key, snap)
        }
        const part = snap.bytes.subarray(offset, offset + length)
        if (offset + part.length >= snap.bytes.length) s.snapshots.delete(key)
        return handled({ data: part.toString('base64'), size: snap.bytes.length, rev, format: 'snapshot' as const })
      }
      case 'work.sheets.since': {
        const held = heldOf(item!)
        return handled(held.at === 'package' ? s.packages.since(held.path, req.params.rev) : await host(ctx, 'since', { sheet: held.ref, rev: req.params.rev }))
      }
      case 'work.sheets.edit': {
        const got = await edit(s, item!, req.params.baseRev, req.params.mutations, by)
        if (!('conflict' in got)) await announce(s, item!, false)
        return handled(got)
      }
      case 'work.sheets.review': {
        const held = heldOf(item!)
        const key = storeKey(held)
        if (held.at === 'package') {
          const decided = s.suggestions.decide(key, req.params.which, req.params.verdict)
          if (req.params.verdict === 'accept' && decided.length) await writeAccepted(s, held.path, decided, principalOf(ctx, by))
        } else await host(ctx, 'review', { sheet: held.ref, which: req.params.which, verdict: req.params.verdict })
        await announce(s, item!)
        return handled(await viewOf(s, item!))
      }
      case 'work.sheets.mode': {
        s.suggestions.setMode(storeKey(heldOf(item!)), req.params.mode)
        await announce(s, item!)
        return handled(await viewOf(s, item!))
      }
      case 'work.sheets.undo': {
        const held = heldOf(item!)
        if (held.at !== 'package') throw new Error('Take it back with Undo in the sheet, or restore from History.')
        await s.packages.undo(held.path, req.params.writeId)
        s.suggestions.setWritten(storeKey(held), null)
        await announce(s, item!)
        return handled(await viewOf(s, item!))
      }
      case 'work.sheets.history': {
        const held = heldOf(item!)
        return handled(held.at === 'package' ? { revisions: s.packages.history(held.path) } : await host(ctx, 'history', { sheet: held.ref }))
      }
      case 'work.sheets.compare': {
        const held = heldOf(item!)
        const { from, to } = req.params
        return handled(held.at === 'package' ? await s.packages.compare(held.path, from, to, SHEET_COMPARE_MAX) : await host(ctx, 'compare', { sheet: held.ref, from, to, max: SHEET_COMPARE_MAX }))
      }
      case 'work.sheets.restore': {
        const held = heldOf(item!)
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
        setChart(ctx, storeKey(heldOf(item!)), req.params.chart, req.params.remove)
        await announce(s, item!)
        return handled(await viewOf(s, item!))
      }
      case 'work.sheets.switch': {
        const held = heldOf(item!)
        if (held.at !== 'package') throw new Error('This sheet opens only here for now.')
        await openInExcel(held.path)
        return handled({ opened: true as const })
      }
      case 'work.sheets.export':
        throw new Error('not built: writing a sheet out as an .xlsx (milestone 27 left it; the model writer is not in yet)')
    }
    return NOT_HANDLED
  },
  tools: () => sheetTools,
  preamble: () =>
    'A sheet in the canvas is read with `sheet_read` and changed with `sheet_write` or `sheet_suggest`, cells in A1. Say why you write: `because: "asked"` with the owner\'s words as `quote` when he asked for exactly this change, `"routine"` when a routine you run was granted it, else `"own"`. On a sheet others share, your own idea waits as a suggestion he steps through cell by cell.',
  sessionsRemoved() {},
  workspaceRemoved() {}
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

