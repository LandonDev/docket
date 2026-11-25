import { createHash, randomUUID } from 'node:crypto'
import { writeBackInPieces } from './pieces'
import { basename } from 'node:path'
import type { FileOrigin, WrittenBack } from '@shared/contract-work-files'
import { canvasSourcePath, filesPaneOf, type CanvasSource } from '@shared/work'
import { refKey, type FolderRef } from '@shared/work/files'
import { linkWords, saveAsName, type DocLink, type SaveAsFormat, type SavedAs } from '@shared/work/saveAs'
import { attachmentDocPathOf, reserveLink, settlePrivateWrites } from '../docs/target'
import { endGuestEditOn } from '../guests/store'
import type { Caller, WorkCtx } from '../modules'
import { admitOwner, deliver, freshBytes, freshVersion, unreachable } from './copies'
import { vmList } from '../office/vm/files'
import { admitChange, filesState, HELD_BY_TOOLS, THREADS_BY_TOOLS, vmWhere, writeBytes } from './handle'
import { admitCaller, locate, workspaceHere } from './policy'
import { versionWord } from './save'
import { makeBytes, makeFolderRef } from './verbs'
import { vmReadVersioned } from './vmVerbs'
import { uploadPending, uploadWrote } from './uploads'
import { liveRev, wordTiming } from './word'
import { canonicalPath } from '../service/ctx'
import type { DocRevision } from '../service/wire'
import { OpLost, opKnown, runOp, versionOf } from './write'

/**
 * Save As… (docs/agents/work-files.md "Save As…"; the owner's asks of 2026-11-24): a document he has open, saved as
 * Word, PDF, OpenDocument, Rich Text or Markdown into a folder he picks: the workspace's own folder, a Teams or
 * OneDrive library on this host or in its Windows VM, or a library on another computer of his. The file is made under
 * his name through Files' one door as a `make` in that folder; a file of that name already there is never written over
 * unasked: the answer says so, and his Replace (by the version read now) or Keep Both (a free name) decides.
 *
 * The document and the file stay LINKED unless he chose Just a copy: each later edit of the document is written to the
 * file again by the host, by version, once his typing has paused (`autosaveLinks`), the same rule the Word file's
 * autosave keeps (word.ts): the live revision (the Work service's) against the one last written, so Saved is said only
 * of what is on screen. A change made there stops it for that file until his press (Replace, Keep Both, Unlink); a
 * place that does not answer keeps the document as it is and is tried again. His press alone makes a link or saves:
 * a thread is refused at the wire (`CHANGES`) and here, a read key by its capability, a key without `approve` by the
 * door where others can open the folder.
 */

const METHOD = 'work.files.saveAs'
const NOT_A_FOLDER_HERE = 'A file is saved into a folder on a computer: the workspace\'s folder, Teams or OneDrive.'
const DOC_ELSEWHERE = 'That document is on another host: save it there.'
const NOT_OPEN_HERE = 'That document is not open in this workspace.'
/** An agent's change landed in the document as he pressed: he sees it before it goes anywhere (docs/target.ts, the hold's race). */
export const AGENT_JUST_WROTE = 'An agent changed this document just now. Look it over, then save again.'
/** His window: what the host itself writes as for a link his press made. */
const LOCAL: Caller = { kind: 'local', caps: ['read', 'operate', 'approve'] }
/** How long his document must be still before a linked file is written again, and how long a place that did not answer waits. */
export const linkTiming = {
  get pause() { return wordTiming.pause },
  retry: 30_000
}

export interface LinkRow {
  id: string
  workspace_id: string
  doc: string
  format: SaveAsFormat
  host: string
  path: string
  vm: number
  name: string
  place: string
  computer: string | null
  version: string
  sha: string
  /** the version a change made there was found at: his Replace names it */
  seen_version: string | null
  /** the sha256 of the last write sent whose answer never came */
  tried_sha: string | null
  saved_rev: string | null
  saved_at: number | null
  state: 'ok' | 'waiting' | 'changed' | 'gone' | 'refused'
  changed_at: number | null
  detail: string | null
  tried_at: number | null
  made_at: number
}

