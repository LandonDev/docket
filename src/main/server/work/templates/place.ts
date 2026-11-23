import { randomUUID } from 'node:crypto'
import { constants, existsSync, realpathSync } from 'node:fs'
import { copyFile, link, mkdir, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ClientRequest } from '@shared/contract'
import type { FileDone, FilesPlaces } from '@shared/contract-work-files'
import type { CanvasSource, HostId } from '@shared/work'
import { freeName, PLACE, splitName, type FileVerb, type FolderRef } from '@shared/work/files'
import type { TemplateForm, TemplateKind } from '@shared/work/templates'
import { WORK_MODULES, type Caller, type WorkCtx, type WorkModule } from '../modules'
import type { WorkspaceRow } from './shelf'

/**
 * Where a file made from a template is put (docs/agents/work-templates.md
 * "Making a file"). Files owns New: once its place can make a file, the
 * filled scratch file is handed to `work.files.make` and Files writes it in
 * the folder he is in, in that place's form, through its one door. Until
 * then the file is copied into the workspace's own folder, never over
 * another, and nowhere else. A thread's make, and another pillar's, always takes the
 * second way: only his own press goes through Files' door.
 */

export interface PlaceAsk {
  workspace: WorkspaceRow
  /** absent: the workspace's own folder */
  into?: FolderRef
  kind: TemplateKind
  form: TemplateForm
  /** the file's name without its extension */
  title: string
  /** the filled file, in a scratch folder of this pillar */
  scratch: string
}
export interface Placed {
  source: CanvasSource
  /** the name it was given, without its extension */
  title: string
}

export type PlaceCtx = Pick<WorkCtx, 'db' | 'host' | 'dataDir' | 'reaches' | 'log'>

/** The modules a place may ask: the registry's, or a test's. */
export type Pillars = () => readonly WorkModule[]
const registry: Pillars = () => WORK_MODULES

export const OWN_FOLDER_ONLY = 'A file from a template is made in this workspace\'s own folder: move it to a shared place in Files.'
export const OUT_OF_REACH = "That workspace's folder is outside what this key may reach."

/** Files' own words for a verb it has not built (files/handle.ts): the one refusal that means "not yet", and not "no". */
const NOT_YET = /^Files cannot .+ yet\b/

/**
 * One verb asked of Files on this host. Null when Files has not built it
 * yet (or is not loaded): the caller then does the plain thing itself. Any
 * other refusal is Files' answer and is thrown as it is. `ctx.peer` refuses
 * its own host, so the files module's `handle` is called from the registry,
 * with the real caller, so its door judges who pressed.
 */
export async function askFilesVerb<T>(ctx: WorkCtx, by: Caller, verb: string, params: Record<string, unknown>, pillars: Pillars = registry, signal?: AbortSignal): Promise<T | null> {
  const files = pillars().find((m) => m.id === 'files')
  if (!files?.handle) return null
  const request = { id: `templates-${randomUUID()}`, method: `work.files.${verb}`, params: { ...params, op: randomUUID() } } as unknown as ClientRequest
  try {
    const answer = await files.handle(request, ctx, by, signal)
    return answer.handled ? (answer.result as T) : null
  } catch (err) {
    if (err instanceof Error && NOT_YET.test(err.message)) return null
    throw err
  }
}

/**
 * Whether Files carries out a verb in the workspace's own folder yet. Its
 * place lists the verbs it does (`FilePlace.can`; the folder's list is empty
 * until Files builds its changes), and its door refuses any other in its
 * own words before the verb is reached: so the place is asked first, and a
 * verb it does not list is this pillar's to do the plain way.
 */
export async function folderCan(ctx: WorkCtx, by: Caller, workspaceId: string, verb: FileVerb, pillars: Pillars = registry, signal?: AbortSignal): Promise<boolean> {
  const files = pillars().find((m) => m.id === 'files')
  if (!files?.handle) return false
  try {
    const answer = await files.handle({ id: `templates-${randomUUID()}`, method: 'work.files.places', params: { workspaceId } } as unknown as ClientRequest, ctx, by, signal)
    if (!answer.handled) return false
    return (answer.result as FilesPlaces).places.find((p) => p.id === PLACE.folder)?.can.includes(verb) ?? false
  } catch {
    return false
  }
}

