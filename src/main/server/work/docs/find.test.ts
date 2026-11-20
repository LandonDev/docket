import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasItem, WorkScope } from '@shared/work'
import { DEFAULT_SPEC } from '@shared/work/docFind'
import type { Caller, ToolCtx, WorkCtx } from '../modules'
import { ensureGuestTables, GuestStore } from '../guests/store'
import { ensureOutboxTables, HELD_TABLE } from '../outbox/store'
import { canonicalPath } from '../service/ctx'
import { dropView, dropWorkspaceViews, ensureViewsTable, findDocs, keepText, listViews, saveView, VIEWS_MOST, walkFolder } from './find'
import { docTools } from './tools'

/* Finding documents: the host's merge of LifeOS's catalog, the workspace folder and the threads' items, and the agent's doc_find. */

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const DAY = 86_400_000
const NOW = Date.now()
const LOCAL: Caller = { kind: 'local', caps: [] }

function rig(o: { lifeos?: 'down'; reaches?: (path: string) => boolean; items?: (folder: string) => CanvasItem[] } = {}) {
  const dir = canonicalPath(mkdtempSync(join(tmpdir(), 'find-docs-')))
  dirs.push(dir)
  const folder = join(dir, 'Work')
  mkdirSync(join(folder, 'sub'), { recursive: true })
  mkdirSync(join(folder, '.hidden'))
  mkdirSync(join(folder, 'node_modules'))
  writeFileSync(join(folder, 'Plan.tcdoc'), 'state')
  writeFileSync(join(folder, 'sub', 'costs.csv'), 'item,cost\nvenue rental,400\n')
  writeFileSync(join(folder, 'sub', 'scan.pdf'), '%PDF')
  writeFileSync(join(folder, 'notes.log'), 'not a kind')
  writeFileSync(join(folder, '.hidden', 'x.pdf'), '%PDF')
  writeFileSync(join(folder, 'node_modules', 'y.pdf'), '%PDF')

  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL, sector TEXT, kind TEXT)')
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?)').run('w1', folder, 'purdue', 'work')
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?)').run('w2', join(dir, 'Other'), 'life', 'work')
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?)').run('code', dir, null, null)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, project_id TEXT)')
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('t1', 'w1', null)
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('chat', null, null)
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('orphan', 'code', null)
  ensureViewsTable(db)
  ensureGuestTables(db)
  ensureOutboxTables(db)

  const calls: string[] = []
  const catalog: Record<string, unknown[]> = {
    purdue: [
      { table: 'sheets', id: 's1', title: 'Event budget', projectId: 'p1', shared: false, editedAt: NOW - 20 * DAY, createdAt: NOW - 60 * DAY, lastBy: 'agent', openThreads: 0, waiting: 2 },
      { table: 'docs', id: 'd1', title: 'Kickoff brief', shared: false, editedAt: NOW - DAY, createdAt: NOW - 3 * DAY, lastBy: 'owner', openThreads: 1, waiting: 0 }
    ],
    life: [{ table: 'docs', id: 'd9', title: 'Private budget', shared: false, editedAt: NOW, createdAt: NOW, openThreads: 0, waiting: 0 }]
  }
  const ctx = {
    db,
    host: 'env_box',
    reaches: (_by: Caller, path: string) => (o.reaches ? o.reaches(path) : true),
    lifeos: {
      connected: () => true,
      owner: () => ({
        query: async (fn: string, args: { sector: string; text?: string; table?: string }) => {
          calls.push(`${fn} ${args.sector}${args.text ? ` ${args.text}` : ''}${args.table ? ` ${args.table}` : ''}`)
          if (o.lifeos === 'down') throw new Error('LifeOS is unreachable')
          if (fn === 'catalog:list') return { rows: (catalog[args.sector] ?? []).filter((r) => (r as { table: string }).table === args.table), isDone: true, continueCursor: '' }
          if (fn === 'projects:list') return args.sector === 'purdue' ? [{ _id: 'p1', name: 'Fall Invitational' }] : []
          if (fn === 'catalog:search') return args.sector === 'purdue' && args.text === 'venue' ? [{ table: 'docs', id: 'd1', snippet: '…book the venue by…' }] : []
          throw new Error(fn)
        }
      })
    },
    service: {
      internal: async (route: string, body: { file: string }) => {
        calls.push(`${route} ${body.file.slice(folder.length)}`)
        return { markdown: '# Plan\n\nThe venue holds two hundred.' }
      }
    },
    canvas: { forWorkspace: (id: string) => (id === 'w1' ? (o.items?.(folder) ?? []) : []) }
  } as unknown as WorkCtx
  return { ctx, db, folder, calls }
}