const rowOf = (ctx: Pick<WorkCtx, 'db'>, id: string): LinkRow | null => (ctx.db.prepare(`SELECT * FROM work_files_links WHERE id = ?`).get(id) as LinkRow | undefined) ?? null
const shaOf = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** Whether a document is the workspace's own to save: an open item of it shows it, or it is the document a mail's attachment there was read into. */
function openIn(ctx: WorkCtx, workspaceId: string, source: CanvasSource): boolean {
  const key = refKey(source)
  const path = canvasSourcePath(source)
  return ctx.canvas.forWorkspace(workspaceId, { open: true, panes: true }).some((item) => refKey(item.source) === key || (path !== null && item.source.at === 'mail' && attachmentDocPathOf(ctx.dataDir, item) === path))
}

/**
 * A mail's attachment, named by its own source as the window names its document (work-mail.md "Attachments"): the
 * `.tcdoc` an open item of the workspace read it into, as a file of this host. Null for any other source.
 */
function attachmentFileIn(ctx: WorkCtx, workspaceId: string, source: CanvasSource): CanvasSource | null {
  if (source.at !== 'mail') return null
  const key = refKey(source)
  const item = ctx.canvas.forWorkspace(workspaceId, { open: true, panes: true }).find((i) => i.source.at === 'mail' && refKey(i.source) === key)
  return item ? { at: 'file', host: ctx.host, path: attachmentDocPathOf(ctx.dataDir, item) } : null
}

/** The document's file on this host, which a link follows by its live revision; null for a LifeOS or Google document. */
const linkableDoc = (ctx: WorkCtx, source: CanvasSource): string | null => (source.at === 'file' && source.host === ctx.host && source.path.endsWith('.tcdoc') ? source.path : null)

/** The document in a format, as the host writes it now from the live text: the exporter's own, and PDF its Word file drawn by the converter. */
export async function exportBytes(ctx: WorkCtx, source: CanvasSource, format: SaveAsFormat): Promise<{ name: string; data: Buffer }> {
  if (format === 'pdf') {
    const { lifeosRow, madeFromShared, targetOf, titleOf } = await import('../docs/target')
    const { fileDocumentPdf } = await import('../formats/preview')
    const { safeName } = await import('../formats/importer')
    const t = await targetOf(ctx, LOCAL, METHOD, source)
    const name = `${safeName(titleOf(t, await lifeosRow(ctx, t)))}.pdf`
    return { name, data: await fileDocumentPdf(ctx, t, madeFromShared(ctx, source)) }
  }
  const { exportDoc } = await import('../formats/exporter')
  const out = await exportDoc(ctx, LOCAL, { source, format })
  return { name: out.name, data: Buffer.from(out.data, 'base64') }
}

type Spot = Pick<LinkRow, 'workspace_id' | 'host' | 'path' | 'vm' | 'name'>
const separator = (vm: boolean): string => (vm ? '\\' : '/')
const join2 = (folder: string, name: string, vm: boolean): string => `${folder.replace(/[\\/]+$/, '')}${separator(vm)}${name}`

/** The version a file has where it lies now, or null when there is none of that name. */
async function versionNow(ctx: WorkCtx, r: Spot): Promise<string | null> {
  try {
    if (r.host !== ctx.host) {
      // Another computer is asked whether the file is there before its bytes are read for their version.
      const peer = ctx.peer.call({ scope: { sessionId: filesPaneOf(r.workspace_id), workspaceId: r.workspace_id } } as never, r.host)
      const got = (await peer.call('files', 'stat', { workspaceId: r.workspace_id, refs: [{ at: 'file', host: r.host, path: r.path }] })) as { entries: unknown[] }
      if (!got.entries[0]) return null
      // Its exact version, with one byte of it: the whole file is pulled only from a host a build behind.
      return (await freshVersion(ctx, r)) ?? (await freshBytes(ctx, r)).version
    }
    if (r.vm) {
      // The VM's folder is listed first, by name read case-blind as Windows reads it.
      const dir = r.path.slice(0, r.path.lastIndexOf('\\'))
      const at = locate(ctx, LOCAL, r.workspace_id, { at: 'file', host: r.host, path: dir }, METHOD)
      if (at.in !== 'library' || !at.library.vm) return null
      const names = new Set((await vmList(vmWhere(ctx, LOCAL, at).library.library, dir)).map((e) => e.name.toLowerCase()))
      return names.has(r.name.toLowerCase()) ? (await vmReadVersioned(r.path, 0, 1)).version : null
    }
    return versionWord(await versionOf(r.path))
  } catch (err) {
    if (/not there any more|gone|not found|No file|ENOENT|no such file/i.test(err instanceof Error ? err.message : String(err))) return null
    throw err
  }
}

