import type { ProjectLinked } from '@shared/contract-work-projects'
import type { WorkspaceMeta } from '@shared/domain'
import { canvasSourcePath, type CanvasSource } from '@shared/work'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import { lifeosProjectIn, type LifeosProject } from './mirrors'

/**
 * Linking a thing to a LifeOS project (docs/agents/work-projects.md
 * "Linking"): the one project write that needs the host. A LifeOS document
 * or sheet joins the project by its own `projectId`; anything else LifeOS
 * does not hold (a file on a host, a Google or Microsoft item, a Frame.io
 * file) becomes a linked item of the project. The write is made as the
 * owner, so the checks a fenced key would get from LifeOS are made here:
 * the project and the document are the workspace's own sector's, and a
 * remote key names only a file it could have named itself.
 */

export const LINK_METHOD = 'work.projects.link'

/** What cannot be linked, in words a screen or a thread can show; null when the source can be. */
export function linkRefusal(source: CanvasSource): string | null {
  if (source.at === 'lifeos' && source.table !== 'docs' && source.table !== 'sheets') return "Only a document or a sheet of LifeOS's own can be linked to a project"
  if (source.at === 'browser') return 'A browser window cannot be linked to a project'
  if (source.at === 'thread') return "An item a thread made lives in that thread: save it as a file or a LifeOS document, then link that"
  return null
}

export interface LinkAsk {
  workspace: Pick<WorkspaceMeta, 'name' | 'sector'>
  lifeosProjectId: string
  source: CanvasSource
  title: string
}

/** Links `source` to the project; answers what was made and the project it joined. */
export async function linkToProject(ctx: WorkCtx, by: Caller, ask: LinkAsk): Promise<{ linked: ProjectLinked; project: LifeosProject }> {
  const refused = linkRefusal(ask.source)
  if (refused) throw new Error(refused)
  const title = ask.title.trim().slice(0, 500)
  if (!title) throw new Error('A linked item needs a title')
  const path = canvasSourcePath(ask.source)
  // The listener fenced a path named in the params; this is the same answer for one that came through an item.
  if (path !== null && !ctx.reaches(by, path)) throw new FenceError(LINK_METHOD)
  // A finished project still takes a document: only a new thread waits for a reopen.
  const project = await lifeosProjectIn(ctx, ask.workspace, ask.lifeosProjectId, { over: true })
  const owner = ctx.lifeos.owner()
  if (ask.source.at === 'lifeos') {
    // A guest of a shared project reads its documents: a thread never puts one before him. LifeOS refuses its own bot the same.
    if (by.kind === 'model' && project.shared) throw new Error(`${project.name} is shared with a guest: only the owner links a document or sheet to it`)
    const table = ask.source.table as 'docs' | 'sheets'
    const what = table === 'docs' ? 'document' : 'sheet'
    const row = await owner.query<{ sector?: string } | null>(`${table}:get`, { id: ask.source.id }).catch(() => null)
    // Linking moves a document into the project's sector: one of another sector is not this workspace's to move, whatever id was handed in.
    if (!row || row.sector !== ask.workspace.sector) throw new Error(`LifeOS has no such ${what} in ${ask.workspace.name}'s sector`)
    await owner.mutation(`${table}:setProject`, { id: ask.source.id, projectId: project._id })
    return { linked: { as: table === 'docs' ? 'doc' : 'sheet', id: ask.source.id }, project }
  }
  const id = await owner.mutation<string>('projectItems:add', { projectId: project._id, title, source: ask.source })
  return { linked: { as: 'item', id }, project }
}
