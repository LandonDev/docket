import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'
import type { WorkScope } from '@shared/work'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import { inputShapeOf, type ToolCtx, type WorkCtx, type WorkModule } from '../modules'
import { mentionReachOf, type ScopeFacts } from '../scope'
import { search } from './index'
import type { SearchSource } from './source'
import { lifeosSources } from './sources/lifeos'
import { COSMIC, fakeSource, hit, makeRig, PURDUE } from './testkit'
import { searchPreamble, searchText, searchTools } from './tools'

/**
 * The agents' tool and its fence: it reads the thread's own reach and has
 * no argument that could point it at another job. The reach here is the
 * real rule's (`mentionReachOf`, work/scope.ts) over made-up rows.
 */

const workspace = (id: string, sector: string | null, kind: 'work' | 'code' = 'work'): WorkspaceMeta => ({ id, name: id, path: `/w/${id}`, kind, sector }) as unknown as WorkspaceMeta
const thread = (id: string, over: Partial<SessionMeta>): SessionMeta => ({ id, parentId: null, projectId: null, workspaceId: null, scope: 'work', ...over }) as SessionMeta
const rows: Record<string, SessionMeta> = {
  't-purdue': thread('t-purdue', { workspaceId: PURDUE }),
  // a subagent's row carries its root's job, stamped at create
  't-child': thread('t-child', { workspaceId: PURDUE, parentId: 't-purdue' }),
  't-in-project': thread('t-in-project', { projectId: 'proj-lan' }),
  't-chat': thread('t-chat', {}),
  't-code': thread('t-code', { workspaceId: 'ws-code', scope: undefined }),
  't-orphan': thread('t-orphan', { workspaceId: 'ws-code' })
}
const facts: ScopeFacts = {
  workspaces: () => [workspace(PURDUE, 'purdue'), workspace(COSMIC, 'cosmic'), workspace('ws-bare', null), workspace('ws-code', 'cosmic', 'code')],
  project: (id) => (id === 'proj-lan' ? ({ id, workspaceId: PURDUE, name: 'LAN' } as unknown as ProjectMeta) : null),
  session: (id) => rows[id] ?? null
}

/** A rig whose `ctx.mentionReach` is the real rule. */
function rigged() {
  const rig = makeRig()
  const ctx = { ...rig.ctx, mentionReach: (sessionId: string) => mentionReachOf(facts, rows[sessionId] ?? null) } as WorkCtx
  return { ...rig, ctx }
}
/** A source that answers one matching row in each job it is given: what a careless source would do with a wide reach. */
const perJob = (kind: string): SearchSource & { asks: { reach: { workspaces: { id: string }[] } }[] } => fakeSource(kind, (ask) => [...ask.reach.workspaces.map((w) => hit(`${kind}-${w.id}`, w.id, { title: `Budget in ${w.name}` })), ...(ask.reach.chats ? [hit(`${kind}-chat`, null, { title: 'Budget in a chat' })] : [])])

const toolFor = (own: SearchSource[], modules: WorkModule[] = []) => searchTools(() => own, modules)[0]
const run = async (rig: ReturnType<typeof rigged>, sessionId: string, own: SearchSource[], args: Record<string, unknown> = { query: 'budget' }) => {
  const tool = toolFor(own)
  const result = await tool.run(tool.input.parse(args), { ...rig.ctx, sessionId, scope: {} as WorkScope, signal: new AbortController().signal } as ToolCtx)
  return { text: (result.content[0] as { text: string }).text, isError: result.isError === true }
}

