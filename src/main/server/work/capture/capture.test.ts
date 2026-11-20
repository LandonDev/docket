import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { CaptureRequestSchemas, CAPTURE_CAPS } from '@shared/contract-work-capture'
import { requiredCapability } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import type { Caller, WorkCtx } from '../modules'
import { capture } from '.'
import { captureState, taskWords, threadText, TITLE_MAX } from './file'

/*
 * The capture pillar on a LifeOS that stands in: what a capture writes as
 * the owner, where its files are kept, and the thread it starts when asked.
 */

const LOCAL: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
const REMOTE: Caller = { kind: 'remote', caps: ['read', 'operate'] }

let db: DatabaseSync
let root: string
let sent: { fn: string; args: Record<string, unknown> }[]
let started: { workspaceId: string; text: string; about?: unknown }[]
let connected: boolean
let ctx: WorkCtx

const req = (method: string, params: unknown) => ({ method, params }) as ClientRequest
const file = (params: Record<string, unknown>, by: Caller = LOCAL) =>
  capture.handle!(req('work.capture.file', { key: 'k-00000001', text: '', sector: null, ...params }), ctx, by).then((r) => (r as { result: unknown }).result as { taskId: string; kept: string[]; threadId?: string })

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  root = mkdtempSync(join(tmpdir(), 'capture-'))
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, path TEXT, kind TEXT, sector TEXT, created_at INTEGER)')
  for (const [id, name, sector] of [
    ['ws-purdue', 'Purdue', 'purdue'],
    ['ws-life', 'Life', 'life']
  ]) {
    mkdirSync(join(root, name))
    db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run(id, name, join(root, name), 'work', sector, 1)
  }
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run('repo', 'temp-code', root, 'code', 'cosmic', 1)
  capture.ensure(db)
  sent = []
  started = []
  connected = true
  ctx = {
    db,
    host: 'env_mac',
    log: () => {},
    reaches: (by: Caller, path: string) => by.kind !== 'remote' || path.startsWith('/managed/'),
    lifeos: {
      connected: () => connected,
      owner: () => ({
        mutation: async (fn: string, args: Record<string, unknown>) => {
          sent.push({ fn, args })
          return 'task_1'
        }
      })
    },
    threads: {
      start: async (o: { workspaceId: string; text: string; about?: unknown }) => {
        started.push(o)
        return 'thread_1'
      }
    }
  } as unknown as WorkCtx
})

describe('the wire', () => {
  it('reads state with read and files with operate', () => {
    expect(CaptureRequestSchemas.map((s) => s.shape.method.value)).toEqual(['work.capture.state', 'work.capture.file'])
    expect(CAPTURE_CAPS['work.capture.file']).toBe('operate')
    expect(requiredCapability({ method: 'work.capture.state' })).toBe('read')
  })
})

