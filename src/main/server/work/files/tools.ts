import { randomUUID } from 'node:crypto'
import { heldChange } from '../outbox/words'
import { basename, dirname } from 'node:path'
import { z } from 'zod'
import type { ClientRequest } from '@shared/contract'
import { FILE_MAKE_KINDS, FileActSchema, type FileAct, type FileActVerb, type FileDone, type FileRef, type FileMakeKind, type FilesListing, type FilesPlaces } from '@shared/contract-work-files'
import { canvasSourcePath, workText, type CanvasSource, type WorkScope, type WorkToolResult } from '@shared/work'
import { audienceOf, MAKE_WORDS, refKey, refusal, type FileEntry, type FilePlace, type FileVerb, type FolderRef } from '@shared/work/files'
import { errorText } from '@shared/work/ids'
import type { ActKindDef, Caller, ToolCtx, WorkCtx, WorkTool } from '../modules'
import { ActNotSent, ActStale } from '../outbox/kinds'
import { admitChange, filesHandle, filesState, openAs } from './handle'
import { formIn } from './make'
import { changeDigest, locate, workspaceHere } from './policy'
import { restoreRows, trashFiles } from './trash'
import { copyVerb, isHeldMoved, isNameTaken, makeFolderRef, makeVerb, moveVerb, renameVerb, replayed } from './verbs'
import { admitDrive, driveMake, driveMove, driveRename, driveTrash, type DriveDone } from './driveVerbs'
import { googleSeated, googleSeatOf } from '../google/drive'
import { driveFacts } from './places/drive'

/**
 * The agents' side of the Files place (docs/agents/work-files.md "Agents"): the `files_*` tools a Work thread
 * calls, and the held act `file.act`. A file is named by its place (an id `files_places` answers) and its path
 * inside that place in words (`Events/Poster.png`), never by a host path. Every change asks the one door
 * (`admitChange`, handle.ts, over `admitWrite`): in his own place it runs at once, with a Result whose Undo is
 * `files_undo`; in a place others can open it is held as a `file.act` for his press, whatever the thread says
 * he asked. A place on another computer of his is reached through `ctx.peer`, and every change there is held:
 * a peer reaches only that computer's libraries, all of which others can open.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
const threadOf = (sessionId: string): Caller => ({ kind: 'model', caps: [], sessionId })
/** His own window: the press on a held act runs as the window's change, after the thread's fence is checked again. */
const WINDOW: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }

export const NO_PLACE_IN_CHAT = 'A Work Chat has no files place. Files belong to a Work workspace; ask the owner which one.'
const NO_SUCH_PLACE = (place: string): string => `No place "${place}" here: list them with files_places.`
const TWO_PLACES = (place: string): string => `Two computers have a place "${place}": name the host as files_places shows it.`
const NOT_A_PATH = 'Name a file by its path inside the place, with forward slashes (Events/Poster.png): no "." or "..".'
const OPEN_FAR = (host: string): string => `That file is on ${host}: open it with teams_open, which copies it here.`

// ── where a thread's words point ──────────────────────────────────────

/** A place as a thread may name it: the place and the host that answers for it. */
interface Named {
  host: string
  place: FilePlace
}

/** The hosts a thread may reach files on: its own, then the desktops its workspace may use. */
const hostsOf = (ctx: ToolCtx): string[] => [...new Set([ctx.host, ...(ctx.scope.workspaceId ? ctx.settings.workspace(ctx.scope.workspaceId).mayUseDesktop : [])])]

/** Asks one `work.files.*` verb of a host as this thread: here through the one handler, else over the host link. */
async function ask<T>(ctx: ToolCtx, host: string, verb: string, params: Record<string, unknown>): Promise<T> {
  if (host !== ctx.host) return (await ctx.peer(host).call('files', verb, params)) as T
  const answer = await filesHandle({ id: 'tool', method: `work.files.${verb}`, params } as unknown as ClientRequest, ctx, threadOf(ctx.sessionId), ctx.signal)
  if (!answer.handled) throw new Error(`work.files.${verb} is not answered on this host`)
  return answer.result as T
}

/** Every place the thread may name, each host answering in turn; a host that does not answer is named in `failed`. */
async function allPlaces(ctx: ToolCtx, workspaceId: string, only?: string): Promise<{ named: Named[]; failed: { host: string; error: string }[] }> {
  const named: Named[] = []
  const failed: { host: string; error: string }[] = []
  await Promise.all(
    hostsOf(ctx)
      .filter((host) => !only || host === only)
      .map(async (host) => {
        try {
          const got = await ask<FilesPlaces>(ctx, host, 'places', { workspaceId })
          for (const place of got.places) named.push({ host, place })
        } catch (err) {
          failed.push({ host, error: errorText(err) })
        }
      })
  )
  // This host's places first, in the order its host lists them.
  named.sort((a, b) => Number(a.host !== ctx.host) - Number(b.host !== ctx.host))
  return { named, failed }
}

/** The place a thread named, by its id or its name (case-blind), on `host` when it gave one. */
async function placeNamed(ctx: ToolCtx, workspaceId: string, place: string, host?: string): Promise<Named> {
  const { named } = await allPlaces(ctx, workspaceId, host)
  const byId = named.filter((n) => n.place.id === place)
  const found = byId.length ? byId : named.filter((n) => n.place.name.toLowerCase() === place.trim().toLowerCase())
  if (!found.length) throw new Error(NO_SUCH_PLACE(place))
  if (found.length > 1 && new Set(found.map((n) => n.host)).size > 1) throw new Error(TWO_PLACES(place))
  return found[0]!
}

/** A Google Drive place: its things have ids, not paths, so a thread's words are found by name (`driveRefIn`). */
const isDrive = (place: FilePlace): boolean => place.root.at === 'drive'
const sameName = (a: string, b: string): boolean => a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase()

/** A path in a Drive place's words as the Drive ref it names: each step found by its name among what TempCode may see there. */
async function driveRefIn(ctx: ToolCtx, workspaceId: string, named: Named, words: string): Promise<FileRef> {
  const parts = words.split(/[\\/]+/).filter(Boolean)
  if (parts.some((p) => p === '.' || p === '..')) throw new Error(NOT_A_PATH)
  let folder: FolderRef = named.place.root
  let ref: FileRef = folder
  for (const [i, part] of parts.entries()) {
    if (ref !== folder) throw new Error(`${parts.slice(0, i).join('/')} is a file, not a folder.`)
    const found: FileEntry[] = []
    let cursor: string | undefined
    do {
      const page = await ask<FilesListing>(ctx, named.host, 'list', { workspaceId, at: folder, ...(cursor ? { cursor } : {}) })
      found.push(...page.entries.filter((e) => sameName(e.name, part)))
      cursor = page.next
    } while (cursor)
    const exact = found.filter((e) => e.name === part)
    const pick = exact.length ? exact : found
    if (!pick.length) throw new Error(`${parts.slice(0, i + 1).join('/')} is not there, or this thread may not reach it.`)
    if (pick.length > 1) throw new Error(`Two things are named ${part} there: Google Drive lets names repeat. Ask the owner which one.`)
    if (pick[0]!.folder) ref = folder = pick[0]!.folder
    else ref = pick[0]!.ref as FileRef
  }
  return ref
}

