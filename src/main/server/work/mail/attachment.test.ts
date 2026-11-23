import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filesPaneOf, mailPaneOf, type CanvasItem, type MentionReach } from '@shared/work'
import type { WorkCtx } from '../modules'
import { fetchAttachment, GONE, NO_MAIL, NOT_FETCHED, OUT_OF_REACH, type AttachmentDeps } from './attachment'

type Part = { partId: string; name: string; size: number; url: string | null; fetch: 'pending' | 'done' | 'failed' | null }

let dir: string
let part: Part
let sector: string | undefined
const asked: unknown[] = []
const reads: string[] = []
const reached: Array<{ id: string; draft: unknown }> = []

const item = (sessionId = 't1'): CanvasItem => ({
  id: 'i1',
  sessionId,
  workspaceId: 'w1',
  kind: 'pdf',
  title: 'Q3 report.pdf',
  source: { at: 'mail', threadId: 'mt1', messageId: 'mm1', partId: '2', name: 'Q3 report.pdf' },
  state: 'open',
  position: 0,
  rev: 0,
  createdAt: 0,
  updatedAt: 0
})

const ctx = (reach: MentionReach | null = { work: true, workspaceId: 'w1', sectors: ['cosmic'], sessionId: 't1' }, onRequest?: () => void): WorkCtx =>
  ({
    mentionReach: (id: string, draft?: unknown) => (reached.push({ id, draft }), reach),
    lifeos: {
      owner: () => ({
        query: async (fn: string, args: { id: string }) => {
          reads.push(`${fn} ${args.id}`)
          return { thread: { _id: 'mt1', sector }, messages: [{ _id: 'mm1', attachments: [part] }] }
        },
        mutation: async (fn: string, args: unknown) => {
          asked.push({ fn, args })
          onRequest?.()
          return null
        }
      })
    }
  }) as unknown as WorkCtx

const bytes = new TextEncoder().encode('%PDF-1.7 hello')
const deps = (over: Partial<AttachmentDeps> = {}): AttachmentDeps => ({
  fetch: async (url) => {
    expect(String(url)).toBe('https://lifeos.test/api/storage/abc')
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
  },
  pollMs: 1,
  waitMs: 1_000,
  ...over
})
const to = (progress: Array<[number, number | null]> = []) => ({ dest: join(dir, 'out.pdf'), progress: (r: number, t: number | null) => void progress.push([r, t]), signal: new AbortController().signal })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-mail-attachment-'))
  part = { partId: '2', name: 'Q3 report.pdf', size: bytes.length, url: 'https://lifeos.test/api/storage/abc', fetch: 'done' }
  sector = 'cosmic'
  asked.length = 0
  reads.length = 0
  reached.length = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("a mail's attachment for a canvas", () => {
  it("writes the stored bytes, saying how far it got", async () => {
    const progress: Array<[number, number | null]> = []
    await fetchAttachment(item(), ctx(), to(progress), deps())
    expect(readFileSync(join(dir, 'out.pdf'), 'utf8')).toBe('%PDF-1.7 hello')
    expect(progress.at(-1)).toEqual([bytes.length, bytes.length])
    expect(reads).toEqual(['mail:thread mt1'])
    expect(asked).toEqual([])
  })

  it("asks LifeOS's worker for a file it has not fetched, and waits until it has", async () => {
    part = { ...part, url: null, fetch: null }
    let polls = 0
    const c = ctx(undefined, () => void (part = { ...part, fetch: 'pending' }))
    const answer = fetchAttachment(item(), c, to(), deps({ pollMs: 1 }))
    // The worker lands the file after a few reads.
    const timer = setInterval(() => {
      if (++polls === 3) part = { ...part, url: 'https://lifeos.test/api/storage/abc', fetch: 'done' }
    }, 2)
    await answer.finally(() => clearInterval(timer))
    expect(asked).toEqual([{ fn: 'mail:requestAttachments', args: { messageId: 'mm1', partIds: ['2'] } }])
    expect(reads.length).toBeGreaterThan(1)
  })

  it('says so when the worker could not get the file', async () => {
    part = { ...part, url: null, fetch: 'pending' }
    const c = ctx()
    setTimeout(() => void (part = { ...part, fetch: 'failed' }), 5)
    await expect(fetchAttachment(item(), c, to(), deps())).rejects.toThrow(NOT_FETCHED)
    // A file already on its way is not asked for twice.
    expect(asked).toEqual([])
  })

  it("refuses a mail outside the pane's sector, whatever LifeOS answered", async () => {
    sector = 'purdue'
    await expect(fetchAttachment(item(), ctx(), to(), deps())).rejects.toThrow(OUT_OF_REACH)
    sector = undefined
    await expect(fetchAttachment(item(), ctx(), to(), deps())).rejects.toThrow(OUT_OF_REACH)
    // A Work Chat reads every sector.
    sector = 'purdue'
    await expect(fetchAttachment(item(), ctx({ work: true, workspaceId: null, sectors: 'all', sessionId: 't1' }), to(), deps())).resolves.toBeUndefined()
  })

  it('reads no mail for a pane with no sector', async () => {
    await expect(fetchAttachment(item(), ctx(null), to(), deps())).rejects.toThrow(NO_MAIL)
    await expect(fetchAttachment(item(), ctx({ work: true, workspaceId: 'w1', sectors: [], sessionId: 't1' }), to(), deps())).rejects.toThrow(NO_MAIL)
    expect(reads).toEqual([])
  })

  it("reads a Mail view's pane by its workspace", async () => {
    await fetchAttachment(item(mailPaneOf('w1')), ctx(), to(), deps())
    expect(reached).toEqual([{ id: mailPaneOf('w1'), draft: { workspaceId: 'w1' } }])
  })

  it("reads a Files tab's pane by its workspace", async () => {
    await fetchAttachment(item(filesPaneOf('w1')), ctx(), to(), deps())
    expect(reached).toEqual([{ id: filesPaneOf('w1'), draft: { workspaceId: 'w1' } }])
  })

  it('says a file gone from the mail is gone', async () => {
    part = { ...part, partId: '9' }
    await expect(fetchAttachment(item(), ctx(), to(), deps())).rejects.toThrow(GONE)
  })

  it("says the store's refusal", async () => {
    await expect(fetchAttachment(item(), ctx(), to(), deps({ fetch: async () => new Response('no', { status: 403 }) }))).rejects.toThrow("LifeOS's file store answered 403.")
  })
})
