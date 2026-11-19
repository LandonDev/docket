import { z } from 'zod'
import { CanvasSourceSchema } from './work/canvas'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The projects pillar's wire (docs/agents/work-projects.md). The project
 * screens read and write LifeOS themselves, through the workspace's
 * narrowed session; the host acts only where it must. `work.projects.link`
 * is that one write: linking a document, a sheet, a file or another item to
 * a LifeOS project, since a file's path has to pass this host's fence and a
 * LifeOS document must be the workspace's own sector's before it moves.
 */
export const ProjectsRequestSchemas = [
  /** → ProjectLinked: links `source` to a LifeOS project of the workspace's sector */
  request(
    'work.projects.link',
    z.object({ workspaceId: z.string().min(1).max(200), lifeosProjectId: z.string().min(1).max(200), source: CanvasSourceSchema, title: z.string().min(1).max(500) })
  )
] as const

/** What a link made: a LifeOS document or sheet now in the project, or a linked item of its own (`projectItems`), with the id to unlink it by. */
export type ProjectLinked = { as: 'doc' | 'sheet'; id: string } | { as: 'item'; id: string }

export type ProjectsPush = never
export const PROJECTS_CAPS = {
  'work.projects.link': 'operate'
} satisfies CapsOf<typeof ProjectsRequestSchemas>
export const PROJECTS_RELAY = {} satisfies RelayOf<typeof ProjectsRequestSchemas>
