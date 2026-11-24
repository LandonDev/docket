import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import type { FileDone, FilesHome, FilesListing, FilesOpened, FilesPlaces } from '@shared/contract-work-files'
import type { CanvasSource } from '@shared/work'
import type { FileEntry, FilePlace } from '@shared/work/files'
import { registerCanvasFetcher } from '../../canvas/fetch'
import { ensureGuestTables, GuestStore } from '../../guests/store'
import type { Caller } from '../../modules'
import { closeFilesState, THREADS_BY_TOOLS } from '../handle'
import { files } from '../index'
import { admitWrite, ASK_FIRST, MAIL_NEEDS_APPROVE, NEEDS_APPROVE, NEEDS_PRESS, PEER_LIBRARIES, setThreadsMayWrite, THREAD_ELSEWHERE } from '../policy'
import { forgetSearches } from '../search'
import { approver, at, makeRig, peer, phone, thread, window, WS, type Rig } from '../testkit'
import { docTools } from '../../docs/tools'
import type { ToolCtx } from '../../modules'
import { kindOfFile } from '@shared/work/docFind'
import { refKey } from '@shared/work/files'
import { forgetLifeos, GONE, LIFEOS_DOWN, lifeosPlace, listedProjects, NOT_IN_SECTOR, PROJECT_IN_PROJECTS, repointLinks, type MailPart } from './lifeos'

/**
 * LifeOS as a place of Files, From mail and a project's lens (places/lifeos.ts), through the module as a socket's
 * requests reach it, against a LifeOS in memory. Dummy names only.
 */

const NOW = Date.now()
const DAY = 86_400_000

interface Item {
  table: 'docs' | 'sheets'
  id: string
  title: string
  sector: string
  projectId?: string
  shared: boolean
  editedAt: number
  waiting: number
  lastBy?: 'owner' | 'agent' | 'guest'
  deletedAt?: number
}

/** LifeOS in memory: the functions Files calls, and `trashLive` for whether its soft delete is deployed. */
class FakeLifeos {
  up = true
  trashLive = true
  calls: string[] = []
  rows = new Map<string, Item>()
  projects = [
    { _id: 'p2', name: 'Fall LAN', status: 'active', _creationTime: 2 },
    { _id: 'p1', name: 'Spring LAN', status: 'backlog', _creationTime: 1 },
    { _id: 'p3', name: 'Old cup', status: 'done', _creationTime: 0 },
    { _id: 'px', name: 'Other job', status: 'active', _creationTime: 3 }
  ]
  sectorOf: Record<string, string> = { p1: 'life', p2: 'life', p3: 'life', px: 'ref' }
  items: { _id: string; projectId: string; title: string; source: CanvasSource }[] = []
  parts: MailPart[] = []
  private next = 1

  add(item: Omit<Item, 'shared' | 'editedAt' | 'waiting'> & Partial<Item>): Item {
    const row = { shared: false, editedAt: NOW - 1000 * this.next++, waiting: 0, ...item }
    this.rows.set(`${row.table}:${row.id}`, row)
    return row
  }
  private live = (sector: string) => [...this.rows.values()].filter((r) => r.sector === sector && r.deletedAt === undefined)
  private catalogRow = (r: Item) => ({ table: r.table, id: r.id, title: r.title, ...(r.projectId ? { projectId: r.projectId } : {}), shared: r.shared, editedAt: r.editedAt, createdAt: 0, ...(r.lastBy ? { lastBy: r.lastBy } : {}), openThreads: 0, waiting: r.waiting })

  async query(fn: string, a: Record<string, any>): Promise<any> {
    this.calls.push(fn)
    if (!this.up) throw new Error('LifeOS is unreachable')
    switch (fn) {
      case 'catalog:list':
        return { rows: this.live(a.sector).filter((r) => r.table === a.table).map(this.catalogRow), isDone: true, continueCursor: '' }
      case 'catalog:search':
        return this.live(a.sector).filter((r) => r.table === 'docs' && r.title === 'Run of show' && /venue/.test(a.text)).map((r) => ({ table: r.table, id: r.id, snippet: 'the venue' }))
      case 'catalog:trash':
        if (!this.trashLive) throw new Error("Could not find public function for 'catalog:trash'")
        return [...this.rows.values()].filter((r) => r.sector === a.sector && r.deletedAt !== undefined).map((r) => ({ ...this.catalogRow(r), deletedAt: r.deletedAt }))
      case 'projects:list':
        return this.projects.filter((p) => this.sectorOf[p._id] === a.sector)
      case 'projects:page':
        return { items: this.items.filter((i) => i.projectId === a.id) }
      case 'docs:get':
      case 'sheets:get': {
        const r = this.rows.get(`${fn.split(':')[0]}:${a.id}`)
        return r && r.deletedAt === undefined ? { title: r.title, sector: r.sector, projectId: r.projectId, shared: r.shared } : null
      }
      case 'mail:attachments':
        return { parts: this.parts.filter((p) => p.sentAt >= a.since), isDone: true, continueCursor: '' }
      case 'projectItems:bySource':
        return this.items.filter((i) => JSON.stringify(i.source) === JSON.stringify(a.source)).map((i) => ({ id: i._id, projectId: i.projectId, name: this.projects.find((p) => p._id === i.projectId)!.name, title: i.title }))
    }
    throw new Error(`no fake for ${fn}`)
  }