/** A path in a place's words as the ref its host takes: a disk's path, or a Drive's id. */
const refOf = (ctx: ToolCtx, workspaceId: string, named: Named, words: string): Promise<FileRef> => (isDrive(named.place) ? driveRefIn(ctx, workspaceId, named, words) : Promise.resolve(refIn(named.place, words)))

/** The root folder of a place, on a disk: the only kind of place a thread names files in by a path. */
function rootOf(place: FilePlace): { host: string; path: string } {
  const root = place.root
  if (root.at !== 'file') throw new Error('That place is not read by this build yet.')
  return { host: root.host, path: root.path }
}
const sepOf = (place: FilePlace, root: string): string => (place.vm || (/^[A-Za-z]:\\/.test(root) && !root.includes('/')) ? '\\' : '/')

/** A path in a place's words as a ref of its host. */
export function refIn(place: FilePlace, words = ''): { at: 'file'; host: string; path: string } {
  const parts = words.split(/[\\/]+/).filter(Boolean)
  if (parts.some((p) => p === '.' || p === '..')) throw new Error(NOT_A_PATH)
  const root = rootOf(place)
  const sep = sepOf(place, root.path)
  return { at: 'file', host: root.host, path: parts.length ? `${root.path.replace(/[\\/]+$/, '')}${sep}${parts.join(sep)}` : root.path }
}

/** A host's path as words inside its place: '' for the place's top. */
export function wordsIn(place: FilePlace, path: string): string {
  const root = rootOf(place).path.replace(/[\\/]+$/, '')
  const rest = path.startsWith(root) ? path.slice(root.length) : path
  return rest.split(/[\\/]+/).filter(Boolean).join('/')
}

/** Where a thing lies, as a held act's sentence says it: the team, the place, then the folders. */
function whereOf(place: FilePlace, words: string): FileAct['from'] {
  return { place: place.id, name: place.name, trail: words.split('/').filter(Boolean) }
}
const whereWords = (where: FileAct['from'], group?: string): string => {
  const parts = [group, where.name, ...where.trail].filter((p): p is string => !!p)
  return parts.filter((p, i) => i === 0 || p.toLowerCase() !== parts[i - 1]!.toLowerCase()).join(', ')
}

const pathOf = (e: Pick<FileEntry, 'ref' | 'folder'>): string | null => (e.ref ? canvasSourcePath(e.ref) : e.folder?.at === 'file' ? e.folder.path : null)
const refOfEntry = (e: FileEntry): FileRef => (e.ref ?? e.folder!) as FileRef
/** A file's version as a held act binds it: its size and when it last changed, read from its place's listing. No byte of a shared file is read for it. */
export const versionOfEntry = (e: Pick<FileEntry, 'size' | 'changed'>): string => `${e.size ?? 0}:${e.changed ?? 0}:`

/** One row as a thread reads it: its path in the place, never the host's. */
function line(place: FilePlace, e: FileEntry, dir = ''): Record<string, unknown> {
  const path = pathOf(e)
  return {
    file: path !== null ? wordsIn(place, path) : [dir, e.name].filter(Boolean).join('/'),
    kind: e.kind,
    ...(e.size !== undefined && e.kind !== 'folder' ? { size: e.size } : {}),
    ...(e.changed ? { changed: new Date(e.changed).toISOString() } : {}),
    ...(e.local === false ? { downloaded: false } : {}),
    ...(e.madeBy ? { madeBy: e.madeBy } : {})
  }
}

/** The thread's name as the rail says it, for the row of a file it made. */
function threadName(ctx: WorkCtx, sessionId: string): string {
  try {
    const row = ctx.db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as { title?: string | null } | undefined
    if (row?.title?.trim()) return row.title.trim().slice(0, 200)
  } catch {
    // a host with no sessions table (a test): the plain word
  }
  return 'A thread'
}

/** A file made through `files_make`, or by a press on a thread's held make: its row leads with the thread's name until he opens it. */
function markMade(ctx: WorkCtx, workspaceId: string, sessionId: string, entries: readonly FileEntry[]): void {
  if (!workspaceHere(ctx.db, workspaceId)) return
  const marks = filesState(ctx).marks
  const who = threadName(ctx, sessionId)
  for (const e of entries) marks.madeBy(workspaceId, e.key, e.ref ? { file: e.ref } : { folder: e.folder! }, e.name, who)
}

const names = (list: readonly string[]): string => (list.length === 1 ? list[0]! : list.length === 2 ? `${list[0]} and ${list[1]}` : `${list[0]}, ${list[1]} and ${list.length - 2} more`)

// ── the held act ──────────────────────────────────────────────────────

/** The one sentence a held file act shows everywhere, a phone or an older window included: every fact before a press. */
export function fileActWords(p: Pick<FileAct, 'verb' | 'request' | 'things' | 'from' | 'into' | 'audience'>): { summary: string; verb: string } {
  const what = names(p.things.map((t) => t.name))
  const from = whereWords(p.from)
  const head =
    p.verb === 'make'
      ? `Make ${p.request.name ?? `a new ${(MAKE_WORDS[p.request.kind ?? 'text'] ?? 'file').toLowerCase()}`} in ${from}.`
      : p.verb === 'rename'
        ? `Rename ${what} to ${p.request.name} in ${from}.`
        : p.verb === 'trash'
          ? `Delete ${what} from ${from}.`
          : `${p.verb === 'move' ? 'Move' : 'Copy'} ${what} to ${whereWords(p.into!)}.`
  return { summary: `${head} ${p.audience}`, verb: { make: 'Make', rename: 'Rename', move: 'Move', copy: 'Copy', trash: 'Delete' }[p.verb] }
}

const STALE = {
  moved: 'The thread that asked for this is no longer in that workspace, so nothing was done.',
  changed: (name: string) => `${name} changed since this was held, so nothing was done. Ask the thread again if it is still wanted.`,
  gone: (name: string) => `${name} is no longer where it was, so nothing was done.`,
  folder: (name: string) => `The folder ${name} is gone or moved, so nothing was done.`,
  digest: 'This act no longer matches the change it describes, so nothing was done.',
  audience: (name: string) => `Who can open ${name} changed since this was held, so nothing was done. Ask the thread again if it is still wanted.`,
  taken: (folder: string, name: string) => `${folder} already holds something named ${name}, so nothing was done: the copy would take another name than the one shown.`,
  renamed: (name: string) => `The folder ${name} was renamed since this was held, so nothing was done.`
}

/** The keys of the folders above a Drive folder, top first, as its listing's trail gives them; null for any other folder. */
async function parentsOf(ctx: ToolCtx, host: string, workspaceId: string, to: FolderRef | undefined): Promise<string[] | null> {
  if (!to || to.at !== 'drive') return null
  const listed = await ask<FilesListing>(ctx, host, 'list', { workspaceId, at: to, foldersOnly: true })
  return (listed.trail ?? []).slice(0, -1).map((c) => refKey(c.at))
}

