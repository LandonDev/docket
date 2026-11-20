import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import { ProjectsRequestSchemas } from '@shared/contract-work-projects'
import { requiredCapability } from '@shared/capabilities'
import type { CanvasItem, CanvasSource, MentionReach, WorkScope } from '@shared/work'
import { FenceError } from '../../remote/fence'
import type { Caller, ToolCtx, WorkCtx } from '../modules'
import { docs } from '../docs'
import { projects, projectsTools } from '.'
import { linkRefusal, linkToProject } from './link'
import { cardMention } from './mentions'

/*
 * The projects pillar's host side on a LifeOS that stands in: what a link
 * writes, and every check made here because the write is the owner's (the
 * project's sector, a document's sector, a remote key's path, a thread's
 * own pane).
 */

const LOCAL: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
const REMOTE: Caller = { kind: 'remote', caps: ['read', 'operate'] }
const PURDUE = { name: 'Purdue', sector: 'purdue' }

let db: DatabaseSync
let sent: { fn: string; args: Record<string, unknown> }[]
let results: { sessionId: string; kind: string; summary: string }[]
let items: Map<string, CanvasItem>
let ctx: WorkCtx
let asked: { fn: string; args: unknown }[]
const lifeosTasks = [
  { _id: 't41', key: 'PUR-41', title: 'Network for 64 seats', description: 'Wired only.', sector: 'purdue', projectId: 'lp_1', dueAt: 99 },
  { _id: 't42', key: 'PUR-42', title: 'Renew the parking pass', sector: 'purdue' },
  { _id: 't7', key: 'COS-7', title: 'Loot table audit', sector: 'cosmic', projectId: 'lp_far' }
]

const lifeosProjects = [
  { _id: 'lp_1', name: 'Spring LAN', status: 'active', sector: 'purdue' },
  { _id: 'lp_done', name: 'Fall LAN', status: 'done', sector: 'purdue' },
  { _id: 'lp_far', name: 'Loot tables', status: 'active', sector: 'cosmic' }
]
const lifeosRows: Record<string, { sector: string; title: string }> = {
  'docs:d_near': { sector: 'purdue', title: 'Run of show' },
  'docs:d_far': { sector: 'cosmic', title: 'Drop rates' },
  'sheets:s_near': { sector: 'purdue', title: 'Budget' }
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, kind TEXT, sector TEXT)')
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?)').run('ws', 'Purdue', 'work', 'purdue')
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?)').run('side', 'Side', 'work', null)
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?)').run('repo', 'temp-code', 'code', 'purdue')
  sent = []
  asked = []
  results = []
  items = new Map()
  ctx = {
    db,
    host: 'env_box',
    log: () => {},
    // A remote key reaches only what is under /managed.
    reaches: (by: Caller, path: string) => by.kind !== 'remote' || path.startsWith('/managed/'),
    lifeos: {
      connected: () => true,
      owner: () => ({
        query: async (fn: string, args: { sector?: string; id?: string; keys?: string[] }) => {
          asked.push({ fn, args })
          if (fn === 'tasks:byKeys') return lifeosTasks.filter((t) => args.keys!.includes(t.key))
          if (fn === 'projects:list') return lifeosProjects.filter((p) => p.sector === args.sector)
          return lifeosRows[`${fn.split(':')[0]}:${args.id}`] ?? null
        },
        mutation: async (fn: string, args: Record<string, unknown>) => {
          sent.push({ fn, args })
          return fn === 'projectItems:add' ? 'item_1' : null
        }
      })
    },
    canvas: {
      get: (id: string) => items.get(id) ?? null,
      // t-sub is a subagent of t-root: its items show in t-root's pane.
      paneOf: (sessionId: string) => (sessionId === 't-sub' ? 't-root' : sessionId)
    },
    results: { add: (r: { sessionId: string; kind: string; summary: string }) => void results.push(r) }
  } as unknown as WorkCtx
})

const item = (id: string, sessionId: string, source: CanvasSource, title: string): void =>
  void items.set(id, { id, sessionId, workspaceId: 'ws', kind: 'document', title, source, state: 'open', position: 0, rev: 1, createdAt: 1, updatedAt: 1 })
const file = (path: string): CanvasSource => ({ at: 'file', host: 'env_box', path })
const link = (source: CanvasSource, o: { by?: Caller; project?: string; title?: string } = {}) =>
  linkToProject(ctx, o.by ?? LOCAL, { workspace: PURDUE, lifeosProjectId: o.project ?? 'lp_1', source, title: o.title ?? 'A thing' })

