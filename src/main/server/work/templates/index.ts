import type { z } from 'zod'
import type { ClientRequest } from '@shared/contract'
import { TemplatesRequestSchemas } from '@shared/contract-work-templates'
import { handled, NOT_HANDLED, type Handled } from '@shared/work'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { makeFromShelf } from './make'
import { OUT_OF_REACH } from './place'
import { fieldsOfSource, moveTemplate, removeTemplate, renameTemplate, saveTemplate, unhideTemplates } from './save'
import { jobDir, listTemplates, reachesFile, workspaceOf } from './shelf'
import { ensureTemplatesTables, TemplatesStore } from './store'
import { templateTools } from './tools'

/**
 * The templates pillar's server module (docs/agents/work-templates.md): the
 * shelf of a Work workspace. A template is a file; the shelf is read from
 * its folders at every ask (shelf.ts), a new file is made from one with its
 * fields filled (make.ts), and any file is put on it as a copy (save.ts).
 * It raises no notice and holds nothing: what it writes is his own.
 */

type Method = z.infer<(typeof TemplatesRequestSchemas)[number]>['method']
const PARAMS = new Map(TemplatesRequestSchemas.map((s) => [s.shape.method.value as string, s.shape.params]))
/** A method's params as its contract reads them: a call from another pillar or a peer is held to the same shape as the wire's. */
const params = <M extends Method>(req: ClientRequest, method: M): Extract<z.infer<(typeof TemplatesRequestSchemas)[number]>, { method: M }>['params'] => PARAMS.get(method)!.parse((req as { params?: unknown }).params ?? {}) as never

/** A remote key reads a shelf only of a workspace whose folder it may reach: the answer names files there. */
function reach(ctx: WorkCtx, by: Caller, workspaceId: string): void {
  if (by.kind === 'remote' && !by.peer && !ctx.reaches(by, workspaceOf(ctx, workspaceId).path)) throw new Error(OUT_OF_REACH)
}

export async function templatesHandle(req: ClientRequest, ctx: WorkCtx, by: Caller, signal?: AbortSignal): Promise<Handled> {
  switch (req.method as string) {
    case 'work.templates.list': {
      const p = params(req, 'work.templates.list')
      reach(ctx, by, p.workspaceId)
      const list = listTemplates(ctx, p.workspaceId)
      // A key is told of no file it could not name itself: one of the job's own reached by a link into a library it may not.
      return handled(by.kind === 'remote' && !by.peer ? { ...list, templates: list.templates.filter((t) => t.where !== 'job' || t.source.at !== 'file' || reachesFile(ctx, by, t.source.path)) } : list)
    }
    case 'work.templates.make': {
      const p = params(req, 'work.templates.make')
      return handled(await makeFromShelf(ctx, by, p, { ...(signal ? { signal } : {}) }))
    }
    case 'work.templates.save': {
      const p = params(req, 'work.templates.save')
      return handled(await saveTemplate(ctx, by, p, { ...(signal ? { signal } : {}) }))
    }
    case 'work.templates.rename': {
      const p = params(req, 'work.templates.rename')
      return handled(await renameTemplate(ctx, by, p.workspaceId, p.template, p.name))
    }
    case 'work.templates.move': {
      const p = params(req, 'work.templates.move')
      return handled(await moveTemplate(ctx, by, p.workspaceId, p.template, p.everywhere))
    }
    case 'work.templates.remove': {
      const p = params(req, 'work.templates.remove')
      return handled(await removeTemplate(ctx, by, p.workspaceId, p.template, p.confirmed === true ? (p.version ?? '') : null, { ...(signal ? { signal } : {}) }))
    }
    case 'work.templates.unhide': {
      const p = params(req, 'work.templates.unhide')
      unhideTemplates(ctx, by, p.workspaceId, p.template)
      return handled({})
    }
    case 'work.templates.fields': {
      const p = params(req, 'work.templates.fields')
      return handled(fieldsOfSource(ctx, by, p.workspaceId, p.source))
    }
  }
  return NOT_HANDLED
}

export const templates: WorkModule = {
  id: 'templates',
  ensure: ensureTemplatesTables,
  handle: templatesHandle,
  // A Work Chat has no workspace, so no shelf: it is listed no template tool.
  tools: (scope) => (scope.workspaceId ? templateTools : []),
  workspaceRemoved(workspaceId, ctx) {
    // The workspace's row is gone by now: its folder is not known, so its index rows wait for the next read of a folder of that path.
    new TemplatesStore(ctx.db).workspaceRemoved(workspaceId)
  }
}

export { jobDir }