const item = (o: Partial<CanvasItem> & Pick<CanvasItem, 'id' | 'kind' | 'title' | 'source'>): CanvasItem => ({
  sessionId: 't1',
  workspaceId: 'w1',
  state: 'open',
  position: 0,
  rev: 1,
  createdAt: NOW - 5 * DAY,
  updatedAt: NOW - 4 * DAY,
  ...o
})

describe('work.docs.find', () => {
  it('lists LifeOS rows, the folder by kind and the threads\' outside items as one list', async () => {
    const { ctx, db, folder } = rig({
      items: (folder) => [
        item({ id: 'i1', kind: 'sheet', title: 'Roster', source: { at: 'google', account: 'a', fileId: 'g1', mime: 'application/vnd.google-apps.spreadsheet' } }),
        item({ id: 'i2', kind: 'form', title: 'Sign-up', source: { at: 'thread' } }),
        item({ id: 'i3', kind: 'pdf', title: 'scan', source: { at: 'file', host: 'env_box', path: join(folder, 'sub', 'scan.pdf') } }),
        item({ id: 'i4', kind: 'browser', title: 'A page', source: { at: 'browser', host: 'env_box', sessionId: 'b' } }),
        item({ id: 'i5', kind: 'document', title: 'From LifeOS', source: { at: 'lifeos', table: 'docs', id: 'd1' } })
      ]
    })
    new GuestStore(db).create({ name: 'Ana', source: { at: 'lifeos', table: 'docs', id: 'd1' }, title: 'Kickoff brief', role: 'comment', expiresAt: NOW + DAY, bySession: null })
    db.prepare(`INSERT INTO ${HELD_TABLE} (id, workspace_id, kind, origin, summary, payload, state, run_key, created_at, updated_at) VALUES ('h2', 'w1', 'mail.send', 'agent', 'x', ?, 'held', 'k2', 1, 1)`).run(JSON.stringify({ attach: [`${join(folder, 'sub', 'scan.pdf')}.bak`] }))
    db.prepare(`INSERT INTO ${HELD_TABLE} (id, workspace_id, kind, origin, summary, payload, state, run_key, created_at, updated_at) VALUES ('h1', 'w1', 'mail.send', 'agent', 'x', ?, 'held', 'k1', 1, 1)`).run(JSON.stringify({ attach: [{ at: 'lifeos', table: 'sheets', id: 's1' }] }))

    const got = await findDocs(ctx, LOCAL, { workspaceId: 'w1' })
    const byKey = new Map(got.entries.map((e) => [e.key, e]))
    expect([...byKey.keys()].sort()).toEqual(
      ['google:g1', 'item:i2', 'lifeos:docs:d1', 'lifeos:sheets:s1', `file:${join(folder, 'Plan.tcdoc')}`, `file:${join(folder, 'sub', 'costs.csv')}`, `file:${join(folder, 'sub', 'scan.pdf')}`].sort()
    )
    expect(byKey.get('lifeos:docs:d1')).toMatchObject({ kind: 'document', where: 'lifeos', guest: true, comments: 1, lastBy: 'owner' })
    expect(byKey.get('lifeos:sheets:s1')).toMatchObject({ kind: 'sheet', projectId: 'p1', held: 1, waiting: 2 })
    expect(byKey.get(`file:${join(folder, 'Plan.tcdoc')}`)).toMatchObject({ title: 'Plan', kind: 'document', where: 'folder' })
    expect(byKey.get('google:g1')).toMatchObject({ kind: 'sheet', where: 'google', shared: true })
    expect(byKey.get('item:i2')).toMatchObject({ kind: 'form', where: 'thread', sessionId: 't1' })
    // A path that only begins like the file's counts nothing against it.
    expect(byKey.get(`file:${join(folder, 'sub', 'scan.pdf')}`)!.held).toBe(0)
    expect(got.projects).toEqual([{ id: 'p1', name: 'Fall Invitational' }])
    expect(got.complete).toBe(true)
    expect(got.hits).toEqual([])
  })

  it('finds what is written inside: LifeOS by its index, a .tcdoc through the service and a .csv from disk, read once per change', async () => {
    const { ctx, folder, calls } = rig()
    const got = await findDocs(ctx, LOCAL, { workspaceId: 'w1', query: 'Venue' })
    expect(got.hits.map((h) => h.key).sort()).toEqual(['lifeos:docs:d1', `file:${join(folder, 'Plan.tcdoc')}`, `file:${join(folder, 'sub', 'costs.csv')}`].sort())
    expect(got.hits.find((h) => h.key.endsWith('Plan.tcdoc'))!.snippet).toContain('The venue holds two hundred.')
    await findDocs(ctx, LOCAL, { workspaceId: 'w1', query: 'venue' })
    expect(calls.filter((c) => c.startsWith('/internal/docs/read'))).toEqual(['/internal/docs/read /Plan.tcdoc'])
  })

  it('reads LifeOS\'s catalog once for a run of searches, and afresh when asked', async () => {
    const { ctx, calls } = rig()
    await findDocs(ctx, LOCAL, { workspaceId: 'w1' })
    await findDocs(ctx, LOCAL, { workspaceId: 'w1', query: 'venue' })
    expect(calls.filter((c) => c.startsWith('catalog:list'))).toEqual(['catalog:list purdue docs', 'catalog:list purdue sheets'])
    await findDocs(ctx, LOCAL, { workspaceId: 'w1', refresh: true })
    expect(calls.filter((c) => c.startsWith('catalog:list'))).toHaveLength(4)
  })

  it('holds a remote key to the fence file by file, past the folder\'s denied parts', async () => {
    const { ctx, folder } = rig({ reaches: (p) => !p.includes('/sub') })
    const got = await findDocs(ctx, { kind: 'remote', caps: ['read'] }, { workspaceId: 'w1', query: 'venue' })
    expect(got.entries.filter((e) => e.where === 'folder').map((e) => e.key)).toEqual([`file:${join(folder, 'Plan.tcdoc')}`])
    expect(got.hits.some((h) => h.key.includes('/sub'))).toBe(false)
  })

  it('shows a caller the folder only when it may reach it, and keeps the folder when LifeOS is down', async () => {
    const fenced = rig({ reaches: () => false })
    expect((await findDocs(fenced.ctx, { kind: 'remote', caps: ['read'] }, { workspaceId: 'w1' })).entries.map((e) => e.where)).toEqual(['lifeos', 'lifeos'])
    const down = rig({ lifeos: 'down' })
    const got = await findDocs(down.ctx, LOCAL, { workspaceId: 'w1' })
    expect(got.lifeos).toBe('LifeOS is unreachable')
    expect(got.entries.every((e) => e.where === 'folder')).toBe(true)
  })

  it('refuses a workspace that is not Work', async () => {
    const { ctx } = rig()
    await expect(findDocs(ctx, LOCAL, { workspaceId: 'code' })).rejects.toThrow('no such Work workspace')
  })

  it('walks the folder bounded, past hidden folders and dependencies', async () => {
    const { folder } = rig()
    const { files, complete } = await walkFolder(folder)
    expect(files.map((f) => f.path.slice(folder.length)).sort()).toEqual(['/Plan.tcdoc', '/sub/costs.csv', '/sub/scan.pdf'])
    expect(complete).toBe(true)
    // Many entries and few documents: the look stops, and says the list is not whole.
    expect((await walkFolder(folder, { files: 100, seen: 3 })).complete).toBe(false)
  })
})