  async mutation(fn: string, a: Record<string, any>): Promise<any> {
    this.calls.push(fn)
    if (!this.up) throw new Error('LifeOS is unreachable')
    const row = (table: string) => {
      const r = this.rows.get(`${table}:${a.id}`)
      if (!r) throw new Error('not found')
      return r
    }
    const [table] = fn.split(':') as [string]
    switch (fn) {
      case 'docs:create': {
        const id = `d${this.next++}`
        this.add({ table: 'docs', id, title: a.title, sector: a.projectId ? this.sectorOf[a.projectId]! : a.sector, ...(a.projectId ? { projectId: a.projectId } : {}) })
        return id
      }
      case 'docs:rename':
      case 'sheets:rename':
        row(table).title = a.title
        return null
      case 'docs:setProject':
      case 'sheets:setProject':
        if (a.projectId) row(table).projectId = a.projectId
        else delete row(table).projectId
        return null
      case 'docs:remove':
      case 'sheets:remove':
        if (!this.trashLive) throw new Error("Could not find public function for 'docs:remove'")
        row(table).deletedAt = Date.now()
        return null
      case 'docs:restore':
      case 'sheets:restore':
        delete row(table).deletedAt
        return null
      case 'projectItems:add':
        this.items.push({ _id: `i${this.next++}`, projectId: a.projectId, title: a.title, source: a.source })
        return null
      case 'projectItems:remove':
        this.items = this.items.filter((i) => i._id !== a.id)
        return null
      case 'projectItems:repoint': {
        const hit = this.items.filter((i) => JSON.stringify(i.source) === JSON.stringify(a.from))
        for (const i of hit) i.source = a.to
        return hit.length
      }
    }
    return null
  }
}

let rig: Rig
let lifeos: FakeLifeos
let ops = 0
let fetched: string[]
let offFetcher: () => void
beforeEach(() => {
  rig = makeRig()
  // The workspace is linked to a dummy sector.
  rig.db.prepare(`UPDATE workspaces SET sector = 'life' WHERE id = ?`).run(WS)
  ensureGuestTables(rig.db)
  lifeos = new FakeLifeos()
  lifeos.add({ table: 'docs', id: 'd1', title: 'Run of show', sector: 'life', projectId: 'p1', waiting: 2 })
  lifeos.add({ table: 'sheets', id: 's1', title: 'Budget', sector: 'life' })
  lifeos.add({ table: 'docs', id: 'd2', title: 'Shared brief', sector: 'life' })
  lifeos.add({ table: 'docs', id: 'd3', title: 'Cup recap', sector: 'life', projectId: 'p3' })
  lifeos.add({ table: 'docs', id: 'dx', title: 'Elsewhere', sector: 'ref' })
  lifeos.items.push({ _id: 'i1', projectId: 'p1', title: 'Poster.png', source: { at: 'file', host: rig.ctx.host, path: join(rig.folder, 'Events', 'Poster.png') } })
  lifeos.parts = [
    { threadId: 't1', messageId: 'm1', partId: '1', name: 'Bracket.pdf', contentType: 'application/pdf', size: 3, sentAt: NOW - 2 * DAY, from: 'Dummy Coach', subject: 'Brackets' },
    { threadId: 't1', messageId: 'm2', partId: '1', name: 'Roster.xlsx', contentType: '', size: 4, sentAt: NOW - DAY, from: 'Dummy Coach', subject: 'Roster' }
  ]
  const owner = { query: (fn: string, a?: Record<string, unknown>) => lifeos.query(fn, a ?? {}), mutation: (fn: string, a?: Record<string, unknown>) => lifeos.mutation(fn, a ?? {}), action: async () => null }
  Object.assign(rig.ctx, {
    lifeos: { connected: () => lifeos.up, owner: () => owner, jwt: async () => '', subscribe: () => () => {} },
    service: { internal: async (route: string, body: { title: string; at: { lifeos: { sector: string; projectId?: string } } }) => {
      if (route !== '/internal/sheet/create') throw new Error(route)
      const id = `s${lifeos.rows.size + 10}`
      lifeos.add({ table: 'sheets', id, title: body.title, sector: body.at.lifeos.sector, ...(body.at.lifeos.projectId ? { projectId: body.at.lifeos.projectId } : {}) })
      return { sheet: { lifeos: id } }
    } }
  })
  fetched = []
  offFetcher = registerCanvasFetcher({
    at: 'mail',
    fetch: async (item, _ctx, to) => {
      fetched.push(item.title)
      writeFileSync(to.dest, `bytes of ${item.title}`)
    }
  })
})
afterEach(() => {
  offFetcher()
  forgetLifeos(rig.ctx)
  forgetSearches(rig.db)
  closeFilesState(rig.db)
  rig.close()
})

