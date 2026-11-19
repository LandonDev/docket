import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileDocName } from 'work-kit/collab-server'
import { everyBlock, plain, type Block } from 'work-kit/formats'
import type { CanvasSource } from '@shared/work'
import type { WorkCtx } from '../modules'
import { ensureThreadTables } from '../docs/threads'
import { GoogleError, GOOGLE_MIME, type GoogleApi } from './client'
import { mapGoogleDoc } from './mapper'
import { baseOf, planSuggest, planWrite, rebase, type DocBase } from './write'
import type { Google } from './google'

/**
 * A Google Doc in the document canvas (docs/agents/work-google.md "Docs"):
 * read when it is opened, never mirrored live. The Doc is read through the
 * Docs API with its comments and suggestions and written as a `.tcdoc` of
 * its own under `<dataDir>/google/` (the mirror), which the document kind
 * opens as it opens any `.tcdoc`. Google stays the truth: his edits in the
 * mirror go back by `batchUpdate` when he writes them (write.ts), an
 * agent's only as Google suggestions, and the mirror is read again when the
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

/**
 * The mirror an opened Doc's item reads: the one already made while the Doc has not moved in Google,
 * or while his edits wait to be written (the item then says Google moved); else a new one, read now.
 */
export async function docMirror(ctx: WorkCtx, g: Google, source: GoogleSource): Promise<string> {
  if (source.mime !== GOOGLE_MIME.doc) throw new Error('That Google file is not a Doc.')
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
  g.files.put({ account: source.account, fileId: source.fileId, kind: 'doc', name, version, mirror: path, base: baseOf(mapped.imported.blocks, mapped.paragraphs), behind: null })
  if (old && old !== path) {
    rmSync(old, { force: true })
    ctx.db.prepare('DELETE FROM work_docs_threads WHERE doc = ?').run(fileDocName(old))
  }
  ctx.log(`google: read ${name} (${made.threads.length} comment threads, ${made.branches.length} authors of suggestions)`)
  return path
}

/** How many blocks his edits changed, added or removed since the mirror last matched Google. */
export async function unsentEdits(ctx: WorkCtx, g: Google, mirror: string, base: DocBase | null): Promise<number> {
  if (!base) return 0
  const blocks = [...everyBlock(await g.blocksOf(ctx, mirror))]
  const seen = new Set(blocks.map((b) => b.id))
  let n = 0
  for (const b of blocks) {
    const p = base.paragraphs[b.id]
    if (p ? p.text !== (Array.isArray(b.content) ? plain(b.content) : '') : !(b.id in base.others)) n++
  }
  for (const id of Object.keys(base.paragraphs)) if (!seen.has(id)) n++
  return n
}

export interface DocWritten {
  changed: number
  added: number
  removed: number
  /** what was not written, and why, one line each */
  refused: string[]
}

/** His edits in the mirror, written to Google in one `batchUpdate` against the revision just read. */
export async function writeDoc(ctx: WorkCtx, g: Google, source: GoogleSource): Promise<DocWritten> {
  const row = g.files.get(source.account, source.fileId)
  if (!row?.mirror || !row.base) throw new Error('Open the Doc first.')
  const api = g.api(source.account)
  const current = await g.blocksOf(ctx, row.mirror)
  for (let attempt = 0; ; attempt++) {
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
    try {
      await api.docUpdate(source.fileId, plan.requests, { requiredRevisionId: fresh.revisionId })
    } catch (err) {
      // Someone wrote between the read and the write: read again, once.
      if (err instanceof GoogleError && err.code === 'conflict' && attempt === 0) continue
      throw err
    }
    const after = await api.doc(source.fileId)
    const version = (await api.file(source.fileId)).version
    g.files.update(source.account, source.fileId, { base: rebase(current, mapGoogleDoc(after).paragraphs), version, ours: version, behind: null })
    return { changed: plan.changed, added: plan.added, removed: plan.removed, refused }
  }
}

/** An agent's edits, as Google suggestions he accepts or rejects in Google or here. */
export async function suggestDoc(g: Google, source: GoogleSource, edits: { find: string; replace: string }[]): Promise<number> {
  const api = g.api(source.account)
  const fresh = await api.doc(source.fileId)
  if (!fresh.revisionId) throw new GoogleError('Google lets this account read the Doc but not suggest in it.', 'refused')
  const plan = planSuggest(mapGoogleDoc(fresh).paragraphs, edits)
  if ('error' in plan) throw new Error(plan.error)
  await api.docUpdate(source.fileId, plan.requests, { requiredRevisionId: fresh.revisionId, writeMode: 'SUGGEST' })
  return edits.length
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
