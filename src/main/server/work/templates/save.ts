import { constants, existsSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs'
import { copyFile, link, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ClientRequest } from '@shared/contract'
import type { FileDone } from '@shared/contract-work-files'
import type { ExportAnswer } from '@shared/contract-work-formats'
import type { TemplateFields, TemplateRemoved } from '@shared/contract-work-templates'
import type { CanvasSource } from '@shared/work'
import { splitName } from '@shared/work/files'
import { askedFields, fileStem, parseTemplateId, templateFormOf, type Template, type TemplateForm } from '@shared/work/templates'
import { sharedOf } from '../files/policy'
import { WORK_MODULES, type Caller, type WorkCtx } from '../modules'
import { isOfficeForm, scanOffice } from './ooxml'
import { admitDirect, askFilesVerb, copyNoReplace, folderCan, OUT_OF_REACH, type Pillars } from './place'
import { jobDir, reachesFile, resolveTemplate, sharedDir, shelfOf, tcdocEveryField, tcdocFields, toTemplate, workspaceOf, type ShelfEntry, type WorkspaceRow } from './shelf'
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
export const CHANGED = 'That template changed while it was asked about: nothing was deleted.'
export const MOVED_UNDER = 'That template changed while it moved: it was left where it was.'
export const PEER_CONFIRM = 'Another host of his cannot delete a template: delete it from a window.'

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

/** The open canvas item that shows our own sheet, when the sheet is his own: the one a save can export as Excel. Null for any other. */
function exportableSheet(ctx: WorkCtx, workspace: WorkspaceRow, source: CanvasSource, path: string): { id: string } | null {
  if (sharedOf(ctx, source)) return null
  return ctx.canvas.forWorkspace(workspace.id, { panes: true }).find((i) => i.kind === 'sheet' && i.source.at === 'file' && i.source.path === path) ?? null
}

/**
 * The file that goes on the shelf for a source, as a path to copy and the
 * form it is kept in; `drop` is a file an export made that goes once it is
 * copied.
 */
/** Our own document as Word, through the formats pillar's export, written to `to`. */
export async function exportWord(ctx: WorkCtx, by: Caller, source: CanvasSource, to: string, deps: SaveDeps = {}): Promise<void> {
  const out = await ask<ExportAnswer>(ctx, by, deps.pillars ?? registry, 'work.formats.export', { source, format: 'docx' }, deps.signal)
  await writeFile(to, Buffer.from(out.data, 'base64'))
}

async function shelfFile(ctx: WorkCtx, by: Caller, workspace: WorkspaceRow, source: CanvasSource, path: string, form: TemplateForm, deps: SaveDeps): Promise<{ from: string; form: TemplateForm; drop?: string }> {
  const pillars = deps.pillars ?? registry
  if (form === 'tcdoc' && tcdocEveryField(path).length) {
    // Our document with any field, one filled without asking among them, is kept as Word: the fill reads and writes Word.
    const dir = join(ctx.dataDir, 'work-templates', 'scratch')
    await mkdir(dir, { recursive: true })
    const made = join(dir, `export-${Date.now()}-${Math.random().toString(36).slice(2)}.docx`)
    try {
      await exportWord(ctx, by, source, made, deps)
    } catch (err) {
      await rm(made, { force: true })
      throw err
    }
    return { from: made, form: 'docx', drop: made }
  }
  const item = form === 'tcsheet' ? exportableSheet(ctx, workspace, source, path) : null
  if (item) {
    // Our sheet is kept as Excel. Its export is by the item that shows it and is written among the item's own
    // files, where the sheets pillar keeps its exports: it is copied from there and left as that pillar left it.
    try {
      const out = await ask<{ path: string }>(ctx, by, pillars, 'work.sheets.export', { itemId: item.id, format: 'xlsx' }, deps.signal)
      if (out.path && out.path !== path && existsSync(out.path)) return { from: out.path, form: 'xlsx' }
    } catch (err) {
      if (deps.signal?.aborted) throw err
      ctx.log(`templates: ${basename(path)} is kept as it is: its export did not answer`)
    }
  }
  return { from: path, form }
}

/**
 * Whether a path is a starter or a template for all jobs on this workspace's shelf. Those lie in the app's own
 * folders, which no key's fence names; a key that reaches the workspace may copy one ("Edit a copy").
 */
function shelved(ctx: WorkCtx, workspaceId: string, path: string): boolean {
  const shelf = shelfOf(ctx, workspaceId)
  return [...shelf.entries, ...shelf.hiddenEntries, ...shelf.replacedEntries].some((e) => e.where !== 'job' && e.path === path)
}

export async function saveTemplate(ctx: WorkCtx, by: Caller, ask_: SaveAsk, deps: SaveDeps = {}): Promise<Template> {
  const workspace = workspaceOf(ctx, ask_.workspaceId)
  const path = pathOf(ctx, ask_.source)
  if (by.kind === 'remote' && !by.peer && (!ctx.reaches(by, workspace.path) || (!reachesFile(ctx, by, path) && !shelved(ctx, workspace.id, path)))) throw new Error(OUT_OF_REACH)
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
  const dir = ask_.everywhere ? sharedDir(ctx) : jobDir(workspace)
  // Before anything is exported: a folder others can open takes a thread's file only on his press.
  admitDirect(ctx, by, dir, 'make')
  const kept = await shelfFile(ctx, by, workspace, ask_.source, path, formed.form, deps)
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
  if (by.kind === 'remote' && !by.peer && (!ctx.reaches(by, shelf.workspace.path) || (entry.where === 'job' && !reachesFile(ctx, by, entry.path)))) throw new Error(OUT_OF_REACH)
  return { workspace: shelf.workspace, entry }
}

/** The files an entry is: its own, and the Word file its `.tcdoc` was made of. */
const filesOf = (entry: ShelfEntry): string[] => (entry.twin ? [entry.path, entry.twin] : [entry.path])
/** A file's new path under a new stem, in its own folder, keeping its extension. */
const renamed = (path: string, stem: string): string => join(dirname(path), `${stem}${splitName(basename(path)).ext}`)
/** Whether two looks at a path saw the same file, as it was: a link keeps the file whatever is written in it; a copy only what it read. */
const same = (a: Stats, b: Stats, linked: boolean): boolean => a.dev === b.dev && a.ino === b.ino && (linked || (a.size === b.size && a.mtimeMs === b.mtimeMs))
const statOrNull = async (path: string): Promise<Stats | null> => {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/** The first of `stem`, `stem 2`, … under which no file of `files` would take a name already in `dir`. */
function freeStem(dir: string, files: readonly string[], stem: string): string {
  for (let n = 1; n < 1000; n++) {
    const next = n === 1 ? stem : `${stem} ${n}`
    if (!files.some((f) => taken(dir, basename(renamed(f, next))))) return next
  }
  throw new Error(`No free name for ${stem} there.`)
}

/** A name taken in a folder, as a disk that reads names case-blind would say. */
const taken = (dir: string, name: string, but?: string): boolean => {
  try {
    return readdirSync(dir).some((n) => n.toLowerCase() === name.toLowerCase() && n !== but)
  } catch {
    return false
  }
}

/**
 * Moves a file to a path nothing holds, and gives the file back as it was found when that cannot be done whole:
 * a link and then the old name goes; over a disk's edge, or on a disk with no hard links, an exclusive copy.
 * Before the old name goes it is looked at again: a file that an editor saved anew there meanwhile stays, and
 * the move is undone, so no edit is lost to it. A change of case alone, on a disk that reads both names as one
 * file, is one rename of that file.
 */
async function moveNoReplace(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  const taken = (): Error => new Error(`A template named ${splitName(basename(to)).stem} is already there.`)
  const before = await stat(from)
  let linked = true
  try {
    await link(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      // The new name is the old file itself: the disk reads names without case. Anything else holds the name.
      const there = await statOrNull(to)
      if (there && same(there, before, true) && from.toLowerCase() === to.toLowerCase()) return rename(from, to)
      throw taken()
    }
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw err
    linked = false
    try {
      await copyFile(from, to, constants.COPYFILE_EXCL)
    } catch (again) {
      if ((again as NodeJS.ErrnoException).code === 'EEXIST') throw taken()
      throw again
    }
  }
  const now = await statOrNull(from)
  if (!now || !same(now, before, linked)) {
    await rm(to, { force: true })
    throw new Error(MOVED_UNDER)
  }
  await rm(from, { force: true })
}

export async function renameTemplate(ctx: WorkCtx, by: Caller, workspaceId: string, ref: string, name: string): Promise<Template> {
  const { workspace, entry } = ownOf(ctx, by, workspaceId, ref)
  const stem = fileStem(name)
  if (!stem) throw new Error('A template needs a name.')
  const dir = dirname(entry.path)
  const next = `${stem}.${entry.form}`
  if (next === basename(entry.path)) return toTemplate(entry)
  for (const file of filesOf(entry)) if (taken(dirname(file), basename(renamed(file, stem)), basename(file))) throw new Error(`A template named ${stem} is already there.`)
  admitDirect(ctx, by, dir, 'rename')
  const done: string[] = []
  try {
    for (const file of filesOf(entry)) {
      await moveNoReplace(file, renamed(file, stem))
      done.push(file)
    }
  } catch (err) {
    // The document and the Word file it was made of keep one name: a half-done rename is taken back.
    for (const file of done.reverse()) await moveNoReplace(renamed(file, stem), file).catch(() => undefined)
    throw err
  }
  ctx.push({ push: 'work.templates', workspaceId: entry.where === 'all' ? null : workspace.id })
  return found(ctx, workspace.id, entry.where as 'job' | 'all', next)
}

export async function moveTemplate(ctx: WorkCtx, by: Caller, workspaceId: string, ref: string, everywhere: boolean): Promise<Template> {
  const { workspace, entry } = ownOf(ctx, by, workspaceId, ref)
  const where = everywhere ? 'all' : 'job'
  if (entry.where === where) return toTemplate(entry)
  const dir = everywhere ? sharedDir(ctx) : jobDir(workspace)
  admitDirect(ctx, by, dir, 'make')
  admitDirect(ctx, by, dirname(entry.path), 'trash')
  // Every file of the entry under one free name: the document and its Word file stay together.
  const stem = freeStem(dir, filesOf(entry), entry.name)
  const done: string[] = []
  try {
    for (const file of filesOf(entry)) {
      await moveNoReplace(file, join(dir, basename(renamed(file, stem))))
      done.push(file)
    }
  } catch (err) {
    for (const file of done.reverse()) await moveNoReplace(join(dir, basename(renamed(file, stem))), file).catch(() => undefined)
    throw err
  }
  const name = `${stem}.${entry.form}`
  // Every workspace's shelf changed: one lost or gained a template for all jobs.
  ctx.push({ push: 'work.templates', workspaceId: null })
  return found(ctx, workspace.id, where, name)
}

/**
 * Takes a template off the shelf. A starter is hidden in this workspace.
 * One of his own goes to Files' Trash where Files has one; where it has
 * none yet, nothing is deleted until the caller says he was asked.
 */
export async function removeTemplate(ctx: WorkCtx, by: Caller, workspaceId: string, ref: string, confirmed: string | null, deps: SaveDeps = {}): Promise<TemplateRemoved> {
  // The fence first: a key that may not reach the workspace changes nothing of its shelf, a Hide neither.
  const workspace = workspaceOf(ctx, workspaceId)
  if (by.kind === 'remote' && !by.peer && !ctx.reaches(by, workspace.path)) throw new Error(OUT_OF_REACH)
  const { shelf, entry } = resolveTemplate(ctx, workspaceId, ref)
  if (entry.where === 'starter') {
    new TemplatesStore(ctx.db).hide(workspaceId, parseTemplateId(entry.id)!.key)
    ctx.push({ push: 'work.templates', workspaceId })
    return {}
  }
  ownOf(ctx, by, workspaceId, ref)
  const everyone = entry.where === 'all'
  const refs: CanvasSource[] = filesOf(entry).map((path) => ({ at: 'file', host: ctx.host, path }))
  // Trash is the workspace folder's: a template for all jobs lies in the app's own data, which Files does not list.
  if (!everyone && by.kind !== 'model' && !by.peer && (await folderCan(ctx, by, workspaceId, 'trash', deps.pillars, deps.signal))) {
    const done = await askFilesVerb<FileDone>(ctx, by, 'trash', { workspaceId, refs }, deps.pillars, deps.signal)
    if (done) {
      if (done.refused.length && !done.trashed?.length) throw new Error(done.refused[0]!.text)
      ctx.push({ push: 'work.templates', workspaceId: shelf.workspace.id })
      return { trashed: done.trashed ?? [] }
    }
  }
  if (by.peer) throw new Error(PEER_CONFIRM)
  // What he was asked about is the file as it was then: its version rides the question, and a file that is not that one any more is left.
  const version = versionOf(filesOf(entry))
  if (confirmed === null) return { confirm: true, version }
  if (confirmed !== version) throw new Error(CHANGED)
  admitDirect(ctx, by, dirname(entry.path), 'trash')
  for (const file of filesOf(entry)) await rm(file, { force: true })
  ctx.push({ push: 'work.templates', workspaceId: everyone ? null : shelf.workspace.id })
  return {}
}

/** The files as they are now, in one string: which file each name holds, and what it last held. */
function versionOf(files: readonly string[]): string {
  return files
    .map((file) => {
      try {
        const info = statSync(file)
        return `${info.dev}:${info.ino}:${info.size}:${Math.floor(info.mtimeMs)}`
      } catch {
        return 'gone'
      }
    })
    .join('/')
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
export function fieldsOfSource(ctx: WorkCtx, by: Caller, workspaceId: string, source: CanvasSource): TemplateFields {
  const workspace = workspaceOf(ctx, workspaceId)
  const path = pathOf(ctx, source)
  if (by.kind === 'remote' && !by.peer && (!ctx.reaches(by, workspace.path) || (!reachesFile(ctx, by, path) && !shelved(ctx, workspace.id, path)))) throw new Error(OUT_OF_REACH)
  const formed = templateFormOf(path)
  if (!formed) throw new Error(NOT_A_TEMPLATE)
  if (formed.form === 'tcdoc') return { fields: tcdocFields(path) }
  // Our own sheet that a save will keep as Excel: what it asks for is read from that Excel file, so it is known only then.
  if (formed.form === 'tcsheet') return exportableSheet(ctx, workspace, source, path) ? { fields: [], later: true } : { fields: [] }
  if (!isOfficeForm(formed.form)) return { fields: [] }
  try {
    return { fields: askedFields(scanOffice(formed.form, new Uint8Array(readFileSync(path)))) }
  } catch {
    return { fields: [] } // a file that is no zip, or is gone: a plain copy asks for nothing
  }
}
