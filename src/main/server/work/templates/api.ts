import type { Template, TemplateMade } from '@shared/work/templates'
import type { Caller, WorkCtx } from '../modules'
import { makeFromShelf, type MakeAsk } from './make'
import { listTemplates, registerStarterTemplates, type StarterEntry } from './shelf'

/**
 * What another pillar may call (docs/agents/work-templates.md "For other
 * pillars"). This is the only file of the templates pillar another may
 * import; it loads no screen and starts nothing.
 */

/** A pillar's own call is no person's press: it is treated as a thread's, so it writes only into the workspace's own folder and never asks Files' door as him. */
const PILLAR: Caller = { kind: 'model', caps: [] }

/**
 * Makes a file from a template in a workspace and answers where it is.
 * `template` is an id, a starter's key (`'unify/invoice'`,
 * `'any/meeting-notes'`) or a name (`'Invoice'`): by name his own in that
 * job wins, then all jobs', then ours. `into` is a folder inside the
 * workspace's own folder, made if missing. A field not passed stays in the
 * file as `{{Field}}` and is named in `unfilled`; nothing asks. Opening the
 * file is the caller's. Pass `by` when the call is a person's own press, so
 * Files' door judges it as his.
 */
export const makeFromTemplate = (ctx: WorkCtx, ask: MakeAsk, by: Caller = PILLAR): Promise<TemplateMade> => makeFromShelf(ctx, by, ask)

/** A workspace's shelf, in its order: the job's own, its starters, all jobs', every job's starters. */
export const templatesFor = (ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, workspaceId: string): Template[] => listTemplates(ctx, workspaceId).templates

export { registerStarterTemplates }
export type { MakeAsk, StarterEntry }