/** A thing's ref inside a folder on a disk, by its name; null for a place with no path (a Drive). */
function childRef(folder: FileRef | undefined, name: string): FileRef | null {
  if (!folder || folder.at !== 'file') return null
  const slash = /^[A-Za-z]:\\/.test(folder.path) ? '\\' : '/'
  return { ...folder, path: `${folder.path.replace(/[\\/]+$/, '')}${slash}${name}` }
}

/**
 * A move or copy whose name is taken in the folder it goes to: a copy (and a move across places, which is a copy)
 * takes the next free name there, which is not the change the card shows. Answers the first name taken.
 */
async function takenIn(ctx: ToolCtx, host: string, workspaceId: string, to: FileRef | undefined, names: readonly string[]): Promise<string | null> {
  const refs = names.map((n) => childRef(to, n))
  if (refs.some((r) => r === null) || !refs.length) return null
  const got = await ask<{ entries: (FileEntry | null)[] }>(ctx, host, 'stat', { workspaceId, refs })
  const i = got.entries.findIndex((e) => e !== null)
  return i < 0 ? null : names[i]!
}

/**
 * `file.act`: a thread's change in a place others can open, carried out only by his press. No matcher (no grant
 * fits it, and none is offered), no edit (the Outbox's `EDITABLE_KINDS` leaves it out), and Away presses nothing.
 * The press checks the thread's fence and every bound fact again on the file's own host, then runs the same verb
 * his window does there, under the act's operation id, with the act's id and digest as where it began.
 */
export const fileActKind: ActKindDef<FileAct, never> = {
  kind: 'file.act',
  store: 'host',
  payload: FileActSchema,
  words: (p) => fileActWords(p),
  async execute(p, act) {
    const item = act.item
    if (!item.sessionId || item.workspaceId !== p.workspaceId) throw new ActStale(STALE.moved)
    // A history import or a thread moved to another workspace leaves this act behind: it is stale, not carried.
    const scope = act.scopeOf(item.sessionId)
    if (!scope || scope.workspaceId !== p.workspaceId) throw new ActStale(STALE.moved)
    if (changeDigest({ workspaceId: p.workspaceId, verb: p.verb, refs: p.request.refs, to: p.request.to, name: p.request.name, kind: p.request.kind }) !== p.digest) throw new ActStale(STALE.digest)
    const signal = AbortSignal.timeout(5 * 60_000)
    const toolCtx = { ...act, scope, sessionId: item.sessionId, signal } as ToolCtx
    // The things the card named, as held, go with the press: the host that writes checks them as it acts (verbs.ts `boundThing`).
    const origin = { from: 'act' as const, id: item.ref.id, digest: p.digest, things: p.things.map((t) => ({ key: t.key, version: t.version })), ...(p.into ? { into: p.into.key } : {}) }
    const params = { workspaceId: p.workspaceId, ...(p.verb === 'rename' ? { ref: p.request.refs[0], name: p.request.name } : p.verb === 'make' ? { at: p.request.refs[0], kind: p.request.kind, ...(p.request.name ? { name: p.request.name } : {}) } : { refs: p.request.refs, to: p.request.to }), op: p.op, origin, asked: true }
    // A press whose answer was lost, pressed again: the change ran under its own operation id, and its receipt here
    // answers what it did, before the facts it moved (an old path gone) can call it stale. (Another host's receipt is
    // that host's to answer: see docs/agents/work-files.md "The held act".)
    const asked = p.verb === 'make' ? { ...params, at: makeFolderRef(act, WINDOW, p.request.refs[0] as FolderRef) } : params
    const receipt = p.host === act.host && p.verb !== 'trash' ? replayed(act, WINDOW, p.verb, asked as never) : null
    if (receipt) return pressed(act, p, item.sessionId, await receipt)
    // The fence and the facts, again, on the file's own host: the thread must still reach each thing as it was.
    const now = await ask<{ entries: (FileEntry | null)[] }>(toolCtx, p.host, 'stat', { workspaceId: p.workspaceId, refs: p.request.refs })
    p.things.forEach((thing, i) => {
      const e = now.entries[i]
      if (!e || e.key !== thing.key) throw new ActStale(p.verb === 'make' ? STALE.folder(thing.name) : STALE.gone(thing.name))
      if (p.verb !== 'make' && versionOfEntry(e) !== thing.version) throw new ActStale(STALE.changed(thing.name))
      // The sentence he read said who can open it: a thing whose sharing changed under the same key is not that act.
      if (thing.shared !== undefined && !!e.shared !== thing.shared) throw new ActStale(STALE.audience(thing.name))
    })
    if (p.request.to) {
      const into = (await ask<{ entries: (FileEntry | null)[] }>(toolCtx, p.host, 'stat', { workspaceId: p.workspaceId, refs: [p.request.to] })).entries[0]
      const name = p.into?.trail.at(-1) ?? p.into?.name ?? 'it was to go in'
      if (!into || into.key !== p.into?.key || into.kind !== 'folder') throw new ActStale(STALE.folder(name))
      if (p.into.shared !== undefined && !!into.shared !== p.into.shared) throw new ActStale(STALE.audience(name))
      // A Drive's folder keeps its id when renamed: the card named it by the name it had.
      const last = p.into.trail.at(-1)
      if (p.request.to?.at === 'drive' && last !== undefined && into.name !== last) throw new ActStale(STALE.renamed(last))
      if (p.verb === 'copy' || p.verb === 'move') {
        const taken = await takenIn(toolCtx, p.host, p.workspaceId, p.request.to, p.things.map((t) => t.name))
        if (taken) throw new ActStale(STALE.taken(name, taken))
      }
      // A Drive folder moved under other folders keeps its id, its name and its sharing: the folders above it say so.
      if (p.into.parents && JSON.stringify(await parentsOf(toolCtx, p.host, p.workspaceId, p.request.to)) !== JSON.stringify(p.into.parents)) throw new ActStale(STALE.folder(name))
    }
    // A named New lands under that name or not at all (the verb holds it to it at the write, `exactIn`).
    if (p.verb === 'make' && p.request.name) {
      const taken = await takenIn(toolCtx, p.host, p.workspaceId, p.request.refs[0] as FileRef, [p.request.name])
      if (taken) throw new ActStale(STALE.taken(p.from.trail.at(-1) ?? p.from.name, taken))
    }
    let done: FileDone
    try {
      if (p.host === act.host) {
        const answer = await filesHandle({ id: 'act', method: `work.files.${p.verb}`, params } as unknown as ClientRequest, act, WINDOW, signal)
        if (!answer.handled) throw new ActNotSent(`work.files.${p.verb} is not answered on this host`)
        done = answer.result as FileDone
      } else {
        done = (await act.peer.call(toolCtx, p.host).call('files', p.verb, params)) as FileDone
      }
    } catch (err) {
      // The name it showed was taken, or a thing it names changed, between the check and the write: nothing was done.
      if (err instanceof Error && (isNameTaken(err.message) || isHeldMoved(err.message))) throw new ActStale(err.message)
      throw err
    }
    return pressed(act, p, item.sessionId, done)
  }
}