async function call<T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> {
  const req = ClientRequestSchema.parse({ id: '1', method, params: { workspaceId: WS, ...params } })
  const out = await files.handle!(req, rig.ctx, by)
  if (!out.handled) throw new Error(`${method} was not handled`)
  return out.result as T
}
const op = (): string => `op-lifeos-${++ops}`
const doc = (id: string): CanvasSource => ({ at: 'lifeos', table: 'docs', id })
const sheet = (id: string): CanvasSource => ({ at: 'lifeos', table: 'sheets', id })
const places = async (by: Caller = window): Promise<FilePlace[]> => (await call<FilesPlaces>('work.files.places', {}, by)).places
const list = (atRef: Record<string, unknown>, by: Caller = window): Promise<FilesListing> => call<FilesListing>('work.files.list', { at: atRef }, by)
const names = (l: FilesListing): string[] => l.entries.map((e) => e.name)
const top = { at: 'place', id: 'lifeos' }
const mailPlace = { at: 'place', id: 'mail' }
/** What was kept is read again: as the next window would after 30 seconds. */
const fresh = (): void => forgetLifeos(rig.ctx, 'life')

describe('the LifeOS place', () => {
  it('is listed for a workspace with a sector, with the projects the column lists, oldest first, and From mail with its count', async () => {
    const got = await places()
    const lifeosRow = got.find((p) => p.id === 'lifeos')!
    expect(lifeosRow).toMatchObject({ kind: 'lifeos', name: 'LifeOS', host: '', shared: false, state: { state: 'ok' }, root: top, makes: ['document', 'sheet'] })
    expect(lifeosRow.can).toEqual(expect.arrayContaining(['make', 'rename', 'move', 'trash', 'restore']))
    expect(got.filter((p) => p.kind === 'project').map((p) => [p.id, p.name, p.root])).toEqual([
      ['project:p1', 'Spring LAN', { at: 'project', id: 'p1' }],
      ['project:p2', 'Fall LAN', { at: 'project', id: 'p2' }]
    ])
    expect(got.find((p) => p.id === 'mail')).toMatchObject({ kind: 'mail', name: 'From mail', count: 2 })
    // A workspace with no sector has none of them.
    rig.db.prepare(`UPDATE workspaces SET sector = NULL WHERE id = ?`).run(WS)
    expect((await places()).filter((p) => ['lifeos', 'project', 'mail'].includes(p.kind))).toEqual([])
  })

  it('stays listed, greyed with its one sentence, while LifeOS is down, and Files stays up', async () => {
    lifeos.up = false
    const got = await places()
    expect(got.find((p) => p.id === 'lifeos')!.state).toEqual({ state: 'signed-out', detail: LIFEOS_DOWN })
    expect(got.find((p) => p.id === 'mail')!.state.state).toBe('signed-out')
    expect(got.find((p) => p.id === 'folder')).toBeTruthy()
    await expect(list(top)).rejects.toThrow(LIFEOS_DOWN)
    expect(names(await list({ at: 'place', id: 'folder' }))).toContain('notes.txt')
  })

  it('offers a delete only once LifeOS answers its trash', async () => {
    lifeos.trashLive = false
    expect((await places()).find((p) => p.id === 'lifeos')!.can).not.toContain('trash')
    expect(lifeosPlace(rig.ctx, false).can).toEqual(['make', 'rename', 'move', 'edit'])
  })

  it('gives a thread and another host of his none of it, and a key without approve no From mail', async () => {
    expect((await places(thread())).some((p) => p.kind === 'lifeos')).toBe(false)
    expect((await places(peer)).some((p) => p.kind === 'lifeos')).toBe(false)
    const key = await places(phone)
    expect(key.some((p) => p.id === 'lifeos')).toBe(true)
    expect(key.some((p) => p.id === 'mail')).toBe(false)
    expect((await places(approver)).some((p) => p.id === 'mail')).toBe(true)
  })

  it('orders projects as the Projects column does', () => {
    expect(listedProjects(lifeos.projects).map((p) => p._id)).toEqual(['p1', 'p2', 'px'])
  })
})