/** Presses whose make on another computer lost its answer: sent again, they are asked of that host's journal by the same id. */
const lostOps = new Set<string>()

/** A file made in the folder under a free name, never over anything: its path, name and version. */
async function makeIn(ctx: WorkCtx, by: Caller, p: { workspaceId: string; at: FolderRef & { at: 'file' }; name: string; data: Buffer; op: string; vm: boolean; linked: boolean }): Promise<{ path: string; name: string; version: string }> {
  if (p.at.host === ctx.host) {
    const done = await makeBytes(ctx, by, { workspaceId: p.workspaceId, at: p.at, name: p.name, data: p.data, op: p.op }, METHOD)
    const ref = done.entries[0]?.ref
    if (!ref || ref.at !== 'file') throw new Error('The file was not made.')
    // Only a linked file needs the version it was made at: the next write goes over it by that version alone.
    const version = !p.linked ? '' : p.vm ? (await vmReadVersioned(ref.path, 0, 1)).version : versionWord(await versionOf(ref.path))
    // A file made in the VM's library is followed until OneDrive has it, as any write of ours there is (uploads.ts).
    if (p.vm) uploadWrote(ctx, { workspace_id: p.workspaceId, host: ctx.host, path: ref.path, vm: true })
    return { path: ref.path, name: done.entries[0]!.name, version }
  }
  // A library on another computer of his: that host makes the file in its folder through its own door (`writeBack` with `into`).
  const origin: FileOrigin = { from: 'window' }
  const peer = ctx.peer.call({ scope: { sessionId: filesPaneOf(p.workspaceId), workspaceId: p.workspaceId } } as never, p.at.host)
  const ref: CanvasSource = { at: 'file', host: p.at.host, path: join2(p.at.path, p.name, false) }
  // Under the press's own id there, so the same press sent again after a lost answer is the file that host made.
  const got = (await writeBackInPieces((method, params) => peer.call('files', method, params), { workspaceId: p.workspaceId, ref, version: '', origin, into: true, op: p.op }, p.data).catch((err: unknown) => {
    if (!unreachable(err)) throw err
    lostOps.add(p.op)
    throw new OpLost(err instanceof Error ? err.message : String(err))
  })) as WrittenBack
  if (!('copy' in got)) throw new Error('The file was not made.')
  // That host says whether it lies in a folder OneDrive syncs; until then nothing is told of the cloud.
  uploadWrote(ctx, { workspace_id: p.workspaceId, host: p.at.host, path: got.copy.path, vm: false })
  return { path: got.copy.path, name: got.copy.name, version: got.copy.version }
}

/** A file written over by version: this host's through its door, another computer's by its own (`writeBack`). */
async function putOver(ctx: WorkCtx, r: Spot & { version: string }, data: Buffer): Promise<{ version: string } | { conflict: { changed: number; version: string } | { gone: true } }> {
  // Another computer's write is followed by `deliver`; one into the VM's library here is followed from this send on (uploads.ts).
  const vmHere = r.host === ctx.host && !!r.vm
  if (vmHere) uploadPending(ctx, r)
  const got = r.host === ctx.host ? await writeBytes(ctx, LOCAL, { workspaceId: r.workspace_id, ref: { at: 'file', host: r.host, path: r.path }, data, version: r.version }, METHOD) : await deliver(ctx, { ...r, vm: 0 }, data, false)
  // The linked file was renamed or moved there: the link has followed it (`deliver`), and this write goes there, once.
  if ('conflict' in got && 'gone' in got.conflict && got.conflict.movedTo && got.conflict.movedTo !== r.path) return putOver(ctx, { ...r, path: got.conflict.movedTo }, data)
  if ('conflict' in got) return { conflict: 'gone' in got.conflict ? { gone: true } : { changed: got.conflict.changed, version: got.conflict.version } }
  if ('copy' in got) throw new Error('The file was not written.')
  if (vmHere) uploadWrote(ctx, r)
  return { version: got.version }
}

