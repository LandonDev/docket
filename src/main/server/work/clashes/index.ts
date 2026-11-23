import { handled, NOT_HANDLED } from '@shared/work/ids'
import type { WorkModule } from '../modules'
import { answer, leaveFor, listClashes, milesFor, waive } from './read'
import type { TellKind } from './tell'
import { clashesListTool } from './tool'
import { ensureClashes, watchClashes } from './watch'

/**
 * The clashes pillar's server module (docs/agents/work-clashes.md). LifeOS
 * finds clashes across every job and measures the drives; this module
 * watches them, tells the digest of each new one, answers the wire and
 * gives a thread its own job's clashes. It declares no act kind: his
 * answer from the Clash dialog is his press, and an agent's goes through
 * the held tools that exist.
 */
const module: WorkModule = {
  id: 'clashes',
  ensure: ensureClashes,
  start: (ctx) => watchClashes(ctx),
  tools: () => [clashesListTool],
  async handle(req, ctx, by) {
    switch (req.method) {
      case 'work.clashes.list':
        return handled(await listClashes(ctx, req.params.from, req.params.to))
      case 'work.clashes.leave':
        return handled(await leaveFor(ctx, req.params.eventId))
      case 'work.clashes.miles':
        return handled(await milesFor(ctx, req.params.workspaceId, req.params.from, req.params.to))
      case 'work.clashes.waive':
        return handled(await waive(ctx, req.params.id, req.params.on))
      case 'work.clashes.answer':
        return handled(await answer(ctx, req.params, by))
    }
    return NOT_HANDLED
  }
}

/** The digest's group for news of a clash. */
export const CLASHES_TELLS: TellKind[] = [{ kind: 'clashes.new', group: 'clashes', name: 'Clashes' }]

// `tells` rides beside the module until the digest declares it on WorkModule; then it moves into the literal above.
export const clashes: WorkModule = Object.assign(module, { tells: CLASHES_TELLS })
