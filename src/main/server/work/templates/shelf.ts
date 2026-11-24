import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { TemplatesList } from '@shared/contract-work-templates'
import type { HostId } from '@shared/work'
import { splitName } from '@shared/work/files'
import {
  ANY_SECTOR,
  askedFields,
  fieldKey,
  fieldsOf,
  parseTemplateId,
  STARTER_KEY,
  starterSlug,
  templateFormOf,
  templateId,
  TEMPLATES_FOLDER,
  type Template,
  type TemplateForm,
  type TemplateKind,
  type TemplateWhere
} from '@shared/work/templates'
import { appRoot } from '../../appRoot'
import { locate, within } from '../files/policy'
import type { Caller, WorkCtx } from '../modules'
import { isOfficeForm, scanOffice, tcdocPreview, tcdocSource } from './ooxml'
import { TemplatesStore } from './store'

/**
 * The shelf of a Work workspace (docs/agents/work-templates.md "The shelf"),
 * read from three folders at every ask: his own for the job (the top level
 * of `<workspace folder>/Templates`), the ones for all jobs on this host
 * (`<userData>/work-templates/shared`), and our starters for the job's
 * sector and for every job (`resources/work-templates/<sector>` and
 * `/any`). A file is opened only when its size or time changed since its
 * fields were last read.
 */

export type ShelfCtx = Pick<WorkCtx, 'db' | 'host' | 'dataDir'>

export interface WorkspaceRow {
  id: string
  name: string
  /** its folder on this host */
  path: string
  sector: string | null
}

export const NO_WORKSPACE = 'That workspace is not a Work workspace on this computer.'
export const OUT_OF_REACH = "That workspace's folder is outside what this key may reach."

/** The Work workspace of this id on this host. Throws for any other. */
export function workspaceOf(ctx: Pick<WorkCtx, 'db'>, id: string): WorkspaceRow {
  const row = ctx.db.prepare('SELECT id, name, path, kind, sector FROM workspaces WHERE id = ?').get(id) as { id: string; name: string; path: string | null; kind: string | null; sector: string | null } | undefined
  if (!row || row.kind !== 'work' || !row.path) throw new Error(NO_WORKSPACE)
  return { id: row.id, name: row.name, path: row.path, sector: row.sector ?? null }
}

/** His name, as LifeOS gave it to this host; null before it has. */
export function ownerName(ctx: Pick<WorkCtx, 'db'>): string | null {
  try {
    return (ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get('work.ownerName') as { value?: string } | undefined)?.value?.trim() || null
  } catch {
    return null // no settings table: a test's database
  }
}

// ── the folders ───────────────────────────────────────────────────────

export const jobDir = (workspace: WorkspaceRow): string => join(workspace.path, TEMPLATES_FOLDER)
export const sharedDir = (ctx: Pick<WorkCtx, 'dataDir'>): string => join(ctx.dataDir, 'work-templates', 'shared')
export const scratchRoot = (ctx: Pick<WorkCtx, 'dataDir'>): string => join(ctx.dataDir, 'work-templates', 'scratch')

let startersOverride: string | null = null
/** For a test and a proof: the starters' folder in place of the shipped one; null puts the shipped one back. */
export const setStartersRoot = (dir: string | null): void => void (startersOverride = dir)
/**
 * Where the starters ship: `resources/work-templates` under the app's root,
 * which is the checkout in a dev tree, the build's folder on the box and
 * the app's own folder in a packed app (it is packed with no archive, so
 * the files are plain files there too). `TEMP_CODE_WORK_TEMPLATES` names
 * another folder.
 */
export const startersRoot = (env: NodeJS.ProcessEnv = process.env, root: () => string = appRoot): string => startersOverride ?? env.TEMP_CODE_WORK_TEMPLATES ?? join(root(), 'resources', 'work-templates')

// ── an editor's own starters ──────────────────────────────────────────

export interface StarterEntry {
  /** as the shelf says it: "Budget" */
  name: string
  /** the file, on this host */
  path: string
}
const registered = new Map<string, { kind: TemplateKind; entry: StarterEntry }>()

/**
 * An editor's own starter files, shown in the shelf's All jobs group. This
 * is the file's own state, so a pillar may call it when it loads, before or
 * after this module starts. One with the name of one of ours takes ours'
 * place on every shelf, and its key. Returns its off.
 */
export function registerStarterTemplates(kind: TemplateKind, entries: readonly StarterEntry[]): () => void {
  const mine = entries.map((entry) => ({ slug: starterSlug(entry.name), value: { kind, entry } }))
  for (const { slug, value } of mine) registered.set(slug, value)
  return () => {
    for (const { slug, value } of mine) if (registered.get(slug) === value) registered.delete(slug)
  }
}

