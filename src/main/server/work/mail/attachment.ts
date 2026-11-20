import { createWriteStream } from 'node:fs'
import { mailPaneWorkspace, type CanvasItem } from '@shared/work'
import type { CanvasFetcher } from '../canvas/fetch'
import type { WorkCtx } from '../modules'

/**
 * A mail's attachment opened in a canvas (docs/agents/work-mail.md
 * "Attachments"): the host reads the mail as the owner, keeps to the pane's
 * sector whatever LifeOS answers, asks LifeOS's worker for a file it has
 * not fetched yet, and writes the bytes where the canvas said.
 */

/** LifeOS's `mail:thread`, as much of it as this reads. */
interface ThreadView {
  thread: { _id: string; sector?: string }
  messages: { _id: string; attachments: { partId: string; name: string; size: number; url: string | null; fetch: 'pending' | 'done' | 'failed' | null }[] }[]
}

/** The biggest attachment a canvas fetches: Gmail sends nothing near it. */
export const ATTACHMENT_MAX_BYTES = 200 * 1024 * 1024
/** How long the worker gets to fetch a file from the mail provider, and how often it is asked. */
const WAIT_MS = 120_000
const POLL_MS = 1_500

export const NO_MAIL = 'This pane reads no mail.'
export const OUT_OF_REACH = 'That mail is not in this workspace’s sector.'
export const GONE = 'That file is no longer in the mail.'
export const NOT_FETCHED = 'LifeOS could not get this file from the mail.'

export interface AttachmentDeps {
  fetch: typeof globalThis.fetch
  pollMs: number
  waitMs: number
}

const DEFAULTS: AttachmentDeps = { fetch: (input, init) => globalThis.fetch(input, init), pollMs: POLL_MS, waitMs: WAIT_MS }

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })

/** The attachment as LifeOS holds it now, read only within the owner's reach. */
async function readPart(ctx: WorkCtx, item: CanvasItem): Promise<ThreadView['messages'][number]['attachments'][number]> {
  if (item.source.at !== 'mail') throw new Error(`${item.title} is not a mail's file.`)
  const pane = mailPaneWorkspace(item.sessionId)
  const reach = ctx.mentionReach(item.sessionId, pane ? { workspaceId: pane } : undefined)
  if (!reach || (reach.sectors !== 'all' && reach.sectors.length === 0)) throw new Error(NO_MAIL)
  const view = await ctx.lifeos.owner().query<ThreadView | null>('mail:thread', { id: item.source.threadId })
  if (!view) throw new Error(GONE)
  // The host reads as the owner, so the sector is the fence here: a mail outside the pane's sector is refused whatever LifeOS answered.
  if (reach.sectors !== 'all' && !(view.thread.sector && reach.sectors.includes(view.thread.sector))) throw new Error(OUT_OF_REACH)
  const { messageId, partId } = item.source
  const part = view.messages.find((m) => m._id === messageId)?.attachments.find((a) => a.partId === partId)
  if (!part) throw new Error(GONE)
  return part
}

/** Fetches one attachment into `dest`: asks LifeOS's worker for it first when it has not fetched it, and waits. */
export async function fetchAttachment(item: CanvasItem, ctx: WorkCtx, to: Parameters<CanvasFetcher['fetch']>[2], deps: AttachmentDeps = DEFAULTS): Promise<void> {
  if (item.source.at !== 'mail') throw new Error(`${item.title} is not a mail's file.`)
  const { messageId, partId } = item.source
  let part = await readPart(ctx, item)
  if (!part.url) {
    // A file that failed before is asked for again: Retry means try the mail provider again.
    if (part.fetch !== 'pending') await ctx.lifeos.owner().mutation('mail:requestAttachments', { messageId, partIds: [partId] })
    const until = Date.now() + deps.waitMs
    while (!part.url) {
      if (part.fetch === 'failed') throw new Error(NOT_FETCHED)
      if (Date.now() > until) throw new Error('LifeOS is still getting this file from the mail. Try again in a moment.')
      await sleep(deps.pollMs, to.signal)
      part = await readPart(ctx, item)
    }
  }
  if (part.size > ATTACHMENT_MAX_BYTES) throw new Error('This file is too big to open here. Download it instead.')
  const url = part.url
  if (!/^https?:\/\//i.test(url)) throw new Error(NOT_FETCHED)
  const res = await deps.fetch(url, { signal: to.signal })
  if (!res.ok || !res.body) throw new Error(`LifeOS's file store answered ${res.status}.`)
  const total = Number(res.headers.get('content-length')) || part.size || null
  const out = createWriteStream(to.dest, { mode: 0o600 })
  let received = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > ATTACHMENT_MAX_BYTES) throw new Error('This file is too big to open here. Download it instead.')
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
      to.progress(received, total)
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
  }
}

export const mailAttachmentFetcher: CanvasFetcher = { at: 'mail', fetch: (item, ctx, to) => fetchAttachment(item, ctx, to) }
