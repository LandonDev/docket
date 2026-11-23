import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { TemplateFieldsSchema } from '@shared/contract-work-templates'
import type { CanvasItem, CanvasSource } from '@shared/work'
import { errorText } from '@shared/work/ids'
import { canvasKindOf, fieldList } from '@shared/work/templates'
import { workText, type WorkToolResult } from '@shared/work/tools'
import type { Caller, ToolCtx, WorkTool } from '../modules'
import { makeFromShelf } from './make'
import { saveTemplate } from './save'
import { listTemplates, starterSector } from './shelf'

/**
 * The templates tools (docs/agents/work-templates.md "Tools"): a thread
 * lists the workspace's shelf, makes a file from a template and puts a
 * canvas item's file on the shelf. Every one stays inside the thread's own
 * workspace. A made file goes into the workspace's own folder, which is
 * his and unshared, so nothing is held; no tool takes a folder, and none
 * reaches a Teams or OneDrive library.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
const callerOf = (ctx: ToolCtx): Caller => ({ kind: 'model', caps: [], sessionId: ctx.sessionId })

/** The thread's workspace; a Work Chat has none (and is listed no tool). */
function workspaceIdOf(ctx: ToolCtx): string {
  if (!ctx.scope.workspaceId) throw new Error('A Work Chat has no templates: they belong to a workspace.')
  return ctx.scope.workspaceId
}

/** The file of one of the thread's own canvas items, as a source a save can copy. */
function itemSource(ctx: ToolCtx, itemId: string): { item: CanvasItem; source: CanvasSource } {
  const item = ctx.canvas.get(itemId)
  // An item of another thread, or of another workspace, is not this thread's to name.
  if (!item || !ctx.canvas.forSession(ctx.canvas.paneOf(ctx.sessionId)).some((i) => i.id === item.id)) throw new Error(`There is no item ${itemId} in this thread's canvas.`)
  if (item.source.at === 'thread') {
    // A deck the thread made lives in the item's own folder.
    const own = join(ctx.dataDir, 'canvas', item.sessionId, item.id, 'deck.pptx')
    if (item.kind === 'slides' && existsSync(own)) return { item, source: { at: 'file', host: ctx.host, path: own } }
    throw new Error('That item is not a file yet: keep it as a file first.')
  }
  return { item, source: item.source }
}

export const templateTools: WorkTool[] = [
  {
    name: 'template_list',
    description: "Lists this workspace's templates: each one's name, what it makes (document, sheet or deck), its group (this job's, all jobs', or one of TempCode's starters) and the fields it asks for.",
    input: z.object({}),
    readOnly: true,
    run: async (_args, ctx) => {
      try {
        const { templates } = listTemplates(ctx, workspaceIdOf(ctx))
        if (!templates.length) return workText('This workspace has no templates.')
        const group = (where: string, id: string): string => (where === 'job' ? 'this job' : where === 'all' ? 'all jobs' : starterSector(id) === 'any' ? 'starter, all jobs' : 'starter')
        const lines = templates.map((t) => `- ${t.name} (${t.kind}; ${group(t.where, t.id)})${t.fields.length ? `: asks for ${fieldList(t.fields)}` : ''}`)
        return { ...workText(lines.join('\n')), structuredContent: { templates: templates.map((t) => ({ id: t.id, name: t.name, kind: t.kind, where: t.where, fields: t.fields })) } }
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'template_make',
    description:
      "Makes a new file from one of this workspace's templates, in the workspace's own folder, and opens it in this thread's canvas. `template` is a name from `template_list` (or its id). `fields` gives a value for each field the template asks for, by the field's name; Date, Name and Job are filled for you. A field you give no value stays in the file as `{{Field}}` and is named in the answer. `title` names the file; without it the file is named for the template and its first field. Answers the item id.",
    input: z.object({ template: z.string().min(1).max(500), fields: TemplateFieldsSchema.optional(), title: z.string().min(1).max(200).optional() }).strict(),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { template: string; fields?: Record<string, string>; title?: string }
      try {
        const made = await makeFromShelf(ctx, callerOf(ctx), { workspaceId: workspaceIdOf(ctx), template: a.template, ...(a.fields ? { fields: a.fields } : {}), ...(a.title ? { title: a.title } : {}) }, { signal: ctx.signal })
        const item = ctx.canvas.open(ctx.sessionId, canvasKindOf(made.kind), made.source, made.title)
        const left = made.unfilled.length ? ` Still to fill: ${made.unfilled.map((f) => `{{${f}}}`).join(', ')}.` : ''
        return { ...workText(`Made ${made.title} and opened it as item ${item.id}.${left}`), structuredContent: { item: item.id, title: made.title, kind: made.kind, unfilled: made.unfilled } }
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'template_save',
    description:
      "Puts the file of one of this thread's canvas items on the workspace's shelf as a template, as a copy: the file itself is not changed. Type `{{Client}}` in a file's text to make a field the template asks for. `name` names the template (the file's name without it); `everywhere: true` keeps it for all jobs on this computer.",
    input: z.object({ item: z.string().min(1).max(200), name: z.string().min(1).max(200).optional(), everywhere: z.boolean().optional() }).strict(),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item: string; name?: string; everywhere?: boolean }
      try {
        const { item, source } = itemSource(ctx, a.item)
        const saved = await saveTemplate(ctx, callerOf(ctx), { workspaceId: workspaceIdOf(ctx), source, name: a.name ?? item.title.replace(/\.[A-Za-z0-9]{1,8}$/, ''), ...(a.everywhere ? { everywhere: true } : {}) }, { signal: ctx.signal })
        return { ...workText(`Saved ${saved.name} to Templates${saved.fields.length ? `. It asks for ${fieldList(saved.fields)}` : ''}.`), structuredContent: { id: saved.id, name: saved.name, fields: saved.fields } }
      } catch (err) {
        return fail(errorText(err))
      }
    }
  }
]