// ── reading a folder ──────────────────────────────────────────────────

/** A template with where its file is. */
export interface ShelfEntry extends Template {
  path: string
  /**
   * The Word file a `.tcdoc` was made of, beside it under the same name: the document kind edits a `.tcdoc` made
   * of a Word file, never the file, so Edit on a Word template leaves the two. The `.tcdoc` holds his edits and
   * stands for both; a rename, a move or a remove takes the Word file with it.
   */
  twin?: string
}

/** The asked fields of a template file: read from the file when it changed, else from what was kept. */
function fieldsOfFile(store: TemplatesStore, path: string, form: TemplateForm, size: number, mtime: number): string[] {
  const kept = store.fields(path, size, mtime)
  if (kept) return kept
  let fields: string[] = []
  // Our own document is read from the markdown preview it carries; our own sheet is a plain copy, its state not opened.
  if (form === 'tcdoc') fields = tcdocFields(path)
  else if (isOfficeForm(form)) {
    try {
      fields = askedFields(scanOffice(form, new Uint8Array(readFileSync(path))))
    } catch {
      fields = [] // a file that is no zip is still a template: a plain copy
    }
  }
  store.keep(path, size, mtime, fields)
  return fields
}

function entryOf(ctx: ShelfCtx, store: TemplatesStore, where: TemplateWhere, key: string, name: string, path: string): ShelfEntry | null {
  const formed = templateFormOf(path)
  if (!formed) return null
  let info
  try {
    info = statSync(path)
  } catch {
    return null
  }
  if (!info.isFile()) return null
  return { id: templateId(where, key), name, kind: formed.kind, form: formed.form, where, fields: fieldsOfFile(store, path, formed.form, info.size, Math.floor(info.mtimeMs)), source: { at: 'file', host: ctx.host as HostId, path }, path }
}

/** A name a person never made: a dot file, Office's lock file beside an open document. */
const hiddenName = (name: string): boolean => name.startsWith('.') || name.startsWith('~$')
const byName = (a: Template, b: Template): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })

const realOr = (path: string): string | null => {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}
/**
 * The host's own read of a file the shelf already admitted for its caller: his window's row, which Files' door asks
 * nothing of but the database and the host. Never a caller's own: a key's, a thread's are judged before it is used.
 */
export const SHELF_READ: Caller = { kind: 'local', caps: ['read'] }

/**
 * Whether a file of the job's Templates folder lies, by its real path, where Files' door lets the workspace reach:
 * its own folder or a library of this host (`locate`). A link to a file elsewhere on the disk is no template.
 */
function inJob(ctx: ShelfCtx, workspaceId: string, path: string): boolean {
  try {
    locate({ ...ctx, reaches: () => true, scopeOf: () => null, settings: null } as unknown as Parameters<typeof locate>[0], SHELF_READ, workspaceId, { at: 'file', host: ctx.host as HostId, path }, 'work.templates.list')
    return true
  } catch {
    return false
  }
}

/** Whether the shelf reads a job's Templates folder where it really is: one not made yet is made inside the job. */
export const jobShelfReads = (ctx: ShelfCtx, workspaceId: string, dir: string): boolean => !existsSync(dir) || inJob(ctx, workspaceId, dir)

/** Whether a file lies, by its real path, inside a folder by its real path: a link out of the app's own folder is no template. */
const inDir = (dir: string, path: string): boolean => {
  const at = realOr(path)
  const root = realOr(dir)
  return !!at && !!root && within(at, root)
}

/** A remote key reads or changes a workspace's shelf only where it may reach the workspace's folder. Throws the one refusal. */
export function reachWorkspace(ctx: Pick<WorkCtx, 'db' | 'reaches'>, by: Caller, workspaceId: string): WorkspaceRow {
  const workspace = workspaceOf(ctx, workspaceId)
  if (by.kind === 'remote' && !by.peer && !ctx.reaches(by, workspace.path)) throw new Error(OUT_OF_REACH)
  return workspace
}

/**
 * Whether a remote key could name a template's file itself, by the path the shelf reads and by the file a link
 * there leads to. This host's window, a thread and another host of his always could (`ctx.reaches`).
 */
export function reachesFile(ctx: Pick<WorkCtx, 'reaches'>, by: Caller, path: string): boolean {
  if (by.kind !== 'remote' || by.peer) return true
  return ctx.reaches(by, path) && ctx.reaches(by, realOr(path) ?? path)
}

