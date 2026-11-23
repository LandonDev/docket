import { filesPaneWorkspace } from '@shared/work'
import type { WorkModule } from '../modules'
import { closeFilesState, filesHandle, filesState, itemsGone, removeWorkspace } from './handle'
import { ensureFilesTables } from './tables'
import { pruneOps, settleOps } from './write'

/**
 * The files pillar's server module (docs/agents/work-files.md): the Files place of a Work workspace. Its
 * tables come from `ensure`; its methods are `work.files.*` (src/shared/contract-work-files.ts, answered in
 * handle.ts). The three registries a kind's pillar fills for it (hooks.ts) are their own state: nothing here
 * clears them, so a registration made before or after this module starts is kept.
 */
export const files: WorkModule = {
  id: 'files',
  ensure: ensureFilesTables,
  handle: (req, ctx, by, signal) => filesHandle(req, ctx, by, signal),
  // Never touches the registries of hooks.ts: what a kind's pillar registered before this ran is still there after.
  start(ctx) {
    try {
      // A tab whose item is gone and an item whose tab is gone are dropped once, before any window asks.
      const mended = filesState(ctx).tabs.check()
      if (mended.tabs || mended.items) ctx.log(`files: dropped ${mended.tabs} tabs with no item and ${mended.items} items with no tab`)
    } catch (err) {
      ctx.log(`files: the tabs could not be checked: ${err instanceof Error ? err.message : String(err)}`)
    }
    // The journal: a change a dead process left running is marked failed, and rows past a week go, now and once a day.
    const tidy = (): void => {
      try {
        settleOps(ctx.db)
        pruneOps(ctx.db)
      } catch (err) {
        ctx.log(`files: the journal could not be tidied: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    tidy()
    const daily = setInterval(() => void pruneOps(ctx.db), 24 * 60 * 60 * 1000)
    daily.unref?.()
    return () => {
      clearInterval(daily)
      closeFilesState(ctx.db)
    }
  },
  // An item of a Files pane closed by another way than its tab (the pane's own Close): its tab goes too.
  itemsRemoved(items, ctx) {
    const mine = items.filter((item) => filesPaneWorkspace(item.sessionId) !== null)
    if (mine.length) itemsGone(ctx, mine.map((item) => item.id))
  },
  workspaceRemoved: (workspaceId, ctx) => removeWorkspace(ctx, workspaceId)
}