/** What a press did, as the Outbox records it: what went, and what was refused. */
function pressed(act: WorkCtx, p: FileAct, sessionId: string, done: FileDone): { summary: string; ref: unknown } {
  // A delete answers what it sent to the bin, not entries: what was not refused went.
  const went = p.verb === 'trash' ? p.things.filter((t) => !done.refused.some((r) => r.name === t.name)).map((t) => ({ key: t.key, name: t.name })) : done.entries
  const why = done.refused.map((r) => `${r.name}: ${r.text}`).join(' ')
  // Nothing done because what it names is not as shown (a taken name, a changed file): stale, as a New's is. Else not sent.
  if (!went.length && done.refused.length) throw done.refused.every((r) => isNameTaken(r.text) || isHeldMoved(r.text)) ? new ActStale(why) : new ActNotSent(why)
  if (p.verb === 'make') markMade(act, p.workspaceId, sessionId, done.entries)
  const words = fileActWords(p)
  const past = { make: 'Made', rename: 'Renamed', move: 'Moved', copy: 'Copied', trash: 'Deleted' }[p.verb]
  const left = done.refused.length ? ` Not done: ${done.refused.map((r) => `${r.name} (${r.text})`).join('; ')}` : ''
  return { summary: `${past}: ${went.map((e) => e.name).join(', ')}.${left}`, ref: { keys: went.map((e) => e.key), asked: words.summary } }
}

// ── a change, run or held ─────────────────────────────────────────────

interface Asked {
  verb: FileActVerb
  named: Named
  /** what the verb is sent */
  request: FileAct['request']
  /** each ref in the thread's own words (for make, the folder's): a Drive's things have no path to say them by */
  paths: string[]
  /** the place a move or copy lands in, its folder, and the folder in the thread's words */
  into?: { named: Named; entry: FileEntry; words: string }
}

const PAST: Record<Asked['verb'], string> = { make: 'Made', rename: 'Renamed', move: 'Moved', copy: 'Copied', trash: 'Put in Trash' }
const UNDO_LABEL: Record<Asked['verb'], string> = { make: 'Delete it', rename: 'Rename it back', move: 'Move it back', copy: 'Delete the copy', trash: 'Put it back' }

/** The thing each ref names now, as its place lists it; a name that finds nothing is refused in words. */
async function statAll(ctx: ToolCtx, host: string, workspaceId: string, refs: readonly FileRef[], words: readonly string[]): Promise<FileEntry[]> {
  const got = await ask<{ entries: (FileEntry | null)[] }>(ctx, host, 'stat', { workspaceId, refs })
  return got.entries.map((e, i) => {
    if (!e) throw new Error(`${words[i] || 'That'} is not there, or this thread may not reach it.`)
    return e
  })
}

/** A change through the door: run now in his own place with its Undo, or held as a `file.act` where others can open it. */
async function change(ctx: ToolCtx, workspaceId: string, a: Asked): Promise<WorkToolResult> {
  const { host, place } = a.named
  const me = threadOf(ctx.sessionId)
  const things = await statAll(ctx, host, workspaceId, a.request.refs, a.paths)
  const method = `work.files.${a.verb}`
  let verdict: 'run' | 'hold'
  if (host === ctx.host && isDrive(place)) {
    // Drive says now whether others can open each thing, and the folder it would land in.
    verdict = (await admitDrive(ctx, me, a.verb as FileVerb, { workspaceId, refs: [...a.request.refs], to: a.request.to, name: a.request.name }, method)).verdict
  } else if (host === ctx.host) {
    verdict = admitChange(ctx, me, a.verb as FileVerb, { workspaceId, refs: [...a.request.refs], to: a.request.to, name: a.request.name }, method)
  } else {
    // Everything a peer reaches is a library others can open: the grammar decides what may be asked, and the rest waits for his press.
    for (const e of things) {
      const no = refusal(place, a.verb as FileVerb, { name: e.name, kind: e.kind, shared: true }, a.into?.named.place ?? null)
      if (no) throw new Error(no.text)
    }
    verdict = 'hold'
  }
  if (verdict === 'hold') {
    return await hold(ctx, workspaceId, a, things)
  }
  const op = `tool:${randomUUID()}`
  const done = await runHere(ctx, me, workspaceId, a, op, method)
  ctx.db.prepare(`UPDATE work_files_ops SET session_id = ? WHERE id = ?`).run(ctx.sessionId, op)
  if (a.verb === 'make') markMade(ctx, workspaceId, ctx.sessionId, done.entries)
  const what = done.entries.map((e) => (pathOf(e) !== null ? wordsIn(place.id === a.into?.named.place.id || !a.into ? place : a.into.named.place, pathOf(e)!) : [a.into ? a.into.words : a.verb === 'make' ? a.paths[0] : dirOfWords(a.paths[0] ?? ''), e.name].filter(Boolean).join('/')))
  const left = done.refused.map((r) => `${r.name}: ${r.text}`)
  if (!done.entries.length && !done.trashed?.length) return fail(left.join('\n') || 'Nothing was done.')
  const shown = a.verb === 'trash' ? things.map((t) => t.name) : what
  const summary = `${PAST[a.verb]} ${names(shown)}${a.into ? ` in ${whereWords(whereOf(a.into.named.place, a.into.words), a.into.named.place.group)}` : ` in ${place.name}`}`
  ctx.results.add({ sessionId: ctx.sessionId, kind: `file.${a.verb}`, summary, undo: { pillar: 'files', verb: 'files_undo', args: { op }, label: UNDO_LABEL[a.verb] } })
  return {
    ...workText([`${summary}.`, ...(left.length ? [`Not done: ${left.join('; ')}`] : []), `Undo: files_undo with {"op": "${op}"}. The owner can undo it from Results too.`].join('\n')),
    structuredContent: { done: what, refused: done.refused, undo: { op } }
  }
}

/** The verb itself, as this thread, in his own place on this host. */
async function runHere(ctx: ToolCtx, me: Caller, workspaceId: string, a: Asked, op: string, method: string): Promise<FileDone> {
  const r = a.request
  if (isDrive(a.named.place)) {
    if (a.verb === 'make') return driveMake(ctx, me, { workspaceId, op, at: r.refs[0] as FolderRef, kind: r.kind!, ...(r.name ? { name: r.name } : {}) }, method)
    if (a.verb === 'rename') return driveRename(ctx, me, { workspaceId, op, ref: r.refs[0]!, name: r.name! }, method)
    if (a.verb === 'move') return driveMove(ctx, me, { workspaceId, op, refs: [...r.refs], to: r.to! }, method)
    if (a.verb === 'trash') {
      const workspace = workspaceHere(ctx.db, workspaceId)
      if (!workspace) throw new Error('No such Work workspace on this host.')
      return driveTrash(ctx, me, workspace, [...r.refs], op)
    }
    throw new Error('Nothing can be copied in a Google Drive from here.')
  }
  if (a.verb === 'make') return makeVerb(ctx, me, { workspaceId, op, at: r.refs[0] as FolderRef, kind: r.kind!, ...(r.name ? { name: r.name } : {}) }, method)
  if (a.verb === 'rename') return renameVerb(ctx, me, { workspaceId, op, ref: r.refs[0]!, name: r.name! }, method)
  if (a.verb === 'move') return moveVerb(ctx, me, { workspaceId, op, refs: [...r.refs], to: r.to! }, method)
  if (a.verb === 'copy') return copyVerb(ctx, me, { workspaceId, op, refs: [...r.refs], to: r.to! }, method)
  return trashFiles(ctx, me, workspaceId, [...r.refs], op)
}

