import { randomUUID } from 'node:crypto'
import { constants, existsSync, lstatSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs'
import { copyFile, link, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ClientRequest } from '@shared/contract'
import type { FileDone } from '@shared/contract-work-files'
import type { ExportAnswer } from '@shared/contract-work-formats'
import type { TemplateFields, TemplateRemoved } from '@shared/contract-work-templates'
import type { CanvasSource } from '@shared/work'
import { freeName, splitName } from '@shared/work/files'
import { askedFields, fileStem, parseTemplateId, templateFormOf, type Template, type TemplateForm } from '@shared/work/templates'
import { sharedOf } from '../files/policy'
import { WORK_MODULES, type Caller, type WorkCtx } from '../modules'
import { isOfficeForm, scanOffice } from './ooxml'
import { admitDirect, askFilesVerb, copyNoReplace, folderCan, FOLDER_MOVED, OUT_OF_REACH, reachesDir, real, resolveDir, unchanged, type Pillars } from './place'
import { docKey, fileIdentity, jobDir, jobShelfReads, reachesFile, reachWorkspace, resolveTemplate, sharedDir, shelfOf, tcdocEveryField, tcdocFields, toTemplate, type ShelfEntry, type WorkspaceRow } from './shelf'
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
export const LINKED = 'That template is a link to a file elsewhere: move the file it links to instead.'
export const GONE_FILE = (name: string): string => `The file of the template "${name}" is gone.`
export const SHELF_UNREAD = "This job's Templates folder leads out of the job, so the shelf would not show a file put there."

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

async function shelfFile(ctx: WorkCtx, by: Caller, workspace: WorkspaceRow, source: CanvasSource, path: string, form: TemplateForm, deps: SaveDeps, readAt = path): Promise<{ from: string; form: TemplateForm; drop?: string }> {
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
  return { from: readAt, form }
}

/**
 * Whether a path is a starter or a template for all jobs on this workspace's shelf. Those lie in the app's own
 * folders, which no key's fence names; a key that reaches the workspace may copy one ("Edit a copy").
 */
function shelved(ctx: WorkCtx, workspaceId: string, path: string): boolean {
  const shelf = shelfOf(ctx, workspaceId)
  return [...shelf.entries, ...shelf.hiddenEntries, ...shelf.replacedEntries].some((e) => e.where !== 'job' && e.path === path)
}

/**
 * The job's Templates folder as a place to write: a key must reach it where it really is (a link may lead it out of
 * the key's roots), and the shelf must read it there (Files' door, `jobShelfReads`), or a file written there would be
 * lost to the shelf.
 */
function admitJobShelf(ctx: WorkCtx, by: Caller, workspace: WorkspaceRow, dir: string): void {
  if (!reachesDir(ctx, by, dir)) throw new Error(OUT_OF_REACH)
  if (!jobShelfReads(ctx, workspace.id, dir)) throw new Error(SHELF_UNREAD)
}

export async function saveTemplate(ctx: WorkCtx, by: Caller, ask_: SaveAsk, deps: SaveDeps = {}): Promise<Template> {
  const workspace = reachWorkspace(ctx, by, ask_.workspaceId)
  const path = pathOf(ctx, ask_.source)
  if (by.kind === 'remote' && !by.peer && !reachesFile(ctx, by, path) && !shelved(ctx, workspace.id, path)) throw new Error(OUT_OF_REACH)
  // The file the checks judged, by its real path, resolved in the same step: a copy reads that file, whatever a link leads to later.
  const readAt = real(path)
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
  // Resolved once: every check is made on the folder the name leads to now, and the file is written there and nowhere
  // else, so a link moved while the export runs cannot carry it past the checks.
  const target = resolveDir(dir)
  // The host's own folder for all jobs is no key's to name; the job's Templates folder is judged where it really is.
  if (!ask_.everywhere) admitJobShelf(ctx, by, workspace, target.path)
  // Before anything is exported: a folder others can open takes a thread's file only on his press.
  admitDirect(ctx, by, target.path, 'make')
  const kept = await shelfFile(ctx, by, workspace, ask_.source, path, formed.form, deps, readAt)
  let name: string
  try {
    // A name that leads elsewhere now is refused: the file would land where the shelf no longer reads.
    if (!unchanged(dir, target)) throw new Error(FOLDER_MOVED)
    name = await copyNoReplace(kept.from, target.path, `${stem}.${kept.form}`)
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
/** A file a change acts on, as it was checked: its path by its folder's real path, and what it was then. */
interface Checked {
  path: string
  was: Stats
}

function ownOf(ctx: WorkCtx, by: Caller, workspaceId: string, ref: string): { workspace: WorkspaceRow; entry: ShelfEntry; files: Checked[] } {
  // The workspace's fence before its shelf is read: a key outside it learns no template's name.
  reachWorkspace(ctx, by, workspaceId)
  const { shelf, entry } = resolveTemplate(ctx, workspaceId, ref)
  if (entry.where === 'starter') throw new Error(STARTER_FIXED)
  // Every file the change touches: the template's own and the Word file its document was made of.
  if (entry.where === 'job' && !filesOf(entry).every((file) => reachesFile(ctx, by, file))) throw new Error(OUT_OF_REACH)
  // Resolved once, here: the change acts on these files, by these paths, and on nothing a name leads to later.
  const files = filesOf(entry).map((file) => {
    try {
      return { path: join(real(dirname(file)), basename(file)), was: statSync(file) }
    } catch {
      throw new Error(GONE_FILE(entry.name))
    }
  })
  return { workspace: shelf.workspace, entry, files }
}

/** The files an entry is: its own, and the Word file its `.tcdoc` was made of. */
const filesOf = (entry: ShelfEntry): string[] => (entry.twin ? [entry.path, entry.twin] : [entry.path])
/** A file's new path under a new stem, in its own folder, keeping its extension. */
const renamed = (path: string, stem: string): string => join(dirname(path), `${stem}${splitName(basename(path)).ext}`)
/**
 * Whether two looks at a path saw the same file, as it was: a link keeps the file whatever is written in it; a copy
 * only what it read. The file's birth time is part of which file it is: a freed inode's number is soon given to a new
 * file, which is born later.
 */
const same = (a: Stats, b: Stats, linked: boolean): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs && (linked || (a.size === b.size && a.mtimeMs === b.mtimeMs))
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
 * Takes a file's name in one step to a hidden name in its own folder, so what is removed after is exactly what was
 * looked at: an editor that saves the name anew meanwhile saves a new file under the old name, which nothing here
 * removes. Null when nothing has the name.
 */
async function claim(path: string): Promise<string | null> {
  const held = join(dirname(path), `.${randomUUID()}.claimed`)
  try {
    await rename(path, held)
    return held
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Gives a claimed file its name back, never over a file that took the name meanwhile: that one keeps it, and this one takes the next free name beside it. */
async function release(held: string, path: string): Promise<void> {
  const dir = dirname(path)
  const free = (): string => join(dir, freeName(basename(path), (n) => existsSync(join(dir, n))))
  // A link, or on a disk with none an exclusive copy: neither ever writes over a file.
  const put = async (to: string): Promise<void> => {
    try {
      await link(held, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw err
      await copyFile(held, to, constants.COPYFILE_EXCL)
    }
  }
  try {
    await put(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    await put(free())
  }
  await rm(held, { force: true })
}

/** Removes what a name holds only if it is still the file `is` knows; anything else is given its name back. Answers whether it removed it. */
async function removeIfSame(path: string, is: (now: Stats) => boolean): Promise<boolean> {
  const held = await claim(path)
  if (!held) return false
  const now = await statOrNull(held)
  if (now && is(now)) {
    await rm(held, { force: true })
    return true
  }
  await release(held, path)
  return false
}

/** The disk has no hard links (or the two names are on two disks): the step falls back to an exclusive copy. */
const noLink = (code: string | undefined): boolean => code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS'

/**
 * Moves a file to a path nothing holds, and answers what it published there; it gives the file back as it was found
 * when that cannot be done whole. A link puts the very file at the new name; over a disk's edge, or on a disk with no
 * hard links, the file is copied to a hidden name of the new folder, which nothing else names, and that name is linked
 * to the new one, so what is published is known without looking at the new name again. `was`, when given, is the file
 * the caller checked: a name that holds another file by now moves nothing. The old name goes only once it is claimed
 * and seen to hold the file that was moved: a file an editor saved anew there meanwhile stays, and the new name is
 * taken back only while it holds what this move published. A change of case alone, on a disk that reads both names as
 * one file, is one rename of that file.
 *
 * One gap stays on a disk with no hard links at all (a share, some FAT volumes): there the new name is an exclusive
 * copy, and what it holds is read just after it is written; a file put under that name in that moment, if the move is
 * then taken back, is kept as it is only when its size or time differ.
 */
async function moveNoReplace(from: string, to: string, was?: Stats): Promise<Stats> {
  await mkdir(dirname(to), { recursive: true })
  const taken = (): Error => new Error(`A template named ${splitName(basename(to)).stem} is already there.`)
  const before = await stat(from)
  // Exactly the file named, as it was: written to since, it is left for the caller to look at again.
  if (was && !same(before, was, false)) throw new Error(MOVED_UNDER)
  let linked = true
  let published = before
  let unproven = false
  try {
    await link(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      // The new name is the old file itself: the disk reads names without case. Anything else holds the name.
      const there = await statOrNull(to)
      if (there && same(there, before, true) && from.toLowerCase() === to.toLowerCase()) {
        await rename(from, to)
        return before
      }
      throw taken()
    }
    if (!noLink(code)) throw err
    linked = false
    const staged = join(dirname(to), `.${randomUUID()}.moving`)
    try {
      await copyFile(from, staged, constants.COPYFILE_EXCL)
      published = await stat(staged)
      try {
        await link(staged, to)
      } catch (again) {
        const why = (again as NodeJS.ErrnoException).code
        if (why === 'EEXIST') throw taken()
        if (!noLink(why)) throw again
        try {
          await copyFile(staged, to, constants.COPYFILE_EXCL)
        } catch (last) {
          if ((last as NodeJS.ErrnoException).code === 'EEXIST') throw taken()
          throw last
        }
        // No link to bind the new name to the copy made: what it holds now may already be another file. Nothing
        // proves which, so a take-back leaves it.
        unproven = true
      }
    } finally {
      await rm(staged, { force: true })
    }
  }
  // By size and time too: a freed inode's number is soon given to a new file. A new name this move cannot prove it
  // wrote is never taken back: it stays, and the move says where.
  const ours = (now: Stats): boolean => !unproven && same(now, published, false)
  const left = (): Error => (unproven ? new Error(`${MOVED_UNDER} A copy may be left at ${basename(to)}.`) : new Error(MOVED_UNDER))
  let gone: boolean
  try {
    gone = await removeIfSame(from, (now) => same(now, before, linked))
  } catch (err) {
    // The old name could not be taken (a file held open): the new one is taken back, and the file stays where it was.
    if (!unproven) await removeIfSame(to, ours).catch(() => undefined)
    throw err
  }
  if (gone) return unproven ? await stat(to) : published
  // The old name holds a newer file, or none: it stays as it is, and so does anything that took the new name since.
  if (!unproven) await removeIfSame(to, ours)
  throw left()
}

/** A step of a change of several files, done: where the file was, where it is, and what is there. */
interface Moved {
  from: string
  to: string
  published: Stats
}

/** Takes back the files a change of several moved before one failed, each only while its new name holds what was published. */
async function takeBack(done: readonly Moved[]): Promise<void> {
  for (const d of [...done].reverse()) await moveNoReplace(d.to, d.from, d.published).catch(() => undefined)
}

/**
 * What is known of a pair after this pillar moved its files: a pair stays one under its new names (a move by copy
 * gives a file a new identity); a lone file put beside a document or a Word file of its name is recorded apart from it,
 * so the import's record, which names files by name alone, never joins two files this pillar put side by side.
 */
function recordMoved(ctx: WorkCtx, entry: ShelfEntry, done: readonly Moved[]): void {
  const store = new TemplatesStore(ctx.db)
  // The Word file by the identity this move published there, never by what its new name holds when read again.
  const identityOf = (p: Stats): string => `${p.dev}:${p.ino}:${Math.floor(p.birthtimeMs)}`
  if (done.length === 2) {
    store.pair(done[0]!.to, identityOf(done[1]!.published), true)
    return
  }
  const moved = done[0]
  if (!moved || (entry.form !== 'tcdoc' && entry.form !== 'docx')) return
  const other = entry.form === 'tcdoc' ? 'docx' : 'tcdoc'
  const stem = splitName(basename(moved.to)).stem
  let names: string[]
  try {
    names = readdirSync(dirname(moved.to))
  } catch {
    return
  }
  for (const n of names) {
    if (splitName(n).stem !== stem || templateFormOf(n)?.form !== other) continue
    const theirs = join(dirname(moved.to), n)
    if (entry.form === 'tcdoc') {
      const word = fileIdentity(theirs)
      if (word) store.pair(moved.to, word, false)
    } else {
      const doc = docKey(theirs)
      if (doc) store.pair(doc, identityOf(moved.published), false)
    }
  }
}

export async function renameTemplate(ctx: WorkCtx, by: Caller, workspaceId: string, ref: string, name: string): Promise<Template> {
  const { workspace, entry, files } = ownOf(ctx, by, workspaceId, ref)
  const stem = fileStem(name)
  if (!stem) throw new Error('A template needs a name.')
  const dir = dirname(files[0]!.path)
  // The name as it is written: the file keeps its own extension, `.DOCX` as `.docx`.
  const next = basename(renamed(entry.path, stem))
  if (next === basename(entry.path)) return toTemplate(entry)
  for (const file of files) if (taken(dirname(file.path), basename(renamed(file.path, stem)), basename(file.path))) throw new Error(`A template named ${stem} is already there.`)
  admitDirect(ctx, by, dir, 'rename')
  const done: Moved[] = []
  try {
    for (const file of files) {
      const to = renamed(file.path, stem)
      done.push({ from: file.path, to, published: await moveNoReplace(file.path, to, file.was) })
    }
  } catch (err) {
    // The document and the Word file it was made of keep one name: a half-done rename is taken back.
    await takeBack(done)
    throw err
  }
  recordMoved(ctx, entry, done)
  ctx.push({ push: 'work.templates', workspaceId: entry.where === 'all' ? null : workspace.id })
  return found(ctx, workspace.id, entry.where as 'job' | 'all', next)
}

export async function moveTemplate(ctx: WorkCtx, by: Caller, workspaceId: string, ref: string, everywhere: boolean): Promise<Template> {
  const moving = ownOf(ctx, by, workspaceId, ref)
  const where = everywhere ? 'all' : 'job'
  if (moving.entry.where === where) return toTemplate(moving.entry)
  const { workspace, entry, files } = moving
  // Resolved once: the checks and the move are made on the folder the name leads to now.
  const target = resolveDir(everywhere ? sharedDir(ctx) : jobDir(workspace))
  // A link moved to another folder would lead elsewhere, or nowhere: the file it leads to is his to move.
  if (files.some((f) => isLink(f.path))) throw new Error(LINKED)
  if (!everywhere) admitJobShelf(ctx, by, workspace, target.path)
  admitDirect(ctx, by, target.path, 'make')
  admitDirect(ctx, by, dirname(files[0]!.path), 'trash')
  // Every file of the entry under one free name: the document and its Word file stay together.
  const stem = freeStem(target.path, files.map((f) => f.path), entry.name)
  const done: Moved[] = []
  try {
    for (const file of files) {
      const to = join(target.path, basename(renamed(file.path, stem)))
      done.push({ from: file.path, to, published: await moveNoReplace(file.path, to, file.was) })
    }
  } catch (err) {
    await takeBack(done)
    throw err
  }
  recordMoved(ctx, entry, done)
  const name = basename(renamed(entry.path, stem))
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
  reachWorkspace(ctx, by, workspaceId)
  const { shelf, entry } = resolveTemplate(ctx, workspaceId, ref)
  if (entry.where === 'starter') {
    new TemplatesStore(ctx.db).hide(workspaceId, parseTemplateId(entry.id)!.key)
    ctx.push({ push: 'work.templates', workspaceId })
    return {}
  }
  const { files: checked } = ownOf(ctx, by, workspaceId, ref)
  const everyone = entry.where === 'all'
  // The file he pressed on alone. The Word file beside a document is paired by the import's record of a name and a
  // time, which an unrelated older Word file of that name can pass; nothing proves the two are one, so the Word file
  // is never deleted with it and stays on the shelf as its own tile.
  const refs: CanvasSource[] = [{ at: 'file', host: ctx.host, path: entry.path }]
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
  const files = [checked[0]!.path]
  const version = versionOf(files)
  if (confirmed === null) return { confirm: true, version }
  if (confirmed !== version) throw new Error(CHANGED)
  admitDirect(ctx, by, dirname(files[0]!), 'trash')
  // Each name is claimed, then what it holds is checked against what he was asked about: only then does anything go.
  // A file saved under a name since the check is given its name back, and so is every other claimed file; a claim or
  // a removal that fails gives back every file not yet gone, so no file of his is left under a hidden name.
  const stamps = version.split('/')
  const held: { path: string; at: string | null }[] = []
  const giveBack = async (): Promise<void> => {
    for (const h of held) if (h.at) await release(h.at, h.path).catch(() => undefined)
  }
  try {
    for (const file of files) held.push({ path: file, at: await claim(file) })
  } catch (err) {
    await giveBack()
    throw err
  }
  const looks = await Promise.all(held.map((h) => (h.at ? statOrNull(h.at) : null)))
  if (!looks.every((s, i) => s && stampOf(s) === stamps[i])) {
    await giveBack()
    throw new Error(CHANGED)
  }
  const store = new TemplatesStore(ctx.db)
  for (const [i, h] of held.entries()) {
    try {
      await rm(h.at!, { force: true })
      h.at = null
    } catch (err) {
      await giveBack()
      throw err
    }
    const gone = looks[i]!
    // What was known of it goes: a document by its path, a Word file by its identity (`docKey`, `fileIdentity`).
    store.forget(entry.form === 'tcdoc' ? h.path : `${gone.dev}:${gone.ino}:${Math.floor(gone.birthtimeMs)}`)
  }
  ctx.push({ push: 'work.templates', workspaceId: everyone ? null : shelf.workspace.id })
  return {}
}

/** Which file a name holds, and what it last held. */
const stampOf = (info: Stats): string => `${info.dev}:${info.ino}:${info.size}:${Math.floor(info.mtimeMs)}`

/** The files as they are now, in one string: each one's stamp. */
function versionOf(files: readonly string[]): string {
  return files
    .map((file) => {
      try {
        return stampOf(statSync(file))
      } catch {
        return 'gone'
      }
    })
    .join('/')
}

/** Whether a name is a link: what it leads to is judged by the shelf, and a link is never moved to another folder. */
const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Shows the workspace's hidden starters again: every one, or the one named (the undo of one Hide). */
export function unhideTemplates(ctx: WorkCtx, by: Caller, workspaceId: string, ref?: string): void {
  reachWorkspace(ctx, by, workspaceId)
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
  const workspace = reachWorkspace(ctx, by, workspaceId)
  const path = pathOf(ctx, source)
  if (by.kind === 'remote' && !by.peer && !reachesFile(ctx, by, path) && !shelved(ctx, workspace.id, path)) throw new Error(OUT_OF_REACH)
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
