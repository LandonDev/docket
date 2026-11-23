import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, rename, utimes } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import type { PdfView } from '@shared/contract-work-pdf'
import type { CanvasItem } from '@shared/work'
import { errorText } from '@shared/work/ids'
import { runnerOf } from '../formats/jobs'
import type { WorkCtx } from '../modules'
import { hasMagic, itemDir, pushFor, ItemFileError, sourcePath, stampOf, type FileStamp } from './file'
import { PdfFormError, readForm, writePdf, type FormRead, type WriteInput } from './form'
import { PdfStore } from './store'

/**
 * A PDF item as the host serves it (docs/agents/work-pdf.md): the copy its
 * bytes are read from, its form, what is drawn over it, and the copy that
 * leaves. The methods (index.ts) and the tools (tools.ts) both go through
 * here.
 */

type Ctx = Pick<WorkCtx, 'db' | 'host' | 'push' | 'dataDir' | 'canvas'>

/** The file's name inside the folder of an item a thread made. */
const OWN_FILE = 'file.pdf'

/** How many kept copies an item holds: the one shown, and the one before it, so a load begun on it can finish. */
const KEEP = 2
const KEPT = /^kept-([0-9a-f]{16})\.pdf$/

export interface Snapshot {
  /** the copy the bytes are read from; `rev` is the version of the file it was taken from */
  stamp: FileStamp
  name: string
  missing?: { asOf: number }
}

