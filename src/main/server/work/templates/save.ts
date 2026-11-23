import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { copyFile, link, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ClientRequest } from '@shared/contract'
import type { FileDone } from '@shared/contract-work-files'
import type { ExportAnswer } from '@shared/contract-work-formats'
import type { TemplateRemoved } from '@shared/contract-work-templates'
import type { CanvasSource } from '@shared/work'
import { splitName } from '@shared/work/files'
import { askedFields, fileStem, parseTemplateId, templateFormOf, type Template, type TemplateForm } from '@shared/work/templates'
import { sharedOf } from '../files/policy'
import { WORK_MODULES, type Caller, type WorkCtx } from '../modules'
import { isOfficeForm, scanOffice } from './ooxml'
import { askFilesVerb, copyNoReplace, folderCan, OUT_OF_REACH, type Pillars } from './place'
import { jobDir, resolveTemplate, sharedDir, shelfOf, tcdocEveryField, tcdocFields, toTemplate, workspaceOf, type ShelfEntry, type WorkspaceRow } from './shelf'
import { TemplatesStore } from './store'

/**
 * Putting a file on the shelf, and changing what is there
 * (docs/agents/work-templates.md "Save as template"). A template is a copy:
 * the file it was saved from is never moved, renamed or written, whoever
 * can open it. An Office file is copied as it is, and so is our own
 * document with no field; our document with fields is kept as Word and our
 * sheet as Excel, through their own pillars' exports, so there is one fill
 * in one place.
 */

export interface SaveAsk {
  workspaceId: string
  source: CanvasSource
  name?: string
  everywhere?: boolean
}
export interface SaveDeps {
  pillars?: Pillars
  signal?: AbortSignal
}

export const NOT_A_TEMPLATE = 'Only a Word, Excel or PowerPoint file, or a document or sheet kept as a file, can be a template.'
export const ELSEWHERE = 'That file is on another computer: save it as a template from a window on that one.'
export const STARTER_FIXED = "One of TempCode's own templates cannot be changed: use Edit a copy."

const registry: Pillars = () => WORK_MODULES

/** A file's path on this host, from the sources a file on a disk can have. */
function pathOf(ctx: Pick<WorkCtx, 'host'>, source: CanvasSource): string {
  if (source.at === 'file') {
    if (source.host !== ctx.host) throw new Error(ELSEWHERE)
    return source.path
  }
  if (source.at === 'microsoft' && source.ref.kind === 'path') {
    if (source.host !== ctx.host) throw new Error(ELSEWHERE)
    return source.ref.path
  }
  throw new Error(NOT_A_TEMPLATE)
}

/** Another pillar's method on this host, from the registry (`ctx.peer` refuses its own host). */
async function ask<T>(ctx: WorkCtx, by: Caller, pillars: Pillars, method: string, params: unknown, signal?: AbortSignal): Promise<T> {
  const id = method.split('.')[1]
  const module = pillars().find((m) => m.id === id)
  const answer = module?.handle ? await module.handle({ id: 'templates', method, params } as unknown as ClientRequest, ctx, by, signal) : null
  if (!answer?.handled) throw new Error(`${method} did not answer.`)
  return answer.result as T
}

/**
 * The file that goes on the shelf for a source, as a path to copy and the
 * form it is kept in; `drop` is a file an export made that goes once it is
 * copied.
 */
async function shelfFile(ctx: WorkCtx, by: Caller, workspace: WorkspaceRow, source: CanvasSource, path: string, form: TemplateForm, deps: SaveDeps): Promise<{ from: string; form: TemplateForm; drop?: string }> {
  const pillars = deps.pillars ?? registry
  if (form === 'tcdoc' && tcdocEveryField(path).length) {
    // Our document with any field, one filled without asking among them, is kept as Word: the fill reads and writes Word.
    const out = await ask<ExportAnswer>(ctx, by, pillars, 'work.formats.export', { source, format: 'docx' }, deps.signal)
    const dir = join(ctx.dataDir, 'work-templates', 'scratch')
    await mkdir(dir, { recursive: true })
    const made = join(dir, `export-${Date.now()}-${Math.random().toString(36).slice(2)}.docx`)
    await writeFile(made, Buffer.from(out.data, 'base64'))
    return { from: made, form: 'docx', drop: made }
  }
  if (form === 'tcsheet' && !sharedOf(ctx, source)) {
    // Our sheet is kept as Excel. Its export is by the item that shows it, and writes beside the file: so only
    // for a sheet that is open and is his own, and what it wrote goes once it is on the shelf.
    const item = ctx.canvas.forWorkspace(workspace.id, { panes: true }).find((i) => i.kind === 'sheet' && i.source.at === 'file' && i.source.path === path)
    if (item) {
      try {
        const out = await ask<{ path: string }>(ctx, by, pillars, 'work.sheets.export', { itemId: item.id, format: 'xlsx' }, deps.signal)
        if (out.path && out.path !== path && existsSync(out.path)) return { from: out.path, form: 'xlsx', drop: out.path }
      } catch (err) {
        if (deps.signal?.aborted) throw err
        ctx.log(`templates: ${basename(path)} is kept as it is: its export did not answer`)
      }
    }
  }
  return { from: path, form }
}