describe('linking to a project', () => {
  it("a LifeOS document of the workspace's sector joins the project by its own projectId", async () => {
    const { linked, project } = await link({ at: 'lifeos', table: 'docs', id: 'd_near' })
    expect(linked).toEqual({ as: 'doc', id: 'd_near' })
    expect(project.name).toBe('Spring LAN')
    expect(sent).toEqual([{ fn: 'docs:setProject', args: { id: 'd_near', projectId: 'lp_1' } }])
  })

  it('a LifeOS sheet does the same', async () => {
    expect((await link({ at: 'lifeos', table: 'sheets', id: 's_near' })).linked).toEqual({ as: 'sheet', id: 's_near' })
    expect(sent).toEqual([{ fn: 'sheets:setProject', args: { id: 's_near', projectId: 'lp_1' } }])
  })

  it("a document of another sector is refused and nothing is written: linking would move it into this one", async () => {
    await expect(link({ at: 'lifeos', table: 'docs', id: 'd_far' })).rejects.toThrow("LifeOS has no such document in Purdue's sector")
    await expect(link({ at: 'lifeos', table: 'docs', id: 'd_none' })).rejects.toThrow("LifeOS has no such document in Purdue's sector")
    expect(sent).toEqual([])
  })

  it('a file, a Google item, a Microsoft item and a Frame.io file become linked items of the project, source and all', async () => {
    const sources: CanvasSource[] = [
      file('/managed/Work/Purdue/budget.xlsx'),
      { at: 'google', account: 'l@purdue.edu', fileId: 'g1', mime: 'application/vnd.google-apps.document' },
      { at: 'microsoft', host: 'env_mac', app: 'excel', name: 'Roster.xlsx', ref: { kind: 'url', url: 'https://purdue.sharepoint.com/r.xlsx' } },
      { at: 'frameio', account: 'l@hypixel.net', fileId: 'f1' }
    ]
    for (const source of sources) expect((await link(source, { title: '  Budget  ' })).linked).toEqual({ as: 'item', id: 'item_1' })
    expect(sent.map((s) => s.fn)).toEqual(['projectItems:add', 'projectItems:add', 'projectItems:add', 'projectItems:add'])
    expect(sent[0].args).toEqual({ projectId: 'lp_1', title: 'Budget', source: sources[0] })
    expect(sent[2].args.source).toEqual(sources[2])
  })

  it('a finished project still takes a document', async () => {
    expect((await link(file('/managed/a.pdf'), { project: 'lp_done' })).project.name).toBe('Fall LAN')
  })

  it("a project of another sector, or none, is refused and nothing is written", async () => {
    await expect(link(file('/managed/a.pdf'), { project: 'lp_far' })).rejects.toThrow("LifeOS has no such project in Purdue's sector")
    await expect(link(file('/managed/a.pdf'), { project: 'lp_none' })).rejects.toThrow("LifeOS has no such project in Purdue's sector")
    expect(sent).toEqual([])
  })

  it('a remote key links only a file it could have named itself, by path or inside a Microsoft source; this window links any', async () => {
    await expect(link(file('/home/landon/secret.pdf'), { by: REMOTE })).rejects.toBeInstanceOf(FenceError)
    await expect(link({ at: 'microsoft', host: 'env_mac', app: 'word', name: 'x.docx', ref: { kind: 'path', path: '/home/landon/x.docx' } }, { by: REMOTE })).rejects.toBeInstanceOf(FenceError)
    expect(sent).toEqual([])
    await link(file('/managed/Work/Purdue/a.pdf'), { by: REMOTE })
    await link(file('/home/landon/secret.pdf'))
    expect(sent).toHaveLength(2)
  })

  it('what a project cannot list is refused in words: another LifeOS row, a browser window, an item a thread made, an empty title', async () => {
    expect(linkRefusal({ at: 'lifeos', table: 'outbox', id: 'o1' })).toBe("Only a document or a sheet of LifeOS's own can be linked to a project")
    expect(linkRefusal({ at: 'browser', host: 'env_box', sessionId: 'b1' })).toBe('A browser window cannot be linked to a project')
    expect(linkRefusal({ at: 'thread' })).toContain('save it as a file or a LifeOS document')
    expect(linkRefusal(file('/managed/a.pdf'))).toBeNull()
    await expect(link({ at: 'lifeos', table: 'projectDocs', id: 'n1' })).rejects.toThrow('Only a document or a sheet')
    await expect(link(file('/managed/a.pdf'), { title: '   ' })).rejects.toThrow('A linked item needs a title')
    expect(sent).toEqual([])
  })
})

