import { createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { paneWorkspace, type CanvasItem } from '@shared/work'
import type { ChatFileStatus } from '@shared/work/messages'
import type { CanvasFetcher } from '../canvas/fetch'
import type { WorkCtx } from '../modules'

/**
 * A chat message's picture or file opened in a canvas
 * (docs/agents/work-messages.md "Files"): the host reads the file's row as
 * the owner, keeps to the pane's sector whatever LifeOS answers, asks
 * LifeOS's worker for bytes it has not stored yet, and writes them where the
 * canvas said. The item rides the mail arm of `CanvasSource` with
 * `from: 'chat'`, so every kind opens it as it opens a mail's attachment.
 */

/** LifeOS's `chats:file`: one file of one message, with the ids that place it. */
interface FileView {
  _id: string
  chatId: string
  messageId: string
  sector: string
  name: string
  size?: number
  status: ChatFileStatus
  url?: string
  error?: string
}

/** The biggest file a canvas fetches. LifeOS keeps none over 25 MB; this is the canvas's own ceiling, as a mail's. */
export const CHAT_FILE_MAX_BYTES = 200 * 1024 * 1024
/** How long LifeOS's worker gets to fetch a file from the chat service, and how often it is asked. */
const WAIT_MS = 120_000
const POLL_MS = 1_500

export const NO_CHAT_HERE = 'This pane reads no chat.'
export const OUT_OF_REACH = 'That conversation is not in this workspace’s sector.'
export const GONE = 'That file is no longer in the conversation.'
export const NOT_FETCHED = 'LifeOS could not get this file from the conversation.'
export const STILL_COMING = 'LifeOS is still getting this file. Try again in a moment.'
export const TOO_BIG = 'This file is too big to open here.'

export interface ChatFileDeps {
  fetch: typeof globalThis.fetch
  pollMs: number
  waitMs: number
}

const DEFAULTS: ChatFileDeps = { fetch: (input, init) => globalThis.fetch(input, init), pollMs: POLL_MS, waitMs: WAIT_MS }

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })

/** The file as LifeOS holds it now, read only within the owner's reach. */
async function readFile(ctx: WorkCtx, item: CanvasItem): Promise<FileView> {
  if (item.source.at !== 'mail' || item.source.from !== 'chat') throw new Error(`${item.title} is not a chat's file.`)
  // A pane owner (the Messages view's) reaches by its workspace; a thread by its own scope.
  const pane = paneWorkspace(item.sessionId)
  const reach = ctx.mentionReach(item.sessionId, pane ? { workspaceId: pane } : undefined)
  if (!reach || (reach.sectors !== 'all' && reach.sectors.length === 0)) throw new Error(NO_CHAT_HERE)
  const { threadId, messageId, partId } = item.source
  const file = await ctx.lifeos.owner().query<FileView | null>('chats:file', { id: partId })
  // The item names its conversation and message: a row of another is not the file he opened.
  if (!file || file.chatId !== threadId || file.messageId !== messageId) throw new Error(GONE)
  // The host reads as the owner, so the sector is the fence here: a file outside the pane's sector is refused whatever LifeOS answered.
  if (reach.sectors !== 'all' && !reach.sectors.includes(file.sector)) throw new Error(OUT_OF_REACH)
  return file
}

/** Fetches one chat file into `dest`: asks LifeOS's worker for it first when it is not stored, and waits. */
export async function fetchChatFile(item: CanvasItem, ctx: WorkCtx, to: Parameters<CanvasFetcher['fetch']>[2], deps: ChatFileDeps = DEFAULTS): Promise<void> {
  let file = await readFile(ctx, item)
  if (!file.url) {
    // A file that failed before is asked for again: Retry means try the service again.
    if (file.status !== 'wanted') await ctx.lifeos.owner().mutation('chats:requestFiles', { messageId: file.messageId })
    const until = Date.now() + deps.waitMs
    let asked = false
    while (!file.url) {
      // The row read before the ask may still say failed; only a failure after it is this ask's.
      if (asked && file.status === 'failed') throw new Error(file.error?.trim() || NOT_FETCHED)
      if (Date.now() > until) throw new Error(STILL_COMING)
      await sleep(deps.pollMs, to.signal)
      file = await readFile(ctx, item)
      asked = true
    }
  }
  if ((file.size ?? 0) > CHAT_FILE_MAX_BYTES) throw new Error(TOO_BIG)
  const url = file.url
  if (!/^https?:\/\//i.test(url)) throw new Error(NOT_FETCHED)
  const res = await deps.fetch(url, { signal: to.signal })
  if (!res.ok || !res.body) throw new Error(`LifeOS's file store answered ${res.status}.`)
  const total = Number(res.headers.get('content-length')) || file.size || null
  let received = 0
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.byteLength
      if (received > CHAT_FILE_MAX_BYTES) return done(new Error(TOO_BIG))
      to.progress(received, total)
      done(null, chunk)
    }
  })
  // One pipeline, so a failed read, a failed write (a full disk) or an abort rejects here and the canvas cleans up: an
  // error event no one hears would reach the Work service's fatal handler.
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), counted, createWriteStream(to.dest, { mode: 0o600 }), { signal: to.signal })
}

export const chatFileFetcher: CanvasFetcher = { at: 'mail', from: 'chat', fetch: (item, ctx, to) => fetchChatFile(item, ctx, to) }