/**
 * `work.files.saveAs`: the document as a new file in the folder, or over the file of that name already there on his
 * Replace, or beside it on his Keep Both; linked unless `link` is false.
 */
export async function saveAs(
  ctx: WorkCtx,
  by: Caller,
  p: { workspaceId: string; source: CanvasSource; at: FolderRef; name?: string; format: SaveAsFormat; link?: boolean; place?: string; computer?: string; exists?: 'replace' | 'keep'; version?: string; op: string },
  method = METHOD
): Promise<SavedAs> {
  if (by.kind === 'model') throw new Error(THREADS_BY_TOOLS)
  admitCaller(ctx, by, p.workspaceId)
  if (by.kind === 'remote' && !by.caps.includes('operate')) throw new Error('This key may not change files.')
  if (p.source.at === 'file' && p.source.host !== ctx.host) throw new Error(DOC_ELSEWHERE)
  if (!openIn(ctx, p.workspaceId, p.source)) throw new Error(NOT_OPEN_HERE)
  const source = attachmentFileIn(ctx, p.workspaceId, p.source) ?? p.source
  const made0 = makeFolderRef(ctx, by, p.at)
  // The workspace's own folder is a place by name: its path on this host.
  const home = made0.at === 'place' && made0.id === 'folder' ? workspaceHere(ctx.db, p.workspaceId)?.path : undefined
  const at = home ? { at: 'file' as const, host: ctx.host, path: home } : made0
  if (at.at !== 'file') throw new Error(NOT_A_FOLDER_HERE)
  const far = at.host !== ctx.host
  const here = far ? null : locate(ctx, by, p.workspaceId, at, method)
  const vm = here?.in === 'library' && here.library.vm === true
  // The door before anything is exported: a folder here as New's, one on another computer as his own edit there.
  if (far) admitOwner(by, { name: 'that folder', host: at.host })
  else if (admitChange(ctx, by, 'make', { workspaceId: p.workspaceId, refs: [at] }, method) === 'hold') throw new Error(HELD_BY_TOOLS)
  const file = linkableDoc(ctx, source)
  const doc = p.link === false ? null : file
  // The hold's race: a link counts the document shared from this press, before anything is exported, and an agent's
  // write begun while it was private is waited for; one that wrote straight in stops the press until he has seen it.
  const release = doc ? reserveLink(doc) : () => {}
  try {
    if (file && (await settlePrivateWrites(file))) throw new Error(AGENT_JUST_WROTE)
    return await saveAsReserved(ctx, by, p, { source, at, vm, doc })
  } finally {
    release()
  }
}

