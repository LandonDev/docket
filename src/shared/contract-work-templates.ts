import { z } from 'zod'
import { CanvasSourceSchema } from './work/canvas'
import { FolderRefSchema } from './contract-work-files'
import { FIELD_NAME_MAX, isDay, type Template } from './work/templates'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The templates pillar's wire (docs/agents/work-templates.md): the shelf of
 * a Work workspace. A template is a file; the shelf lists his own for the
 * job, the ones for all jobs on this host and our starters for the job's
 * sector, makes a new file from one with its fields filled, and takes any
 * file as a new template. Every verb is one word, so `ctx.peer` carries it
 * to another host of his.
 */

const Workspace = z.string().min(1).max(200)
/** A template by id (`job:…`, `all:…`, `starter:…`), by a starter's key (`unify/invoice`) or by name. */
const TemplateRef = z.string().min(1).max(500)
const Name = z.string().min(1).max(200)
/** What he typed for each field, by the field's name; a caller's too. */
export const TemplateFieldsSchema = z.record(z.string().min(1).max(FIELD_NAME_MAX + 8), z.string().max(2000))
/** The caller's own day, `YYYY-MM-DD`. */
const Day = z.string().refine(isDay, 'a day as YYYY-MM-DD')

export const TemplatesRequestSchemas = [
  /** → TemplatesList: the workspace's shelf, his own first, and how many starters he hid. */
  request('work.templates.list', z.object({ workspaceId: Workspace })),
  /** → TemplateMade: a new file from the template, its fields filled, kept in `into` (the workspace's folder when absent). Opening it is the caller's. */
  request('work.templates.make', z.object({ workspaceId: Workspace, template: TemplateRef, into: FolderRefSchema.optional(), fields: TemplateFieldsSchema.optional(), today: Day.optional(), title: Name.optional() })),
  /** → Template: a copy of the file on the shelf, for this job or (`everywhere`) for all jobs on this host. */
  request('work.templates.save', z.object({ workspaceId: Workspace, source: CanvasSourceSchema, name: Name.optional(), everywhere: z.boolean().optional() })),
  /** → Template: one of his own under a new name. */
  request('work.templates.rename', z.object({ workspaceId: Workspace, template: TemplateRef, name: Name })),
  /** → Template: one of his own moved between this job's and all jobs'. */
  request('work.templates.move', z.object({ workspaceId: Workspace, template: TemplateRef, everywhere: z.boolean() })),
  /**
   * → TemplateRemoved: a starter is hidden from this workspace's shelf. One of his own goes to Files' Trash
   * (`trashed`: the rows Put back takes); where Files has no Trash yet nothing is deleted until the window has
   * asked him and says so (`confirmed`): the first call answers `confirm`.
   */
  request('work.templates.remove', z.object({ workspaceId: Workspace, template: TemplateRef, confirmed: z.boolean().optional() })),
  /** → {}: every starter he hid in this workspace is shown again; with `template`, that one alone (the undo of one Hide). */
  request('work.templates.unhide', z.object({ workspaceId: Workspace, template: TemplateRef.optional() })),
  /** → TemplateFields: the fields a file would ask for as a template, read before it is saved; nothing is copied. */
  request('work.templates.fields', z.object({ workspaceId: Workspace, source: CanvasSourceSchema }))
] as const

export type { Template, TemplateMade } from './work/templates'

export interface TemplatesList {
  templates: Template[]
  /** starters hidden in this workspace */
  hidden: number
}

/** What `work.templates.fields` answers: the asked fields, in the file's order. */
export interface TemplateFields {
  fields: string[]
}

/** What a remove did: nothing yet (`confirm`: ask him, then say `confirmed`), a move to Files' Trash (`trashed`), or it is done. */
export interface TemplateRemoved {
  trashed?: string[]
  confirm?: true
}

/** The shelf changed on this host: one workspace's, or (null) every workspace's, as when a template for all jobs was saved. */
export type TemplatesPush = { push: 'work.templates'; workspaceId: string | null }

export const TEMPLATES_CAPS = {
  'work.templates.list': 'read',
  'work.templates.make': 'operate',
  'work.templates.save': 'operate',
  'work.templates.rename': 'operate',
  'work.templates.move': 'operate',
  'work.templates.remove': 'operate',
  'work.templates.unhide': 'operate',
  'work.templates.fields': 'read'
} satisfies CapsOf<typeof TemplatesRequestSchemas>

// Every method is carried to the workspace's host, so a Mac window reaches a shelf on the box.
export const TEMPLATES_RELAY = {} satisfies RelayOf<typeof TemplatesRequestSchemas>