describe('a listing', () => {
  it('shows the projects as folders at the top, then what is in no listed project, with suggestions waiting and the project', async () => {
    const got = await list(top)
    expect(got.place).toBe('lifeos')
    expect(got.trail).toEqual([{ name: 'LifeOS', at: top }])
    expect(got.entries.filter((e) => e.kind === 'folder').map((e) => [e.name, e.folder])).toEqual([
      ['Fall LAN', { at: 'project', id: 'p2' }],
      ['Spring LAN', { at: 'project', id: 'p1' }]
    ])
    const rows = got.entries.filter((e) => e.kind !== 'folder')
    expect(rows.map((e) => e.name).sort()).toEqual(['Budget', 'Cup recap', 'Shared brief'])
    expect(rows.find((e) => e.name === 'Cup recap')!.project).toEqual({ id: 'p3', name: 'Old cup' })
    expect(rows.find((e) => e.name === 'Budget')).toMatchObject({ key: 'lifeos:sheets:s1', ref: sheet('s1'), kind: 'sheet' })
    // Another sector's row is never listed.
    expect(names(got)).not.toContain('Elsewhere')
  })

  it('lists a project, as a folder and as its own lens: its LifeOS rows and the files linked to it', async () => {
    const folder = await list({ at: 'project', id: 'p1' })
    expect(folder.trail!.map((c) => c.name)).toEqual(['LifeOS', 'Spring LAN'])
    expect(folder.entries.map((e) => [e.name, e.kind])).toEqual([
      ['Poster.png', 'picture'],
      ['Run of show', 'document']
    ])
    expect(folder.entries.find((e) => e.name === 'Run of show')).toMatchObject({ state: { is: 'suggestions', count: 2 }, project: { id: 'p1', name: 'Spring LAN' } })
    const lens = await list({ at: 'place', id: 'project:p1' })
    expect(lens.place).toBe('project:p1')
    expect(names(lens)).toEqual(names(folder))
    await expect(list({ at: 'project', id: 'px' })).rejects.toThrow('no such project')
  })

  it('puts the project on a folder row a project links', async () => {
    const got = await list({ at: 'file', host: rig.ctx.host, path: join(rig.folder, 'Events') })
    expect(got.entries.find((e) => e.name === 'Poster.png')!.project).toEqual({ id: 'p1', name: 'Spring LAN' })
  })

  it('counts a row with a live guest link as shared', async () => {
    new GuestStore(rig.db).create({ name: 'Dummy Guest', source: { at: 'lifeos', table: 'docs', id: 'd2' }, title: 'Shared brief', role: 'comment', expiresAt: NOW + DAY, bySession: null })
    const got = await list(top)
    expect(got.entries.find((e) => e.name === 'Shared brief')!.shared).toBe(true)
    expect(got.entries.find((e) => e.name === 'Budget')!.shared).toBeUndefined()
  })

  it('pages as the wire pages, and says a list that changed between pages is stale', async () => {
    for (let i = 0; i < 520; i++) lifeos.add({ table: 'sheets', id: `bulk${i}`, title: `Sheet ${i}`, sector: 'life' })
    fresh()
    const first = await list(top)
    expect(first.entries).toHaveLength(500)
    const second = await call<FilesListing>('work.files.list', { at: top, cursor: first.next })
    // Two project folders and three rows besides the 520.
    expect(second.entries.length).toBe(525 - 500)
    expect(second.next).toBeUndefined()
    lifeos.add({ table: 'sheets', id: 'late', title: 'Late', sector: 'life' })
    fresh()
    await new Promise((r) => setTimeout(r, 0))
    expect(await call<FilesListing>('work.files.list', { at: top, cursor: first.next })).toEqual({ entries: [], stale: true })
  })
})

describe('the door for a LifeOS ref', () => {
  it('refuses a row of another sector to every caller, a thread of another workspace, and another host of his', async () => {
    await expect(call('work.files.open', { ref: doc('dx') })).rejects.toThrow(NOT_IN_SECTOR)
    await expect(call('work.files.open', { ref: doc('gone') })).rejects.toThrow(GONE)
    await expect(call('work.files.rename', { ref: doc('dx'), name: 'x', op: op() })).rejects.toThrow(NOT_IN_SECTOR)
    // A key bound to another workspace names this sector's row through its own workspace: refused there too.
    await expect(call('work.files.open', { workspaceId: 'w2', ref: doc('d1') }, phone)).rejects.toThrow(NOT_IN_SECTOR)
    await expect(call('work.files.list', { at: top }, thread('t2'))).rejects.toThrow(THREAD_ELSEWHERE)
    await expect(call('work.files.list', { at: top }, peer)).rejects.toThrow(PEER_LIBRARIES)
    // A thread of the workspace reads it, and changes nothing by the wire.
    expect(names(await list(top, thread()))).toContain('Budget')
    await expect(call('work.files.rename', { ref: doc('d2'), name: 'x', op: op() }, thread())).rejects.toThrow(THREADS_BY_TOOLS)
  })

  it('holds a thread\'s change to a row others can open, and asks a key for approve', async () => {
    // As the module's start leaves it: threads change files through the tools.
    setThreadsMayWrite(true)
    const place = lifeosPlace(rig.ctx, true)
    const entry = { name: 'Shared brief', kind: 'document' as const, shared: true }
    expect(admitWrite(thread(), { verb: 'rename', from: place, entry })).toBe('hold')
    expect(admitWrite(thread(), { verb: 'rename', from: place, entry: { ...entry, shared: false } })).toBe('run')
    expect(() => admitWrite(phone, { verb: 'rename', from: place, entry })).toThrow(NEEDS_APPROVE)
    expect(admitWrite(approver, { verb: 'rename', from: place, entry })).toBe('run')
    // His window asks before a delete others will see.
    expect(() => admitWrite(window, { verb: 'trash', from: place, entry })).toThrow(ASK_FIRST)
    setThreadsMayWrite(false)
  })
})

