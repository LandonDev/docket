import { handled, NOT_HANDLED } from '@shared/work'
import type { WorkModule } from '../modules'
import { announce, dashItem, dashRow, DashStore, ensureDashboardsTables, fenceDash, refresh, removeBlock, review, viewOf } from './dash'
import { dashboardsTools } from './tools'

/**
 * The dashboards pillar's server module (docs/agents/work-dashboards.md): a
 * saved page of figures read from sheets, refreshed on his press or by a
 * routine's `dashboard_refresh`. A block an agent adds waits for his Accept.
 */

const OWNER_ONLY = new Set(['work.dashboards.refresh', 'work.dashboards.review', 'work.dashboards.remove'])

export const dashboards: WorkModule = {
  id: 'dashboards',
  ensure(db) {
    ensureDashboardsTables(db)
  },
  async handle(req, ctx, by) {
    if (!req.method.startsWith('work.dashboards.')) return NOT_HANDLED
    if (by.kind === 'model' && OWNER_ONLY.has(req.method)) throw new Error('Only the owner changes a dashboard from the canvas.')
    const item = dashItem(ctx, (req as { params: { itemId: string } }).params.itemId)
    // A remote key sees the figures only when it could name every file they are read from.
    fenceDash(ctx, by, dashRow(ctx, item), req.method)
    switch (req.method) {
      case 'work.dashboards.open':
        return handled(await viewOf(ctx, dashRow(ctx, item)))
      case 'work.dashboards.refresh':
        return handled(await announce(ctx, await refresh(ctx, item)))
      case 'work.dashboards.review':
        return handled(await announce(ctx, review(ctx, item, req.params.which, req.params.verdict)))
      case 'work.dashboards.remove':
        return handled(await announce(ctx, removeBlock(ctx, item, req.params.blockId)))
    }
    return NOT_HANDLED
  },
  tools: () => dashboardsTools,
  preamble: () =>
    'A dashboard is a saved page of figures read from sheets: make one with `dashboard_create`, propose blocks with `dashboard_add` (each waits for the owner\'s Accept; say what every number counts), read it with `dashboard_read`, and read it again with `dashboard_refresh`, which is what a routine that keeps it current calls.',
  sessionsRemoved(ids, ctx) {
    new DashStore(ctx.db).removeSessions(ids)
  },
  // Nothing: a deleted workspace's threads are removed too, and `sessionsRemoved` clears their rows.
  workspaceRemoved() {}
}