async function saveAsReserved(
  ctx: WorkCtx,
  by: Caller,
  p: Parameters<typeof saveAs>[2],
  { source, at, vm, doc }: { source: CanvasSource; at: FolderRef & { at: 'file' }; vm: boolean; doc: string | null }
): Promise<SavedAs> {
  // From here the document's edits go on to another file: a guest who could edit it views it instead, before anything is written.
  if (doc) await endGuestEditOn(ctx.db, canonicalPath(doc))
  // The revision written is the one read before the export: an edit after it is written next.
  const rev = doc ? await liveRev(ctx, doc).catch(() => null) : null
  const out = await exportBytes(ctx, source, p.format)
  const name = saveAsName(p.name?.trim() || out.name, p.format)
  const there: Spot = { workspace_id: p.workspaceId, host: at.host, path: join2(at.path, name, vm), vm: vm ? 1 : 0, name }
  const linkTo = async (made: { path: string; name: string; version: string }): Promise<void> => {
    if (!doc) return
    const place = p.place?.trim() || basename(at.path.replaceAll('\\', '/'))
    // One link a document and a file: the same file saved as again takes the link it has, in its turn, never a second writer.
    const had = ctx.db.prepare(`SELECT id FROM work_files_links WHERE doc = ? AND host = ? AND (path = ? OR (vm = 1 AND lower(path) = lower(?)))`).get(doc, at.host, made.path, made.path) as { id: string } | undefined
    if (had)
      await onRow(had.id, async () =>
        void ctx.db
          .prepare(`UPDATE work_files_links SET format = ?, path = ?, name = ?, place = ?, computer = ?, version = ?, sha = ?, saved_rev = ?, saved_at = ?, state = 'ok', changed_at = NULL, detail = NULL, seen_version = NULL, tried_sha = NULL WHERE id = ?`)
          .run(p.format, made.path, made.name, place, p.computer ?? null, made.version, shaOf(out.data), rev, Date.now(), had.id)
      )
    else
      ctx.db
        .prepare(
          `INSERT INTO work_files_links (id, workspace_id, doc, format, host, path, vm, name, place, computer, version, sha, saved_rev, saved_at, state, made_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)`
        )
        .run(randomUUID(), p.workspaceId, doc, p.format, at.host, made.path, vm ? 1 : 0, made.name, place, p.computer ?? null, made.version, shaOf(out.data), rev, Date.now(), Date.now())
    filesState(ctx).tabs.touch(p.workspaceId)
  }
  let made: { path: string; name: string; version: string }
  // The same press sent again (its answer was lost) is answered by what it made, never asked about the file it made.
  const again = p.exists !== 'replace' && (lostOps.has(p.op) || opKnown(ctx.db, p.op))
  const version = p.exists === 'keep' || again ? null : await versionNow(ctx, there)
  // The question names the version it found: his Replace writes over that one alone.
  if (version !== null && p.exists === undefined) return { exists: { name, version } }
  if (version !== null && p.exists === 'replace') {
    // His Replace: over the version its question showed him, by that version. None named (a window a release behind),
    // or a newer file there (a colleague saved while he read the question), is asked again, never written over.
    if (p.version !== version) return { exists: { name, version } }
    const got = await putOver(ctx, { ...there, version }, out.data)
    if ('conflict' in got) return 'gone' in got.conflict ? { exists: { name } } : { exists: { name, version: got.conflict.version } }
    made = { path: there.path, name, version: got.version }
    await linkTo(made)
  } else {
    // The same press again (its operation id) answers what it did: nothing is made, or linked, twice.
    made = await runOp(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb: 'saveAs', refs: { source: p.source, at, name, format: p.format } }, async () => {
      const got = await makeIn(ctx, by, { workspaceId: p.workspaceId, at, name, data: out.data, op: p.op, vm, linked: !!doc })
      lostOps.delete(p.op)
      await linkTo(got)
      return got
    })
  }
  return { saved: { name: made.name, ref: { at: 'file', host: at.host, path: made.path }, linked: !!doc } }
}

const inFlight = new Set<string>()
/** Each linked document's live revision when last seen, and since when: the pause is counted from it. */
const seenRevs = new Map<string, { rev: string; at: number }>()

/** How a link stands for the header: the record's state, and whether the document holds words the file does not yet. */
function viewOf(r: LinkRow): DocLink {
  const seen = seenRevs.get(r.doc)?.rev
  const behind = seen !== undefined && seen !== r.saved_rev
  const state: DocLink['state'] = r.state === 'ok' ? (inFlight.has(r.id) || behind ? 'saving' : 'saved') : r.state
  const folder = r.path.slice(0, Math.max(r.path.lastIndexOf('/'), r.path.lastIndexOf('\\')))
  return {
    id: r.id,
    name: r.name,
    format: r.format,
    place: r.place,
    ...(r.computer ? { computer: r.computer } : {}),
    ref: { at: 'file', host: r.host, path: r.path },
    folder: { at: 'file', host: r.host, path: folder },
    state,
    ...(r.state === 'changed' && r.seen_version ? { version: r.seen_version } : {}),
    ...(r.saved_at ? { at: r.saved_at } : {}),
    ...(r.changed_at ? { changedAt: r.changed_at } : {}),
    ...(r.detail ? { detail: r.detail } : {})
  }
}