describe('the verbs', () => {
  it('makes a document and a sheet, at the top and in a project, and no folder, deck or text file', async () => {
    const madeDoc = await call<FileDone>('work.files.make', { at: top, kind: 'document', name: 'Agenda', op: op() })
    expect(madeDoc.entries[0]).toMatchObject({ name: 'Agenda', kind: 'document', ref: { at: 'lifeos', table: 'docs' } })
    const agenda = [...lifeos.rows.values()].find((r) => r.title === 'Agenda')!
    expect(agenda.sector).toBe('life')
    expect(agenda.projectId).toBeUndefined()
    const madeSheet = await call<FileDone>('work.files.make', { at: { at: 'project', id: 'p2' }, kind: 'sheet', op: op() })
    expect(madeSheet.entries[0]).toMatchObject({ name: 'Untitled sheet', kind: 'sheet', project: { id: 'p2', name: 'Fall LAN' } })
    await expect(call('work.files.make', { at: top, kind: 'folder', op: op() })).rejects.toThrow(PROJECT_IN_PROJECTS)
    await expect(call('work.files.make', { at: top, kind: 'deck', op: op() })).rejects.toThrow('documents and sheets')
    await expect(call('work.files.make', { at: { at: 'project', id: 'px' }, kind: 'document', op: op() })).rejects.toThrow('no such project')
    await expect(call('work.files.upload', { at: top, name: 'a.pdf', size: 1, sha256: 'a'.repeat(64), op: op() })).rejects.toThrow('Nothing can be uploaded in LifeOS from here.')
    // The same op again does nothing twice.
    const id = op()
    await call('work.files.make', { at: top, kind: 'document', name: 'Once', op: id })
    await call('work.files.make', { at: top, kind: 'document', name: 'Once', op: id })
    expect([...lifeos.rows.values()].filter((r) => r.title === 'Once')).toHaveLength(1)
  })

  it('renames a row, and moves rows between projects and to the top, never out of LifeOS', async () => {
    const renamed = await call<FileDone>('work.files.rename', { ref: sheet('s1'), name: 'Budget 2027', op: op() })
    expect(renamed.entries[0]!.name).toBe('Budget 2027')
    const moved = await call<FileDone>('work.files.move', { refs: [sheet('s1'), doc('d1')], to: { at: 'project', id: 'p2' }, op: op() })
    expect(moved.refused).toEqual([])
    expect(moved.entries.map((e) => e.project?.name)).toEqual(['Fall LAN', 'Fall LAN'])
    await call<FileDone>('work.files.move', { refs: [doc('d1')], to: top, op: op() })
    expect(lifeos.rows.get('docs:d1')!.projectId).toBeUndefined()
    await expect(call('work.files.move', { refs: [doc('d1')], to: { at: 'place', id: 'folder' }, op: op() })).rejects.toThrow('A LifeOS document lives in LifeOS. Export a copy instead.')
    await expect(call('work.files.copy', { refs: [doc('d1')], to: { at: 'place', id: 'folder' }, op: op() })).rejects.toThrow('Export a copy instead')
    const into = await call<FileDone>('work.files.move', { refs: [at(join(rig.folder, 'notes.txt'))], to: top, op: op() })
    expect(into.refused[0]!.text).toBe('Only a LifeOS document lives in LifeOS. Make one there instead.')
  })

  it('refuses a delete in the grammar\'s sentence until LifeOS\'s trash is live, and deletes into it after', async () => {
    lifeos.trashLive = false
    await expect(call('work.files.trash', { refs: [sheet('s1')], op: op() })).rejects.toThrow('LifeOS cannot put a document back yet. Delete it in LifeOS.')
    expect(lifeos.calls).not.toContain('sheets:remove')
    lifeos.trashLive = true
    fresh()
    const done = await call<FileDone>('work.files.trash', { refs: [sheet('s1')], op: op() })
    expect(done.trashed).toEqual(['lifeos:sheets:s1'])
    expect(names(await list(top))).not.toContain('Budget')
  })

  it('lists LifeOS\'s trash beside the folder\'s, and puts each back by its own place', async () => {
    await call<FileDone>('work.files.trash', { refs: [sheet('s1'), at(join(rig.folder, 'notes.txt'))], op: op() })
    const trash = await list({ at: 'place', id: 'trash' })
    expect(trash.entries.map((e) => [e.key, e.name]).sort()).toEqual([
      ['trash:lifeos:sheets:s1', 'Budget'],
      [expect.stringMatching(/^trash:/), 'notes.txt']
    ].sort())
    const ids = trash.entries.map((e) => e.key.slice('trash:'.length))
    const back = await call<FileDone>('work.files.restore', { ids, op: op() })
    expect(back.refused).toEqual([])
    expect(back.entries.map((e) => e.name).sort()).toEqual(['Budget', 'notes.txt'])
    expect(lifeos.rows.get('sheets:s1')!.deletedAt).toBeUndefined()
    expect(existsSync(join(rig.folder, 'notes.txt'))).toBe(true)
    // A row of another sector's trash is no row of this one.
    lifeos.rows.get('docs:dx')!.deletedAt = NOW
    const other = await call<FileDone>('work.files.restore', { ids: ['lifeos:docs:dx'], op: op() })
    expect(other.refused[0]!.text).toBe('That is not in Trash any more.')
    expect(lifeos.rows.get('docs:dx')!.deletedAt).toBe(NOW)
  })

  it('puts nothing back for a key that may not approve when the selection holds a row others can open, its LifeOS rows neither', async () => {
    await call<FileDone>('work.files.trash', { refs: [sheet('s1')], op: op() })
    // A library's row, its file in that computer's bin.
    rig.db
      .prepare(`INSERT INTO work_files_trash (id, workspace_id, ref, name, place, was_at, state, held_at, deleted_at, by, provider) VALUES ('lib1', ?, ?, 'Testing.pptx', 'p', ?, 'held', 1, 1, 'owner', 'onedrive')`)
      .run(WS, JSON.stringify(at(join(rig.team, 'General', 'Testing.pptx'))), JSON.stringify(at(join(rig.team, 'General'))))
    await expect(call('work.files.restore', { ids: ['lifeos:sheets:s1', 'lib1'], op: op() }, phone)).rejects.toThrow(NEEDS_PRESS)
    // An id that is in no Trash is no way round it either.
    await expect(call('work.files.restore', { ids: ['lifeos:docs:nope', 'lib1'], op: op() }, phone)).rejects.toThrow(NEEDS_PRESS)
    expect(lifeos.rows.get('sheets:s1')!.deletedAt).toBeDefined()
    expect(rig.db.prepare(`SELECT state FROM work_files_trash WHERE id = 'lib1'`).get()).toEqual({ state: 'held' })
    // A LifeOS row LifeOS says others can open is his press too, as its delete is; his own comes back for the same key.
    lifeos.add({ table: 'docs', id: 'd9', title: 'Open notes', sector: 'life', shared: true, deletedAt: NOW })
    await expect(call('work.files.restore', { ids: ['lifeos:sheets:s1', 'lifeos:docs:d9'], op: op() }, phone)).rejects.toThrow(NEEDS_PRESS)
    expect(lifeos.rows.get('sheets:s1')!.deletedAt).toBeDefined()
    expect((await call<FileDone>('work.files.restore', { ids: ['lifeos:sheets:s1'], op: op() }, phone)).entries.map((e) => e.name)).toEqual(['Budget'])
    expect((await call<FileDone>('work.files.restore', { ids: ['lifeos:docs:d9'], op: op() }, approver)).entries.map((e) => e.name)).toEqual(['Open notes'])
  })

  it('deletes no LifeOS row of a selection whose other rows their door refuses', async () => {
    await expect(call('work.files.trash', { refs: [sheet('s1'), at(join(rig.team, 'General', 'Plan.docx'))], op: op() })).rejects.toThrow()
    expect(lifeos.calls).not.toContain('sheets:remove')
    expect(lifeos.rows.get('sheets:s1')!.deletedAt).toBeUndefined()
  })

  it('ends a deleted row\'s guest links, and asks before a delete others will see', async () => {
    const store = new GuestStore(rig.db)
    const { link } = store.create({ name: 'Dummy Guest', source: { at: 'lifeos', table: 'docs', id: 'd2' }, title: 'Shared brief', role: 'comment', expiresAt: NOW + DAY, bySession: null })
    await expect(call('work.files.trash', { refs: [doc('d2')], op: op() })).rejects.toThrow(ASK_FIRST)
    await call<FileDone>('work.files.trash', { refs: [doc('d2')], op: op(), asked: true })
    expect(store.get(link.id)!.revokedAt).not.toBeNull()
  })
})

