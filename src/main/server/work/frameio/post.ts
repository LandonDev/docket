import { randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { MediaShapeSchema } from '@shared/contract-work-media'
import type { FrameioPost } from '@shared/contract-work-frameio'
import { liveOf as mediaOf, pushSoon } from '../media/view'
import type { ActKindDef, WorkCtx } from '../modules'
import { ActStale } from '../outbox/kinds'
import { frameioConfig } from './auth'
import { mediaServes } from '../../media'
import { FrameioError, seg, type FrameioApi } from './api'
import { annotationOf, commentBody } from './map'
import { frameioItem, frameioOf, saveItem } from './live'
import { syncComments } from './media'

/**
 * `frameio.post`, the one outward act of the pillar
 * (docs/agents/work-frameio.md, "Held"): an agent's comment at a frame, or a
 * new version on top of a stack, waits in the Outbox with exactly what will
 * go and goes on the person's press. No matcher: nothing posted to a review
 * others read goes on a grant.
 */

const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
export const FrameioPostSchema: z.ZodType<FrameioPost> = z.discriminatedUnion('what', [
  z.object({
    what: z.literal('comment'),
    account: z.string(),
    fileId: z.string(),
    fileName: z.string(),
    text: z.string().min(1).max(40_000),
    frame: z.number().int().nonnegative().optional(),
    durationFrames: z.number().int().positive().optional(),
    clock: z.string().max(40).optional(),
    pin: point.optional(),
    shapes: z.array(MediaShapeSchema).max(200).optional(),
    height: z.number().int().positive().optional(),
    itemId: z.string().optional(),
    noteId: z.string().optional()
  }),
  z.object({ what: z.literal('version'), account: z.string(), onto: z.string(), ontoName: z.string(), from: z.string(), path: z.string(), name: z.string(), size: z.number().int().nonnegative(), itemId: z.string().optional() })
])

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function postWords(p: FrameioPost): { summary: string; verb: string } {
  // The file by its name: the local path it came from is the host's business, never the title.
  if (p.what === 'version') return { summary: `Add ${p.name} as the next version of ${p.ontoName} in Frame.io`, verb: 'Upload' }
  const lossy = p.shapes?.length ? annotationOf(p.shapes, p.height ?? 1080).lossy : []
  return { summary: `Comment on ${p.fileName}${p.clock ? ` at ${p.clock}` : ''}: “${clip(p.text, 60)}”${lossy.length ? ` (${lossy.join('; ')})` : ''}`, verb: 'Post' }
}

const UPLOAD_WAIT_MS = 10 * 60_000

/** Uploads the file's bytes to each part address Frame.io gave, in order, and waits for Frame.io to say it has them all. */
async function upload(api: FrameioApi, account: string, folder: string, p: Extract<FrameioPost, { what: 'version' }>): Promise<string> {
  const size = statSync(p.path).size
  if (size !== p.size) throw new ActStale(`${p.name} changed since it was held. Nothing was uploaded.`)
  const made = await api.localUpload(account, folder, p.name, size)
  const fd = openSync(p.path, 'r')
  try {
    let at = 0
    for (const part of made.upload_urls) {
      const buf = Buffer.alloc(part.size)
      const got = readSync(fd, buf, 0, part.size, at)
      at += got
      const res = await frameioConfig.fetch(part.url, { method: 'PUT', headers: { 'x-amz-acl': 'private', 'Content-Type': made.media_type ?? 'application/octet-stream' }, body: buf.subarray(0, got) })
      if (!res.ok) throw new Error(`Frame.io refused a part of ${p.name} (${res.status})`)
    }
  } finally {
    closeSync(fd)
  }
  const until = Date.now() + UPLOAD_WAIT_MS
  for (let wait = 500; ; wait = Math.min(wait * 2, 10_000)) {
    const s = await api.uploadStatus(account, made.id)
    if (s.upload_complete) return made.id
    if (s.upload_failed) throw new Error(`Frame.io says the upload of ${p.name} failed`)
    if (Date.now() > until) throw new Error(`Frame.io did not finish taking ${p.name} in ten minutes`)
    await new Promise((r) => setTimeout(r, wait))
  }
}

/** Puts a new file on top of `onto`'s stack, making the stack when `onto` stands alone. Answers the new file's id and its stack's. */
export async function addVersion(ctx: WorkCtx, p: Extract<FrameioPost, { what: 'version' }>): Promise<{ id: string; stackId: string }> {
  const { api } = frameioOf(ctx)
  const onto = await api.file(p.account, p.onto).catch((err) => {
    if (err instanceof FrameioError && err.status === 404) throw new ActStale(`${p.ontoName} is no longer in Frame.io. Nothing was uploaded.`)
    throw err
  })
  if (!onto.parent_id) throw new Error(`Frame.io did not say where ${p.ontoName} is`)
  const stacked = await api.isStack(p.account, onto.parent_id)
  const folder = stacked ? ((await api.call<{ parent_id?: string }>('GET', `/accounts/${seg(p.account)}/version_stacks/${seg(onto.parent_id)}`)).parent_id ?? '') : onto.parent_id
  if (!folder) throw new Error(`Frame.io did not say which folder holds ${p.ontoName}`)
  const id = await upload(api, p.account, folder, p)
  // The migration guide's way: upload into the stack's folder, then move the file into the stack.
  if (stacked) {
    await api.moveFile(p.account, id, onto.parent_id)
    return { id, stackId: onto.parent_id }
  }
  return { id, stackId: (await api.makeStack(p.account, folder, [onto.id, id])).id }
}

/** Where a held version's copy waits: under the host's data folder, one folder per hold. */
export const heldDir = (dataDir: string): string => join(dataDir, 'work-frameio', 'held')

/**
 * Copies a file named for upload into the held folder: only a file the
 * media host would show (by its real path, so a link pointing out is out),
 * so the bytes pressed are the bytes named.
 */
export function holdCopy(dataDir: string, file: string): { path: string; size: number } {
  if (!mediaServes(file)) throw new Error(`${file} is outside the folders this host shows; put the file in the workspace first`)
  const dir = join(heldDir(dataDir), randomUUID())
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, basename(file))
  copyFileSync(realpathSync(file), path)
  return { path, size: statSync(path).size }
}