/** A change others will see: held for his press, bound to each thing as it is now. */
async function hold(ctx: ToolCtx, workspaceId: string, a: Asked, things: FileEntry[]): Promise<WorkToolResult> {
  const { host, place } = a.named
  const verb = a.verb
  // The card says where the things are now as one folder: things from several folders are held one folder at a time.
  if (new Set(a.paths.map(dirOfWords)).size > 1) return fail('Those are in different folders: move or copy the files of one folder at a time.')
  if (verb === 'copy' || verb === 'move') {
    const taken = await takenIn(ctx, host, workspaceId, a.request.to, things.map((t) => t.name))
    if (taken) return fail(`${a.into?.words || 'That folder'} already holds something named ${taken}: rename one first.`)
  }
  if (verb === 'make' && a.request.name) {
    const taken = await takenIn(ctx, host, workspaceId, a.request.refs[0] as FileRef, [a.request.name])
    if (taken) return fail(`${a.paths[0] || place.name} already holds something named ${taken}: give it another name.`)
  }
  const parents = await parentsOf(ctx, host, workspaceId, a.request.to)
  const at = a.into?.named.place ?? place
  const payload: FileAct = {
    workspaceId,
    host,
    verb,
    op: `act:${randomUUID()}`,
    request: { ...a.request, refs: [...a.request.refs] },
    digest: changeDigest({ workspaceId, verb, refs: a.request.refs, to: a.request.to, name: a.request.name, kind: a.request.kind }),
    things: things.map((e) => ({ key: e.key, name: e.name, version: versionOfEntry(e), shared: !!e.shared })),
    from: whereOf(place, verb === 'make' ? (a.paths[0] ?? '') : dirOfWords(a.paths[0] ?? '')),
    ...(a.into ? { into: { ...whereOf(a.into.named.place, a.into.words), key: a.into.entry.key, shared: !!a.into.entry.shared, ...(parents ? { parents } : {}) } } : {}),
    audience: audienceOf(at, true)
  }
  // A channel is said with its team: "Esports Staff, Events".
  if (place.group && place.group !== place.name) payload.from = { ...payload.from, name: `${place.group}, ${place.name}` }
  if (payload.into && at.group && at.group !== at.name) payload.into = { ...payload.into, name: `${at.group}, ${at.name}` }
  const held = ctx.held.create({ kind: 'file.act', sessionId: ctx.sessionId, payload }) as { n?: number | null; summary: string; ref: { id: string } }
  return {
    ...workText(heldChange(held, 'Nothing in the place changed.')),
    structuredContent: { held: held.n ?? held.ref.id }
  }
}
const dirOfWords = (words: string): string => words.split('/').slice(0, -1).join('/')

// ── undo ──────────────────────────────────────────────────────────────

const UNDO_GONE = 'That change is not one this thread can undo: it is unknown here, or older than a week.'
const UNDO_STALE = (name: string): string => `${name} changed since, so it was left as it is.`
/** The door answered `hold`: the place became one others can open since the change, so an Undo would change it for them. */
const UNDO_SHARED = 'Others can open it now, so the owner changes it back himself.'

/** The inverse of a change a `files_*` tool ran in his own place, refused for any file that is no longer the one the change left. */
async function undo(ctx: ToolCtx, workspaceId: string, op: string): Promise<WorkToolResult> {
  if (!op.startsWith('tool:')) return fail(UNDO_GONE)
  // A thread undoes its own change alone: another thread's op is as unknown to it as one never made.
  const row = ctx.db.prepare(`SELECT verb, refs, state, result FROM work_files_ops WHERE id = ? AND workspace_id = ? AND session_id = ?`).get(op, workspaceId, ctx.sessionId) as { verb: string; refs: string; state: string; result: string | null } | undefined
  if (!row || row.state !== 'done' || !row.result) return fail(UNDO_GONE)
  const done = JSON.parse(row.result) as FileDone
  const asked = JSON.parse(row.refs) as { ref?: FileRef; refs?: FileRef[] }
  const me = threadOf(ctx.sessionId)
  const back = `tool:${randomUUID()}`
  if (row.verb === 'trash') {
    const workspace = workspaceHere(ctx.db, workspaceId)
    if (!workspace || !done.trashed?.length) return fail(UNDO_GONE)
    const put = await restoreRows(ctx, me, workspace, done.trashed, back)
    return answerOf('Put back', put)
  }
  if (done.entries.some(inDrive)) return undoDrive(ctx, workspaceId, row.verb, done, back)
  // Each thing the change left must still be as it left it.
  const left = done.entries.filter((e) => pathOf(e) !== null)
  const now = await ask<{ entries: (FileEntry | null)[] }>(ctx, ctx.host, 'stat', { workspaceId, refs: left.map(refOfEntry) })
  const stale = left.filter((e, i) => !now.entries[i] || now.entries[i]!.key !== e.key || (e.kind !== 'folder' && versionOfEntry(now.entries[i]!) !== versionOfEntry(e)))
  if (stale.length) return fail(stale.map((e) => UNDO_STALE(e.name)).join(' '))
  const method = 'work.files.undo'
  if (row.verb === 'make' || row.verb === 'copy') {
    const refs = left.map(refOfEntry)
    if (admitChange(ctx, me, 'trash', { workspaceId, refs }, method) === 'hold') return fail(UNDO_SHARED)
    return answerOf('Put in Trash', await trashFiles(ctx, me, workspaceId, refs, back), left.map((e) => e.name))
  }
  if (row.verb === 'rename') {
    const was = asked.ref ? canvasSourcePath(asked.ref as CanvasSource) ?? (asked.ref as { path?: string }).path : null
    if (!was || !left[0]) return fail(UNDO_GONE)
    if (admitChange(ctx, me, 'rename', { workspaceId, refs: [refOfEntry(left[0])], name: basename(was) }, method) === 'hold') return fail(UNDO_SHARED)
    return answerOf('Renamed back', await renameVerb(ctx, me, { workspaceId, op: back, ref: refOfEntry(left[0]), name: basename(was) }, method))
  }
  if (row.verb === 'move') {
    // Each thing back to the folder it came from, by its name.
    const from = new Map((asked.refs ?? []).map((r) => [basename((r as { path: string }).path), dirname((r as { path: string }).path)]))
    const out: FileDone = { entries: [], refused: [], op: back }
    for (const e of left) {
      const dir = from.get(e.name)
      if (!dir) {
        out.refused.push({ name: e.name, text: UNDO_GONE })
        continue
      }
      const to: FolderRef = { at: 'file', host: ctx.host, path: dir }
      // Others can open it, or the folder it went back to, now: the owner changes it back himself.
      if (admitChange(ctx, me, 'move', { workspaceId, refs: [refOfEntry(e)], to }, method) === 'hold') {
        out.refused.push({ name: e.name, text: UNDO_SHARED })
        continue
      }
      const got = await moveVerb(ctx, me, { workspaceId, op: `${back}:${out.entries.length + out.refused.length}`, refs: [refOfEntry(e)], to }, method)
      out.entries.push(...got.entries)
      out.refused.push(...got.refused)
    }
    return answerOf('Moved back', out)
  }
  return fail(UNDO_GONE)
}