describe('the text kept for searches', () => {
  it('drops the least read past its cap', () => {
    const cache = new Map<string, { mtime: number; text: string }>()
    keepText(cache, 'a', { mtime: 1, text: 'x'.repeat(4) }, 10)
    keepText(cache, 'b', { mtime: 1, text: 'x'.repeat(4) }, 10)
    keepText(cache, 'a', cache.get('a')!, 10)
    keepText(cache, 'c', { mtime: 1, text: 'x'.repeat(4) }, 10)
    expect([...cache.keys()]).toEqual(['a', 'c'])
  })
})

describe('saved views', () => {
  it('are kept per workspace, renamed in place, dropped, and capped', () => {
    const { db } = rig()
    const spec = { ...DEFAULT_SPEC, query: 'budget', filter: { kinds: ['sheet' as const] } }
    const a = saveView(db, 'w1', { name: ' Budgets ', spec }, 1)
    saveView(db, 'w2', { name: 'Elsewhere', spec: DEFAULT_SPEC }, 2)
    expect(listViews(db, 'w1')).toEqual([{ id: a.id, name: 'Budgets', spec }])
    saveView(db, 'w1', { id: a.id, name: 'Sheets', spec: DEFAULT_SPEC })
    expect(listViews(db, 'w1')).toEqual([{ id: a.id, name: 'Sheets', spec: DEFAULT_SPEC }])
    expect(() => saveView(db, 'w2', { id: a.id, name: 'Stolen', spec })).toThrow('no such saved view')
    dropView(db, 'w2', a.id)
    expect(listViews(db, 'w1')).toHaveLength(1)
    dropView(db, 'w1', a.id)
    expect(listViews(db, 'w1')).toEqual([])
    for (let i = 0; i < VIEWS_MOST; i++) saveView(db, 'w1', { name: `v${i}`, spec: DEFAULT_SPEC })
    expect(() => saveView(db, 'w1', { name: 'one more', spec: DEFAULT_SPEC })).toThrow(`at most ${VIEWS_MOST}`)
    dropWorkspaceViews(db, 'w1')
    expect(listViews(db, 'w1')).toEqual([])
  })
})

