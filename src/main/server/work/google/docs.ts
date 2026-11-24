import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileDocName } from 'work-kit/collab-server'
import { everyBlock, plain, type Block } from 'work-kit/formats'
import type { CanvasSource } from '@shared/work'
import { counted, quoted } from '@shared/work/changeWords'
import type { WorkCtx } from '../modules'
import { ensureThreadTables } from '../docs/threads'
import { GoogleError, GOOGLE_MIME, type GoogleApi } from './client'
import { mapGoogleDoc } from './mapper'
import { baseOf, planSuggest, planWrite, rebase, unsentCount, type BaseParagraph, type DocBase } from './write'
import type { Google } from './google'

/**
 * A Google Doc in the document canvas (docs/agents/work-google.md "Docs"):
 * read when it is opened, never mirrored live. The Doc is read through the
 * Docs API with its comments and suggestions and written as a `.tcdoc` of
 * its own under `<dataDir>/google/` (the mirror), which the document kind
 * opens as it opens any `.tcdoc`. Google stays the truth: his edits in the
 * mirror go back by `batchUpdate` when he writes them (write.ts), an
 * agent's only when he approves them (a held `google.edit`), and the mirror is read again when the
 * Doc moved in Google and nothing of his waits to be written.
 */

export type GoogleSource = Extract<CanvasSource, { at: 'google' }>

/** What a Doc's mirror needs of the Work service: its blocks as they stand (the service route; a test's own). */
export type BlocksOf = (ctx: WorkCtx, mirror: string) => Promise<Block[]>
export const serviceBlocks: BlocksOf = async (ctx, mirror) => ((await ctx.service.internal('/internal/google/blocks', { file: mirror, fence: { sectors: 'all' } })) as { blocks: Block[] }).blocks

const IMAGE_MAX = 4 * 1024 * 1024

