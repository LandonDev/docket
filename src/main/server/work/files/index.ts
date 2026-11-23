import { NOT_HANDLED } from '@shared/work'
import type { WorkModule } from '../modules'
import { ensureFilesTables } from './tables'

/**
 * The files pillar's server module (docs/agents/work-files.md): the Files place of a Work workspace. Its
 * tables come from `ensure`; its methods are `work.files.*` (src/shared/contract-work-files.ts). The three
 * registries a kind's pillar fills for it (hooks.ts) are their own state: nothing here clears them, so a
 * registration made before or after this module starts is kept.
 */
export const files: WorkModule = {
  id: 'files',
  ensure: ensureFilesTables,
  // Never touches the registries of hooks.ts: what a kind's pillar registered before this ran is still there after.
  start: () => () => {},
  async handle() {
    return NOT_HANDLED
  }
}
