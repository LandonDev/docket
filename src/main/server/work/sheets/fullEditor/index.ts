import type { CanvasItem } from '@shared/work'
import { Toolchain } from '../../formats/tools'
import type { Caller, WorkCtx } from '../../modules'
import { servicePaths } from '../../service/config'
import { FullEditor, type FullEditorDeps } from './editor'

/**
 * The sheet canvas's full-editor switch on the box (milestone 40;
 * docs/agents/work-sheets.md, "The full editor"): ONLYOFFICE Docs
 * Community, unmodified, as a separate server for the owner alone
 * (architecture §12.1). The switch calls `openFull`; the Work service's
 * `/w/full/<token>/` route serves the editor; a save lands in the file as a
 * change from outside.
 */

const toolchains = new Map<string, Toolchain>()
const toolchainOf = (dataDir: string): Toolchain => {
  let t = toolchains.get(dataDir)
  if (!t) toolchains.set(dataDir, (t = new Toolchain(dataDir)))
  return t
}

/** Whether this host offers the full editor: Linux (the box), with ONLYOFFICE installed. */
export function fullEditorHere(dataDir: string): boolean {
  return process.platform === 'linux' && toolchainOf(dataDir).has('onlyoffice')
}

const editors = new WeakMap<WorkCtx['db'], FullEditor>()

/** This host's one full editor; a test hands its own seams. */
export function fullEditorOf(ctx: WorkCtx, seams: Partial<FullEditorDeps> = {}): FullEditor {
  let fe = editors.get(ctx.db)
  if (fe) return fe
  fe = new FullEditor({
    dataDir: ctx.dataDir,
    serviceSocket: servicePaths(ctx.dataDir).socketPath,
    toolDir: () => toolchainOf(ctx.dataDir).dir('onlyoffice'),
    enabled: () => ctx.enabled(),
    log: (line) => ctx.log(line),
    saved: (open) => void reload(ctx, open.itemId),
    failed: (open, words) => {
      // Said over the grid as the package store's own failed save is ("Couldn't save"), until the file next saves.
      ctx.db.prepare('UPDATE work_sheets_files SET save_error = ? WHERE path = ?').run(words, open.path)
      void reload(ctx, open.itemId)
    },
    ...seams
  })
  editors.set(ctx.db, fe)
  return fe
}

/** A save landed in the file: the item's canvases catch up (the package store sees the change from outside). */
async function reload(ctx: WorkCtx, itemId: string): Promise<void> {
  const item = ctx.canvas.get(itemId)
  if (!item) return
  try {
    const [{ sheetsOf }, { announce }] = await Promise.all([import('../held'), import('../index')])
    await announce(await sheetsOf(ctx), item)
  } catch (err) {
    ctx.log(`[full-editor] the canvas did not hear of the save: ${(err as Error).message}`)
  }
}

/** The address remote clients reach this host by (Settings → Hosts), else what the tunnel last said. */
function publicOrigin(ctx: WorkCtx): string | null {
  const read = (key: string): string | null => (ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value || null
  return read('remote.publicOrigin') ?? read('remote.learnedOrigin')
}

/**
 * Opens a workbook in the full editor for the owner and answers the page's
 * address: this host's loopback for a window on this host, else the address
 * the owner's own devices reach it by. Never for a thread, and never for a
 * key short of admin (a guest has none at all).
 */
export async function openFull(ctx: WorkCtx, item: CanvasItem, path: string, by: Caller): Promise<string> {
  if (by.kind === 'model') throw new Error('The full editor is the owner\'s: a thread cannot open it.')
  if (by.kind === 'remote' && !by.caps.includes('admin')) throw new Error('The full editor opens only on the owner\'s own devices.')
  // The route is the Work service's: it must be running before a token is worth anything.
  const local = ctx.service.url('/w/full/')
  const token = await fullEditorOf(ctx).open({ path, itemId: item.id, title: item.title })
  if (by.kind === 'local') return `${local}${token}/`
  const origin = publicOrigin(ctx)
  if (!origin) throw new Error('This host has no address the owner\'s devices reach it by (Settings → Hosts).')
  return `${origin.replace(/\/+$/, '')}/w/full/${token}/`
}