export async function saveTemplate(ctx: WorkCtx, by: Caller, ask_: SaveAsk, deps: SaveDeps = {}): Promise<Template> {
  const workspace = workspaceOf(ctx, ask_.workspaceId)
  const path = pathOf(ctx, ask_.source)
  if (by.kind === 'remote' && !by.peer && (!ctx.reaches(by, path) || !ctx.reaches(by, workspace.path))) throw new Error(OUT_OF_REACH)
  const formed = templateFormOf(path)
  let info
  try {
    info = statSync(path)
  } catch {
    info = null
  }
  if (!formed || !info?.isFile()) throw new Error(NOT_A_TEMPLATE)
  const stem = fileStem(ask_.name ?? splitName(basename(path)).stem)
  if (!stem) throw new Error('A template needs a name.')
  const kept = await shelfFile(ctx, by, workspace, ask_.source, path, formed.form, deps)
  const dir = ask_.everywhere ? sharedDir(ctx) : jobDir(workspace)
  let name: string
  try {
    name = await copyNoReplace(kept.from, dir, `${stem}.${kept.form}`)
  } finally {
    if (kept.drop) await rm(kept.drop, { force: true })
  }
  ctx.push({ push: 'work.templates', workspaceId: ask_.everywhere ? null : workspace.id })
  return found(ctx, workspace.id, ask_.everywhere ? 'all' : 'job', name)
}

/** The shelf's entry for a file just written. */
function found(ctx: WorkCtx, workspaceId: string, where: 'job' | 'all', fileName: string): Template {
  const entry = shelfOf(ctx, workspaceId).entries.find((e) => e.where === where && basename(e.path) === fileName)
  if (!entry) throw new Error(`${fileName} was saved but is not on the shelf.`)
  return toTemplate(entry)
}

/** One of his own templates by what a caller names; a starter is refused. */
function ownOf(ctx: WorkCtx, by: Caller, workspaceId: string, ref: string): { workspace: WorkspaceRow; entry: ShelfEntry } {
  const { shelf, entry } = resolveTemplate(ctx, workspaceId, ref)
  if (entry.where === 'starter') throw new Error(STARTER_FIXED)
  if (by.kind === 'remote' && !by.peer && (!ctx.reaches(by, shelf.workspace.path) || (entry.where === 'job' && !ctx.reaches(by, entry.path)))) throw new Error(OUT_OF_REACH)
  return { workspace: shelf.workspace, entry }
}

/** A name taken in a folder, as a disk that reads names case-blind would say. */
const taken = (dir: string, name: string, but?: string): boolean => {
  try {
    return readdirSync(dir).some((n) => n.toLowerCase() === name.toLowerCase() && n !== but)
  } catch {
    return false
  }
}