/** The kept copies, newest first. */
function keptCopies(dir: string): Array<{ path: string; rev: string; mtimeMs: number }> {
  return readdirSync(dir)
    .flatMap((f) => {
      const m = KEPT.exec(f)
      return m ? [{ path: join(dir, f), rev: m[1], mtimeMs: statSync(join(dir, f)).mtimeMs }] : []
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

const servedAs = (path: string, name: string, rev: string): FileStamp => ({ ...stampOf(path, name), rev })

/**
 * The item's file as it is served: a copy kept per version of the file, so
 * a load by range reads one version from its first range to its last, and
 * the pages still show when the file moves. Only `refresh` (an open, a
 * thread's read) looks at the file and copies a new version; everything
 * else serves the newest copy kept. `rev` asks for one version: a version
 * no longer kept is refused with a sentence.
 */
export async function snapshot(ctx: Ctx, item: CanvasItem, o: { refresh?: boolean; rev?: string } = {}): Promise<Snapshot> {
  // A thread's own file, and a mail's attachment fetched into the item's folder, never change under the item: served as they are.
  if (item.source.at === 'thread' || item.source.at === 'mail') {
    const path = await sourcePath(ctx, item, OWN_FILE)
    const name = nameOf(item, path)
    const stamp = stampOf(path, item.title)
    if (!hasMagic(path, 'pdf')) throw new ItemFileError(`${name} is not a PDF.`)
    if (o.rev && o.rev !== stamp.rev) throw stale()
    return { stamp, name }
  }
  const dir = await itemDir(ctx, item)
  let path: string | null = null
  let fault: unknown
  try {
    path = await sourcePath(ctx, item, OWN_FILE)
  } catch (err) {
    fault = err
  }
  const name = nameOf(item, path)
  const here = !!path && existsSync(path)
  const kept = keptCopies(dir)
  if (o.rev) {
    const copy = kept.find((k) => k.rev === o.rev)
    if (!copy) throw here || kept.length ? stale() : (fault ?? new ItemFileError(`${name} is not where it was.`, 'missing'))
    return { stamp: servedAs(copy.path, name, copy.rev), name, ...(here ? {} : { missing: { asOf: copy.mtimeMs } }) }
  }
  if (here && (o.refresh || kept.length === 0)) {
    const src = stampOf(path!, name)
    if (!hasMagic(path!, 'pdf')) throw new ItemFileError(`${name} is not a PDF.`)
    const target = join(dir, `kept-${src.rev}.pdf`)
    if (!existsSync(target)) {
      // Off the event loop, and whole or absent: a copy beside its place, then moved onto it. The name is
      // the open's own, so two opens of a new version at once never share one.
      const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
      await copyFile(path!, tmp)
      await rename(tmp, target)
    }
    // Kept copies are ordered by when they were taken, never by the file's own time (a copy may keep it): the one
    // this open found or made is the newest, so a file put back to an earlier version is served as that version.
    const now = new Date()
    await utimes(target, now, now)
    for (const old of keptCopies(dir).filter((k) => k.path !== target).slice(KEEP - 1)) rmSync(old.path, { force: true })
    return { stamp: servedAs(target, name, src.rev), name }
  }
  if (kept.length) return { stamp: servedAs(kept[0].path, name, kept[0].rev), name, ...(here ? {} : { missing: { asOf: kept[0].mtimeMs } }) }
  throw fault ?? new ItemFileError(`${name} is not where it was.`, 'missing')
}

const stale = (): ItemFileError => new ItemFileError('This file changed since it was opened: open it again.', 'stale')

export const nameOf = (item: CanvasItem, path: string | null): string => {
  const source = item.source
  if (source.at === 'microsoft') return source.name
  if (source.at === 'mail') return source.name
  if (path && source.at === 'file') return basename(path)
  return /\.pdf$/i.test(item.title) ? item.title : `${item.title}.pdf`
}

/** A file's form, read once per version of the file. */
const forms = new Map<string, Promise<FormRead | { error: string }>>()
export function formOf(stamp: FileStamp): Promise<FormRead | { error: string }> {
  const key = `${stamp.path}:${stamp.rev}`
  let form = forms.get(key)
  if (!form) {
    form = readForm(readFileSync(stamp.path)).catch((err) => ({ error: err instanceof PdfFormError ? err.message : `The form could not be read: ${errorText(err)}` }))
    forms.set(key, form)
    if (forms.size > 32) forms.delete(forms.keys().next().value!)
  }
  return form
}

/** What is drawn over the item. `refresh`: an open, which takes a new copy when the file changed. */
export async function viewOf(ctx: Ctx, item: CanvasItem, o: { refresh?: boolean } = {}): Promise<PdfView> {
  const snap = await snapshot(ctx, item, o)
  const form = await formOf(snap.stamp)
  const store = new PdfStore(ctx.db)
  const kept = store.keep(item)
  const read = 'error' in form ? null : form
  // First: a signature over another version or other values comes off, and the fields show that.
  const signed = store.signedOver(kept.id, kept.sessionId, snap.stamp.rev, read?.fields ?? [])
  const written = store.written(kept.id)
  return {
    itemId: item.id,
    sessionId: item.sessionId,
    name: snap.name,
    size: snap.stamp.size,
    rev: snap.stamp.rev,
    mode: store.mode(kept.id),
    fields: store.fields(kept.id, read?.fields ?? [], store.labels(kept.id, snap.stamp.rev)),
    marks: store.marks(kept.id),
    hasSignature: store.signature() !== null,
    signed,
    ...(written ? { written: { id: written.id, text: written.text, at: written.at } } : {}),
    ...(read?.xfaOnly ? { xfaOnly: true } : {}),
    ...('error' in form ? { formError: form.error } : {}),
    ...(snap.missing ? { missing: snap.missing } : {})
  }
}

/** The other open PDF items of the workspace whose rows are the item's (a Files tab and a thread on one file). */
export function sharing(ctx: Ctx, item: CanvasItem): CanvasItem[] {
  if (!item.workspaceId) return []
  const store = new PdfStore(ctx.db)
  const kept = store.keep(item).id
  return ctx.canvas.forWorkspace(item.workspaceId, { open: true, panes: true }).filter((other) => other.id !== item.id && other.kind === 'pdf' && store.keep(other).id === kept)
}

/** Tells every client what is drawn over the item now, and over each item that shares its rows, and answers the item's. */
export async function announce(ctx: Ctx, item: CanvasItem): Promise<PdfView> {
  const view = await viewOf(ctx, item)
  // A remote key's socket hears of an item only when it could read the item's file: the push can filter by capability
  // alone, so an item outside the remote roots goes only to sockets that hold every capability (this host's window).
  ctx.push({ push: 'work.pdf', sessionId: item.sessionId, view }, pushFor(item))
  for (const other of sharing(ctx, item)) {
    try {
      ctx.push({ push: 'work.pdf', sessionId: other.sessionId, view: await viewOf(ctx, other) }, pushFor(other))
    } catch {
      // One whose file cannot be read now hears again when it is opened.
    }
  }
  return view
}

/** The file's own fields, or a sentence saying why they cannot be read. */
export async function fieldsOfFile(ctx: Ctx, item: CanvasItem): Promise<{ stamp: FileStamp; form: FormRead }> {
  const snap = await snapshot(ctx, item)
  const form = await formOf(snap.stamp)
  if ('error' in form) throw new ItemFileError(form.error)
  return { stamp: snap.stamp, form }
}

/** The font a filled value is drawn with: the pdf manifest's own, which covers Latin, Greek and Cyrillic. Absent, pdf-lib's Helvetica draws what WinAnsi can say and the rest is refused by name. */
async function unicodeFont(ctx: Pick<WorkCtx, 'db'>): Promise<Uint8Array | undefined> {
  const font = (await runnerOf(ctx))?.tools.bin('pdf-font')
  try {
    return font ? new Uint8Array(readFileSync(font)) : undefined
  } catch {
    return undefined
  }
}

export interface ExportResult {
  path: string
  name: string
  size: number
  rev: string
  /** what could not be written, one sentence each */
  warnings: string[]
  /** values that still wait for the owner, which the copy does not carry */
  pending: number
}

/**
 * Writes the copy that leaves: the values he accepted or typed, his
 * highlights as real annotations, and his signature drawn into the page
 * when he signed. A value that still waits is never in it.
 */
export async function exportCopy(ctx: Ctx, item: CanvasItem, flatten: boolean): Promise<ExportResult> {
  const { stamp, form } = await fieldsOfFile(ctx, item)
  const store = new PdfStore(ctx.db)
  const kept = store.keep(item)
  // His ink goes only on the version and the values he signed.
  const signature = store.signedOver(kept.id, kept.sessionId, stamp.rev, form.fields) ? store.signature() : null
  const fields = store.fields(kept.id, form.fields)
  const overlays: WriteInput['overlays'] = []
  for (const f of fields) {
    if (f.type === 'signature') {
      if (signature && f.state === 'accepted') overlays.push({ page: f.page, bbox: f.bbox, signature })
      continue
    }
    // A box's value is his (a suggestion waiting over it is not): the copy carries it, as the signature's hash counts it.
    if (f.origin !== 'overlay' || f.value === null) continue
    overlays.push(typeof f.value === 'boolean' ? { page: f.page, bbox: f.bbox, check: f.value } : { page: f.page, bbox: f.bbox, text: f.value })
  }
  const out = await writePdf(new Uint8Array(readFileSync(stamp.path)), {
    values: form.xfaOnly ? [] : store.ownValues(kept.id),
    overlays,
    marks: store.marks(kept.id).map((m) => ({ name: `tc:${item.sessionId}:${m.id}`, page: m.page, quads: m.quads, ...(m.note ? { note: m.note } : {}), author: m.by === 'owner' ? 'Owner' : 'Agent' })),
    flatten,
    font: await unicodeFont(ctx)
  })
  // Each copy in a folder of its own, under the document's own name (it is what gets attached): a draft
  // that kept an earlier copy's path still attaches those bytes. The newest few are kept.
  const dir = await itemDir(ctx, item, 'export')
  const id = `${Date.now().toString(36).padStart(9, '0')}-${randomBytes(3).toString('hex')}`
  mkdirSync(join(dir, id), { recursive: true, mode: 0o700 })
  const name = `${basename(stamp.name, extname(stamp.name))}.pdf`
  const path = join(dir, id, name)
  writeFileSync(path, out.bytes)
  for (const old of exportDirs(dir).slice(EXPORTS_KEPT)) rmSync(join(dir, old), { recursive: true, force: true })
  const made = stampOf(path, name)
  return { path, name, size: made.size, rev: made.rev, warnings: out.warnings, pending: store.pending(kept.id) }
}

/** How many exported copies an item keeps. */
export const EXPORTS_KEPT = 5
/** The export folders, newest first (their names start with the time). */
const exportDirs = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()

/** The copy last made of an item, if one was. */
export function lastExport(dir: string): FileStamp | null {
  for (const sub of exportDirs(dir)) {
    const name = readdirSync(join(dir, sub)).find((f) => f.toLowerCase().endsWith('.pdf'))
    if (name) return stampOf(join(dir, sub, name), name)
  }
  return null
}

/** Today as a form's date line reads. */
export const signedDate = (now = new Date()): string => now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

