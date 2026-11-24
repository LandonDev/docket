import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CanvasSourceSchema, messagesPaneOf, messagesPaneWorkspace, paneWorkspace, type CanvasItem, type MentionReach } from '@shared/work'
import type { ChatFileStatus } from '@shared/work/messages'
import { ensureFetched, registerCanvasFetcher } from '../canvas/fetch'
import type { WorkCtx } from '../modules'
import { chatFileFetcher, fetchChatFile, GONE, NO_CHAT_HERE, NOT_FETCHED, OUT_OF_REACH, STILL_COMING, type ChatFileDeps } from './file'

type File = { _id: string; chatId: string; messageId: string; sector: string; name: string; size?: number; status: ChatFileStatus; url?: string; error?: string }

let dir: string
let file: File | null
const asked: unknown[] = []
const reads: string[] = []
const reached: Array<{ id: string; draft: unknown }> = []

const item = (sessionId = messagesPaneOf('w1')): CanvasItem => ({
  id: 'i1',
  sessionId,
  workspaceId: 'w1',
  kind: 'media',
  title: 'venue.png',
  source: { at: 'mail', from: 'chat', threadId: 'c1', messageId: 'm1', partId: 'f1', name: 'venue.png' },
  state: 'open',
  position: 0,
  rev: 0,
  createdAt: 0,
  updatedAt: 0
})

const ctx = (reach: MentionReach | null = { work: true, workspaceId: 'w1', sectors: ['cosmic'], sessionId: null }, onRequest?: () => void): WorkCtx =>
  ({
    dataDir: dir,
    push: () => {},
    mentionReach: (id: string, draft?: unknown) => (reached.push({ id, draft }), reach),
    lifeos: {
      owner: () => ({
        query: async (fn: string, args: { id: string }) => {
          reads.push(`${fn} ${args.id}`)
          return file
        },
        mutation: async (fn: string, args: unknown) => {
          asked.push({ fn, args })
          onRequest?.()
          return null
        }
      })
    }
  }) as unknown as WorkCtx