/** `work.files.links`: the files a document is linked to, oldest first, as the header shows them. */
export function linksOf(ctx: WorkCtx, by: Caller, p: { workspaceId: string; source: CanvasSource }): DocLink[] {
  admitCaller(ctx, by, p.workspaceId)
  const doc = linkableDoc(ctx, attachmentFileIn(ctx, p.workspaceId, p.source) ?? p.source)
  if (!doc) return []
  const rows = ctx.db.prepare(`SELECT * FROM work_files_links WHERE workspace_id = ? AND doc = ? ORDER BY made_at`).all(p.workspaceId, doc) as unknown as LinkRow[]
  return rows.map(viewOf)
}

/** The words a link's line says, for the log. */
export const linkLine = (r: LinkRow): string => linkWords(viewOf(r), (at) => new Date(at).toISOString())

/**
 * `work.files.linkAct`: his press on a link. `unlink` stops it and leaves the file as it is; `retry` writes it again now;
 * `replace` writes the document over the file as it is there now (after a change made there); `keep` puts the
 * document beside it under a free name and links that file instead.
 */
export async function linkAct(ctx: WorkCtx, by: Caller, p: { workspaceId: string; id: string; act: 'unlink' | 'retry' | 'replace' | 'keep'; version?: string }): Promise<DocLink[]> {
  if (by.kind === 'model') throw new Error(THREADS_BY_TOOLS)
  admitCaller(ctx, by, p.workspaceId)
  const r = rowOf(ctx, p.id)
  if (!r || r.workspace_id !== p.workspaceId) throw new Error('That file is no longer linked.')
  admitOwner(by, r)
  const source: CanvasSource = { at: 'file', host: ctx.host, path: r.doc }
  // In the row's turn (audit A5): a write of it under way lands first, and its outcome is what this press acts on.
  const stale = await onRow(r.id, () => actOn(ctx, r.id, p))
  if (stale) return stale
  filesState(ctx).tabs.touch(p.workspaceId)
  return linksOf(ctx, by, { workspaceId: p.workspaceId, source })
}

/** His press on one link, in its row's turn; answers the links when the press found a newer change to show instead. */
async function actOn(ctx: WorkCtx, id: string, p: { workspaceId: string; act: 'unlink' | 'retry' | 'replace' | 'keep'; version?: string }): Promise<DocLink[] | null> {
  const r = rowOf(ctx, id)
  // Unlinked meanwhile (his other window): nothing to act on.
  if (!r) return null
  const source: CanvasSource = { at: 'file', host: ctx.host, path: r.doc }
  if (p.act === 'unlink') {
    ctx.db.prepare(`DELETE FROM work_files_links WHERE id = ?`).run(r.id)
  } else if (p.act === 'keep') {
    // The revision the export is made of, read before it: an edit while it runs is written next, never marked saved.
    const rev = await liveRev(ctx, r.doc).catch(() => null)
    const out = await exportBytes(ctx, source, r.format)
    const folder = r.path.slice(0, Math.max(r.path.lastIndexOf('/'), r.path.lastIndexOf('\\')))
    const made = await makeIn(ctx, LOCAL, { workspaceId: r.workspace_id, at: { at: 'file', host: r.host, path: folder }, name: r.name, data: out.data, op: randomUUID(), vm: r.vm === 1, linked: true })
    ctx.db
      .prepare(`UPDATE work_files_links SET path = ?, name = ?, version = ?, sha = ?, saved_rev = ?, saved_at = ?, state = 'ok', changed_at = NULL, detail = NULL WHERE id = ?`)
      .run(made.path, made.name, made.version, shaOf(out.data), rev, Date.now(), r.id)
  } else {
    if (p.act === 'replace') {
      const version = await versionNow(ctx, r)
      if (version === null) throw new Error(`${r.name} is not in ${r.place} any more: Keep Both saves it there again.`)
      // His Replace goes over the change the link showed him (its `version`) and no later one: that is shown instead.
      if (p.version !== version) {
        ctx.db.prepare(`UPDATE work_files_links SET state = 'changed', seen_version = ?, changed_at = ? WHERE id = ?`).run(version, Date.now(), r.id)
        filesState(ctx).tabs.touch(p.workspaceId)
        return linksOf(ctx, LOCAL, { workspaceId: p.workspaceId, source })
      }
      ctx.db.prepare(`UPDATE work_files_links SET version = ?, seen_version = NULL, state = 'ok', changed_at = NULL, detail = NULL WHERE id = ?`).run(version, r.id)
    } else ctx.db.prepare(`UPDATE work_files_links SET state = 'ok', detail = NULL WHERE id = ?`).run(r.id)
    await writeLinkNow(ctx, r.id, await liveRev(ctx, r.doc).catch(() => null))
  }
  return null
}

