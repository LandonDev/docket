import { createHash } from 'node:crypto'
import { lstatSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { projectOrder } from 'work-kit/projects/order'
import type { FileCrumb, FileDone, FileRef, FilesListing } from '@shared/contract-work-files'
import { filesPaneOf, type CanvasKind, type CanvasSource } from '@shared/work'
import { matchesName } from '@shared/work/fileSearch'
import { freeName, kindOfEntry, PLACE, refKey, sortEntries, threadCanvasOf, UNTITLED, type FileEntry, type FilePlace, type FileSort, type FileVerb, type FolderRef } from '@shared/work/files'
import { lifeosCatalog, type CatalogRow } from '../../docs/find'
import { ensureFetched, fetchedPath } from '../../canvas/fetch'
import { GuestStore, isLive } from '../../guests/store'
import { guestRuntime } from '../../guests'
import type { Caller, WorkCtx } from '../../modules'
import { host as sheetHost } from '../../sheets/held'
import { admitWrite, locateLifeos, type DoorPlace, type WorkspaceRow } from '../policy'
import { makeFile, runOp } from '../write'

/**
 * LifeOS as a place of Files, the From mail lens and a project's lens (docs/agents/work-files.md "LifeOS, From
 * mail and Projects"). Nothing here keeps a byte of a document: rows are read from LifeOS's catalog through the
 * host's own session (`ctx.lifeos.owner()`), a short while at a time, and every change is a LifeOS mutation
 * that passes the one door first (`admitWrite`).
 *
 * - The LifeOS place (`PLACE.lifeos`) holds the sector's active projects as folders (`{ at: 'project', id }`),
 *   then the documents and sheets in no active project. A project's folder holds its LifeOS rows and the files
 *   linked to it (`projectItems`). The same folder is the project's own lens (`project:<id>`).
 * - From mail (`PLACE.mail`) lists the files of the sector's mail of the last 30 days he has not kept
 *   (`mail:attachments`); each opens as the Mail view's `{ at: 'mail' }` item, and Keep copies one into the
 *   workspace's folder.
 * - Down (no LifeOS session here): the places are listed, greyed with one sentence, and Files stays up.
 */

export const LIFEOS_DOWN = 'LifeOS is not signed in on this host.'
export const NOT_IN_SECTOR = "That is not in this workspace's part of LifeOS."
export const GONE = 'That is not in LifeOS any more.'
export const PROJECT_IN_PROJECTS = 'A project is made in Projects.'
export const ONLY_LIFEOS_KINDS = 'LifeOS holds documents and sheets. Make anything else in your workspace\'s folder.'
export const NO_PROJECT = 'LifeOS has no such project in this workspace.'
export const MAIL_KEPT_INTO = "A mail's file is kept in your workspace's folder."
export const MAIL_NO_VIEWER = 'This file has no viewer here. Keep it first, then open it.'

/** The project states the Projects column lists: a project's lens is shown while it is one of these. */
const LISTED = new Set(['backlog', 'active', 'paused'])
/** How far back From mail looks. */
export const MAIL_DAYS = 30
/** Mail parts read for From mail at most: pages of LifeOS's answer, and the rows they give. */
const MAIL_PAGES = 8
const MAIL_MOST = 400
/** How long what LifeOS answered is kept, and how long a first answer is waited for before Files answers without it. */
const FRESH_MS = 30_000
const FIRST_WAIT_MS = 1_500
/** The kinds a mail's file opens as beside a mail (the renderer's `FETCHED_KINDS`, work/canvas/fetched.ts). */
const MAIL_KINDS: readonly CanvasKind[] = ['pdf', 'sheet', 'media', 'slides', 'document', 'meeting']

export interface LifeosProject {
  _id: string
  name: string
  status: string
  _creationTime?: number
}

/** One file of a mail, as `mail:attachments` answers it. */
export interface MailPart {
  threadId: string
  messageId: string
  partId: string
  name: string
  contentType: string
  size: number
  sentAt: number
  from: string
  subject: string
}

type MailSource = Extract<CanvasSource, { at: 'mail' }>
type LifeosTable = 'docs' | 'sheets'

// ── what LifeOS answered, kept a short while ────────────────────────────

interface Kept<T> {
  at: number
  value?: T
  reading?: Promise<T>
}
const kept = new WeakMap<object, Map<string, Kept<unknown>>>()

/**
 * What `read` answers, kept `FRESH_MS`: a fresh value at once; a stale one at once, read again behind it
 * (`onChange` hears a new answer); none yet, waited for `wait` ms at most, then null. A failed read keeps what
 * was there.
 */
async function keptRead<T>(ctx: Pick<WorkCtx, 'db' | 'log'>, key: string, read: () => Promise<T>, o: { wait?: number; refresh?: boolean; onChange?: () => void } = {}): Promise<T | null> {
  const cache = kept.get(ctx.db) ?? kept.set(ctx.db, new Map()).get(ctx.db)!
  const slot = (cache.get(key) ?? cache.set(key, { at: 0 }).get(key)!) as Kept<T>
  const start = (): Promise<T> => {
    if (slot.reading) return slot.reading
    const had = slot.value
    const reading = read().then(
      (value) => {
        slot.value = value
        slot.at = Date.now()
        slot.reading = undefined
        if (had !== undefined && o.onChange && JSON.stringify(had) !== JSON.stringify(value)) o.onChange()
        return value
      },
      (err: unknown) => {
        slot.reading = undefined
        ctx.log(`files: LifeOS did not answer ${key.split('|')[0]}: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }
    )
    slot.reading = reading
    return reading
  }
  if (slot.value !== undefined && !o.refresh) {
    if (Date.now() - slot.at > FRESH_MS) start().catch(() => undefined)
    return slot.value
  }
  const wait = o.wait ?? Infinity
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      start(),
      new Promise<T | null>((done) => {
        if (wait === Infinity) return
        timer = setTimeout(() => done(slot.value ?? null), wait)
        timer.unref?.()
      })
    ])
  } catch {
    return slot.value ?? null
  } finally {
    clearTimeout(timer)
  }
}

/** Forgets what was kept for a sector: a change Files made is read again at once. */
export function forgetLifeos(ctx: WorkCtx, sector?: string): void {
  // The docs finder's catalog is read again on its next use too (a fresh read replaces what it kept).
  if (sector) void lifeosCatalog(ctx, sector, true).catch(() => undefined)
  const cache = kept.get(ctx.db)
  if (!cache) return
  for (const key of [...cache.keys()]) if (!sector || key.endsWith(`|${sector}`)) cache.delete(key)
}

const q = <T>(ctx: Pick<WorkCtx, 'lifeos'>, fn: string, args: Record<string, unknown>): Promise<T> => ctx.lifeos.owner().query<T>(fn, args)
const m = <T>(ctx: Pick<WorkCtx, 'lifeos'>, fn: string, args: Record<string, unknown>): Promise<T> => ctx.lifeos.owner().mutation<T>(fn, args)

/** The sector's projects, every state. */
const projectsOf = (ctx: WorkCtx, sector: string, o: { wait?: number; refresh?: boolean } = {}) =>
  keptRead(ctx, `projects|${sector}`, () => q<LifeosProject[]>(ctx, 'projects:list', { sector }), { ...o, onChange: () => pushPlaces(ctx, sector) })

/** The projects the Projects column lists, oldest first, as it orders them. */
export const listedProjects = (rows: readonly LifeosProject[]): LifeosProject[] =>
  rows
    .filter((p) => LISTED.has(p.status))
    .map((p) => ({ p, createdAt: p._creationTime ?? 0, id: p._id }))
    .sort(projectOrder)
    .map(({ p }) => p)

/** The sector's documents and sheets: the docs finder's own reader (docs/find.ts), kept there 30 s. */
const catalogOf = (ctx: WorkCtx, sector: string, refresh = false) => lifeosCatalog(ctx, sector, refresh).then((c) => c.rows)

/** Whether LifeOS answers the trash (`catalog:trash`): its soft delete is live. Asked once a while, never assumed. */
const trashLive = async (ctx: WorkCtx, sector: string): Promise<boolean> => {
  const got = await keptRead(ctx, `trashLive|${sector}`, () =>
    q<unknown>(ctx, 'catalog:trash', { sector }).then(
      () => true,
      (err: unknown) => (/could not find|not found|no such function/i.test(err instanceof Error ? err.message : String(err)) ? false : Promise.reject(err))
    ),
    { wait: FIRST_WAIT_MS }
  )
  return got === true
}

/** The live guest links' LifeOS rows, as `lifeos:<table>:<id>`: such a row counts as one others can open. */
function guestKeys(ctx: Pick<WorkCtx, 'db'>): Set<string> {
  try {
    return new Set(new GuestStore(ctx.db).live().map((l) => refKey({ at: 'lifeos', table: l.source.table as LifeosTable, id: l.source.id })))
  } catch {
    return new Set()
  }
}

function pushPlaces(ctx: Pick<WorkCtx, 'db' | 'push' | 'log'>, sector: string): void {
  try {
    const rows = ctx.db.prepare(`SELECT id FROM workspaces WHERE kind = 'work' AND sector = ?`).all(sector) as { id: string }[]
    for (const row of rows) ctx.push({ push: 'work.files', workspaceId: row.id, places: true }, { need: 'read' })
  } catch (err) {
    ctx.log(`files: the places push failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── the places ────────────────────────────────────────────────────────

const downState = (ctx: Pick<WorkCtx, 'lifeos'>): FilePlace['state'] => (ctx.lifeos.connected() ? { state: 'ok' } : { state: 'signed-out', detail: LIFEOS_DOWN })

/** The verbs the LifeOS place carries out: a delete and Put back only once LifeOS's trash is live. */
export const lifeosCan = (trash: boolean): FileVerb[] => ['make', 'rename', 'move', 'edit', ...(trash ? (['trash', 'restore'] as FileVerb[]) : [])]

export function lifeosPlace(ctx: Pick<WorkCtx, 'host' | 'lifeos'>, trash: boolean): FilePlace {
  return { id: PLACE.lifeos, kind: 'lifeos', name: 'LifeOS', host: '', env: ctx.host, shared: false, can: lifeosCan(trash), state: downState(ctx), root: { at: 'place', id: PLACE.lifeos }, makes: ['document', 'sheet'] }
}

const projectPlace = (ctx: Pick<WorkCtx, 'host' | 'lifeos'>, p: Pick<LifeosProject, '_id' | 'name'>): FilePlace => ({
  id: `project:${p._id}`,
  kind: 'project',
  name: p.name,
  host: '',
  env: ctx.host,
  shared: false,
  can: [],
  state: downState(ctx),
  root: { at: 'project', id: p._id }
})

const mailPlace = (ctx: Pick<WorkCtx, 'host' | 'lifeos'>, count?: number): FilePlace => ({
  id: PLACE.mail,
  kind: 'mail',
  name: 'From mail',
  host: '',
  env: ctx.host,
  shared: false,
  can: [],
  state: downState(ctx),
  root: { at: 'place', id: PLACE.mail },
  ...(count !== undefined ? { count } : {})
})

/**
 * The LifeOS place, the sector's project lenses (oldest first, as the Projects column orders them) and From mail,
 * for a workspace linked to a sector. Answered from what was kept, waiting a moment only for a first read; a
 * read behind it that changes the answer is pushed (`places`). A thread is given none: its tools name files
 * by path. A remote key without `approve` is not given From mail.
 */
export async function lifeosPlaces(ctx: WorkCtx, by: Caller, workspace: WorkspaceRow): Promise<FilePlace[]> {
  if (!workspace.sector || by.kind === 'model' || by.peer) return []
  const sector = workspace.sector
  const mail = !(by.kind === 'remote' && !by.caps.includes('approve'))
  if (!ctx.lifeos.connected()) return [lifeosPlace(ctx, false), ...(mail ? [mailPlace(ctx)] : [])]
  const [projects, trash, parts] = await Promise.all([projectsOf(ctx, sector, { wait: FIRST_WAIT_MS }), trashLive(ctx, sector), mail ? unkeptParts(ctx, workspace, { wait: FIRST_WAIT_MS }) : Promise.resolve(null)])
  return [lifeosPlace(ctx, trash), ...listedProjects(projects ?? []).map((p) => projectPlace(ctx, p)), ...(mail ? [mailPlace(ctx, parts ? parts.length : undefined)] : [])]
}

// ── rows ──────────────────────────────────────────────────────────────

const lifeosRef = (table: LifeosTable, id: string): CanvasSource => ({ at: 'lifeos', table, id })

/** A catalog row as the wire's entry: its suggestions waiting as its one state, its project, shared while LifeOS or a live guest link says so. */
export function lifeosEntry(r: CatalogRow, projects: ReadonlyMap<string, string>, guests: ReadonlySet<string>): FileEntry {
  const ref = lifeosRef(r.table, r.id)
  const key = refKey(ref)
  const project = r.projectId && projects.has(r.projectId) ? { id: r.projectId, name: projects.get(r.projectId)! } : null
  return {
    key,
    ref,
    folder: null,
    name: r.title,
    kind: r.table === 'docs' ? 'document' : 'sheet',
    changed: r.editedAt,
    ...(r.shared || guests.has(key) ? { shared: true } : {}),
    ...(r.waiting > 0 ? { state: { is: 'suggestions' as const, count: r.waiting } } : {}),
    ...(project ? { project } : {})
  }
}

const mailRef = (p: MailPart): MailSource => ({ at: 'mail', threadId: p.threadId, messageId: p.messageId, partId: p.partId, name: p.name, ...(p.contentType ? { contentType: p.contentType } : {}), size: p.size })

/** A mail's file as the wire's entry: who sent it, as "who last changed it", and the mail's subject as where it is. */
export function mailEntry(p: MailPart): FileEntry {
  const ref = mailRef(p)
  return { key: refKey(ref), ref, folder: null, name: p.name, kind: kindOfEntry(p.name, p.contentType).kind, size: p.size, changed: p.sentAt, by: p.from, where: { place: PLACE.mail, name: 'From mail', trail: [p.subject] } }
}

/** A linked item's source as a row; null for a source a row cannot open here. */
function linkedEntry(source: CanvasSource, title: string, project: { id: string; name: string }): FileEntry {
  const name = source.at === 'file' ? basename(source.path) : source.at === 'microsoft' ? source.name : title
  return { key: refKey(source), ref: source, folder: null, name, kind: kindOfEntry(name, source.at === 'google' ? source.mime : undefined).kind, ...(source.at === 'google' || source.at === 'microsoft' ? { shared: true } : {}), project }
}

/** Keys of the mail files kept in this workspace. */
const keptKeys = (ctx: Pick<WorkCtx, 'db'>, workspaceId: string): Set<string> =>
  new Set((ctx.db.prepare(`SELECT ref_key FROM work_files_kept WHERE workspace_id = ?`).all(workspaceId) as { ref_key: string }[]).map((r) => r.ref_key))

/** The sector's mail files of the last `MAIL_DAYS`, newest first, read a few pages at a time and kept a short while. */
function mailParts(ctx: WorkCtx, sector: string, o: { wait?: number; refresh?: boolean } = {}): Promise<MailPart[] | null> {
  return keptRead(
    ctx,
    `mail|${sector}`,
    async () => {
      const since = Date.now() - MAIL_DAYS * 86_400_000
      const parts: MailPart[] = []
      let cursor: string | null = null
      for (let i = 0; i < MAIL_PAGES && parts.length < MAIL_MOST; i++) {
        const page: { parts: MailPart[]; isDone: boolean; continueCursor: string } = await q(ctx, 'mail:attachments', { sector, since, paginationOpts: { numItems: 50, cursor } })
        parts.push(...page.parts)
        if (page.isDone) break
        cursor = page.continueCursor
      }
      return parts.sort((a, b) => b.sentAt - a.sentAt).slice(0, MAIL_MOST)
    },
    { ...o, onChange: () => pushPlaces(ctx, sector) }
  )
}

/** The mail files not kept in this workspace yet; null while LifeOS has not answered. */
export async function unkeptParts(ctx: WorkCtx, workspace: WorkspaceRow, o: { wait?: number; refresh?: boolean } = {}): Promise<MailPart[] | null> {
  if (!workspace.sector) return []
  const parts = await mailParts(ctx, workspace.sector, o)
  if (!parts) return null
  const keptHere = keptKeys(ctx, workspace.id)
  return parts.filter((p) => !keptHere.has(refKey(mailRef(p))))
}

/**
 * The files linked to each listed project (`projectItems`, read with `projects:page`), by key: what puts a project
 * on a row of the folder, a library or a search, and what a project's lens lists beside its LifeOS rows.
 */
async function linksOf(ctx: WorkCtx, sector: string, o: { wait?: number } = {}): Promise<Map<string, { project: { id: string; name: string }; source: CanvasSource; title: string; id: string }[]> | null> {
  const got = await keptRead(
    ctx,
    `links|${sector}`,
    async () => {
      const projects = listedProjects((await projectsOf(ctx, sector)) ?? []).slice(0, 40)
      const out: [string, { project: { id: string; name: string }; source: CanvasSource; title: string; id: string }][] = []
      for (const p of projects) {
        const page = await q<{ items: { _id: string; title: string; source: CanvasSource }[] } | null>(ctx, 'projects:page', { id: p._id })
        for (const item of page?.items ?? []) out.push([refKey(item.source), { project: { id: p._id, name: p.name }, source: item.source, title: item.title, id: item._id }])
      }
      return out
    },
    o
  )
  if (!got) return null
  const map = new Map<string, { project: { id: string; name: string }; source: CanvasSource; title: string; id: string }[]>()
  for (const [key, link] of got) (map.get(key) ?? map.set(key, []).get(key)!).push(link)
  return map
}

/** Rows of a folder, a library or a search that are linked to a project say so (`FileEntry.project`); unchanged while LifeOS is down or slow. */
export async function withProjects(ctx: WorkCtx, workspace: WorkspaceRow | null, entries: FileEntry[]): Promise<FileEntry[]> {
  if (!workspace?.sector || !entries.length || !ctx.lifeos.connected()) return entries
  const links = await linksOf(ctx, workspace.sector, { wait: FIRST_WAIT_MS })
  if (!links?.size) return entries
  return entries.map((e) => (e.project || !links.has(e.key) ? e : { ...e, project: links.get(e.key)![0]!.project }))
}

// ── one row, held to the sector ───────────────────────────────────────

interface Row {
  table: LifeosTable
  id: string
  title: string
  sector: string
  projectId?: string
  shared: boolean
}

/** A LifeOS document or sheet of the workspace's sector, as LifeOS has it now; refused when it is another sector's or gone. */
export async function lifeosRow(ctx: WorkCtx, workspace: WorkspaceRow & { sector: string }, ref: { table: string; id: string }): Promise<Row> {
  if (ref.table !== 'docs' && ref.table !== 'sheets') throw new Error('Files opens LifeOS documents and sheets.')
  if (!ctx.lifeos.connected()) throw new Error(LIFEOS_DOWN)
  const got = await q<{ title: string; sector: string; projectId?: string; shared: boolean } | null>(ctx, `${ref.table}:get`, { id: ref.id }).catch(() => null)
  if (!got) throw new Error(GONE)
  if (got.sector !== workspace.sector) throw new Error(NOT_IN_SECTOR)
  return { table: ref.table, id: ref.id, title: got.title, sector: got.sector, ...(got.projectId ? { projectId: got.projectId } : {}), shared: got.shared || guestKeys(ctx).has(refKey(lifeosRef(ref.table, ref.id))) }
}

/** A project of the workspace's sector, any state; refused otherwise. */
async function projectOf(ctx: WorkCtx, sector: string, id: string): Promise<LifeosProject> {
  const found = (await projectsOf(ctx, sector, { refresh: true }))?.find((p) => p._id === id)
  if (!found) throw new Error(NO_PROJECT)
  return found
}

// ── listing ───────────────────────────────────────────────────────────

/** A cursor into a list read whole: where the next page starts, and a stamp of the list it was cut from. */
const stampOf = (entries: readonly FileEntry[]): string =>
  createHash('sha1')
    .update(entries.map((e) => `${e.key}:${e.changed ?? ''}`).join('|'))
    .digest('base64url')
    .slice(0, 12)
function page(entries: FileEntry[], sort: FileSort | undefined, cursor: string | undefined, head: { place: string; trail: FileCrumb[] }, foldersOnly?: boolean): FilesListing {
  const all = sortEntries(foldersOnly ? entries.filter((e) => e.kind === 'folder') : entries, sort)
  const stamp = stampOf(all)
  let from = 0
  if (cursor) {
    const [s, n] = cursor.split('.')
    if (s !== stamp || !Number.isInteger(Number(n))) return { entries: [], stale: true }
    from = Number(n)
  }
  const rows = all.slice(from, from + 500)
  const next = from + rows.length < all.length ? `${stamp}.${from + rows.length}` : undefined
  return { entries: rows, ...(next ? { next } : {}), ...(cursor ? {} : head) }
}

const LIFEOS_CRUMB: FileCrumb = { name: 'LifeOS', at: { at: 'place', id: PLACE.lifeos } }

/**
 * One page of the LifeOS place, a project (as a folder of it or as its own lens) or From mail, for a caller
 * `locateLifeos` let through.
 */
export async function listLifeos(ctx: WorkCtx, by: Caller, p: { workspaceId: string; at: FolderRef; cursor?: string; sort?: FileSort; foldersOnly?: boolean }): Promise<FilesListing> {
  const workspace = locateLifeos(ctx, by, p.workspaceId, p.at)
  if (!ctx.lifeos.connected()) throw new Error(LIFEOS_DOWN)
  const sector = workspace.sector
  const at = p.at
  if (at.at === 'place' && at.id === PLACE.mail) {
    const parts = (await unkeptParts(ctx, workspace)) ?? []
    return page(parts.map(mailEntry), p.sort ?? { by: 'changed', dir: 'desc' }, p.cursor, { place: PLACE.mail, trail: [{ name: 'From mail', at }] }, p.foldersOnly)
  }
  const [projects, rows] = await Promise.all([projectsOf(ctx, sector), catalogOf(ctx, sector)])
  const all = projects ?? []
  const names = new Map(all.map((x) => [x._id, x.name]))
  const guests = guestKeys(ctx)
  const projectId = at.at === 'project' ? at.id : at.at === 'place' && at.id.startsWith('project:') ? at.id.slice('project:'.length) : null
  if (projectId === null) {
    // The top: the listed projects as folders, then what is in no listed project.
    const listed = listedProjects(all)
    const shown = new Set(listed.map((x) => x._id))
    const folders: FileEntry[] = listed.map((x) => ({ key: refKey({ at: 'project', id: x._id }), ref: null, folder: { at: 'project', id: x._id }, name: x.name, kind: 'folder' }))
    const files = rows.filter((r) => !r.projectId || !shown.has(r.projectId)).map((r) => lifeosEntry(r, names, guests))
    return page([...folders, ...files], p.sort, p.cursor, { place: PLACE.lifeos, trail: [LIFEOS_CRUMB] }, p.foldersOnly)
  }
  const project = all.find((x) => x._id === projectId)
  if (!project) throw new Error(NO_PROJECT)
  const own = rows.filter((r) => r.projectId === projectId).map((r) => lifeosEntry(r, names, guests))
  const links = (await linksOf(ctx, sector)) ?? new Map()
  const linked = [...links.values()].flat().filter((l) => l.project.id === projectId).map((l) => linkedEntry(l.source, l.title, l.project))
  const lens = at.at === 'place'
  return page([...own, ...linked], p.sort, p.cursor, { place: lens ? at.id : PLACE.lifeos, trail: lens ? [{ name: project.name, at }] : [LIFEOS_CRUMB, { name: project.name, at }] }, p.foldersOnly)
}

/** The rows of LifeOS's trash, for the Trash lens beside the folder's: each one's key is `trash:lifeos:<table>:<id>`. */
export async function lifeosTrash(ctx: WorkCtx, workspace: WorkspaceRow): Promise<FileEntry[]> {
  if (!workspace.sector || !ctx.lifeos.connected() || !(await trashLive(ctx, workspace.sector))) return []
  const rows = await q<(CatalogRow & { deletedAt: number })[]>(ctx, 'catalog:trash', { sector: workspace.sector }).catch((): (CatalogRow & { deletedAt: number })[] => [])
  return rows.map((r): FileEntry => ({ key: `trash:${refKey(lifeosRef(r.table, r.id))}`, ref: null, folder: null, name: r.title, kind: r.table === 'docs' ? 'document' : 'sheet', changed: r.deletedAt, where: { place: PLACE.lifeos, name: 'LifeOS', trail: [] } }))
}

/** Home's Waiting on you: LifeOS rows with suggestions waiting, then mail files not kept, newest first. */
export async function waitingRows(ctx: WorkCtx, by: Caller, workspace: WorkspaceRow, most: number): Promise<FileEntry[]> {
  if (!workspace.sector || !ctx.lifeos.connected()) return []
  const mail = !(by.kind === 'remote' && !by.caps.includes('approve'))
  const [rows, projects, parts] = await Promise.all([
    keptRead(ctx, `catalog|${workspace.sector}`, () => catalogOf(ctx, workspace.sector!), { wait: FIRST_WAIT_MS }),
    projectsOf(ctx, workspace.sector, { wait: FIRST_WAIT_MS }),
    mail ? unkeptParts(ctx, workspace, { wait: FIRST_WAIT_MS }) : Promise.resolve([])
  ])
  const names = new Map((projects ?? []).map((x) => [x._id, x.name]))
  const guests = guestKeys(ctx)
  const waiting = (rows ?? []).filter((r) => r.waiting > 0).map((r) => lifeosEntry(r, names, guests))
  const unkept = (parts ?? []).map(mailEntry)
  return [...waiting.sort((a, b) => (b.changed ?? 0) - (a.changed ?? 0)), ...unkept].slice(0, most)
}

// ── search ────────────────────────────────────────────────────────────

/** Who last changed a LifeOS row, as LifeOS says it: an agent or a guest by these words, and he by his Work name, or `you` without one. */
export const LIFEOS_BY = { agent: 'An agent', guest: 'A guest', you: 'You' } as const

/**
 * LifeOS rows for a search: titles that hold every word, and documents whose text holds them (`catalog:search`).
 * The filter's `project` and `review` are answered here from the row itself; with `who` asked (`owner`: his Work
 * name, null when he has none), each row says who last changed it (`LIFEOS_BY`).
 */
export async function searchLifeos(ctx: WorkCtx, workspace: WorkspaceRow | null, words: readonly string[], who?: { owner: string | null }): Promise<FileEntry[]> {
  if (!workspace?.sector || !ctx.lifeos.connected()) return []
  const sector = workspace.sector
  const [rows, projects, found] = await Promise.all([catalogOf(ctx, sector), projectsOf(ctx, sector), words.length ? q<{ table: LifeosTable; id: string }[]>(ctx, 'catalog:search', { sector, text: words.join(' ') }) : Promise.resolve([])])
  const names = new Map((projects ?? []).map((x) => [x._id, x.name]))
  const guests = guestKeys(ctx)
  const inText = new Set(found.map((h) => `${h.table}:${h.id}`))
  return rows
    .filter((r) => matchesName(r.title, words) || inText.has(`${r.table}:${r.id}`))
    .map((r) => {
      const e = lifeosEntry(r, names, guests)
      const by = !who || !r.lastBy ? undefined : r.lastBy === 'owner' ? (who.owner ?? LIFEOS_BY.you) : LIFEOS_BY[r.lastBy]
      return { ...e, where: { place: PLACE.lifeos, name: 'LifeOS', trail: e.project ? [e.project.name] : [] }, ...(by ? { by } : {}) }
    })
}

/** A LifeOS row again for `stat`: as the catalog has it now, or null when it is gone or not this workspace's. */
export async function statLifeos(ctx: WorkCtx, by: Caller, workspaceId: string, ref: CanvasSource): Promise<FileEntry | null> {
  try {
    const workspace = locateLifeos(ctx, by, workspaceId, ref)
    if (ref.at !== 'lifeos') return null
    const row = await lifeosRow(ctx, workspace, ref)
    return await entryNow(ctx, workspace.sector, row.table, row.id)
  } catch {
    return null
  }
}

// ── opening ───────────────────────────────────────────────────────────

/** What a LifeOS row or a mail's file opens as in a Files tab: its kind, its source, its name. */
export async function openLifeos(ctx: WorkCtx, by: Caller, workspaceId: string, ref: CanvasSource): Promise<{ key: string; kind: CanvasKind; source: CanvasSource; name: string }> {
  const workspace = locateLifeos(ctx, by, workspaceId, ref)
  if (ref.at === 'lifeos') {
    const row = await lifeosRow(ctx, workspace, ref)
    return { key: refKey(ref), kind: row.table === 'docs' ? 'document' : 'sheet', source: lifeosRef(row.table, row.id), name: row.title }
  }
  if (ref.at !== 'mail') throw new Error('That is not a LifeOS file.')
  // The mail pillar's fetcher holds the part to the pane's sector when its bytes are read (mail/attachment.ts).
  const seat = threadCanvasOf(ref.name, ref.contentType)
  if (!seat || !MAIL_KINDS.includes(seat)) throw new Error(MAIL_NO_VIEWER)
  return { key: refKey(ref), kind: seat, source: ref, name: ref.name }
}

// ── changes ───────────────────────────────────────────────────────────

const doorOf = (ctx: WorkCtx, trash: boolean): DoorPlace => lifeosPlace(ctx, trash)
const mailDoor = (ctx: WorkCtx): DoorPlace => mailPlace(ctx)

/** Whether a folder is LifeOS's top or a project. */
export const isLifeosFolder = (at: FileRef): boolean => at.at === 'project' || (at.at === 'place' && (at.id === PLACE.lifeos || at.id.startsWith('project:')))

/** The LifeOS folder a change names: the top (no project) or a project of the sector. */
async function projectIn(ctx: WorkCtx, sector: string, at: FolderRef): Promise<string | null> {
  if (at.at === 'place' && at.id === PLACE.lifeos) return null
  const id = at.at === 'project' ? at.id : at.at === 'place' && at.id.startsWith('project:') ? at.id.slice('project:'.length) : undefined
  if (id === undefined) throw new Error('Only a LifeOS document lives in LifeOS. Make one there instead.')
  return (await projectOf(ctx, sector, id))._id
}

const textOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface ChangeAsk {
  workspaceId: string
  op: string
  asked?: boolean
}

/** Its entry as it is now, for a FileDone. */
async function entryNow(ctx: WorkCtx, sector: string, table: LifeosTable, id: string): Promise<FileEntry | null> {
  const rows = await catalogOf(ctx, sector, true)
  const r = rows.find((x) => x.table === table && x.id === id)
  if (!r) return null
  const projects = (await projectsOf(ctx, sector)) ?? []
  return lifeosEntry(r, new Map(projects.map((x) => [x._id, x.name])), guestKeys(ctx))
}

/** New, in LifeOS: a document or a sheet, at the top or in a project. A folder is a project, made in Projects. */
export function makeLifeos(ctx: WorkCtx, by: Caller, p: ChangeAsk & { at: FolderRef; kind: string; name?: string }): Promise<FileDone> {
  const workspace = locateLifeos(ctx, by, p.workspaceId, p.at)
  return runOp(ctx.db, { id: p.op, workspaceId: workspace.id, verb: 'make', refs: [p.at, p.kind, p.name ?? null] }, async () => {
    if (p.kind === 'folder') throw new Error(PROJECT_IN_PROJECTS)
    if (p.kind !== 'document' && p.kind !== 'sheet') throw new Error(ONLY_LIFEOS_KINDS)
    if (!ctx.lifeos.connected()) throw new Error(LIFEOS_DOWN)
    admitWrite(by, { verb: 'make', from: doorOf(ctx, false), asked: p.asked })
    const projectId = await projectIn(ctx, workspace.sector, p.at)
    const title = (p.name ?? '').trim() || UNTITLED[p.kind]
    let id: string
    if (p.kind === 'document') id = await m<string>(ctx, 'docs:create', { ...(projectId ? { projectId } : { sector: workspace.sector }), title })
    else {
      const got = await sheetHost(ctx, 'create', { title, at: { lifeos: { sector: workspace.sector, ...(projectId ? { projectId } : {}) } } })
      if (!('lifeos' in got.sheet)) throw new Error('LifeOS did not make the sheet.')
      id = got.sheet.lifeos
    }
    const table: LifeosTable = p.kind === 'document' ? 'docs' : 'sheets'
    const entry = (await entryNow(ctx, workspace.sector, table, id)) ?? { key: refKey(lifeosRef(table, id)), ref: lifeosRef(table, id), folder: null, name: title, kind: p.kind, changed: Date.now() }
    pushPlaces(ctx, workspace.sector)
    return { entries: [entry], refused: [], op: p.op }
  })
}

/** Rename a LifeOS row: its title, whole. */
export function renameLifeos(ctx: WorkCtx, by: Caller, p: ChangeAsk & { ref: FileRef; name: string }): Promise<FileDone> {
  const workspace = locateLifeos(ctx, by, p.workspaceId, p.ref)
  return runOp(ctx.db, { id: p.op, workspaceId: workspace.id, verb: 'rename', refs: [p.ref, p.name] }, async () => {
    if (p.ref.at !== 'lifeos') throw new Error('A project is renamed in Projects.')
    const row = await lifeosRow(ctx, workspace, p.ref)
    const title = p.name.trim()
    if (!title || title.length > 500) throw new Error('A name needs 1 to 500 characters.')
    admitWrite(by, { verb: 'rename', from: doorOf(ctx, false), entry: { name: row.title, kind: row.table === 'docs' ? 'document' : 'sheet', shared: row.shared }, asked: p.asked })
    await m(ctx, `${row.table}:rename`, { id: row.id, title })
    const entry = await entryNow(ctx, workspace.sector, row.table, row.id)
    pushPlaces(ctx, workspace.sector)
    return { entries: entry ? [entry] : [], refused: [], op: p.op }
  })
}

/** Move LifeOS rows between projects, or to the top (no project): `docs:setProject`, `sheets:setProject`. */
export function moveLifeos(ctx: WorkCtx, by: Caller, p: ChangeAsk & { refs: FileRef[]; to: FolderRef }): Promise<FileDone> {
  const workspace = locateLifeos(ctx, by, p.workspaceId, p.to)
  return runOp(ctx.db, { id: p.op, workspaceId: workspace.id, verb: 'move', refs: [p.refs, p.to] }, async () => {
    if (!isLifeosFolder(p.to)) throw new Error('A LifeOS document lives in LifeOS. Export a copy instead.')
    if (!ctx.lifeos.connected()) throw new Error(LIFEOS_DOWN)
    const projectId = await projectIn(ctx, workspace.sector, p.to)
    const entries: FileEntry[] = []
    const refused: FileDone['refused'] = []
    for (const ref of p.refs) {
      if (ref.at !== 'lifeos') {
        refused.push({ name: ref.at === 'project' ? 'A project' : 'That', text: ref.at === 'project' ? 'A project is moved in Projects.' : 'Only a LifeOS document lives in LifeOS. Make one there instead.' })
        continue
      }
      try {
        const row = await lifeosRow(ctx, workspace, ref)
        admitWrite(by, { verb: 'move', from: doorOf(ctx, false), entry: { name: row.title, kind: row.table === 'docs' ? 'document' : 'sheet', shared: row.shared }, asked: p.asked })
        await m(ctx, `${row.table}:setProject`, { id: row.id, projectId })
        const entry = await entryNow(ctx, workspace.sector, row.table, row.id)
        if (entry) entries.push(entry)
      } catch (e) {
        refused.push({ name: ref.id, text: textOf(e) })
      }
    }
    forgetLifeos(ctx, workspace.sector)
    pushPlaces(ctx, workspace.sector)
    return { entries, refused, op: p.op }
  })
}

/**
 * Delete LifeOS rows into LifeOS's own trash (`docs:remove`, `sheets:remove`), once that trash is live; until then
 * the grammar's sentence refuses it. A row's live guest links end at once, here as in LifeOS.
 */
export function trashLifeos(ctx: WorkCtx, by: Caller, p: ChangeAsk & { refs: FileRef[] }): Promise<FileDone> {
  const workspace = locateLifeos(ctx, by, p.workspaceId, p.refs[0]!)
  return runOp(ctx.db, { id: p.op, workspaceId: workspace.id, verb: 'trash', refs: p.refs }, async () => {
    const live = await trashLive(ctx, workspace.sector)
    const rows: Row[] = []
    for (const ref of p.refs) {
      if (ref.at !== 'lifeos') throw new Error('A project is deleted in Projects.')
      const row = await lifeosRow(ctx, workspace, ref)
      // One refused refuses all, before anything goes.
      admitWrite(by, { verb: 'trash', from: doorOf(ctx, live), entry: { name: row.title, kind: row.table === 'docs' ? 'document' : 'sheet', shared: row.shared }, asked: p.asked })
      rows.push(row)
    }
    const trashed: string[] = []
    const refused: FileDone['refused'] = []
    const guests = new GuestStore(ctx.db)
    for (const row of rows) {
      try {
        await m(ctx, `${row.table}:remove`, { id: row.id })
        trashed.push(refKey(lifeosRef(row.table, row.id)))
        for (const link of guests.forSource({ at: 'lifeos', table: row.table, id: row.id })) {
          if (isLive(link)) await guestRuntime(ctx).revoke(link.id).catch((e: unknown) => ctx.log(`files: a guest link of ${row.title} did not end: ${textOf(e)}`))
        }
      } catch (e) {
        refused.push({ name: row.title, text: textOf(e) })
      }
    }
    forgetLifeos(ctx, workspace.sector)
    pushPlaces(ctx, workspace.sector)
    return { entries: [], refused, trashed, op: p.op }
  })
}

/** Put back LifeOS rows (`lifeos:<table>:<id>`, as the Trash lens keys them): each through its own restore. */
/** The sector's LifeOS trash by Trash id (`lifeos:<table>:<id>`); none while LifeOS keeps no trash. */
async function trashRows(ctx: WorkCtx, sector: string, live: boolean): Promise<Map<string, CatalogRow>> {
  return new Map((live ? await q<CatalogRow[]>(ctx, 'catalog:trash', { sector }) : []).map((r) => [`lifeos:${r.table}:${r.id}`, r]))
}

/** Whether any of these Trash ids is a LifeOS row LifeOS says others can open, asked before a Put back of a whole selection. */
export async function lifeosTrashShared(ctx: WorkCtx, by: Caller, workspaceId: string, ids: readonly string[]): Promise<boolean> {
  if (!ids.length || !ctx.lifeos.connected()) return false
  const workspace = locateLifeos(ctx, by, workspaceId, { at: 'place', id: PLACE.lifeos })
  const rows = await trashRows(ctx, workspace.sector, await trashLive(ctx, workspace.sector))
  return ids.some((id) => rows.get(id)?.shared === true)
}

export async function restoreLifeos(ctx: WorkCtx, by: Caller, workspaceId: string, ids: string[]): Promise<{ entries: FileEntry[]; refused: FileDone['refused'] }> {
  const workspace = locateLifeos(ctx, by, workspaceId, { at: 'place', id: PLACE.lifeos })
  if (!ctx.lifeos.connected()) throw new Error(LIFEOS_DOWN)
  const entries: FileEntry[] = []
  const refused: FileDone['refused'] = []
  const live = await trashLive(ctx, workspace.sector)
  // Only a row of this sector's trash is this Trash's to put back.
  const inTrash = await trashRows(ctx, workspace.sector, live)
  for (const id of ids) {
    const [, table, rowId] = id.split(':') as [string, LifeosTable, string]
    try {
      // A row LifeOS says others can open is put back by his press alone, as its delete was.
      const row = inTrash.get(id)
      admitWrite(by, { verb: 'restore', from: doorOf(ctx, live), ...(row ? { entry: { name: row.title, kind: row.table === 'docs' ? 'document' : 'sheet', shared: row.shared } } : {}) })
      if (!row) throw new Error('That is not in Trash any more.')
      await m(ctx, `${table}:restore`, { id: rowId })
      const entry = await entryNow(ctx, workspace.sector, table, rowId)
      if (entry) entries.push({ ...entry, where: { place: PLACE.lifeos, name: 'LifeOS', trail: entry.project ? [entry.project.name] : [] } })
    } catch (e) {
      refused.push({ name: id, text: textOf(e) })
    }
  }
  forgetLifeos(ctx, workspace.sector)
  pushPlaces(ctx, workspace.sector)
  return { entries, refused }
}

/**
 * Keep: a mail's file copied into a folder of the workspace, under a free name, through the mail pillar's
 * fetcher and the canvas's fetched copy (the file is read where the Mail view reads it). The door is asked as
 * a copy from From mail into the folder; the kept mark leaves it out of From mail and Waiting on you.
 */
export function keepMail(ctx: WorkCtx, by: Caller, p: ChangeAsk & { refs: FileRef[]; to: FolderRef }, folderOf: (to: FolderRef) => { place: DoorPlace; dir: string; root: string }): Promise<FileDone> {
  const workspace = locateLifeos(ctx, by, p.workspaceId, p.refs[0]!)
  return runOp(ctx.db, { id: p.op, workspaceId: workspace.id, verb: 'copy', refs: [p.refs, p.to] }, async () => {
    const into = folderOf(p.to)
    if (into.place.kind !== 'folder') throw new Error(MAIL_KEPT_INTO)
    const entries: FileEntry[] = []
    const refused: FileDone['refused'] = []
    for (const ref of p.refs) {
      if (ref.at !== 'mail') {
        refused.push({ name: 'That', text: 'Only a mail\'s file is kept from From mail.' })
        continue
      }
      admitWrite(by, { verb: 'copy', from: mailDoor(ctx), to: into.place, entry: { name: ref.name, kind: kindOfEntry(ref.name, ref.contentType).kind }, asked: p.asked })
      // The part is read as an item of the workspace's Files pane, so the fetcher holds it to this workspace's sector.
      const item = ctx.canvas.open(filesPaneOf(workspace.id), kindOfEntry(ref.name, ref.contentType).canvas ?? 'file', ref, ref.name)
      const tabbed = !!ctx.db.prepare(`SELECT 1 FROM work_files_tabs WHERE workspace_id = ? AND item_id = ?`).get(workspace.id, item.id)
      try {
        await ensureFetched(ctx, item)
        const from = fetchedPath(ctx.dataDir, item)
        let path = ''
        for (let tries = 0; !path; tries++) {
          const name = freeName(ref.name, (n) => exists(join(into.dir, n)))
          try {
            path = await makeFile({ roots: [into.root] }, into.dir, name, { from })
          } catch (e) {
            if (!(tries < 3 && e instanceof Error && /already there/.test(e.message))) throw e
          }
        }
        ctx.db.prepare(`INSERT OR REPLACE INTO work_files_kept (workspace_id, ref_key, path, at) VALUES (?, ?, ?, ?)`).run(workspace.id, refKey(ref), path, Date.now())
        const s = statSync(path)
        const kept = { at: 'file' as const, host: ctx.host, path }
        entries.push({ key: refKey(kept), ref: kept, folder: null, name: basename(path), kind: kindOfEntry(basename(path)).kind, size: s.size, changed: Math.round(s.mtimeMs) })
      } catch (e) {
        refused.push({ name: ref.name, text: textOf(e) })
      } finally {
        if (!tabbed) ctx.canvas.remove([item.id])
      }
    }
    pushPlaces(ctx, workspace.sector)
    return { entries, refused, op: p.op }
  })
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

// ── projects ──────────────────────────────────────────────────────────

/** The projects a file is in now: a LifeOS row's own, else its links (`projectItems:bySource`). */
async function projectsOfFile(ctx: WorkCtx, workspace: WorkspaceRow & { sector: string }, ref: CanvasSource): Promise<{ id: string; name: string }[]> {
  const projects = (await projectsOf(ctx, workspace.sector, { refresh: true })) ?? []
  const names = new Map(projects.map((x) => [x._id, x.name]))
  if (ref.at === 'lifeos') {
    const row = await lifeosRow(ctx, workspace, ref)
    return row.projectId && names.has(row.projectId) ? [{ id: row.projectId, name: names.get(row.projectId)! }] : []
  }
  const links = await q<{ projectId: string; name: string }[]>(ctx, 'projectItems:bySource', { source: ref })
  return links.filter((l) => names.has(l.projectId)).map((l) => ({ id: l.projectId, name: l.name }))
}

/** A source LifeOS links to a project (`projectItems`): a file on a host, a Google or Microsoft file, a Frame.io file. */
const linkable = (ref: CanvasSource): boolean => ref.at === 'file' || ref.at === 'google' || ref.at === 'microsoft' || ref.at === 'frameio'

/**
 * `work.files.project`: Add to a project… (`on`) and Take out of this project. A LifeOS row moves into the
 * project, or out of it to LifeOS's top; any other file is linked to it, or its link taken away. Asked of the door
 * as an edit of the file's place (`door`, which the caller works out for a file of a disk). Answers the file's
 * projects after the change.
 */
export async function setProject(
  ctx: WorkCtx,
  by: Caller,
  p: { workspaceId: string; ref: FileRef; projectId: string; on: boolean },
  door: (ref: FileRef) => DoorPlace,
  name: (ref: CanvasSource) => string
): Promise<{ projects: { id: string; name: string }[] }> {
  const workspace = locateLifeos(ctx, by, p.workspaceId, { at: 'place', id: PLACE.lifeos })
  if (!ctx.lifeos.connected()) throw new Error(LIFEOS_DOWN)
  const ref = p.ref
  if (ref.at === 'place' || ref.at === 'project' || ref.at === 'drive') throw new Error('Only a file is added to a project.')
  const source = ref as CanvasSource
  const project = await projectOf(ctx, workspace.sector, p.projectId)
  if (source.at === 'lifeos') {
    const row = await lifeosRow(ctx, workspace, source)
    admitWrite(by, { verb: 'edit', from: doorOf(ctx, false), entry: { name: row.title, kind: row.table === 'docs' ? 'document' : 'sheet', shared: row.shared } })
    if (p.on) await m(ctx, `${row.table}:setProject`, { id: row.id, projectId: project._id })
    else if (row.projectId === project._id) await m(ctx, `${row.table}:setProject`, { id: row.id, projectId: null })
  } else {
    if (source.at === 'mail') throw new Error("A mail's file is read only. Keep it first.")
    if (!linkable(source)) throw new Error('That file cannot be linked to a project.')
    admitWrite(by, { verb: 'edit', from: door(source), entry: { name: name(source), kind: kindOfEntry(name(source)).kind } })
    const links = await q<{ id: string; projectId: string }[]>(ctx, 'projectItems:bySource', { source })
    if (p.on && !links.some((l) => l.projectId === project._id)) await m(ctx, 'projectItems:add', { projectId: project._id, title: name(source), source })
    if (!p.on) for (const l of links.filter((x) => x.projectId === project._id)) await m(ctx, 'projectItems:remove', { id: l.id })
  }
  forgetLifeos(ctx, workspace.sector)
  return { projects: await projectsOfFile(ctx, workspace, source) }
}

/**
 * A file Files renamed or moved on a disk: its links follow it (`projectItems:repoint`), only where one is known
 * (the links kept for the sector), so a folder of thousands asks LifeOS nothing for the files no project links.
 */
export async function repointLinks(ctx: WorkCtx, from: CanvasSource, to: CanvasSource): Promise<number> {
  if (!ctx.lifeos.connected() || !linkable(from) || !linkable(to)) return 0
  const sectors = (ctx.db.prepare(`SELECT DISTINCT sector FROM workspaces WHERE kind = 'work' AND sector IS NOT NULL`).all() as { sector: string }[]).map((r) => r.sector)
  let moved = 0
  for (const sector of sectors) {
    const links = await linksOf(ctx, sector)
    if (!links?.has(refKey(from))) continue
    moved += await m<number>(ctx, 'projectItems:repoint', { from, to, title: to.at === 'file' ? basename(to.path) : undefined })
    forgetLifeos(ctx, sector)
  }
  return moved
}