/** What an undo did. A delete answers Trash rows, not entries: `trashed` names what it put there. */
function answerOf(past: string, done: FileDone, trashed: readonly string[] = []): WorkToolResult {
  const left = done.refused.map((r) => `${r.name}: ${r.text}`)
  const gone = new Set(left.map((l) => l.slice(0, l.indexOf(':'))))
  const shown = done.entries.length ? done.entries.map((e) => e.name) : done.trashed?.length ? trashed.filter((n) => !gone.has(n)) : []
  if (!shown.length) return fail(left.join(' ') || 'Nothing was undone.')
  return workText(`${past}: ${shown.join(', ')}.${left.length ? ` Not done: ${left.join('; ')}` : ''}`)
}

const inDrive = (e: Pick<FileEntry, 'ref' | 'folder'>): boolean => e.ref?.at === 'google' || e.folder?.at === 'drive'

/**
 * The inverse of a change a tool ran in a Google Drive of his: a made thing to Drive's bin through Trash, a rename
 * back to the name it had, a move back to the folder it came from (`before`, which Drive's ids need in place of a
 * path). Each thing must still be as the change left it, and the way back passes the door again: one others can open
 * by now is refused, not held.
 */
async function undoDrive(ctx: ToolCtx, workspaceId: string, verb: string, done: DriveDone, back: string): Promise<WorkToolResult> {
  const me = threadOf(ctx.sessionId)
  const method = 'work.files.undo'
  const left = done.entries.filter(inDrive)
  const refs = left.map(refOfEntry)
  const now = await ask<{ entries: (FileEntry | null)[] }>(ctx, ctx.host, 'stat', { workspaceId, refs })
  const stale = left.filter((e, i) => !now.entries[i] || now.entries[i]!.key !== e.key || now.entries[i]!.name !== e.name || (e.kind !== 'folder' && versionOfEntry(now.entries[i]!) !== versionOfEntry(e)))
  if (stale.length) return fail(stale.map((e) => UNDO_STALE(e.name)).join(' '))
  const ownOnly = async (v: FileVerb, p: { refs: FileRef[]; to?: FolderRef; name?: string }): Promise<void> => {
    if ((await admitDrive(ctx, me, v, { workspaceId, ...p }, method)).verdict === 'hold') throw new Error(UNDO_SHARED)
  }
  if (verb === 'make' || verb === 'copy') {
    const workspace = workspaceHere(ctx.db, workspaceId)
    if (!workspace) return fail(UNDO_GONE)
    await ownOnly('trash', { refs })
    return answerOf('Put in Trash', await driveTrash(ctx, me, workspace, refs, back), left.map((e) => e.name))
  }
  if (verb === 'rename') {
    const was = done.before?.find((b) => b.key === left[0]?.key)
    if (!was) return fail(UNDO_GONE)
    await ownOnly('rename', { refs: [refs[0]!], name: was.name })
    return answerOf('Renamed back', await driveRename(ctx, me, { workspaceId, op: back, ref: refs[0]!, name: was.name }, method))
  }
  if (verb === 'move') {
    const out: FileDone = { entries: [], refused: [], op: back }
    for (const [i, e] of left.entries()) {
      const was = done.before?.find((b) => b.key === e.key)
      // A thing that was in that folder already did not move.
      if (!was) continue
      const account = (e.ref?.at === 'google' ? e.ref.account : (e.folder as { account: string }).account)!
      // Back to the folder it came from; one TempCode cannot see (My Drive's own top among them) is the place's top.
      const parent = was.parents[0] && (await driveFacts(ctx, account, was.parents[0])) ? was.parents[0] : 'root'
      const to: FolderRef = { at: 'drive', account, folderId: parent }
      try {
        await ownOnly('move', { refs: [refs[i]!], to })
        const got = await driveMove(ctx, me, { workspaceId, op: `${back}:${i}`, refs: [refs[i]!], to }, method)
        out.entries.push(...got.entries)
        out.refused.push(...got.refused)
      } catch (err) {
        out.refused.push({ name: e.name, text: errorText(err) })
      }
    }
    return answerOf('Moved back', out)
  }
  return fail(UNDO_GONE)
}

// ── search, until the pillar's own search lands (F4) ──────────────────

const SEARCH_FOLDERS = 300
const SEARCH_HITS = 50

/**
 * What this host's own search finds for a thread (`work.files.search`, search.ts: the names table, the workspace's
 * folder and the libraries on this disk, each with its deadline; a sleeping VM is never woken), each hit with the
 * place it lives in. `only`: one place of this host.
 */
async function searchHere(ctx: ToolCtx, workspaceId: string, query: string, places: Named[], only?: Named): Promise<{ named: Named; entry: FileEntry }[]> {
  const page = await ask<FilesListing>(ctx, ctx.host, 'search', { workspaceId, query, ...(only ? { filter: { places: [only.place.id] } } : {}) })
  const byId = new Map(places.map((named) => [named.place.id, named]))
  return page.entries.flatMap((entry) => {
    const named = only ?? (entry.where ? byId.get(entry.where.place) : undefined)
    return named ? [{ named, entry }] : []
  }).slice(0, SEARCH_HITS)
}

/** Names that hold every word of the query, walked folder by folder from a place's top: for a place on another computer or in the Windows VM, which this host's search does not reach. */
async function searchByName(ctx: ToolCtx, workspaceId: string, query: string, within: Named[]): Promise<{ named: Named; entry: FileEntry }[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hits: { named: Named; entry: FileEntry }[] = []
  let folders = 0
  for (const named of within) {
    const queue: FolderRef[] = [named.place.root]
    while (queue.length && folders < SEARCH_FOLDERS && hits.length < SEARCH_HITS) {
      const at = queue.shift()!
      folders++
      let cursor: string | undefined
      do {
        if (ctx.signal.aborted) throw new Error('cancelled')
        const page = await ask<FilesListing>(ctx, named.host, 'list', { workspaceId, at, ...(cursor ? { cursor } : {}) })
        for (const e of page.entries) {
          if (e.kind === 'folder' && e.folder) queue.push(e.folder)
          const name = e.name.toLowerCase()
          if (terms.every((t) => name.includes(t)) && hits.length < SEARCH_HITS) hits.push({ named, entry: e })
        }
        cursor = page.next
      } while (cursor && hits.length < SEARCH_HITS)
    }
  }
  return hits
}