describe('opening', () => {
  it('seats a LifeOS document or sheet in its kind with its own source, in a tab', async () => {
    const opened = await call<FilesOpened>('work.files.open', { ref: doc('d1') })
    expect(opened.item).toMatchObject({ kind: 'document', source: doc('d1'), title: 'Run of show' })
    expect(opened.tabs.find((t) => t.id === opened.tabId)).toMatchObject({ kind: 'file', key: 'lifeos:docs:d1', name: 'Run of show' })
    const again = await call<FilesOpened>('work.files.open', { ref: doc('d1') })
    expect(again.tabId).toBe(opened.tabId)
    expect((await call<FilesOpened>('work.files.open', { ref: sheet('s1') })).item!.kind).toBe('sheet')
  })
})

describe('From mail', () => {
  const part = (p: MailPart): CanvasSource => ({ at: 'mail', threadId: p.threadId, messageId: p.messageId, partId: p.partId, name: p.name, ...(p.contentType ? { contentType: p.contentType } : {}), size: p.size })

  it('lists the mail files not kept, newest first, only with approve for a remote key', async () => {
    const got = await list(mailPlace)
    expect(got.entries.map((e) => [e.name, e.by])).toEqual([
      ['Roster.xlsx', 'Dummy Coach'],
      ['Bracket.pdf', 'Dummy Coach']
    ])
    expect(got.entries[1]).toMatchObject({ kind: 'pdf', ref: part(lifeos.parts[0]!), key: 'mail:m1:1' })
    await expect(list(mailPlace, phone)).rejects.toThrow(MAIL_NEEDS_APPROVE)
    await expect(call('work.files.open', { ref: part(lifeos.parts[0]!) }, phone)).rejects.toThrow(MAIL_NEEDS_APPROVE)
    expect((await list(mailPlace, approver)).entries).toHaveLength(2)
  })

  it('opens a row as the Mail view\'s {at: mail} item', async () => {
    const opened = await call<FilesOpened>('work.files.open', { ref: part(lifeos.parts[0]!) })
    expect(opened.item).toMatchObject({ kind: 'pdf', source: part(lifeos.parts[0]!) })
  })

  it('keeps a row into the workspace\'s folder, and leaves it out of From mail and its count after', async () => {
    const done = await call<FileDone>('work.files.copy', { refs: [part(lifeos.parts[0]!)], to: { at: 'place', id: 'folder' }, op: op() })
    expect(done.refused).toEqual([])
    expect(done.entries[0]!.name).toBe('Bracket.pdf')
    expect(readFileSync(join(rig.folder, 'Bracket.pdf'), 'utf8')).toBe('bytes of Bracket.pdf')
    expect(fetched).toEqual(['Bracket.pdf'])
    expect(names(await list(mailPlace))).toEqual(['Roster.xlsx'])
    expect((await places()).find((p) => p.id === 'mail')!.count).toBe(1)
    // Kept into a library others can open, or anything but a mail's file from From mail: refused.
    await expect(call('work.files.copy', { refs: [part(lifeos.parts[1]!)], to: top, op: op() })).rejects.toThrow()
    await expect(call('work.files.copy', { refs: [part(lifeos.parts[1]!)], to: { at: 'place', id: 'folder' }, op: op() }, phone)).rejects.toThrow(MAIL_NEEDS_APPROVE)
  })
})

