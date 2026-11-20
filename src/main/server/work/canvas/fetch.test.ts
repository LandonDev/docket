import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkPush } from '@shared/contract-work'
import type { SessionMeta } from '@shared/events'
import { mailPaneOf, mailPaneWorkspace, type CanvasSource } from '@shared/work'
import { openDb } from '../../db'
import type { WorkCtx } from '../modules'
import { ensureFetched, fetchedFile, fetchedPath, readFetched, registerCanvasFetcher } from './fetch'
import { CanvasStore, ensureCanvasTables } from './store'

let dir: string
let db: ReturnType<typeof openDb>
let store: CanvasStore
const pushes: unknown[] = []
const sessions = new Map<string, Pick<SessionMeta, 'id' | 'workspaceId' | 'scope' | 'parentId'>>()

const attachment: CanvasSource = { at: 'mail', threadId: 'mt1', messageId: 'mm1', partId: '2', name: 'Q3 report.pdf', contentType: 'application/pdf', size: 5 }
const ctx = (): WorkCtx => ({ dataDir: dir, push: (p: WorkPush) => pushes.push(p) }) as unknown as WorkCtx

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-canvas-fetch-'))
  db = openDb(join(dir, 'test.db'))
  ensureCanvasTables(db)
  sessions.clear()
  sessions.set('t1', { id: 't1', workspaceId: 'w1', scope: 'work' } as SessionMeta)
  pushes.length = 0
  store = new CanvasStore({ db, dataDir: dir, session: (id) => sessions.get(id) ?? null, workWorkspace: (id) => id === 'w1', push: (p) => pushes.push(p), log: () => {} })
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("a Mail view's pane", () => {
  it('owns items for a Work workspace, with no thread made for them', () => {
    expect(mailPaneWorkspace(mailPaneOf('w1'))).toBe('w1')
    expect(mailPaneWorkspace('t1')).toBeNull()
    const item = store.open(mailPaneOf('w1'), { kind: 'pdf', source: attachment, title: 'Q3 report.pdf' })
    expect(item).toMatchObject({ sessionId: mailPaneOf('w1'), workspaceId: 'w1', kind: 'pdf', state: 'open' })
    expect(store.list(mailPaneOf('w1')).map((i) => i.id)).toEqual([item.id])
    // The same attachment again is the same item.
    expect(store.open(mailPaneOf('w1'), { kind: 'pdf', source: attachment, title: 'Q3 report.pdf' }).id).toBe(item.id)
    expect(store.reorder(mailPaneOf('w1'), [item.id]).map((i) => i.id)).toEqual([item.id])
  })

  it('is refused for a workspace that is not a Work one', () => {
    expect(() => store.open(mailPaneOf('code1'), { kind: 'pdf', source: attachment, title: 'x.pdf' })).toThrow('not a Work workspace: code1')
    expect(() => store.reorder(mailPaneOf('code1'), [])).toThrow('unknown thread')
  })
})