/**
 * Each link row's presses and writes, one at a time (audit A5): Keep Both, Replace and Unlink wait for a write of it
 * under way, and a write that waited reads the row as it is then, so an older write never lands its receipt on a row a
 * press moved to another file, and Unlink answers only once a send that may have landed has.
 */
const rowTurns = new Map<string, Promise<unknown>>()
function onRow<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (rowTurns.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn)
  const tail = run.catch(() => undefined)
  rowTurns.set(id, tail)
  void tail.then(() => rowTurns.get(id) === tail && rowTurns.delete(id))
  return run
}

/** The version the file has there when it holds the link's own write whose answer was lost (`tried_sha`); else null. */
async function ownWriteThere(ctx: WorkCtx, r: LinkRow): Promise<string | null> {
  if (!r.tried_sha) return null
  if (r.host === ctx.host && !r.vm) {
    const v = await versionOf(r.path)
    return v.sha256 === r.tried_sha ? versionWord(v) : null
  }
  const there = await freshBytes(ctx, r)
  return shaOf(there.data) === r.tried_sha ? there.version : null
}

/** One write of a linked file, in its row's turn. */
function writeLink(ctx: WorkCtx, r: LinkRow, rev: string | null): Promise<void> {
  return onRow(r.id, () => writeLinkNow(ctx, r.id, rev))
}

/** One write of a linked file: the document exported now and written over the file by the version last written. */
async function writeLinkNow(ctx: WorkCtx, id: string, rev: string | null): Promise<void> {
  // The row as it is in this turn: unlinked, or stopped by a change made there, it is not written.
  const r = rowOf(ctx, id)
  if (!r || (r.state !== 'ok' && r.state !== 'waiting') || inFlight.has(r.id)) return
  inFlight.add(r.id)
  filesState(ctx).tabs.touch(r.workspace_id)
  const now = Date.now()
  try {
    const out = await exportBytes(ctx, { at: 'file', host: ctx.host, path: r.doc }, r.format)
    // A lost answer (audit A4): the link's own earlier write found there is written over by the version it holds now,
    // and these bytes are kept until this write's answer. Anyone else's bytes there are still a change made there.
    const own = await ownWriteThere(ctx, r).catch(() => null)
    ctx.db.prepare(`UPDATE work_files_links SET tried_sha = ? WHERE id = ?`).run(shaOf(out.data), r.id)
    const got = await putOver(ctx, own ? { ...r, version: own } : r, out.data)
    if ('conflict' in got) {
      // A change made there, or the file gone: nothing is written over it until his press.
      if ('gone' in got.conflict) ctx.db.prepare(`UPDATE work_files_links SET state = 'gone', changed_at = ?, tried_at = ? WHERE id = ?`).run(now, now, r.id)
      else ctx.db.prepare(`UPDATE work_files_links SET state = 'changed', seen_version = ?, changed_at = ?, tried_at = ? WHERE id = ?`).run(got.conflict.version, got.conflict.changed, now, r.id)
    } else {
      ctx.db
        .prepare(`UPDATE work_files_links SET version = ?, sha = ?, saved_rev = ?, saved_at = ?, state = 'ok', changed_at = NULL, detail = NULL, tried_at = ?, tried_sha = NULL WHERE id = ?`)
        .run(got.version, shaOf(out.data), rev, Date.now(), now, r.id)
    }
  } catch (err) {
    const words = err instanceof Error ? err.message : String(err)
    // A place that does not answer keeps the document as it is, and is tried again; anything else is said, with Retry.
    if (unreachable(err)) ctx.db.prepare(`UPDATE work_files_links SET state = 'waiting', tried_at = ? WHERE id = ?`).run(now, r.id)
    else ctx.db.prepare(`UPDATE work_files_links SET state = 'refused', detail = ?, tried_at = ? WHERE id = ?`).run(words.slice(0, 300), now, r.id)
    ctx.log(`files: a linked file was not written: ${words}`)
  } finally {
    inFlight.delete(r.id)
    filesState(ctx).tabs.touch(r.workspace_id)
  }
}