const bytes = new TextEncoder().encode('\x89PNG made up')
const deps = (over: Partial<ChatFileDeps> = {}): ChatFileDeps => ({
  fetch: async (url) => {
    expect(String(url)).toBe('https://lifeos.test/api/storage/abc')
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
  },
  pollMs: 1,
  waitMs: 1_000,
  ...over
})
const to = (progress: Array<[number, number | null]> = []) => ({ dest: join(dir, 'out.png'), progress: (r: number, t: number | null) => void progress.push([r, t]), signal: new AbortController().signal })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-chat-file-'))
  file = { _id: 'f1', chatId: 'c1', messageId: 'm1', sector: 'cosmic', name: 'venue.png', size: bytes.length, status: 'stored', url: 'https://lifeos.test/api/storage/abc' }
  asked.length = 0
  reads.length = 0
  reached.length = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('a chat file in a canvas', () => {
  it('rides the mail arm with from chat, and the Messages pane is a pane owner', () => {
    expect(CanvasSourceSchema.parse(item().source)).toEqual(item().source)
    // A mail's own attachment still parses with no `from`.
    expect(CanvasSourceSchema.safeParse({ at: 'mail', threadId: 't', messageId: 'm', partId: '2', name: 'a.pdf' }).success).toBe(true)
    expect(CanvasSourceSchema.safeParse({ ...item().source, from: 'elsewhere' }).success).toBe(false)
    expect(messagesPaneWorkspace(messagesPaneOf('w1'))).toBe('w1')
    expect(paneWorkspace(messagesPaneOf('w1'))).toBe('w1')
    expect(messagesPaneWorkspace('mailpane_w1')).toBeNull()
  })

  it('writes a stored file where the canvas said, reaching by the pane’s workspace', async () => {
    const progress: Array<[number, number | null]> = []
    await fetchChatFile(item(), ctx(), to(progress), deps())
    expect(readFileSync(join(dir, 'out.png'))).toEqual(Buffer.from(bytes))
    expect(reads).toEqual(['chats:file f1'])
    expect(reached).toEqual([{ id: messagesPaneOf('w1'), draft: { workspaceId: 'w1' } }])
    expect(asked).toEqual([])
    expect(progress.at(-1)).toEqual([bytes.length, bytes.length])
  })

  it('refuses a conversation outside the pane’s sector, whatever LifeOS answered', async () => {
    file!.sector = 'hypixel'
    let fetched = false
    await expect(fetchChatFile(item(), ctx(), to(), deps({ fetch: async () => ((fetched = true), new Response(bytes)) }))).rejects.toThrow(OUT_OF_REACH)
    expect(fetched).toBe(false)
    expect(asked).toEqual([])
  })

  it('refuses a pane with no reach, a file that is gone, and a row of another conversation or message', async () => {
    await expect(fetchChatFile(item(), ctx(null), to(), deps())).rejects.toThrow(NO_CHAT_HERE)
    await expect(fetchChatFile(item(), ctx({ work: true, workspaceId: 'w1', sectors: [], sessionId: null }), to(), deps())).rejects.toThrow(NO_CHAT_HERE)
    file!.chatId = 'c2'
    await expect(fetchChatFile(item(), ctx(), to(), deps())).rejects.toThrow(GONE)
    file = { ...file!, chatId: 'c1', messageId: 'm9' }
    await expect(fetchChatFile(item(), ctx(), to(), deps())).rejects.toThrow(GONE)
    file = null
    await expect(fetchChatFile(item(), ctx(), to(), deps())).rejects.toThrow(GONE)
    // A mail's own attachment is not this fetcher's.
    const mail = { ...item(), source: { at: 'mail' as const, threadId: 'c1', messageId: 'm1', partId: 'f1', name: 'a.pdf' } }
    await expect(fetchChatFile(mail, ctx(), to(), deps())).rejects.toThrow(/not a chat's file/)
  })

  it('asks LifeOS for a file it has not stored, and waits for it', async () => {
    file = { ...file!, status: 'listed', url: undefined }
    const onRequest = (): void => void setTimeout(() => (file = { ...file!, status: 'stored', url: 'https://lifeos.test/api/storage/abc' }), 5)
    await fetchChatFile(item(), ctx(undefined, onRequest), to(), deps())
    expect(asked).toEqual([{ fn: 'chats:requestFiles', args: { messageId: 'm1' } }])
    expect(readFileSync(join(dir, 'out.png'))).toEqual(Buffer.from(bytes))
  })

  it('asks again for one that failed before, and does not ask for one already wanted', async () => {
    file = { ...file!, status: 'failed', url: undefined, error: 'Couldn’t reach Slack' }
    const onRequest = (): void => void (file = { ...file!, status: 'wanted', error: undefined })
    setTimeout(() => (file = { ...file!, status: 'stored', url: 'https://lifeos.test/api/storage/abc' }), 10)
    await fetchChatFile(item(), ctx(undefined, onRequest), to(), deps())
    expect(asked).toHaveLength(1)

    asked.length = 0
    file = { ...file!, status: 'wanted', url: undefined }
    setTimeout(() => (file = { ...file!, status: 'stored', url: 'https://lifeos.test/api/storage/abc' }), 5)
    await fetchChatFile(item(), ctx(), to(), deps())
    expect(asked).toEqual([])
  })

  it('fails in LifeOS’s words when the worker could not get it, and in ours when it gives none or runs long', async () => {
    file = { ...file!, status: 'listed', url: undefined }
    const fail = (error?: string) => (): void => void (file = { ...file!, status: 'failed', ...(error ? { error } : {}) })
    await expect(fetchChatFile(item(), ctx(undefined, fail('Slack needs the files permission. Reinstall the app.')), to(), deps())).rejects.toThrow('Slack needs the files permission. Reinstall the app.')
    file = { ...file!, status: 'listed', error: undefined }
    await expect(fetchChatFile(item(), ctx(undefined, fail()), to(), deps())).rejects.toThrow(NOT_FETCHED)
    file = { ...file!, status: 'listed', error: undefined }
    await expect(fetchChatFile(item(), ctx(), to(), deps({ waitMs: 5 }))).rejects.toThrow(STILL_COMING)
  })

  it('refuses an address that is not the web’s, and a store that says no', async () => {
    file!.url = 'file:///etc/passwd'
    await expect(fetchChatFile(item(), ctx(), to(), deps())).rejects.toThrow(NOT_FETCHED)
    file!.url = 'https://lifeos.test/api/storage/abc'
    await expect(fetchChatFile(item(), ctx(), to(), deps({ fetch: async () => new Response('no', { status: 403 }) }))).rejects.toThrow(/answered 403/)
  })

  it('rejects, and throws nothing past the fetch, when the file cannot be written', async () => {
    await expect(fetchChatFile(item(), ctx(), { ...to(), dest: join(dir, 'gone', 'out.png') }, deps())).rejects.toThrow(/ENOENT/)
  })

  it.runIf(existsSync('/dev/full'))('rejects when the disk fills once the bytes are flowing', async () => {
    const big = new Uint8Array(256 * 1024)
    const fetch = async () => new Response(new ReadableStream({ pull: (c) => (c.enqueue(big), void 0) }))
    await expect(fetchChatFile(item(), ctx(), { ...to(), dest: '/dev/full' }, deps({ fetch }))).rejects.toThrow(/ENOSPC/)
  })

  it('is picked for a chat’s file and never for a mail’s own, through the canvas', async () => {
    const calls: string[] = []
    const offMail = registerCanvasFetcher({ at: 'mail', fetch: async (_i, _c, t) => (calls.push('mail'), writeFileSync(t.dest, 'm')) })
    const offChat = registerCanvasFetcher({ ...chatFileFetcher, fetch: async (_i, _c, t) => (calls.push('chat'), writeFileSync(t.dest, 'c')) })
    try {
      await ensureFetched(ctx(), item())
      const mail: CanvasItem = { ...item(), id: 'i2', source: { at: 'mail', threadId: 'mt1', messageId: 'mm1', partId: '2', name: 'a.pdf' } }
      await ensureFetched(ctx(), mail)
      expect(calls).toEqual(['chat', 'mail'])
      // With the chat fetcher off (Work off, or the pillar not started) a chat's file is refused in words that fit it.
      offChat()
      const other: CanvasItem = { ...item(), id: 'i3' }
      await expect(ensureFetched(ctx(), other)).rejects.toThrow('Files cannot be fetched on this host while Work is off.')
    } finally {
      offMail()
      offChat()
    }
  })
})