// ── the tools ─────────────────────────────────────────────────────────

const Place = z.string().min(1).max(200).describe('A place, by the id or the name files_places answers.')
const Host = z.string().max(200).optional().describe('The host files_places names, only when two computers have a place of that name.')
const PathIn = z.string().max(4096).describe('A path inside the place, with forward slashes (Events/Poster.png); empty for its top.')

/** The thread's workspace, or the refusal for a Work Chat. */
const workspaceOf = (ctx: ToolCtx): string => {
  if (!ctx.scope.workspaceId) throw new Error(NO_PLACE_IN_CHAT)
  return ctx.scope.workspaceId
}

/** A folder the thread named, located for it: a move, copy or New lands there. */
async function folderNamed(ctx: ToolCtx, workspaceId: string, place: string, path: string, host?: string): Promise<{ named: Named; entry: FileEntry; ref: FolderRef; words: string }> {
  const named = await placeNamed(ctx, workspaceId, place, host)
  const ref = (await refOf(ctx, workspaceId, named, path)) as FolderRef
  const [entry] = await statAll(ctx, named.host, workspaceId, [ref], [path || named.place.name])
  if (entry!.kind !== 'folder') throw new Error(`${path} is a file, not a folder.`)
  const words = path.split(/[\\/]+/).filter(Boolean).join('/')
  return { named, entry: entry!, ref, words }
}
const wordsOf = (path: string): string => path.split(/[\\/]+/).filter(Boolean).join('/')

const tool = <S extends z.ZodRawShape>(t: { name: string; description: string; input: S; readOnly: boolean; run(a: z.infer<z.ZodObject<S>>, ctx: ToolCtx, workspaceId: string): Promise<WorkToolResult> }): WorkTool => ({
  name: t.name,
  description: t.description,
  input: z.object(t.input),
  readOnly: t.readOnly,
  run: async (args, ctx) => {
    try {
      return await t.run(args as z.infer<z.ZodObject<S>>, ctx, workspaceOf(ctx))
    } catch (err) {
      return fail(errorText(err))
    }
  }
})

const HELD_RULE = 'In a place others can open (a Teams channel, OneDrive, a shared Google Drive file or folder) the change is held for the owner\'s press, bound to the file as it is now; in his own places it runs at once and can be undone.'
/** Who can open what is in a Google Drive, as files_places says it: each thing by its own sharing. */
const DRIVE_WHO = 'Each file by its own sharing in Google Drive: a change to one others can open waits for the owner.'