function readDir(ctx: ShelfCtx, store: TemplatesStore, where: TemplateWhere, dir: string, keyOf: (fileName: string, stem: string) => string, admit: (path: string) => boolean = () => true): ShelfEntry[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return [] // no folder yet: no templates
  }
  const out: ShelfEntry[] = []
  const present = new Set<string>()
  for (const fileName of names) {
    if (hiddenName(fileName)) continue
    const path = join(dir, fileName)
    // Asked before the file is opened: a link out of where the shelf may read names no fields either.
    if (!templateFormOf(fileName) || !admit(path)) continue
    const entry = entryOf(ctx, store, where, keyOf(fileName, splitName(fileName).stem), splitName(fileName).stem, path)
    if (!entry) continue
    present.add(path)
    out.push(entry)
  }
  if (where !== 'starter') store.prune(dir, present)
  return withTwins(out).sort(byName)
}

/** Office's file systems keep a time to 2 seconds: a Word file written just before its import may read as just after it. */
const CLOCK_SLACK_MS = 2_000

/**
 * Whether a `.tcdoc` was made of this Word file: its sidecar names the file, as a Word file, imported after the file
 * was last written. A name alone proves nothing: his own document "Letter" beside an unrelated Letter.docx is two.
 */
export function madeOf(tcdoc: string, docx: string): boolean {
  try {
    const source = tcdocSource(new Uint8Array(readFileSync(tcdoc)))
    return !!source && source.format === 'docx' && source.name === basename(docx) && statSync(docx).mtimeMs <= source.importedAt + CLOCK_SLACK_MS
  } catch {
    return false
  }
}

/** A `.tcdoc` beside the Word file it was made of stands for both (`ShelfEntry.twin`): one tile, the one with his edits. Any other two of one name are two tiles. */
function withTwins(entries: ShelfEntry[]): ShelfEntry[] {
  const docs = new Map(entries.filter((e) => e.form === 'tcdoc').map((e) => [e.name, e]))
  const out: ShelfEntry[] = []
  for (const e of entries) {
    const doc = e.form === 'docx' ? docs.get(e.name) : undefined
    if (doc && madeOf(doc.path, e.path)) doc.twin = e.path
    else out.push(e)
  }
  return out
}

const starterKey = (sector: string, stem: string): string => `${sector}/${starterSlug(stem)}`
/** The sector part of a starter's id. */
export const starterSector = (id: string): string => parseTemplateId(id)?.key.split('/')[0] ?? ''

/** Our starters of one sector's folder, with an editor's own of the same name in ours' place; `any` also holds every editor's own. */
function startersOf(ctx: ShelfCtx, store: TemplatesStore, sector: string): ShelfEntry[] {
  // A sector is a folder's name, never a way out of the starters' folder.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(sector)) return []
  const shipped = readDir(ctx, store, 'starter', join(startersRoot(), sector), (_file, stem) => starterKey(sector, stem))
  const out: ShelfEntry[] = []
  for (const entry of shipped) {
    const slug = entry.id.slice(entry.id.indexOf('/') + 1)
    const theirs = registered.get(slug)
    if (!theirs) out.push(entry)
    else if (sector !== ANY_SECTOR) {
      const swapped = entryOf(ctx, store, 'starter', `${sector}/${slug}`, theirs.entry.name, theirs.entry.path)
      if (swapped) out.push(swapped)
    }
  }
  if (sector === ANY_SECTOR) {
    for (const [slug, { entry }] of registered) {
      const theirs = entryOf(ctx, store, 'starter', `${ANY_SECTOR}/${slug}`, entry.name, entry.path)
      if (theirs) out.push(theirs)
    }
  }
  return out.sort(byName)
}

export interface Shelf {
  workspace: WorkspaceRow
  /** in the shelf's order: the job's own, the job's starters, all jobs', every job's starters; hidden starters left out */
  entries: ShelfEntry[]
  /** the starters hidden in this workspace that would otherwise show */
  hiddenEntries: ShelfEntry[]
  /** the starters one of his own of the same name stands in for */
  replacedEntries: ShelfEntry[]
}