function linkRows(ctx: WorkCtx, doc: string): LinkRow[] {
  return ctx.db.prepare(`SELECT * FROM work_files_links WHERE doc = ? AND state IN ('ok', 'waiting')`).all(doc) as unknown as LinkRow[]
}

function observeLinks(ctx: WorkCtx, doc: string, links: LinkRow[], rev: string, now: number): boolean {
  const prior = seenRevs.get(doc)?.rev
  const dirty = links.filter((r) => r.saved_rev !== rev)
  if (prior !== rev) {
    seenRevs.set(doc, { rev, at: now })
    const changed = links.filter((r) => (prior !== undefined && prior !== r.saved_rev) !== (rev !== r.saved_rev))
    for (const workspaceId of new Set(changed.map((r) => r.workspace_id))) filesState(ctx).tabs.touch(workspaceId)
  }
  return dirty.some((r) => r.state === 'ok' || now - (r.tried_at ?? 0) >= linkTiming.retry)
}

export function noteLinkRevision(ctx: WorkCtx, { doc, rev }: DocRevision, now: number): boolean {
  const links = linkRows(ctx, doc)
  return links.length > 0 && observeLinks(ctx, doc, links, rev, now)
}

export async function saveLinkRevision(ctx: WorkCtx, doc: string, now: number, active = () => true): Promise<void> {
  const seen = seenRevs.get(doc)
  if (!seen || now - seen.at < wordTiming.pause) return
  for (const r of linkRows(ctx, doc)) {
    if (!active() || seen !== seenRevs.get(doc)) return
    if (r.saved_rev === seen.rev || inFlight.has(r.id)) continue
    if (r.state === 'waiting' && now - (r.tried_at ?? 0) < linkTiming.retry) continue
    const latest = rowOf(ctx, r.id)
    if (latest?.doc === doc && latest.version === r.version && latest.state === r.state) await writeLink(ctx, latest, seen.rev)
  }
}

/** A recoverable missed notification or a linked place that was away gets another look. */
export async function autosaveLinks(ctx: WorkCtx, now = Date.now(), found?: (notice: DocRevision) => void): Promise<void> {
  const docs = ctx.db.prepare(`SELECT DISTINCT doc FROM work_files_links WHERE state IN ('ok', 'waiting')`).all() as { doc: string }[]
  for (const { doc } of docs) {
    const before = seenRevs.get(doc)
    const rev = await liveRev(ctx, doc).catch(() => null)
    if (rev === null || before !== seenRevs.get(doc)) continue
    if (found) found({ doc, rev })
    else {
      const links = linkRows(ctx, doc)
      observeLinks(ctx, doc, links, rev, now)
      await saveLinkRevision(ctx, doc, now)
    }
  }
}

/** Forget what was seen (tests). */
export function resetLinkState(): void {
  seenRevs.clear()
  inFlight.clear()
  rowTurns.clear()
}