/** Asks Files to make the file from the filled scratch copy. Null: Files cannot yet. */
export async function askFiles(ctx: WorkCtx, by: Caller, ask: PlaceAsk, pillars: Pillars = registry, signal?: AbortSignal): Promise<Placed | null> {
  // In the workspace's own folder, Files is asked only once that folder can make a file.
  if (isOwn(ctx, ask.workspace, ask.into) && !(await folderCan(ctx, by, ask.workspace.id, 'make', pillars, signal))) return null
  const done = await askFilesVerb<FileDone>(ctx, by, 'make', { workspaceId: ask.workspace.id, at: ask.into ?? { at: 'place', id: PLACE.folder }, kind: ask.kind, name: ask.title, from: { at: 'file', host: ctx.host, path: ask.scratch } }, pillars, signal)
  if (!done) return null
  const made = done.entries.find((e) => e.ref)
  if (!made?.ref) throw new Error(done.refused[0]?.text ?? 'Files made no file.')
  return { source: made.ref, title: splitName(made.name).stem }
}

const real = (path: string): string => {
  // The nearest folder that exists, by its real path, with the rest as written: a folder not made yet has no real path.
  let at = resolve(path)
  const tail: string[] = []
  while (!existsSync(at) && dirname(at) !== at) {
    tail.unshift(basename(at))
    at = dirname(at)
  }
  try {
    return join(realpathSync(at), ...tail)
  } catch {
    return resolve(path)
  }
}
const within = (path: string, dir: string): boolean => {
  const r = relative(dir, path)
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r))
}

/** The folder of the workspace a copy goes into; throws, in one sentence, for anywhere else. */
export function ownTarget(ctx: Pick<WorkCtx, 'host'>, workspace: WorkspaceRow, into?: FolderRef): string {
  const root = real(workspace.path)
  if (!into || (into.at === 'place' && into.id === PLACE.folder)) return root
  if (into.at !== 'file' || into.host !== ctx.host) throw new Error(OWN_FOLDER_ONLY)
  const dir = real(into.path)
  if (!within(dir, root)) throw new Error(OWN_FOLDER_ONLY)
  return dir
}

/** Whether a folder is the workspace's own, or inside it. */
export function isOwn(ctx: Pick<WorkCtx, 'host'>, workspace: WorkspaceRow, into?: FolderRef): boolean {
  try {
    ownTarget(ctx, workspace, into)
    return true
  } catch {
    return false
  }
}

/** Copies `from` into `dir` as `wanted`, or the next free name, never over another file. Answers the name it took. */
export async function copyNoReplace(from: string, dir: string, wanted: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  // Written whole beside its place under a hidden name, then given its name with a link, which never replaces a file.
  const temp = join(dir, `.${randomUUID()}.tmp`)
  await copyFile(from, temp)
  try {
    for (let tries = 0; tries < 20; tries++) {
      const name = freeName(wanted, (n) => existsSync(join(dir, n)))
      const path = join(dir, name)
      try {
        await link(temp, path)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EEXIST') continue // another make took the name between the look and the link
        // A disk with no hard links: an exclusive copy, which also never replaces.
        if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw err
        try {
          await copyFile(temp, path, constants.COPYFILE_EXCL)
        } catch (again) {
          if ((again as NodeJS.ErrnoException).code === 'EEXIST') continue
          throw again
        }
      }
      return name
    }
    throw new Error(`No free name for ${wanted} in that folder.`)
  } finally {
    await rm(temp, { force: true })
  }
}

/** Copies the scratch file into the workspace's own folder under a free name, never over another file. */
export async function copyIntoOwn(ctx: PlaceCtx, by: Caller, ask: PlaceAsk): Promise<Placed> {
  const dir = ownTarget(ctx, ask.workspace, ask.into)
  if (by.kind === 'remote' && !by.peer && !ctx.reaches(by, dir)) throw new Error(OUT_OF_REACH)
  const name = await copyNoReplace(ask.scratch, dir, `${ask.title}.${ask.form}`)
  return { source: { at: 'file', host: ctx.host as HostId, path: join(dir, name) }, title: splitName(name).stem }
}

/**
 * Puts the filled file in its place. His own press (a window, a paired
 * device) asks Files first; a thread and another pillar never do.
 */
export async function placeFile(ctx: WorkCtx, by: Caller, ask: PlaceAsk, pillars: Pillars = registry, signal?: AbortSignal): Promise<Placed> {
  if (by.kind !== 'model') {
    const placed = await askFiles(ctx, by, ask, pillars, signal)
    if (placed) return placed
  }
  return copyIntoOwn(ctx, by, ask)
}