describe('doc_find', () => {
  const tool = docTools.find((t) => t.name === 'doc_find')!
  const run = (ctx: WorkCtx, args: Record<string, unknown>, scope: Partial<WorkScope> = { workspaceId: 'w1', sector: 'purdue' }) =>
    tool.run(args, { ...ctx, sessionId: scope.workspaceId ? 't1' : 'chat', scope: { sessionId: scope.workspaceId ? 't1' : 'chat', host: 'env_box', away: false, routineRunId: null, shared: () => false, workspaceId: null, sector: null, ...scope }, signal: new AbortController().signal } as ToolCtx)

  it('finds "the budget sheet from last month" in its own workspace only', async () => {
    const { ctx } = rig()
    const got = await run(ctx, { query: 'budget', kinds: ['sheet'], edited_after: new Date(NOW - 40 * DAY).toISOString().slice(0, 10) })
    expect(got.isError).toBeFalsy()
    const text = (got.content[0] as { text: string }).text
    expect(text).toContain('"Event budget": Sheet, LifeOS, project Fall Invitational, edited')
    expect(text).toContain('by an agent, 2 suggestions waiting.')
    expect(text).toContain('source {"at":"lifeos","table":"sheets","id":"s1"}')
    expect(text).not.toContain('Private budget')
  })

  it('takes a project by name, and says which there are when none is', async () => {
    const { ctx } = rig()
    expect((await run(ctx, { project: 'fall' })).content[0]).toMatchObject({ text: expect.stringContaining('Event budget') })
    expect((await run(ctx, { project: 'spring' })).content[0]).toMatchObject({ text: 'No project is named "spring". The projects are: Fall Invitational.' })
  })

  it('refuses a thread with no Work home: it reaches no sector', async () => {
    const { ctx } = rig()
    const got = await tool.run({ query: 'budget' }, { ...ctx, sessionId: 'orphan', scope: { sessionId: 'orphan', host: 'env_box', away: false, routineRunId: null, shared: () => false, workspaceId: null, sector: null }, signal: new AbortController().signal } as ToolCtx)
    expect(got).toMatchObject({ isError: true, content: [{ text: 'This thread has no Work workspace, so it has no documents to find.' }] })
  })

  it('searches every Work workspace from a Work Chat, and refuses a date it cannot read', async () => {
    const { ctx } = rig()
    const text = ((await run(ctx, { query: 'budget' }, {})).content[0] as { text: string }).text
    expect(text).toContain('Event budget')
    expect(text).toContain('Private budget')
    expect((await run(ctx, { edited_after: 'last tuesday' })).isError).toBe(true)
  })
})
