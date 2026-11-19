import { z } from 'zod'
import type { ProjectLinked } from '@shared/contract-work-projects'
import { CanvasSourceSchema, handled, NOT_HANDLED, workText, workspaceKindOf, type CanvasSource, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { WorkCtx, WorkModule, WorkTool } from '../modules'
import { LINK_METHOD, linkToProject } from './link'

/**
 * The projects pillar's server module (docs/agents/work-projects.md). The
 * project screens read and write LifeOS on the workspace's own narrowed
 * session, and an agent works a project through LifeOS's own tools
 * (`get_project`, `add_tasks`, `move_tasks`, `add_comment`, …). This module
 * carries what needs the host: linking a file or an item to a project
 * (link.ts), for a screen (`work.projects.link`) and for a thread
 * (`project_link_item`). The mirrors that hold a project's threads are a
 * part of the context (mirrors.ts), not of this module.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })

/** The Work workspace a link is made in, with the sector that fences it; throws in words a screen can show. */
function linkedWorkspace(ctx: WorkCtx, workspaceId: string): { name: string; sector: string } {
  const row = ctx.db.prepare('SELECT name, kind, sector FROM workspaces WHERE id = ?').get(workspaceId) as { name: string; kind: string | null; sector: string | null } | undefined
  if (!row || workspaceKindOf({ kind: row.kind as 'work' | 'code' | null }) !== 'work' || !row.sector) throw new Error('That workspace is not a Work workspace linked to a LifeOS sector here.')
  return { name: row.name, sector: row.sector }
}

const linkedWords = (linked: ProjectLinked, title: string, project: string): string =>
  linked.as === 'item' ? `Linked ${title} to ${project} (item ${linked.id}).` : `${title} is now a ${linked.as === 'doc' ? 'document' : 'sheet'} of ${project}.`

export const projectsTools: WorkTool[] = [
  {
    name: 'project_link_item',
    description:
      "Links a thing to one of the owner's LifeOS projects, so it is listed with the project's documents: one of this thread's canvas items (`item`), or a `source` you name (a LifeOS document or sheet, a file on a host, a Google or Microsoft item, a Frame.io file). The project must be one of this workspace's sector. A LifeOS document or sheet joins the project itself; anything else is listed as a linked item. A web address is not this: add it with LifeOS's link_project_item.",
    input: z.object({
      project: z.string().min(1).max(200).describe("The LifeOS project's id (from list_projects or get_project)."),
      item: z.string().min(1).max(200).optional().describe("One of this thread's canvas items, by id. Give this or source."),
      source: CanvasSourceSchema.optional().describe('What to link, when it is not a canvas item of this thread. Give this or item.'),
      title: z.string().min(1).max(500).optional().describe("The name it is listed under. Left out, a canvas item's own title.")
    }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { project: string; item?: string; source?: CanvasSource; title?: string }
      if (!!a.item === !!a.source) return fail('Give an item or a source, one of the two.')
      if (!ctx.scope.workspaceId || !ctx.scope.sector) return fail("This thread is in no workspace linked to LifeOS: link from a thread of the project's workspace.")
      let source = a.source
      let title = a.title?.trim()
      if (a.item) {
        const found = ctx.canvas.get(a.item)
        // Only an item of this thread's own pane: another thread's is not its to link, whatever id it was handed.
        if (!found || ctx.canvas.paneOf(found.sessionId) !== ctx.canvas.paneOf(ctx.sessionId)) return fail('This thread has no such canvas item.')
        source = found.source
        title ||= found.title
      }
      if (!source) return fail('Give an item or a source, one of the two.')
      if (!title) return fail('Give a title: a source has no name of its own.')
      try {
        const workspace = linkedWorkspace(ctx, ctx.scope.workspaceId)
        const { linked, project } = await linkToProject(ctx, { kind: 'model', caps: [], sessionId: ctx.sessionId }, { workspace, lifeosProjectId: a.project, source, title })
        ctx.results.add({ sessionId: ctx.sessionId, kind: 'projects.link', summary: `Linked ${title} to ${project.name}`, ref: { at: 'lifeos', table: 'projects', id: project._id } })
        return workText(linkedWords(linked, title, project.name))
      } catch (err) {
        return fail(errorText(err))
      }
    }
  }
]

const PREAMBLE = [
  "Projects: a project's tasks, documents and comments are LifeOS's. Read a project with LifeOS's get_project before you work in it, and name a task by its key (PUR-41).",
  'Move a task to Doing when you start on it, and leave a comment on it with add_comment when you stop: what you did and what is left.',
  "List a file or one of your canvas items with a project's documents with `project_link_item`."
].join(' ')

export const projects: WorkModule = {
  id: 'projects',
  ensure() {},
  async handle(req, ctx, by) {
    if (req.method !== LINK_METHOD) return NOT_HANDLED
    // A screen's method: a thread links through `project_link_item`, where its own pane and sector are the fence.
    if (by.kind === 'model') throw new Error('A thread links to a project with project_link_item.')
    const { workspaceId, lifeosProjectId, source, title } = req.params
    const { linked } = await linkToProject(ctx, by, { workspace: linkedWorkspace(ctx, workspaceId), lifeosProjectId, source, title })
    return handled(linked satisfies ProjectLinked)
  },
  tools: () => projectsTools,
  preamble: () => PREAMBLE
}