describe('projects', () => {
  it('adds a LifeOS row to a project and takes it out, and links any other file', async () => {
    const added = await call<{ projects: { id: string; name: string }[] }>('work.files.project', { ref: sheet('s1'), projectId: 'p1', on: true })
    expect(added.projects).toEqual([{ id: 'p1', name: 'Spring LAN' }])
    expect((await call<{ projects: unknown[] }>('work.files.project', { ref: sheet('s1'), projectId: 'p1', on: false })).projects).toEqual([])
    const file = at(join(rig.folder, 'notes.txt'))
    expect((await call<{ projects: unknown[] }>('work.files.project', { ref: file, projectId: 'p2', on: true })).projects).toEqual([{ id: 'p2', name: 'Fall LAN' }])
    expect(lifeos.items.find((i) => i.projectId === 'p2')).toMatchObject({ title: 'notes.txt', source: file })
    expect((await call<{ projects: unknown[] }>('work.files.project', { ref: file, projectId: 'p2', on: false })).projects).toEqual([])
    await expect(call('work.files.project', { ref: sheet('s1'), projectId: 'px', on: true })).rejects.toThrow('no such project')
    await expect(call('work.files.project', { ref: { at: 'mail', threadId: 't', messageId: 'm', partId: '1', name: 'a.pdf' }, projectId: 'p1', on: true })).rejects.toThrow("Keep it first")
    await expect(call('work.files.project', { ref: sheet('s1'), projectId: 'p1', on: true }, thread())).rejects.toThrow(THREADS_BY_TOOLS)
  })

  it('makes a project link follow a file Files renamed', async () => {
    const from = { at: 'file' as const, host: rig.ctx.host, path: join(rig.folder, 'Events', 'Poster.png') }
    const to = { at: 'file' as const, host: rig.ctx.host, path: join(rig.folder, 'Events', 'Poster 2026.png') }
    expect(await repointLinks(rig.ctx, from, to)).toBe(1)
    expect(lifeos.items[0]!.source).toEqual(to)
    // A file no project links asks LifeOS nothing.
    const before = lifeos.calls.length
    expect(await repointLinks(rig.ctx, at(join(rig.folder, 'notes.txt')), at(join(rig.folder, 'n.txt')))).toBe(0)
    expect(lifeos.calls.slice(before)).not.toContain('projectItems:repoint')
  })
})