export const filesTools: WorkTool[] = [
  tool({
    name: 'files_places',
    description: "Lists the places this workspace's files live in, on this computer and on each computer the workspace may use: its own folder, Teams and OneDrive libraries, and a Google Drive per Google account of the workspace (only the files TempCode made or the owner picked). Each has an id the other files_* tools take, and says who else can open what is in it.",
    input: {},
    readOnly: true,
    run: async (_a, ctx, workspaceId) => {
      const { named, failed } = await allPlaces(ctx, workspaceId)
      const rows = named.map(({ host, place }) => ({
        place: place.id,
        name: place.group && place.group !== place.name ? `${place.group}, ${place.name}` : place.name,
        ...(host !== ctx.host ? { host } : {}),
        who: place.kind === 'drive' ? DRIVE_WHO : place.shared ? audienceOf(place, true) : 'Only the owner and his threads.',
        ...(place.state.state !== 'ok' ? { state: place.state.state } : {})
      }))
      return { ...workText(JSON.stringify({ places: rows, ...(failed.length ? { failed } : {}) }, null, 1)), structuredContent: { places: rows } }
    }
  }),
  tool({
    name: 'files_list',
    description: 'Lists one folder of a place: its folders first, then its files, 500 a page (pass `cursor` for the next). A file is named by its path inside the place.',
    input: { place: Place, path: PathIn.default(''), host: Host, cursor: z.string().max(2000).optional() },
    readOnly: true,
    run: async (a, ctx, workspaceId) => {
      const named = await placeNamed(ctx, workspaceId, a.place, a.host)
      const page = await ask<FilesListing>(ctx, named.host, 'list', { workspaceId, at: a.path ? await refOf(ctx, workspaceId, named, a.path) : named.place.root, ...(a.cursor ? { cursor: a.cursor } : {}) })
      if (page.stale) return fail('The folder changed while it was read: list it again from the start.')
      const entries = page.entries.map((e) => line(named.place, e, wordsOf(a.path)))
      return { ...workText(JSON.stringify({ entries, ...(page.next ? { cursor: page.next } : {}) }, null, 1)), structuredContent: { entries } }
    }
  }),
  tool({
    name: 'files_search',
    description: "Finds files and folders by name (every word of `query` in the name, any case), and by the words in the small text files of the workspace's folder, in this computer's places, or in one place. 50 at most.",
    input: { query: z.string().min(1).max(200), place: Place.optional(), host: Host },
    readOnly: true,
    run: async (a, ctx, workspaceId) => {
      // This host's places are searched as his window's search is. A place in the Windows VM or on another computer is
      // walked, and only when named: each folder there is a call that may wake a machine.
      const one = a.place ? await placeNamed(ctx, workspaceId, a.place, a.host) : null
      const far = one && (one.host !== ctx.host || one.place.vm)
      const hits = far ? await searchByName(ctx, workspaceId, a.query, [one]) : await searchHere(ctx, workspaceId, a.query, (await allPlaces(ctx, workspaceId, ctx.host)).named, one ?? undefined)
      const found = hits.map((h) => ({ place: h.named.place.id, ...(h.named.host !== ctx.host ? { host: h.named.host } : {}), ...line(h.named.place, h.entry) }))
      return { ...workText(found.length ? JSON.stringify({ found }, null, 1) : `Nothing named like "${a.query}".`), structuredContent: { found } }
    }
  }),
  tool({
    name: 'files_open',
    description: "Opens a file beside this thread, in its canvas, as canvas_open does: by `place` and `path`, or by `name` alone (it is found by name first; when several match, they are listed to choose from).",
    input: { place: Place.optional(), path: PathIn.optional(), name: z.string().min(1).max(500).optional(), host: Host },
    readOnly: false,
    run: async (a, ctx, workspaceId) => {
      let named: Named
      let path: string
      if (a.place && a.path) {
        named = await placeNamed(ctx, workspaceId, a.place, a.host)
        path = a.path
      } else if (a.name) {
        const hits = (await searchHere(ctx, workspaceId, a.name, (await allPlaces(ctx, workspaceId, ctx.host)).named)).filter((h) => h.entry.kind !== 'folder')
        const exact = hits.filter((h) => h.entry.name.toLowerCase() === a.name!.trim().toLowerCase())
        const pick = exact.length === 1 ? exact : hits
        if (!pick.length) return fail(`No file named like "${a.name}": list a place with files_list.`)
        if (pick.length > 1) return fail(`Several files match; open one by place and path:\n${JSON.stringify(pick.slice(0, 20).map((h) => ({ place: h.named.place.id, file: wordsIn(h.named.place, pathOf(h.entry)!) })), null, 1)}`)
        named = pick[0]!.named
        path = wordsIn(named.place, pathOf(pick[0]!.entry)!)
      } else {
        return fail('Name the file by `place` and `path`, or by `name`.')
      }
      if (named.host !== ctx.host) return fail(OPEN_FAR(named.host))
      if (isDrive(named.place)) {
        const google = await refOf(ctx, workspaceId, named, path)
        if (google.at !== 'google') return fail('That is a folder: list it with files_list.')
        locate(ctx, threadOf(ctx.sessionId), workspaceId, google, 'work.files.open')
        const seat = await googleSeatOf(ctx, google.account, google.fileId)
        const item = ctx.canvas.open(ctx.canvas.paneOf(ctx.sessionId), seat.kind, seat.source, seat.name)
        googleSeated(ctx, seat, item.id)
        return { ...workText(`Opened ${item.title} (${item.id}) beside this thread. Read and change it with the google_* tools.`), structuredContent: { item: { id: item.id, kind: item.kind, title: item.title } } }
      }
      const ref = refIn(named.place, path)
      const at = locate(ctx, threadOf(ctx.sessionId), workspaceId, ref, 'work.files.open')
      if (at.in === 'place' || at.in === 'drive') return fail('A place is listed, not opened.')
      const name = at.path.slice(Math.max(at.path.lastIndexOf('/'), at.path.lastIndexOf('\\')) + 1)
      const made = openAs(ctx, at, name)
      const item = ctx.canvas.open(ctx.canvas.paneOf(ctx.sessionId), made.kind, made.source, name)
      return { ...workText(`Opened ${item.title} (${item.id}) beside this thread.`), structuredContent: { item: { id: item.id, kind: item.kind, title: item.title } } }
    }
  }),
  tool({
    name: 'files_make',
    description: `Makes a new ${FILE_MAKE_KINDS.join(', ')} in a folder of a place, in the form that place keeps (a .tcdoc in the workspace's folder, a .docx in Teams), named for its kind unless you name it. ${HELD_RULE} Its row is marked as made by this thread until the owner opens it.`,
    input: { place: Place, path: PathIn.default(''), kind: z.enum(FILE_MAKE_KINDS), name: z.string().min(1).max(200).optional(), host: Host },
    readOnly: false,
    run: async (a, ctx, workspaceId) => {
      const into = await folderNamed(ctx, workspaceId, a.place, a.path, a.host)
      // A held make shows the name it will take; one that runs now takes the next free name there.
      const name = a.name?.trim() || undefined
      return change(ctx, workspaceId, { verb: 'make', named: into.named, paths: [into.words], request: { refs: [into.ref], kind: a.kind as FileMakeKind, ...(name ? { name: withForm(into.named.place, a.kind as FileMakeKind, name) } : {}) } })
    }
  }),
  tool({
    name: 'files_move',
    description: `Moves files or folders into a folder, or renames one (give \`name\` and leave \`to\` out). A move between places is a copy, a check, then the source to Trash. ${HELD_RULE}`,
    input: {
      place: Place,
      paths: z.array(PathIn.min(1)).min(1).max(100).describe('What to move, each a path inside `place`.'),
      to: z.object({ place: Place, path: PathIn.default('') }).optional().describe('The folder to move them into.'),
      name: z.string().min(1).max(500).optional().describe('A new name, for a rename of one thing in its own folder.'),
      host: Host
    },
    readOnly: false,
    run: async (a, ctx, workspaceId) => {
      const named = await placeNamed(ctx, workspaceId, a.place, a.host)
      const refs = await Promise.all(a.paths.map((p) => refOf(ctx, workspaceId, named, p)))
      const paths = a.paths.map(wordsOf)
      if (a.name && !a.to) {
        if (refs.length !== 1) return fail('A rename names one thing.')
        return change(ctx, workspaceId, { verb: 'rename', named, paths, request: { refs, name: a.name } })
      }
      if (!a.to) return fail('Say where they go (`to`), or give a `name` to rename one.')
      if (a.name) return fail('A move keeps each name; rename it before or after.')
      const into = await folderNamed(ctx, workspaceId, a.to.place, a.to.path, a.host ?? (named.host !== ctx.host ? named.host : undefined))
      return change(ctx, workspaceId, { verb: 'move', named, paths, request: { refs, to: into.ref }, into })
    }
  }),
  tool({
    name: 'files_copy',
    description: `Copies files or folders into a folder; a name already there gets the next free one ("notes 2.txt"). ${HELD_RULE}`,
    input: { place: Place, paths: z.array(PathIn.min(1)).min(1).max(100), to: z.object({ place: Place, path: PathIn.default('') }), host: Host },
    readOnly: false,
    run: async (a, ctx, workspaceId) => {
      const named = await placeNamed(ctx, workspaceId, a.place, a.host)
      const into = await folderNamed(ctx, workspaceId, a.to.place, a.to.path, a.host ?? (named.host !== ctx.host ? named.host : undefined))
      return change(ctx, workspaceId, { verb: 'copy', named, paths: a.paths.map(wordsOf), request: { refs: await Promise.all(a.paths.map((p) => refOf(ctx, workspaceId, named, p))), to: into.ref }, into })
    }
  }),
  tool({
    name: 'files_trash',
    description: "Deletes files or folders. In the workspace's own folder they go to Trash at once, where the owner can put them back for 30 days. In a place others can open (Teams, OneDrive) nothing is deleted: the delete is held for the owner's press, which sends them to that computer's own bin.",
    input: { place: Place, paths: z.array(PathIn.min(1)).min(1).max(100), host: Host },
    readOnly: false,
    run: async (a, ctx, workspaceId) => {
      const named = await placeNamed(ctx, workspaceId, a.place, a.host)
      return change(ctx, workspaceId, { verb: 'trash', named, paths: a.paths.map(wordsOf), request: { refs: await Promise.all(a.paths.map((p) => refOf(ctx, workspaceId, named, p))) } })
    }
  }),
  tool({
    name: 'files_undo',
    description: "Undoes a change a files_* tool made in the owner's own place, by the `op` its answer named: a move goes back, a rename back, a made file or copy to Trash, a file put in Trash back. A file that changed since is left as it is.",
    input: { op: z.string().min(8).max(100) },
    readOnly: false,
    run: (a, ctx, workspaceId) => undo(ctx, workspaceId, a.op)
  })
]

/** A name as New would make it in that place: the form's extension added when it is missing, so a held act names the file it will make. */
function withForm(place: FilePlace, kind: FileMakeKind, name: string): string {
  const form = formIn(place, kind)
  return form && !name.toLowerCase().endsWith(`.${form}`) ? `${name}.${form}` : name
}

/** The Work preamble's line on files (`WorkModule.preamble`): only a thread of a workspace has places. */
export function filesPreamble(scope: Pick<WorkScope, 'workspaceId'>): string | null {
  if (!scope.workspaceId) return null
  return "Change the workspace's files with the files_* tools. A change to a file others can open (a Teams channel, OneDrive, a shared Google Drive file) is held for the owner's press, never written at once; do not reach such a file another way."
}