describe('filing', () => {
  it('files his own quick add from Capture in the sector he picked, and remembers the sector', async () => {
    const out = await file({ text: 'Book the arena for April\nAsk about the second court', sector: 'purdue' })
    expect(out).toEqual({ taskId: 'task_1', kept: [] })
    expect(sent).toEqual([
      {
        fn: 'tasks:create',
        args: {
          sector: 'purdue',
          title: 'Book the arena for April',
          description: 'Ask about the second court',
          key: 'capture:k-00000001',
          source: { kind: 'manual', container: 'quick-add', channel: 'Capture', messageId: 'capture:k-00000001', sentAt: expect.any(Number) }
        }
      }
    ])
    expect(captureState(ctx)).toEqual({ last: 'purdue', homes: ['purdue', 'life'], connected: true })
    expect(started).toEqual([])
  })

  it('files one he left unsorted in Life, from Unsorted, and remembers no sector', async () => {
    await file({ text: 'https://example.com/article', sector: 'purdue', key: 'k-first-one' })
    await file({ text: 'https://example.com/article', sector: null })
    expect(sent[1]?.args).toMatchObject({ sector: 'life', title: 'https://example.com/article', source: { channel: 'Unsorted' } })
    expect(captureState(ctx).last).toBeNull()
  })

  it('copies a file into the sector workspace folder under a kept name, and names it in the notes', async () => {
    const from = join(root, 'Budget.xlsx')
    writeFileSync(from, 'cells')
    writeFileSync(join(root, 'Purdue', 'Budget.xlsx'), 'older')
    const out = await file({ text: '', sector: 'purdue', files: [{ at: 'file', host: 'env_mac', path: from }] })
    expect(out.kept).toEqual(['Budget (1).xlsx'])
    expect(readFileSync(join(root, 'Purdue', 'Budget (1).xlsx'), 'utf8')).toBe('cells')
    expect(sent[0]?.args).toMatchObject({ title: 'Budget (1).xlsx', description: 'Kept in Purdue: Budget (1).xlsx' })
  })

  it("keeps an unsorted capture's file in the Life workspace", async () => {
    const from = join(root, 'note.png')
    writeFileSync(from, 'png')
    await file({ text: 'Receipt', files: [{ at: 'file', host: 'env_mac', path: from }] })
    expect(readdirSync(join(root, 'Life'))).toEqual(['note.png'])
  })

  it('refuses before it writes anything: no words or files, LifeOS away, no workspace, a far file, a folder, a fenced path', async () => {
    writeFileSync(join(root, 'a.txt'), 'a')
    const a = { at: 'file', host: 'env_mac', path: join(root, 'a.txt') }
    await expect(file({ text: '  ' })).rejects.toThrow('Nothing to capture.')
    await expect(file({ text: 'x', sector: 'cosmic', files: [a] })).rejects.toThrow('No Cosmic workspace on this computer')
    await expect(file({ text: 'x', sector: 'purdue', files: [{ ...a, host: 'env_box' }] })).rejects.toThrow('another computer')
    await expect(file({ text: 'x', sector: 'purdue', files: [{ ...a, path: join(root, 'Life') }] })).rejects.toThrow('is not a file')
    await expect(file({ text: 'x', sector: 'purdue', files: [a] }, REMOTE)).rejects.toThrow('outside what this key may reach')
    connected = false
    await expect(file({ text: 'x' })).rejects.toThrow('LifeOS is not connected')
    expect(sent).toEqual([])
    expect(readdirSync(join(root, 'Purdue'))).toEqual([])
  })

  it('starts a Work thread on the task when asked: in the sector workspace, else in Work Chats', async () => {
    const from = join(root, 'plan.pdf')
    writeFileSync(from, 'pdf')
    const out = await file({ text: 'Read the venue plan', sector: 'purdue', start: true, files: [{ at: 'file', host: 'env_mac', path: from }] })
    expect(out.threadId).toBe('thread_1')
    expect(started[0]).toEqual({
      workspaceId: 'ws-purdue',
      text: `Read the venue plan\n\nFiles:\n- ${join(root, 'Purdue', 'plan.pdf')}`,
      about: { kind: 'task', label: 'Read the venue plan', ref: { at: 'lifeos', table: 'tasks', id: 'task_1' } }
    })
    await file({ text: 'Think about this', start: true, key: 'k-unsorted1' })
    await file({ text: 'Loot ideas', sector: 'cosmic', start: true, key: 'k-cosmic-01' })
    expect(started.slice(1).map((s) => s.workspaceId)).toEqual(['~work', '~work'])
  })
})

describe('the words', () => {
  it('cuts a long first line into the title and keeps it whole in the notes', () => {
    const long = 'x'.repeat(TITLE_MAX + 20)
    const words = taskWords(`${long}\nmore`, [], null)
    expect(words.title).toHaveLength(TITLE_MAX)
    expect(words.title.endsWith('…')).toBe(true)
    expect(words.description).toBe(`${long}\nmore`)
    expect(taskWords('', [], null).title).toBe('Capture')
    expect(threadText('', ['/a/b.pdf'])).toBe('Files:\n- /a/b.pdf')
  })
})