/** Each image's address lives 30 minutes and carries his access: fetched at once and kept in the mirror. */
async function keepImages(blocks: Block[], fetchImage: typeof fetch, drop: (k: string) => void): Promise<void> {
  for (const b of everyBlock(blocks)) {
    if (b.type !== 'image') continue
    const url = String(b.props.url ?? '')
    b.props.url = ''
    if (!/^https:\/\//i.test(url)) continue
    try {
      const res = await fetchImage(url)
      const bytes = Buffer.from(await res.arrayBuffer())
      const type = res.headers.get('content-type') ?? ''
      if (!res.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) drop('imageUnread')
      else if (bytes.length > IMAGE_MAX) drop('imageTooBig')
      else b.props.url = `data:${type};base64,${bytes.toString('base64')}`
    } catch {
      drop('imageUnread')
    }
  }
}

/** One open or write at a time per file: a second waits for the first, so two never read or write past each other. */
const locks = new Map<string, Promise<unknown>>()
function locked<T>(source: GoogleSource, run: () => Promise<T>): Promise<T> {
  const key = `${source.account.toLowerCase()}/${source.fileId}`
  const next = (locks.get(key) ?? Promise.resolve()).then(run, run)
  const kept = next.catch(() => {})
  locks.set(key, kept)
  void kept.then(() => locks.get(key) === kept && locks.delete(key))
  return next
}

/**
 * The mirror an opened Doc's item reads. `fresh` (opening the item, or Read again) asks Drive whether
 * the Doc moved: the mirror is kept while it has not, or while his edits wait to be written (the item
 * then says Google moved); else a new one is read now. Any other call takes the mirror there is.
 */
export function docMirror(ctx: WorkCtx, g: Google, source: GoogleSource, fresh = true): Promise<string> {
  if (source.mime !== GOOGLE_MIME.doc) throw new Error('That Google file is not a Doc.')
  return locked(source, () => mirrorNow(ctx, g, source, fresh))
}

/** Reads the Doc anew whatever the mirror holds: Read again, after he chose to drop what was not written. */
export function rereadDoc(ctx: WorkCtx, g: Google, source: GoogleSource): Promise<string> {
  return locked(source, async () => {
    const api = g.api(source.account)
    const file = await api.file(source.fileId)
    return importDoc(ctx, g, api, source, file.name, file.version, g.files.get(source.account, source.fileId)?.mirror ?? null)
  })
}

async function mirrorNow(ctx: WorkCtx, g: Google, source: GoogleSource, fresh: boolean): Promise<string> {
  const known = g.files.get(source.account, source.fileId)
  if (!fresh && known?.mirror && existsSync(known.mirror)) return known.mirror
  const api = g.api(source.account)
  const file = await api.file(source.fileId)
  const row = g.files.get(source.account, source.fileId)
  if (row?.mirror && existsSync(row.mirror)) {
    if (row.version === file.version) return row.mirror
    if ((await unsentEdits(ctx, g, row.mirror, row.base)) > 0) {
      g.files.update(source.account, source.fileId, { behind: file.version })
      return row.mirror
    }
  }
  return importDoc(ctx, g, api, source, file.name, file.version, row?.mirror ?? null)
}

async function importDoc(ctx: WorkCtx, g: Google, api: GoogleApi, source: GoogleSource, name: string, version: string, old: string | null): Promise<string> {
  const json = await api.doc(source.fileId)
  const mapped = mapGoogleDoc(json)
  await keepImages(mapped.imported.blocks, g.fetch, (k) => void (mapped.imported.sidecar.dropped[k] = (mapped.imported.sidecar.dropped[k] ?? 0) + 1))
  mapped.imported.sidecar.source = { name, format: 'google', importedAt: Date.now() }
  const folder = join(ctx.dataDir, 'google', createHash('sha256').update(`${source.account.toLowerCase()}/${source.fileId}`).digest('hex').slice(0, 20))
  // A new file each time: a window still on the old mirror keeps it until it reopens.
  const path = join(folder, `${Date.now().toString(36)}.tcdoc`)
  const { writeImportedTcdoc } = await import('work-kit/formats/tcdoc')
  const made = await writeImportedTcdoc(path, mapped.imported, { principal: 'owner' })
  ensureThreadTables(ctx.db)
  ctx.db.prepare('INSERT OR REPLACE INTO work_docs_threads (doc, rows) VALUES (?, ?)').run(fileDocName(path), JSON.stringify(made.threads))
  // The hashes are taken from the mirror as the Work service reads it back, so an untouched block compares equal.
  const served = await g.blocksOf(ctx, path).catch(() => null)
  g.files.put({ account: source.account, fileId: source.fileId, kind: 'doc', name, version, mirror: path, base: baseOf(mapped.imported.blocks, mapped.paragraphs, served), behind: null })
  if (old && old !== path) {
    rmSync(old, { force: true })
    ctx.db.prepare('DELETE FROM work_docs_threads WHERE doc = ?').run(fileDocName(old))
  }
  ctx.log(`google: read ${name} (${made.threads.length} comment threads, ${made.branches.length} authors of suggestions)`)
  return path
}

/** How many blocks his edits changed, added or removed since the mirror last matched Google. */
export async function unsentEdits(ctx: WorkCtx, g: Google, mirror: string, base: DocBase | null): Promise<number> {
  return base ? unsentCount(base, await g.blocksOf(ctx, mirror)) : 0
}

export interface DocWritten {
  changed: number
  added: number
  removed: number
  /** what was not written, and why, one line each */
  refused: string[]
}

/** His edits in the mirror, written to Google in one `batchUpdate` against the revision just read. */
export function writeDoc(ctx: WorkCtx, g: Google, source: GoogleSource): Promise<DocWritten> {
  return locked(source, () => writeNow(ctx, g, source))
}

async function writeNow(ctx: WorkCtx, g: Google, source: GoogleSource): Promise<DocWritten> {
  const api = g.api(source.account)
  for (let attempt = 0; ; attempt++) {
    const row = g.files.get(source.account, source.fileId)
    if (!row?.mirror || !row.base) throw new Error('Open the Doc first.')
    const current = await g.blocksOf(ctx, row.mirror)
    const fresh = await api.doc(source.fileId)
    if (!fresh.revisionId) throw new GoogleError('Google lets this account read the Doc but not change it.', 'refused')
    const plan = planWrite(row.base, current, mapGoogleDoc(fresh).paragraphs)
    const said = (blockId: string): string => {
      const b = [...everyBlock(current)].find((x) => x.id === blockId)
      const words = b && Array.isArray(b.content) ? plain(b.content).slice(0, 60) : ''
      return words ? `“${words}”` : 'A block'
    }
    const refused = plan.refused.map((r) => `${said(r.blockId)}: ${r.why}`)
    if (!plan.requests.length) return { changed: 0, added: 0, removed: 0, refused }
    // A paragraph the write leaves keeps its old base: it stays his, and is never taken for Google's.
    const kept: Record<string, BaseParagraph> = {}
    for (const r of plan.refused) if (row.base.paragraphs[r.blockId]) kept[r.blockId] = row.base.paragraphs[r.blockId]
    try {
      await api.docUpdate(source.fileId, plan.requests, { requiredRevisionId: fresh.revisionId })
    } catch (err) {
      // Someone wrote between the read and the write: read again, once.
      if (err instanceof GoogleError && err.code === 'conflict' && attempt === 0) continue
      // The write may have landed with its answer lost: match the base to Google before anything is written again.
      await settle(g, source, current, kept).catch(() => {})
      throw err
    }
    await settle(g, source, current, kept)
    return { changed: plan.changed, added: plan.added, removed: plan.removed, refused }
  }
}

/** The base after a write, matched to the Doc as Google has it now; its version is this host's own. */
async function settle(g: Google, source: GoogleSource, current: Block[], kept: Record<string, BaseParagraph>): Promise<void> {
  const api = g.api(source.account)
  const version = (await api.file(source.fileId)).version
  const after = await api.doc(source.fileId)
  g.files.update(source.account, source.fileId, { base: rebase(current, mapGoogleDoc(after).paragraphs, kept), version, ours: version, behind: null })
}

/**
 * Where an agent's edits to a Doc stand now: each `find` must stand once in a plain paragraph. Nothing is sent to
 * Google: the edits wait on his host as a held `google.edit` (the owner's ruling of 2026-11-23), so no suggestion
 * of the agent's is ever in the Doc for others to see. Answers the revision it was judged on.
 */
export async function checkEdits(g: Google, source: GoogleSource, edits: readonly { find: string; replace: string }[]): Promise<{ revisionId: string; within: string[]; tabs: string[]; at: number[] }> {
  const fresh = await g.api(source.account).doc(source.fileId)
  if (!fresh.revisionId) throw new GoogleError('Google lets this account read the Doc but not change it.', 'refused')
  const paragraphs = mapGoogleDoc(fresh).paragraphs
  const plan = planSuggest(paragraphs, edits)
  if ('error' in plan) throw new Error(plan.error)
  const at = edits.map((e) => paragraphs.find((p) => p.text.includes(e.find))!)
  return { revisionId: fresh.revisionId, within: at.map((p) => p.text), tabs: at.map((p) => p.tabId), at: at.map((p) => paragraphs.indexOf(p)) }
}

/**
 * His press on a held `google.edit`: the edits written as plain edits, against the Doc as Google has it now, in
 * one `batchUpdate` bound to the revision just read. `stale` when a `find` no longer stands once; `moved` when
 * the Doc changed since the edits were judged, though each still stood once.
 */
export function writeEdits(g: Google, source: GoogleSource, edits: readonly { find: string; replace: string; within?: string; tab?: string; at?: number }[], judgedOn: string): Promise<{ stale: string } | { moved: boolean }> {
  return locked(source, async () => {
    const api = g.api(source.account)
    const fresh = await api.doc(source.fileId)
    if (!fresh.revisionId) throw new GoogleError('Google lets this account read the Doc but not change it.', 'refused')
    const paragraphs = mapGoogleDoc(fresh).paragraphs
    const plan = planSuggest(paragraphs, edits)
    if ('error' in plan) {
      // in his words, not the agent's: which change no longer fits, and why
      const words = quoted(edits[plan.at]?.find ?? '')
      const why = { none: `${words} is no longer in the Doc`, many: `${words} now stands in ${counted(plan.hits, 'place')}`, chip: `${words} now sits in a paragraph with a chip or a waiting suggestion`, overlap: `two of its changes now touch ${words}` }
      return { stale: why[plan.why] }
    }
    // The words he was shown, in the paragraph he was shown: moved to another passage, they are not what he approved.
    // The same paragraph's words in another tab are another passage too.
    const strayed =
      fresh.revisionId === judgedOn
        ? undefined
        : edits.find((e) => {
            const p = paragraphs.find((x) => x.text.includes(e.find))
            return (e.within !== undefined && p?.text !== e.within) || (e.tab !== undefined && p?.tabId !== e.tab) || (e.at !== undefined && (p ? paragraphs.indexOf(p) : -1) !== e.at)
          })
    if (strayed) return { stale: `${quoted(strayed.find)} now stands in another passage than the one shown` }
    // Held before its place in the Doc was kept (its tab and its paragraph's place, round 2), on a Doc that changed
    // since: where it stood cannot be told now, so it is asked for again rather than written where the words are now.
    const unplaced = fresh.revisionId === judgedOn ? undefined : edits.find((e) => e.tab === undefined || e.at === undefined)
    if (unplaced) return { stale: `${quoted(unplaced.find)} was held before its place in the Doc was kept, and the Doc changed since: ask the thread again` }
    await api.docUpdate(source.fileId, plan.requests, { requiredRevisionId: fresh.revisionId })
    return { moved: fresh.revisionId !== judgedOn }
  })
}

/** The Doc as an agent reads it: its words by paragraph, then its open comments and waiting suggestions. */
export async function readDoc(g: Google, source: GoogleSource): Promise<string> {
  const json = await g.api(source.account).doc(source.fileId)
  const m = mapGoogleDoc(json)
  const lines = [...everyBlock(m.imported.blocks)].map((b) => {
    const text = Array.isArray(b.content) ? plain(b.content) : ''
    if (b.type === 'heading') return `${'#'.repeat(Number(b.props.level) || 1)} ${text}`
    if (b.type.endsWith('ListItem')) return `- ${text}`
    if (b.type === 'table') return '[table]'
    if (b.type === 'image') return '[picture]'
    return text
  })
  const open = m.imported.sidecar.threads.filter((t) => !t.resolved)
  const notes = open.map((t) => `- on “${t.quote}”: ${t.comments.map((c) => `${c.author}: ${plain(c.body[0]?.content as never)}`).join(' / ')}`)
  const sugg = m.imported.sidecar.changes.map((c) => `- ${c.author} suggests ${c.kind === 'insert' ? 'adding' : c.kind === 'delete' ? 'removing' : 'restyling'} “${c.text}”`)
  return [`# ${json.title}`, '', ...lines, ...(notes.length ? ['', 'Open comments:', ...notes] : []), ...(sugg.length ? ['', 'Waiting suggestions:', ...sugg] : [])].join('\n')
}