describe('work_search', () => {
  it('has no argument that names a job, a workspace or a sector, and changes nothing', () => {
    const tool = toolFor([])
    expect(tool.name).toBe('work_search')
    expect(tool.readOnly).toBe(true)
    expect(Object.keys(inputShapeOf(tool.input)!).sort()).toEqual(['kinds', 'limit', 'query'])
    // a workspace handed in all the same is not read: the parsed arguments do not carry it
    expect(Object.keys(tool.input.parse({ query: 'budget', workspaceId: COSMIC }) as object)).not.toContain('workspaceId')
  })
  it("gives a thread in one job that job's rows, with matching rows in two jobs", async () => {
    const rig = rigged()
    const mail = perJob('mail')
    const { text } = await run(rig, 't-purdue', [mail])
    expect(text).toContain('Budget in Purdue')
    expect(text).not.toContain('Cosmic')
    expect(text).not.toContain('chat')
    expect(mail.asks[0].reach.workspaces.map((w) => w.id)).toEqual([PURDUE])
  })
  it("gives a subagent of a Work thread its root's job, and a thread in a project the project's job", async () => {
    const rig = rigged()
    for (const id of ['t-child', 't-in-project']) {
      const mail = perJob('mail')
      const { text } = await run(rig, id, [mail])
      expect(text, id).toContain('Budget in Purdue')
      expect(text, id).not.toContain('Cosmic')
      expect(mail.asks[0].reach.workspaces.map((w) => w.id)).toEqual([PURDUE])
    }
  })
  it("drops another job's row even from a source that ignores the reach", async () => {
    const rig = rigged()
    const careless = fakeSource('mail', [hit('m-purdue', PURDUE, { title: 'Ours' }), hit('m-cosmic', COSMIC, { title: 'Theirs' })])
    const { text } = await run(rig, 't-purdue', [careless])
    expect(text).toContain('Ours')
    expect(text).not.toContain('Theirs')
  })
  it('reads every job for a Work Chat, as its @ does, and says which job a row is in', async () => {
    const rig = rigged()
    const { text } = await run(rig, 't-chat', [perJob('mail')])
    expect(text).toContain('Budget in Purdue')
    expect(text).toContain('Budget in Cosmic')
    expect(text).toMatch(/Budget in a chat.*Work Chats/)
    expect(text).toMatch(/Budget in Purdue \(Purdue\)/)
  })
  it('tells a thread with no reach it has nothing to search, and asks no source', async () => {
    const rig = rigged()
    for (const id of ['t-code', 't-orphan', 'unknown']) {
      const mail = perJob('mail')
      const { text, isError } = await run(rig, id, [mail])
      expect(isError, id).toBe(true)
      expect(text).toMatch(/nothing to search/)
      expect(mail.asks).toHaveLength(0)
    }
  })
  it('runs both tiers, keeps to the kinds and the limit asked, and heeds the signal it is given', async () => {
    const rig = rigged()
    const titles = fakeSource('thread', [hit('thread:1', PURDUE, { title: 'Budget thread' })])
    const mail = fakeSource('mail', Array.from({ length: 9 }, (_, i) => hit(`m${i}`, PURDUE, { title: `Budget mail ${i}` })), { tier: 'network' })
    const both = await run(rig, 't-purdue', [titles, mail])
    expect(both.text).toContain('Budget thread')
    expect(both.text).toContain('Budget mail 4')
    expect(both.text).not.toContain('Budget mail 5')
    expect(both.text).toContain('more mail match')
    const few = await run(rig, 't-purdue', [titles, mail], { query: 'budget', kinds: ['mail'], limit: 2 })
    expect(few.text).not.toContain('Budget thread')
    expect(few.text).toContain('Budget mail 1')
    expect(few.text).not.toContain('Budget mail 2')
    expect(mail.asks.at(-1)).toMatchObject({ limit: 2, by: { kind: 'model', sessionId: 't-purdue' } })
    expect(mail.asks.at(-1)!.signal.aborted).toBe(true) // the frame ends a source's signal once it has answered
  })
  it('reads LifeOS rows only of its own sector through the real sources', async () => {
    const rig = rigged()
    rig.rows['mail:search'] = [
      { _id: 'm1', sector: 'purdue', subject: 'Budget for the LAN', senders: ['Dana Kim'], lastMessageAt: Date.UTC(2026, 10, 20) },
      { _id: 'm2', sector: 'cosmic', subject: 'Budget for servers', senders: ['Ops'] }
    ]
    const { text } = await run(rig, 't-purdue', lifeosSources, { query: 'budget', kinds: ['mail'] })
    expect(text).toBe('Mail\n- Budget for the LAN (Dana Kim; 2026-11-20; mailThreads:m1)')
  })
})