/** A workspace's shelf, read now. */
export function shelfOf(ctx: ShelfCtx, workspaceId: string): Shelf {
  const workspace = workspaceOf(ctx, workspaceId)
  const store = new TemplatesStore(ctx.db)
  const hidden = store.hidden(workspaceId)
  const sector = workspace.sector && workspace.sector !== ANY_SECTOR ? workspace.sector : null
  const isHidden = (e: ShelfEntry): boolean => hidden.has(parseTemplateId(e.id)!.key)
  const own = readDir(ctx, store, 'job', jobDir(workspace), (file) => file, (path) => inJob(ctx, workspaceId, path))
  const all = readDir(ctx, store, 'all', sharedDir(ctx), (file) => file, (path) => inDir(sharedDir(ctx), path))
  const jobStarters = sector ? startersOf(ctx, store, sector) : []
  // An editor's own of a name one of the job's starters has is shown once, in the job's group.
  const taken = new Set(jobStarters.map((e) => e.id.slice(e.id.indexOf('/') + 1)))
  const anyStarters = startersOf(ctx, store, ANY_SECTOR).filter((e) => !taken.has(e.id.slice(e.id.indexOf('/') + 1)))
  // His own of a name takes our starter's place on the shelf, as it does for a caller that names it: "Edit a copy"
  // leaves one tile, his. The starter comes back when his is renamed or removed.
  const mine = new Set([...own, ...all].map((e) => fieldKey(e.name)))
  const replaced = (e: ShelfEntry): boolean => mine.has(fieldKey(e.name))
  const starters = [...jobStarters, ...anyStarters]
  return {
    workspace,
    entries: [...own, ...jobStarters.filter((e) => !isHidden(e) && !replaced(e)), ...all, ...anyStarters.filter((e) => !isHidden(e) && !replaced(e))],
    hiddenEntries: starters.filter(isHidden),
    replacedEntries: starters.filter((e) => !isHidden(e) && replaced(e))
  }
}

const bare = ({ path: _path, twin: _twin, ...template }: ShelfEntry): Template => template

/** The shelf as the wire answers it. */
export function listTemplates(ctx: ShelfCtx, workspaceId: string): TemplatesList {
  const shelf = shelfOf(ctx, workspaceId)
  return { templates: shelf.entries.map(bare), hidden: shelf.hiddenEntries.length }
}
export const toTemplate = bare

// ── finding one ───────────────────────────────────────────────────────

export class NoTemplateError extends Error {}

/**
 * The template a caller names: an id, a starter's key (`unify/invoice`), or
 * a name, looked for in the job's own, then all jobs', then the job's
 * starters, then every job's. His own of a name wins, so a template he
 * saved as "Meeting notes" takes ours' place for every caller. A starter he
 * hid is still found: hiding takes it off the shelf, not away from a
 * caller that names it.
 */
export function resolveTemplate(ctx: ShelfCtx, workspaceId: string, ref: string): { shelf: Shelf; entry: ShelfEntry } {
  const shelf = shelfOf(ctx, workspaceId)
  const every = [...shelf.entries, ...shelf.hiddenEntries, ...shelf.replacedEntries]
  const said = ref.trim()
  const id = parseTemplateId(said) ? said : STARTER_KEY.test(said) ? templateId('starter', said) : null
  if (id) {
    const found = every.find((e) => e.id === id) ?? starterElsewhere(ctx, id)
    if (found) return { shelf, entry: found }
    // A name may hold a colon or a slash's look: fall through to the name.
  }
  const want = fieldKey(said)
  const rank = (e: ShelfEntry): number => (e.where === 'job' ? 0 : e.where === 'all' ? 1 : starterSector(e.id) !== ANY_SECTOR ? 2 : 3)
  const named = every.filter((e) => fieldKey(e.name) === want).sort((a, b) => rank(a) - rank(b))
  if (named[0]) return { shelf, entry: named[0] }
  throw new NoTemplateError(`There is no template "${said}" in ${shelf.workspace.name}.`)
}

/** One of our starters by id, for a caller in a workspace of another sector (Money in a job with no sector asks for `unify/invoice`). */
function starterElsewhere(ctx: ShelfCtx, id: string): ShelfEntry | null {
  const parsed = parseTemplateId(id)
  if (!parsed || parsed.where !== 'starter') return null
  const sector = parsed.key.split('/')[0] ?? ''
  return startersOf(ctx, new TemplatesStore(ctx.db), sector).find((e) => e.id === id) ?? null
}

/** Every field a `.tcdoc` holds, Date, Name and Job among them, from the markdown preview it carries: what Save as template reads to pick how it is kept. */
export const tcdocEveryField = (path: string): string[] => {
  const preview = existsSync(path) ? tcdocPreview(new Uint8Array(readFileSync(path))) : null
  return preview ? fieldsOf(preview) : []
}
/** A `.tcdoc`'s asked fields. */
export const tcdocFields = (path: string): string[] => askedFields(tcdocEveryField(path))