describe('search', () => {
  it('finds LifeOS rows by title and by their words, each saying where it is, and answers review and project', async () => {
    const hits = (await call<FilesListing>('work.files.search', { query: 'run' })).entries
    expect(hits.find((e) => e.key === 'lifeos:docs:d1')).toMatchObject({ where: { place: 'lifeos', name: 'LifeOS', trail: ['Spring LAN'] } })
    const words = (await call<FilesListing>('work.files.search', { query: 'venue' })).entries
    expect(words.map((e) => e.name)).toContain('Run of show')
    const review = (await call<FilesListing>('work.files.search', { query: '', filter: { review: true } })).entries
    expect(review.map((e) => e.name)).toEqual(['Run of show'])
    const inProject = (await call<FilesListing>('work.files.search', { query: '', filter: { project: 'p1' } })).entries
    expect(inProject.map((e) => e.name).sort()).toEqual(['Poster.png', 'Run of show'])
    // A thread's search leaves LifeOS to LifeOS's own tools.
    expect((await call<FilesListing>('work.files.search', { query: 'run' }, thread())).entries.some((e) => e.key.startsWith('lifeos:'))).toBe(false)
  })

  it('answers who last changed a LifeOS row and a span of time, as a Docs view saved before Files asked them', async () => {
    lifeos.rows.get('docs:d1')!.lastBy = 'owner'
    lifeos.rows.get('sheets:s1')!.lastBy = 'agent'
    for (const old of ['docs:d2', 'docs:d3']) lifeos.rows.get(old)!.editedAt = NOW - 10 * DAY
    const lifeosNames = async (filter: Record<string, unknown>): Promise<string[]> =>
      (await call<FilesListing>('work.files.search', { query: '', filter: { places: ['lifeos'], ...filter } })).entries.map((e) => e.name).sort()
    expect(await lifeosNames({ who: 'me' })).toEqual(['Run of show'])
    expect(await lifeosNames({ who: 'agent' })).toEqual(['Budget'])
    expect(await lifeosNames({ within: 'week' })).toEqual(['Budget', 'Run of show'])
    // Who is said only when it is asked, in LifeOS's words where Work has no name for him.
    const asked = (await call<FilesListing>('work.files.search', { query: 'run', filter: { who: 'me' } })).entries.find((e) => e.key === 'lifeos:docs:d1')
    expect(asked?.by).toBe('You')
    expect((await call<FilesListing>('work.files.search', { query: 'run' })).entries.find((e) => e.key === 'lifeos:docs:d1')?.by).toBeUndefined()
  })

  it("is what doc_find answers for the same words: the same LifeOS rows and the same files of the workspace's folder", async () => {
    const tool = docTools.find((t) => t.name === 'doc_find')!
    const toolCtx = { ...rig.ctx, sessionId: 't1', scope: { sessionId: 't1', host: rig.ctx.host, away: false, routineRunId: null, shared: () => false, workspaceId: WS, sector: 'life' }, signal: new AbortController().signal } as unknown as ToolCtx
    for (const words of ['budget', 'run', 'venue', 'bracket']) {
      const text = ((await tool.run({ query: words }, toolCtx)).content[0] as { text: string }).text
      const found = [...text.matchAll(/source (\{.*\})$/gm)].map((m) => refKey(JSON.parse(m[1]!) as CanvasSource)).sort()
      const listed = (await call<FilesListing>('work.files.search', { query: words })).entries
        .filter((e) => e.key.startsWith('lifeos:') || (e.ref?.at === 'file' && e.ref.path.startsWith(`${rig.folder}/`) && kindOfFile(e.name)))
        .map((e) => e.key)
        .sort()
      expect(found, words).toEqual(listed)
      expect(found.length, words).toBeGreaterThan(0)
    }
  })
})

describe('Home', () => {
  it('fills Waiting on you with suggestions waiting and the mail files not kept', async () => {
    const home = await call<FilesHome>('work.files.home', {})
    expect(home.waiting.map((e: FileEntry) => e.name)).toEqual(['Run of show', 'Roster.xlsx', 'Bracket.pdf'])
    expect(home.waiting[0]!.state).toEqual({ is: 'suggestions', count: 2 })
    const key = await call<FilesHome>('work.files.home', {}, phone)
    expect(key.waiting.map((e: FileEntry) => e.name)).toEqual(['Run of show'])
  })
})