describe('fetched sources', () => {
  it("writes the bytes into the item's own folder once, says how far it got, and reads them back by range", async () => {
    let calls = 0
    const off = registerCanvasFetcher({
      at: 'mail',
      async fetch(_item, _ctx, to) {
        calls++
        to.progress(2, 5)
        await new Promise((r) => setTimeout(r, 160))
        writeFileSync(to.dest, 'hello')
        to.progress(5, 5)
      }
    })
    try {
      const item = store.open('t1', { kind: 'pdf', source: attachment, title: 'Q3 report.pdf' })
      expect(() => fetchedPath(dir, item)).toThrow('has not come from the mail yet')
      const [a, b] = await Promise.all([ensureFetched(ctx(), item), ensureFetched(ctx(), item)])
      expect(a).toEqual({ size: 5 })
      expect(b).toEqual({ size: 5 })
      expect(calls).toBe(1)
      const path = fetchedPath(dir, item)
      expect(path).toBe(join(dir, 'canvas', 't1', item.id, 'file', 'Q3 report.pdf'))
      expect(readFileSync(path, 'utf8')).toBe('hello')
      expect(existsSync(`${path}.part`)).toBe(false)
      const said = pushes.filter((p) => (p as { push: string }).push === 'work.canvas.fetch')
      expect(said.at(0)).toMatchObject({ sessionId: 't1', itemId: item.id, received: 2, total: 5 })
      expect(said.at(-1)).toMatchObject({ received: 5, total: 5 })
      // A second ask finds the file and fetches nothing.
      await ensureFetched(ctx(), item)
      expect(calls).toBe(1)
      expect(readFetched(dir, item, 1, 3)).toEqual({ data: Buffer.from('ell').toString('base64'), size: 5 })
      expect(readFetched(dir, item, 4, 10)).toEqual({ data: Buffer.from('o').toString('base64'), size: 5 })
    } finally {
      off()
    }
  })

  it('leaves no half file when a fetch fails, and the next ask tries again', async () => {
    let fail = true
    const off = registerCanvasFetcher({
      at: 'mail',
      async fetch(_item, _ctx, to) {
        writeFileSync(to.dest, 'hal')
        if (fail) throw new Error('LifeOS could not get this file from the mail.')
        writeFileSync(to.dest, 'whole')
      }
    })
    try {
      const item = store.open('t1', { kind: 'pdf', source: attachment, title: 'Q3 report.pdf' })
      await expect(ensureFetched(ctx(), item)).rejects.toThrow('could not get this file')
      expect(existsSync(fetchedFile(dir, item))).toBe(false)
      expect(existsSync(`${fetchedFile(dir, item)}.part`)).toBe(false)
      fail = false
      await expect(ensureFetched(ctx(), item)).resolves.toEqual({ size: 5 })
    } finally {
      off()
    }
  })

  it('names the file safely whatever the mail called it', () => {
    const item = store.open('t1', { kind: 'pdf', source: { ...attachment, name: '../../etc/passwd' }, title: 'x' })
    expect(fetchedFile(dir, item)).toBe(join(dir, 'canvas', 't1', item.id, 'file', '__.._etc_passwd'))
  })

  it('says so when no fetcher is registered (Work off)', async () => {
    const item = store.open('t1', { kind: 'pdf', source: attachment, title: 'Q3 report.pdf' })
    await expect(ensureFetched(ctx(), item)).rejects.toThrow('while Work is off')
  })
})

describe('the kinds open a fetched attachment as a file', () => {
  it('a PDF or a deck reads the copy in the item folder, a sheet holds it as a workbook or a CSV', async () => {
    const { sourcePath, ItemFileError } = await import('../pdf/file')
    const { snapshot } = await import('../pdf/view')
    const { heldOf } = await import('../sheets/held')
    const pdf = store.open('t1', { kind: 'pdf', source: attachment, title: 'Q3 report.pdf' })
    const pctx = { host: 'env_test', dataDir: dir, canvas: {} } as never
    // Before the pane fetched it, a kind says it has not come yet.
    await expect(sourcePath(pctx, pdf, 'x.pdf')).rejects.toBeInstanceOf(ItemFileError)
    const off = registerCanvasFetcher({ at: 'mail', fetch: async (_i, _c, to) => writeFileSync(to.dest, '%PDF-1.7 a') })
    try {
      await ensureFetched(ctx(), pdf)
      expect(await sourcePath(pctx, pdf, 'x.pdf')).toBe(fetchedFile(dir, pdf))
      const shot = await snapshot(pctx, pdf, { refresh: true })
      expect(shot).toMatchObject({ name: 'Q3 report.pdf', stamp: { path: fetchedFile(dir, pdf), size: 10 } })
      const book = store.open('t1', { kind: 'sheet', source: { ...attachment, partId: '3', name: 'Budget.xlsx' }, title: 'Budget.xlsx' })
      expect(heldOf(book, dir)).toEqual({ at: 'package', path: fetchedFile(dir, book) })
      const csv = store.open('t1', { kind: 'sheet', source: { ...attachment, partId: '4', name: 'export.csv' }, title: 'export.csv' })
      expect(heldOf(csv, dir)).toMatchObject({ at: 'service', csv: fetchedFile(dir, csv) })
      expect(() => heldOf({ source: attachment, title: 'x.xlsx' }, dir)).toThrow('has not come from the mail yet')
    } finally {
      off()
    }
  })
})