describe('the answer as a thread reads it', () => {
  const reach = { workspaces: [{ id: PURDUE, sector: 'purdue', name: 'Purdue' }], chats: false, sessionId: 't1' }
  it('is plain lines under kind headings, each with what the thread needs to go on', () => {
    const text = searchText(
      'budget',
      {
        groups: [
          { source: 'search.person', kind: 'person', label: 'People', more: false, hits: [hit('lifeos:people:p1', PURDUE, { kind: 'person', title: 'Dana Kim', detail: 'dana.kim@example.edu' })] },
          { source: 'search.file/instant', kind: 'file', label: 'Files', more: false, hits: [hit('file:k1', PURDUE, { kind: 'file', title: 'Budget FY27.xlsx', detail: 'Esports › Finance', cloud: true, open: { to: 'file', ref: {}, name: 'Budget FY27.xlsx' } })] },
          { source: 'search.thread/instant', kind: 'thread', label: 'Threads', more: false, hits: [hit('thread:t9', PURDUE, { kind: 'thread', title: 'Budget review', open: { to: 'thread', sessionId: 't9' } })] },
          {
            source: 'search.thread/network',
            kind: 'thread',
            label: 'Threads',
            more: false,
            hits: [hit('thread:t9', PURDUE, { kind: 'thread', title: 'Budget review' }), hit('thread:t4', PURDUE, { kind: 'thread', title: 'Venue', snippet: '…the budget lines…', open: { to: 'thread', sessionId: 't4', seq: 12 } })]
          }
        ],
        pending: [],
        quiet: [{ cause: 'lifeos', line: 'This host is not signed in to LifeOS' }, { cause: 'source:search.message', line: 'Messages did not answer.' }]
      },
      reach
    )
    expect(text).toBe(
      [
        'People',
        '- Dana Kim (dana.kim@example.edu; people:p1)',
        '',
        'Files',
        '- Budget FY27.xlsx (in Esports › Finance; kept in the cloud)',
        '',
        'Threads',
        '- Budget review (thread t9)',
        '- Venue: "…the budget lines…" (thread t4)',
        '',
        'Not searched: This host is not signed in to LifeOS.',
        '',
        'Not searched: Messages did not answer.'
      ].join('\n')
    )
  })
  it('says so when nothing was found', () => {
    expect(searchText('zebra', { groups: [], pending: [], quiet: [] }, reach)).toBe('Nothing found for "zebra".')
  })
})

describe('the preamble', () => {
  it("is one line that names the tool, worded for a job's thread and for a Work Chat", () => {
    const scope = (workspaceId: string | null): WorkScope => ({ sessionId: 't', workspaceId, sector: null, host: 'h', away: false, routineRunId: null, shared: () => false })
    expect(searchPreamble(scope(PURDUE))).toMatch(/^To find anything in this job .*call `work_search` first\.$/)
    expect(searchPreamble(scope(null))).toMatch(/^To find anything in any job .*call `work_search` first\.$/)
    expect(search.preamble!(scope(PURDUE))).toBe(searchPreamble(scope(PURDUE)))
  })
})

// ── the one mount lists it to every harness ─────────────────────────────
const scopes = new Map<string, WorkScope>()
vi.mock('../scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scope')>()),
  scopePart: () => ({
    scopeOf: (id: string) => scopes.get(id) ?? null,
    mentionReach: () => null,
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))
const { startWork } = await import('../ctx')

describe('the mount', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let work: ReturnType<typeof startWork>
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-work-search-'))
    db = openDb(join(dir, 'test.db'))
    scopes.clear()
    const registry = { get: () => null, onRemoved: () => () => {}, onWorkspaceDeleted: () => () => {}, listWorkspaces: () => [] } as unknown as SessionRegistry
    vi.spyOn(console, 'error').mockImplementation(() => {})
    work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {} }, [search])
    await work.handle({ id: '1', method: 'work.set', params: { enabled: true } } as ClientRequest, LOCAL_PRINCIPAL)
  })
  afterEach(() => {
    work.close()
    db.close()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })
  it('lists work_search to a Work thread as Claude registers it and as the bridge lists it to Codex and Muse, and nothing to a code thread', () => {
    scopes.set('t-work', { sessionId: 't-work', workspaceId: PURDUE, sector: 'purdue', host: 'env_test', away: false, routineRunId: null, shared: () => false })
    // one mount for the three harnesses: Claude's `work` server registers `of`, the bridge lists `listing` to Codex and to Muse
    for (const provider of ['claude', 'codex', 'muse'] as const) {
      const session = { id: 't-work', provider, scope: 'work' } as SessionMeta
      expect(work.tools.of(session)!.tools.map((t) => t.name), provider).toContain('work_search')
      const listed = work.tools.listing(session).find((t) => t.name === 'work_search')!
      expect(listed.readOnly, provider).toBe(true)
      expect(Object.keys((listed.inputSchema as { properties: object }).properties).sort(), provider).toEqual(['kinds', 'limit', 'query'])
      expect(work.tools.of({ id: 't-code', provider } as SessionMeta), provider).toBeNull()
      expect(work.tools.listing({ id: 't-code', provider } as SessionMeta), provider).toEqual([])
    }
  })
  it('made the table for Recent at boot', () => {
    expect(db.prepare(`SELECT COUNT(*) AS n FROM work_search_recent`).get()).toEqual({ n: 0 })
  })
})