/** Moves a file to a path nothing holds; over a disk's edge, a copy and then the old one goes. */
async function moveNoReplace(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  try {
    await link(from, to)
    await rm(from, { force: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new Error(`A template named ${splitName(basename(to)).stem} is already there.`)
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw err
    if (existsSync(to)) throw new Error(`A template named ${splitName(basename(to)).stem} is already there.`)
    await copyFile(from, to)
    await rm(from, { force: true })
  }
}

export async function renameTemplate(ctx: WorkCtx, by: Caller, workspaceId: string, ref: string, name: string): Promise<Template> {
  const { workspace, entry } = ownOf(ctx, by, workspaceId, ref)
  const stem = fileStem(name)
  if (!stem) throw new Error('A template needs a name.')
  const dir = dirname(entry.path)
  const next = `${stem}.${entry.form}`
  if (next === basename(entry.path)) return toTemplate(entry)
  if (taken(dir, next, basename(entry.path))) throw new Error(`A template named ${stem} is already there.`)
  // A change of case alone is one rename: the disk may read both names as one file.
  if (next.toLowerCase() === basename(entry.path).toLowerCase()) await rename(entry.path, join(dir, next))
  else await moveNoReplace(entry.path, join(dir, next))
  ctx.push({ push: 'work.templates', workspaceId: entry.where === 'all' ? null : workspace.id })
  return found(ctx, workspace.id, entry.where as 'job' | 'all', next)
}

export async function moveTemplate(ctx: WorkCtx, by: Caller, workspaceId: string, ref: string, everywhere: boolean): Promise<Template> {
  const { workspace, entry } = ownOf(ctx, by, workspaceId, ref)
  const where = everywhere ? 'all' : 'job'
  if (entry.where === where) return toTemplate(entry)
  const dir = everywhere ? sharedDir(ctx) : jobDir(workspace)
  const name = await copyNoReplace(entry.path, dir, basename(entry.path))
  await rm(entry.path, { force: true })
  // Every workspace's shelf changed: one lost or gained a template for all jobs.
  ctx.push({ push: 'work.templates', workspaceId: null })
  return found(ctx, workspace.id, where, name)
}

/**
 * Takes a template off the shelf. A starter is hidden in this workspace.
 * One of his own goes to Files' Trash where Files has one; where it has
 * none yet, nothing is deleted until the caller says he was asked.
 */
export async function removeTemplate(ctx: WorkCtx, by: Caller, workspaceId: string, ref: string, confirmed: boolean, deps: SaveDeps = {}): Promise<TemplateRemoved> {
  const { shelf, entry } = resolveTemplate(ctx, workspaceId, ref)
  if (entry.where === 'starter') {
    new TemplatesStore(ctx.db).hide(workspaceId, parseTemplateId(entry.id)!.key)
    ctx.push({ push: 'work.templates', workspaceId })
    return {}
  }
  ownOf(ctx, by, workspaceId, ref)
  const everyone = entry.where === 'all'
  // Trash is the workspace folder's: a template for all jobs lies in the app's own data, which Files does not list.
  if (!everyone && by.kind !== 'model' && (await folderCan(ctx, by, workspaceId, 'trash', deps.pillars, deps.signal))) {
    const done = await askFilesVerb<FileDone>(ctx, by, 'trash', { workspaceId, refs: [entry.source] }, deps.pillars, deps.signal)
    if (done) {
      if (done.refused.length && !done.trashed?.length) throw new Error(done.refused[0]!.text)
      ctx.push({ push: 'work.templates', workspaceId: shelf.workspace.id })
      return { trashed: done.trashed ?? [] }
    }
  }
  if (!confirmed) return { confirm: true }
  await rm(entry.path, { force: true })
  ctx.push({ push: 'work.templates', workspaceId: everyone ? null : shelf.workspace.id })
  return {}
}

/** Shows the workspace's hidden starters again: every one, or the one named (the undo of one Hide). */
export function unhideTemplates(ctx: WorkCtx, by: Caller, workspaceId: string, ref?: string): void {
  const workspace = workspaceOf(ctx, workspaceId)
  if (by.kind === 'remote' && !by.peer && !ctx.reaches(by, workspace.path)) throw new Error(OUT_OF_REACH)
  const store = new TemplatesStore(ctx.db)
  if (ref === undefined) store.unhide(workspaceId)
  else {
    const { entry } = resolveTemplate(ctx, workspaceId, ref)
    if (entry.where !== 'starter') return
    store.unhide(workspaceId, parseTemplateId(entry.id)!.key)
  }
  ctx.push({ push: 'work.templates', workspaceId })
}

/**
 * The fields a file would ask for as a template, read where it lies:
 * nothing is copied or written. Our own document is read from the preview it
 * carries; our own sheet names none until it is kept as Excel.
 */
export function fieldsOfSource(ctx: WorkCtx, by: Caller, workspaceId: string, source: CanvasSource): string[] {
  const workspace = workspaceOf(ctx, workspaceId)
  const path = pathOf(ctx, source)
  if (by.kind === 'remote' && !by.peer && (!ctx.reaches(by, path) || !ctx.reaches(by, workspace.path))) throw new Error(OUT_OF_REACH)
  const formed = templateFormOf(path)
  if (!formed) throw new Error(NOT_A_TEMPLATE)
  if (formed.form === 'tcdoc') return tcdocFields(path)
  if (!isOfficeForm(formed.form)) return []
  try {
    return askedFields(scanOffice(formed.form, new Uint8Array(readFileSync(path))))
  } catch {
    return [] // a file that is no zip, or is gone: a plain copy asks for nothing
  }
}