describe('work.projects.link', () => {
  const ask = (params: unknown, by: Caller = LOCAL) => projects.handle!({ id: '1', method: 'work.projects.link', params } as ClientRequest, ctx, by)
  const params = (over: Record<string, unknown> = {}) => ({ workspaceId: 'ws', lifeosProjectId: 'lp_1', source: file('/managed/a.pdf'), title: 'Rules', ...over })

  it('needs operate, and answers what was linked', async () => {
    expect(requiredCapability({ method: 'work.projects.link' })).toBe('operate')
    expect(ProjectsRequestSchemas[0].shape.params.safeParse(params()).success).toBe(true)
    expect(await ask(params())).toEqual({ handled: true, result: { as: 'item', id: 'item_1' } })
  })

  it('is refused in a code workspace and in a Work workspace with no sector', async () => {
    await expect(ask(params({ workspaceId: 'repo' }))).rejects.toThrow('not a Work workspace linked to a LifeOS sector')
    await expect(ask(params({ workspaceId: 'side' }))).rejects.toThrow('not a Work workspace linked to a LifeOS sector')
    await expect(ask(params({ workspaceId: 'nope' }))).rejects.toThrow('not a Work workspace linked to a LifeOS sector')
  })

  it("is a screen's method: a thread's own call is sent to its tool", async () => {
    await expect(ask(params(), { kind: 'model', caps: [], sessionId: 't-root' })).rejects.toThrow('A thread links to a project with project_link_item.')
    expect(sent).toEqual([])
  })

  it('leaves every other method to its own pillar', async () => {
    expect(await projects.handle!({ id: '1', method: 'work.project.open', params: {} } as ClientRequest, ctx, LOCAL)).toEqual({ handled: false })
  })
})

describe('project_link_item', () => {
  const tool = projectsTools[0]
  const scope = (over: Partial<WorkScope> = {}): WorkScope => ({ sessionId: 't-root', workspaceId: 'ws', sector: 'purdue', host: 'env_box', away: false, routineRunId: null, shared: () => false, ...over })
  const run = async (args: unknown, o: { sessionId?: string; scope?: WorkScope } = {}) => {
    const parsed = tool.input.safeParse(args)
    if (!parsed.success) throw new Error(parsed.error.message)
    const answer = await tool.run(parsed.data, { ...ctx, sessionId: o.sessionId ?? 't-root', scope: o.scope ?? scope(), signal: new AbortController().signal } as ToolCtx)
    return { text: (answer.content[0] as { text: string }).text, isError: answer.isError === true }
  }

  it("links one of the thread's canvas items under its own title, and records the result", async () => {
    item('i1', 't-root', { at: 'lifeos', table: 'docs', id: 'd_near' }, 'Run of show')
    expect(await run({ project: 'lp_1', item: 'i1' })).toEqual({ text: 'Run of show is now a document of Spring LAN.', isError: false })
    expect(sent).toEqual([{ fn: 'docs:setProject', args: { id: 'd_near', projectId: 'lp_1' } }])
    expect(results).toEqual([{ sessionId: 't-root', kind: 'projects.link', summary: 'Linked Run of show to Spring LAN', ref: { at: 'lifeos', table: 'projects', id: 'lp_1' } }])
  })

  it("a subagent links an item of its root's pane; another thread's item is not there to link", async () => {
    item('i1', 't-root', file('/work/budget.xlsx'), 'Budget')
    item('i2', 't-other', file('/work/other.xlsx'), 'Other')
    expect((await run({ project: 'lp_1', item: 'i1', title: 'Spring budget' }, { sessionId: 't-sub' })).text).toBe('Linked Spring budget to Spring LAN (item item_1).')
    expect(await run({ project: 'lp_1', item: 'i2' })).toEqual({ text: 'This thread has no such canvas item.', isError: true })
    expect(await run({ project: 'lp_1', item: 'i_none' })).toEqual({ text: 'This thread has no such canvas item.', isError: true })
    expect(sent).toHaveLength(1)
  })

  it('links a named source, which needs a title', async () => {
    expect(await run({ project: 'lp_1', source: file('/work/a.pdf') })).toEqual({ text: 'Give a title: a source has no name of its own.', isError: true })
    expect((await run({ project: 'lp_1', source: file('/work/a.pdf'), title: 'Venue contract' })).isError).toBe(false)
  })

  it('wants an item or a source, never both and never neither', async () => {
    item('i1', 't-root', file('/work/a.pdf'), 'A')
    expect((await run({ project: 'lp_1' })).text).toBe('Give an item or a source, one of the two.')
    expect((await run({ project: 'lp_1', item: 'i1', source: file('/work/a.pdf') })).text).toBe('Give an item or a source, one of the two.')
  })

  it("stays inside the thread's sector: a project or a document of another is refused as missing, and a Work Chat links nothing", async () => {
    item('i1', 't-root', { at: 'lifeos', table: 'docs', id: 'd_far' }, 'Drop rates')
    expect(await run({ project: 'lp_far', source: file('/work/a.pdf'), title: 'A' })).toEqual({ text: "LifeOS has no such project in Purdue's sector", isError: true })
    expect(await run({ project: 'lp_1', item: 'i1' })).toEqual({ text: "LifeOS has no such document in Purdue's sector", isError: true })
    expect((await run({ project: 'lp_1', source: file('/work/a.pdf'), title: 'A' }, { scope: scope({ workspaceId: null, sector: null }) })).text).toContain('This thread is in no workspace linked to LifeOS')
    expect(sent).toEqual([])
    expect(results).toEqual([])
  })

  it('never puts a document before a guest: a LifeOS document is not linked to a shared project by a thread, though a file is and the owner may', async () => {
    lifeosProjects.push({ _id: 'lp_shared', name: 'Open house', status: 'active', sector: 'purdue', shared: true } as never)
    item('i1', 't-root', { at: 'lifeos', table: 'docs', id: 'd_near' }, 'Run of show')
    expect(await run({ project: 'lp_shared', item: 'i1' })).toEqual({ text: 'Open house is shared with a guest: only the owner links a document or sheet to it', isError: true })
    expect(sent).toEqual([])
    expect((await run({ project: 'lp_shared', source: file('/work/a.pdf'), title: 'Venue contract' })).isError).toBe(false)
    expect((await link({ at: 'lifeos', table: 'docs', id: 'd_near' }, { project: 'lp_shared' })).linked).toEqual({ as: 'doc', id: 'd_near' })
    lifeosProjects.pop()
  })

  it('tells the thread what it is told in the preamble, and is the pillar\'s one tool', () => {
    expect(projects.tools!(scope()).map((t) => t.name)).toEqual(['project_link_item'])
    expect(projects.preamble!(scope())).toContain('project_link_item')
    expect(projects.preamble!(scope())).toContain('get_project')
    for (const word of ['expected_state', 'add_comment', 'add_tasks', 'moved on']) expect(projects.preamble!(scope())).toContain(word)
  })
})