/** A held copy goes once its post is sent or given up. */
function dropCopy(dataDir: string, p: FrameioPost): void {
  if (p.what !== 'version' || dirname(dirname(p.path)) !== heldDir(dataDir)) return
  rmSync(dirname(p.path), { recursive: true, force: true })
}

export const frameioPostKind: ActKindDef<FrameioPost, never> = {
  kind: 'frameio.post',
  store: 'host',
  payload: FrameioPostSchema,
  words: postWords,
  async execute(p, act) {
    if (!frameioConfig.tokens.read()) throw new ActStale('Frame.io is not signed in on this host. Nothing was posted.')
    if (p.what === 'version') {
      const { id, stackId } = await addVersion(act, p)
      dropCopy(act.dataDir, p)
      const row = p.itemId ? frameioItem(act.db, p.itemId) : null
      if (row && p.itemId) {
        mediaOf(act).store.addVersion(p.itemId, { source: { at: 'frameio', account: p.account, fileId: id }, name: p.name, by: 'owner' })
        saveItem(act.db, { ...row, stackId, fileIds: [...row.fileIds, id] })
        pushSoon(act, p.itemId)
      }
      return { summary: `Added ${p.name} to ${p.ontoName} in Frame.io`, ref: { fileId: id } }
    }
    const made = await frameioOf(act).api.createComment(p.account, p.fileId, commentBody(p)).catch((err) => {
      if (err instanceof FrameioError && err.status === 404) throw new ActStale(`${p.fileName} is no longer in Frame.io. Nothing was posted.`)
      throw err
    })
    // The waiting note becomes Frame.io's comment: the next read brings it back as the posted one.
    if (p.itemId) {
      const { store } = mediaOf(act)
      if (p.noteId && store.note(p.noteId)) store.removeNote(p.noteId)
      await syncComments(act, p.itemId).catch((err: unknown) => act.log(`frameio: after a post: ${err instanceof Error ? err.message : err}`))
    }
    return { summary: `Commented on ${p.fileName}${p.clock ? ` at ${p.clock}` : ''} in Frame.io`, ref: { commentId: made.id } }
  },
  wayBack: () => null
}

/** A post given up (discarded, or stale) takes its waiting note or its held copy with it. */
export function onPostDecided(ctx: WorkCtx, item: { kind: string; state: string; payload: unknown }): void {
  if (item.kind !== 'frameio.post' || (item.state !== 'discarded' && item.state !== 'stale')) return
  const p = item.payload as FrameioPost
  dropCopy(ctx.dataDir, p)
  if (p.what !== 'comment' || !p.itemId || !p.noteId) return
  const { store } = mediaOf(ctx)
  if (store.note(p.noteId)?.state !== 'suggested') return
  store.removeNote(p.noteId)
  pushSoon(ctx, p.itemId)
}