describe("@ finds a project's card by its key", () => {
  const purdue: MentionReach = { work: true, workspaceId: 'ws', sectors: ['purdue'], sessionId: 't-root' }
  const everywhere: MentionReach = { work: true, workspaceId: null, sectors: 'all', sessionId: 't-chat' }
  const find = (text: string, reach = purdue) => cardMention.search(text, reach, ctx)

  it('answers the task as a card: its key and title, its project as the line under it, its due date', async () => {
    expect(await find('pur-41')).toEqual([
      { chip: { kind: 'card', label: 'PUR-41 Network for 64 seats', ref: { at: 'lifeos', table: 'tasks', id: 't41' }, excerpt: 'Wired only.' }, detail: 'Spring LAN', at: 99 }
    ])
    expect((await find(' PUR-41 '))[0].chip.label).toBe('PUR-41 Network for 64 seats')
  })

  it('finds nothing by words, by a key that is no key, or for a task in no project: those are the Tasks group\'s', async () => {
    for (const text of ['', 'network', 'PUR', 'PUR-', 'PUR-0', 'XYZ-4']) expect(await find(text)).toEqual([])
    expect(asked.filter((a) => a.fn === 'tasks:byKeys')).toEqual([])
    expect(await find('PUR-42')).toEqual([])
    expect(await find('PUR-999')).toEqual([])
  })

  it("never asks LifeOS for a key of a sector the thread may not read, and drops a row of another sector whatever came back", async () => {
    expect(await find('COS-7')).toEqual([])
    expect(asked).toEqual([])
    // A Work Chat reads every sector.
    expect((await find('COS-7', everywhere))[0].chip.ref).toEqual({ at: 'lifeos', table: 'tasks', id: 't7' })
    // LifeOS answering a row of another sector for a key of this one: dropped.
    lifeosTasks.push({ _id: 'tx', key: 'PUR-50', title: 'Moved away', sector: 'cosmic', projectId: 'lp_far' })
    expect(await find('PUR-50')).toEqual([])
    lifeosTasks.pop()
  })

  it('is one of the module\'s kinds, read from LifeOS', () => {
    expect(projects.mentions).toEqual([cardMention])
    expect(cardMention.lifeos).toBe(true)
  })
})

describe("a new document in a project (Documents' New document)", () => {
  const create = (params: unknown) => docs.handle!({ id: '1', method: 'work.docs.create', params } as ClientRequest, ctx, LOCAL)

  it("is made in a project of the sector the call names, and in no other sector's", async () => {
    await create({ sector: 'purdue', projectId: 'lp_1', title: 'Untitled' })
    expect(sent).toEqual([{ fn: 'docs:create', args: { projectId: 'lp_1', title: 'Untitled' } }])
    sent = []
    await expect(create({ sector: 'purdue', projectId: 'lp_far', title: 'Untitled' })).rejects.toThrow('LifeOS has no such project in this sector')
    await expect(create({ sector: 'purdue', projectId: 'lp_none', title: 'Untitled' })).rejects.toThrow('LifeOS has no such project in this sector')
    expect(sent).toEqual([])
  })
})
