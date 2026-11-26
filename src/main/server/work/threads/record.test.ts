import { describe, expect, it, vi } from 'vitest'
import type { OutboxItem, WorkResult } from '@shared/contract-work-outbox'
import type { SessionMeta } from '@shared/events'
import { heldWords, requestWords } from '@shared/work/threadRecord'
import {
  outcomeOf,
  sourceKeyOf,
  threadRecord,
  ThreadRecords,
  WORKS_FRESH_MS,
  WORKS_KEEP_MS,
  WORKS_KEPT,
  WORKS_LATE,
  WORKS_WAIT_MS,
  type OutcomeMeta,
  type RecordFacts,
  type RecordSources
} from './record'

/** What a Work thread left him (work/threads/record.ts): the record, its outcome line, and the keeper that folds it. */

const T0 = 1_700_000_000_000
const idle: OutcomeMeta = { status: 'idle', failure: null, statusDetail: null, treeHasLiveWork: false, treeCanContinue: false }

function item(over: Partial<OutboxItem> = {}): OutboxItem {
  return {
    ref: { at: 'host', id: over.ref?.id ?? 'h1' },
    kind: 'mail.send',
    workspaceId: 'w1',
    sessionId: 'root',
    sector: 'purdue',
    summary: 'Send to Sam Ortiz: Two switches',
    verb: 'Send',
    account: 'landon@purdue.edu',
    state: 'held',
    payload: {},
    createdAt: T0,
    decidedBy: null,
    decidedAt: null,
    n: 1,
    why: 'rule',
    grantId: null,
    error: null,
    result: null,
    routineRunId: null,
    updatedAt: T0,
    ...over
  }
}

function result(over: Partial<WorkResult> = {}): WorkResult {
  return {
    id: 'r1',
    sessionId: 'root',
    rootId: 'root',
    workspaceId: 'w1',
    kind: 'file.make',
    summary: 'Made Seat map.xlsx in Spring LAN',
    account: null,
    ref: { at: 'files', workspaceId: 'w1', files: [{ ref: { at: 'file', host: 'box', path: '/w/Seat map.xlsx' }, name: 'Seat map.xlsx' }] },
    undo: null,
    undoneAt: null,
    createdAt: T0,
    ...over
  }
}

const facts = (over: Partial<RecordFacts> = {}): RecordFacts => ({ root: { ...idle, id: 'root' }, held: [], requests: [], results: [], links: [], tasks: new Map(), ...over })

describe('a task the thread works on', () => {
  it("is named by the task's own title, never the link's, which is the thread's title when it linked", () => {
    const link = { entity: { table: 'tasks', id: 'k1' }, title: 'New chat', state: 'open' as const, at: T0 }
    const named = threadRecord(facts({ links: [link], tasks: new Map([['k1', { title: 'Count the spare cables', status: 'todo' }]]) }))
    expect(named.works[0]!.title).toBe('Count the spare cables')
    // Unread (LifeOS down, past the read cap): the link's words stand.
    expect(threadRecord(facts({ links: [link] })).works[0]!.title).toBe('New chat')
  })
})

describe('the outcome line', () => {
  it('says what is held for his press, by kind, muted as held', () => {
    expect(outcomeOf(idle, [item()], [])).toEqual({ words: '1 mail to send', tone: 'held' })
    expect(outcomeOf(idle, [item(), item({ ref: { at: 'host', id: 'h2' } })], [])).toEqual({ words: '2 mails to send', tone: 'held' })
    expect(heldWords([{ kind: 'mail.send' }, { kind: 'file.act' }])).toBe('2 items to approve')
    expect(heldWords([{ kind: 'office.edit' }])).toBe('1 file change to approve')
  })

  it('puts a question first, over everything held', () => {
    expect(outcomeOf({ ...idle, status: 'waiting' }, [item()], [])).toEqual({ words: 'Asks you', tone: 'asks' })
  })

  it('says a failure in his words: a sign-in that ran out, a send that failed', () => {
    const failure = { kind: 'oauth_expired' as const, account: null, summary: 'The sign-in ran out', cause: 'x' }
    expect(outcomeOf({ ...idle, status: 'error', failure }, [item()], [])).toEqual({ words: "Couldn't sign in", tone: 'failed' })
    expect(outcomeOf(idle, [item({ state: 'failed', error: 'Outlook refused it' })], [])).toEqual({ words: "Couldn't send", tone: 'failed' })
    // Live work again: the old failure is not the line.
    expect(outcomeOf({ ...idle, status: 'running', failure, treeHasLiveWork: true, statusDetail: 'Editing Budget FY27.xlsx' }, [], [])).toEqual({ words: 'Editing Budget FY27.xlsx', tone: 'working' })
  })

  it('says live work by what it does, else Working; held still wins over working', () => {
    expect(outcomeOf({ ...idle, status: 'running' }, [], [])).toEqual({ words: 'Working', tone: 'working' })
    expect(outcomeOf({ ...idle, status: 'running' }, [item()], [])).toEqual({ words: '1 mail to send', tone: 'held' })
  })

  it('names the newest thing made, or the newest act done, once nothing waits', () => {
    expect(outcomeOf(idle, [], [result()])).toEqual({ words: 'Made Seat map.xlsx', tone: 'made' })
    const sent = result({ id: 'r2', kind: 'mail.send', summary: 'Sent to Sam Ortiz', ref: null, createdAt: T0 + 5 })
    expect(outcomeOf(idle, [], [result(), sent])).toEqual({ words: 'Mail sent', tone: 'done' })
    // An undone Result is not what it left him.
    expect(outcomeOf(idle, [], [result({ undoneAt: T0 + 1 })])).toBeNull()
    expect(outcomeOf(idle, [], [])).toBeNull()
  })

  it('folds an open request for his press into the muted held line, below the thread’s own held acts', () => {
    expect(outcomeOf(idle, [], [], 1)).toEqual({ words: '1 request to approve', tone: 'held' })
    expect(requestWords(2)).toBe('2 requests to approve')
    expect(outcomeOf(idle, [item()], [], 1)).toEqual({ words: '1 mail to send', tone: 'held' })
    expect(outcomeOf({ ...idle, status: 'waiting' }, [], [], 1)).toEqual({ words: 'Asks you', tone: 'asks' })
    expect(threadRecord(facts({ requests: [{ id: 'q1', n: 3, head: 'Send 2 items', createdAt: T0 }] })).outcome).toEqual({ words: '1 request to approve', tone: 'held' })
  })

  it('leaves out an Outbox item that no longer waits: discarded, sent, scheduled, or out of date and put away', () => {
    const gone = [
      item({ state: 'discarded' }),
      item({ state: 'sent' }),
      item({ state: 'held', scheduledFor: T0 + 60_000 }),
      item({ state: 'stale', dismissedAt: T0 + 1 })
    ]
    expect(outcomeOf(idle, gone, [])).toBeNull()
    expect(threadRecord(facts({ held: gone })).waits).toEqual([])
    // Out of date and not put away still waits.
    expect(outcomeOf(idle, [item({ state: 'stale' })], [])).toEqual({ words: '1 mail to send', tone: 'held' })
  })
})

describe('the record', () => {
  it('lists what waits, most pressing first: the question, the failure, a request, a failed send, then held oldest first', () => {
    const failure = { kind: 'network' as const, account: null, summary: 'The model could not be reached', cause: 'x' }
    const r = threadRecord(
      facts({
        root: { ...idle, id: 'root', status: 'error', failure },
        held: [item({ ref: { at: 'host', id: 'late' }, createdAt: T0 + 9 }), item({ ref: { at: 'host', id: 'early' } }), item({ ref: { at: 'host', id: 'bad' }, state: 'failed', createdAt: T0 + 20 })],
        requests: [{ id: 'q1', n: 3, head: 'Send 2 items', createdAt: T0 }]
      })
    )
    expect(r.waits.map((w) => (w.kind === 'held' ? `held:${w.item.ref.id}` : w.kind))).toEqual(['failed', 'request', 'held:bad', 'held:early', 'held:late'])
    expect(r.waits[0]).toEqual({ kind: 'failed', sessionId: 'root', words: "Couldn't reach the model", cause: 'The model could not be reached' })
    const asking = threadRecord(facts({ root: { ...idle, id: 'root', status: 'waiting' } }))
    expect(asking.waits).toEqual([{ kind: 'asks', sessionId: 'root' }])
    expect(asking.outcome).toEqual({ words: 'Asks you', tone: 'asks' })
  })

  it('says the task it works on with its waiting-on and since when, the open task first', () => {
    const r = threadRecord(
      facts({
        links: [
          { entity: { table: 'mailThreads', id: 'm1' }, title: 'Switches for the LAN', state: 'open', at: T0 + 5 },
          { entity: { table: 'tasks', id: 't1' }, title: 'Borrow two switches from ITaP', state: 'open', at: T0 },
          { entity: { table: 'projects', id: 'p1' }, title: 'Spring LAN', state: 'open', at: T0 }
        ],
        tasks: new Map([['t1', { status: 'waiting', waitingOn: 'Sam Ortiz', waitingSince: T0 - 6 * 86_400_000, projectId: 'p1' }]])
      })
    )
    expect(r.works).toEqual([
      { table: 'tasks', id: 't1', title: 'Borrow two switches from ITaP', state: 'open', at: T0, task: { status: 'waiting', due: null, projectId: 'p1', waitingOn: { name: 'Sam Ortiz', since: T0 - 6 * 86_400_000 } } },
      { table: 'mailThreads', id: 'm1', title: 'Switches for the LAN', state: 'open', at: T0 + 5 }
    ])
    // A task LifeOS closed reads done whatever the link says.
    const done = threadRecord(facts({ links: [{ entity: { table: 'tasks', id: 't1' }, title: 'x', state: 'open', at: T0 }], tasks: new Map([['t1', { status: 'done' }]]) }))
    expect(done.works[0]?.state).toBe('done')
  })

  it('lists what it made and changed, newest first, each with where it opens; a subagent’s write is its root’s', () => {
    const r = threadRecord(
      facts({
        results: [
          result(),
          result({ id: 'r2', sessionId: 'child', kind: 'file.rename', summary: 'Renamed Budget.xlsx in Spring LAN', createdAt: T0 + 10, ref: { at: 'files', workspaceId: 'w1', files: [{ ref: { at: 'file', host: 'box', path: '/w/Budget FY27.xlsx' }, name: 'Budget FY27.xlsx' }] } }),
          result({ id: 'r3', kind: 'projects.link', summary: 'Linked Run of show to Spring LAN', ref: { at: 'lifeos', table: 'projects', id: 'p1' }, createdAt: T0 + 2 }),
          result({ id: 'r4', kind: 'google.doc.upload', summary: 'Made Agenda a Google Doc', ref: { at: 'google', fileId: 'g', url: 'https://docs.google.com/d/g' }, createdAt: T0 + 1 }),
          result({ id: 'r5', kind: 'mail.send', summary: 'Sent', ref: null, createdAt: T0 + 30 }),
          result({ id: 'r6', kind: 'file.trash', summary: 'Put in Trash Old.xlsx in Spring LAN', ref: null, createdAt: T0 + 3 })
        ]
      })
    )
    expect(r.made.map((m) => [m.id, m.sessionId, m.verb, m.name, m.open?.at ?? null])).toEqual([
      ['r2', 'child', 'Renamed', 'Budget FY27.xlsx', 'files'],
      ['r6', 'root', 'Put in Trash', 'Old.xlsx in Spring LAN', null],
      ['r3', 'root', 'Linked', 'Run of show to Spring LAN', 'project'],
      ['r4', 'root', 'Made', 'Agenda a Google Doc', 'url'],
      ['r1', 'root', 'Made', 'Seat map.xlsx', 'files']
    ])
    expect(r.made[0]!.open).toEqual({ at: 'files', workspaceId: 'w1', ref: { at: 'file', host: 'box', path: '/w/Budget FY27.xlsx' }, name: 'Budget FY27.xlsx' })
    expect(r.outcome).toEqual({ words: 'Mail sent', tone: 'done' })
  })
})

describe('the keeper', () => {
  function keeper(over: Partial<RecordSources> = {}) {
    const waiting = vi.fn(() => [item(), item({ ref: { at: 'host', id: 'h2' }, sessionId: 'child' }), item({ ref: { at: 'host', id: 'h3' }, sessionId: 'other' })])
    const results = vi.fn((root: string) => (root === 'root' ? [result()] : []))
    const sources: RecordSources = {
      waiting,
      results,
      requests: () => [],
      links: async () => [],
      task: async () => null,
      rootOf: (id) => (id === 'child' ? 'root' : id),
      workspaceOf: () => 'w1',
      log: () => {},
      ...over
    }
    const meta = { id: 'root', scope: 'work', ...idle } as unknown as SessionMeta
    const refreshMeta = vi.fn()
    const registry = { get: (id: string) => (id === 'root' ? meta : id === 'code' ? ({ ...meta, id: 'code', scope: undefined } as SessionMeta) : null), refreshMeta }
    return { records: new ThreadRecords(sources, registry), waiting, results, refreshMeta, meta }
  }

  it('folds the outcome from memory: one Outbox read for every row, a child’s held item counted on its root', () => {
    const { records, waiting, results, meta } = keeper()
    expect(records.outcome(meta)).toEqual({ words: '2 mails to send', tone: 'held' })
    expect(records.outcome({ ...meta, id: 'other' })).toEqual({ words: '1 mail to send', tone: 'held' })
    expect(records.outcome(meta)).toEqual({ words: '2 mails to send', tone: 'held' })
    expect(waiting).toHaveBeenCalledTimes(1)
    expect(results).toHaveBeenCalledTimes(2)
  })

  it('reads again only on a change, and says the touched root again', () => {
    const { records, waiting, results, refreshMeta, meta } = keeper()
    records.outcome(meta)
    records.heldChanged({ sessionId: 'child' })
    expect(refreshMeta).toHaveBeenLastCalledWith(['root'])
    records.outcome(meta)
    expect(waiting).toHaveBeenCalledTimes(2)
    records.resultChanged({ rootId: 'root' })
    expect(refreshMeta).toHaveBeenLastCalledWith(['root'])
    records.outcome(meta)
    expect(results).toHaveBeenCalledTimes(2)
    // LifeOS's own held items moved: every root that held before or holds now.
    records.heldChanged(null)
    expect(refreshMeta.mock.lastCall?.[0]).toEqual(expect.arrayContaining(['root', 'other']))
  })

  it('folds a root’s open requests from one read, and says the root again when one moves', () => {
    const requests = vi.fn(() => [{ id: 'q', n: 1, head: 'Send 1 item', createdAt: T0, sessionId: 'child' }])
    const { records, refreshMeta, meta } = keeper({ waiting: () => [], requests })
    expect(records.outcome(meta)).toEqual({ words: '1 request to approve', tone: 'held' })
    expect(records.outcome({ ...meta, id: 'other' })).toBeNull()
    expect(requests).toHaveBeenCalledTimes(1)
    requests.mockReturnValue([])
    records.requestChanged({ sessionId: 'child' })
    expect(refreshMeta).toHaveBeenLastCalledWith(['root'])
    expect(records.outcome(meta)).toEqual({ words: 'Made Seat map.xlsx', tone: 'made' })
  })

  it('lists a mirror’s files: one row a thing at its newest standing write, two files of one name apart, a linked item with its id', () => {
    const at = (path: string) => ({ at: 'files', workspaceId: 'w1', files: [{ ref: { at: 'file', host: 'box', path }, name: 'Budget.xlsx' }] })
    const rows: Record<string, WorkResult[]> = {
      a: [
        result({ id: 'a1', rootId: 'a', sessionId: 'a', summary: 'Made Budget.xlsx', ref: at('/a/Budget.xlsx'), createdAt: T0 + 1 }),
        result({ id: 'a2', rootId: 'a', sessionId: 'a', kind: 'file.save', summary: 'Saved Budget.xlsx', ref: at('/a/Budget.xlsx'), createdAt: T0 + 5 }),
        result({ id: 'a3', rootId: 'a', sessionId: 'a', kind: 'projects.link', summary: 'Linked Run of show to Spring LAN', ref: { at: 'lifeos', table: 'projects', id: 'p1', itemId: 'i-run' }, createdAt: T0 + 2 }),
        result({ id: 'a4', rootId: 'a', sessionId: 'a', kind: 'mail.send', summary: 'Sent', ref: null, createdAt: T0 + 9 })
      ],
      b: [
        result({ id: 'b1', rootId: 'b', sessionId: 'b', summary: 'Made Budget.xlsx', ref: at('/b/Budget.xlsx'), createdAt: T0 + 3 }),
        result({ id: 'b2', rootId: 'b', sessionId: 'b', kind: 'file.save', summary: 'Saved Budget.xlsx', ref: at('/b/Budget.xlsx'), createdAt: T0 + 4, undoneAt: T0 + 6 })
      ]
    }
    const { records } = keeper({ results: (root) => rows[root] ?? [] })
    const files = records.projectFiles(['a', 'b'])
    expect(files.map((f) => [f.id, f.rootId, f.name, f.itemId ?? null])).toEqual([
      ['a2', 'a', 'Budget.xlsx', null],
      ['b1', 'b', 'Budget.xlsx', null],
      ['a3', 'a', 'Run of show to Spring LAN', 'i-run']
    ])
    expect(sourceKeyOf({ id: 'g', ref: { at: 'google', fileId: 'f1', url: 'https://x' } })).toBe(sourceKeyOf({ id: 'h', ref: { at: 'google', fileId: 'f1' } }))
    expect(sourceKeyOf({ id: 'n1', ref: null })).not.toBe(sourceKeyOf({ id: 'n2', ref: null }))
  })

  it('lists a batch’s files one each, each opening itself, one row with a file it changed alone; an old project link with no item draws none', () => {
    const file = (path: string, name: string) => ({ ref: { at: 'file', host: 'box', path }, name })
    const rows: WorkResult[] = [
      result({ id: 'm', rootId: 'a', sessionId: 'a', summary: 'Made 2 files', ref: { at: 'files', workspaceId: 'w1', files: [file('/a/Seat.xlsx', 'Seat.xlsx'), file('/a/Run.docx', 'Run.docx')] }, createdAt: T0 + 1 }),
      result({ id: 's', rootId: 'a', sessionId: 'a', kind: 'file.save', summary: 'Saved Run.docx', ref: { at: 'files', workspaceId: 'w1', files: [file('/a/Run.docx', 'Run.docx')] }, createdAt: T0 + 5 }),
      result({ id: 'old', rootId: 'a', sessionId: 'a', kind: 'projects.link', summary: 'Linked Run of show to Spring LAN', ref: { at: 'lifeos', table: 'projects', id: 'p1' }, createdAt: T0 + 3 })
    ]
    const { records } = keeper({ results: () => rows })
    const files = records.projectFiles(['a'])
    expect(files.map((f) => [f.id, f.name, f.verb])).toEqual([
      ['s', 'Run.docx', 'Saved'],
      ['m:0', 'Seat.xlsx', 'Made']
    ])
    expect(files[1]!.open).toEqual({ at: 'files', workspaceId: 'w1', ref: { at: 'file', host: 'box', path: '/a/Seat.xlsx' }, name: 'Seat.xlsx' })
  })

  it('answers a subagent’s id with its root’s record, and refuses a code thread', async () => {
    const { records } = keeper({ requests: () => [{ id: 'q', n: 1, head: 'Send 1 item', createdAt: T0, sessionId: 'child' }] })
    const r = await records.record('child')
    expect(r.sessionId).toBe('root')
    expect(r.workspaceId).toBe('w1')
    expect(r.waits.map((w) => w.kind)).toEqual(['request', 'held', 'held'])
    expect(r.made.map((m) => m.name)).toEqual(['Seat map.xlsx'])
    await expect(records.record('code')).rejects.toThrow(/not a Work thread/)
    await expect(records.record('gone')).rejects.toThrow(/unknown thread/)
  })

  it('says why the links are missing when LifeOS cannot be read, and keeps the rest', async () => {
    const { records } = keeper({
      links: async () => {
        throw new Error('This host is not signed in to LifeOS')
      }
    })
    const r = await records.record('root')
    expect(r.worksDown).toBe('This host is not signed in to LifeOS')
    expect(r.works).toEqual([])
    expect(r.waits).toHaveLength(2)
  })

  const link = { entity: { table: 'tasks', id: 't1' }, title: 'Thread', state: 'open' as const, at: T0 }

  it('answers a head that asks again from what it keeps: one LifeOS read, no Outbox read, until something changed', async () => {
    let now = T0
    const links = vi.fn(async () => [link])
    const task = vi.fn(async () => ({ title: 'Borrow two switches', status: 'todo' }))
    const { records, waiting, results } = keeper({ links, task, now: () => now })
    const first = await records.record('root')
    const again = await records.record('root')
    expect(again).toEqual(first)
    expect(first.works[0]).toMatchObject({ id: 't1', title: 'Borrow two switches' })
    expect([links.mock.calls.length, task.mock.calls.length]).toEqual([1, 1])
    expect([waiting.mock.calls.length, results.mock.calls.length]).toEqual([1, 1])
    // A held item moved: the held facts are read again, the LifeOS half is not.
    records.heldChanged({ sessionId: 'child' })
    await records.record('root')
    expect([waiting.mock.calls.length, links.mock.calls.length]).toEqual([2, 1])
    // After a minute the LifeOS half is read again.
    now += WORKS_KEEP_MS
    await records.record('root')
    expect(links.mock.calls.length).toBe(2)
  })

  it('reads LifeOS again when the asker saw it move, and when this host linked or completed for the thread', async () => {
    let now = T0
    let title = 'Borrow two switches'
    const links = vi.fn(async () => [link])
    const { records } = keeper({ links, task: async () => ({ title, status: 'todo' }), now: () => now })
    await records.record('root')
    title = 'Borrow three switches'
    // A plain ask a moment later still says what is kept: nothing told the host it moved.
    now += 5_000
    expect((await records.record('root')).works[0]!.title).toBe('Borrow two switches')
    expect((await records.record('root', { fresh: true })).works[0]!.title).toBe('Borrow three switches')
    expect(links.mock.calls.length).toBe(2)
    // The asker's retry right behind a read takes that read.
    now += WORKS_FRESH_MS - 1
    await records.record('root', { fresh: true })
    expect(links.mock.calls.length).toBe(2)
    // A subagent's link is its root's.
    records.worksChanged('child')
    await records.record('root')
    expect(links.mock.calls.length).toBe(3)
    records.reset()
    await records.record('root')
    expect(links.mock.calls.length).toBe(4)
  })

  it('a read out when the thread\'s links changed is never kept: the next ask reads again, and the older answer does not refill the cache', async () => {
    const lands: ((rows: (typeof link)[]) => void)[] = []
    const links = vi.fn(() => new Promise<(typeof link)[]>((resolve) => lands.push(resolve)))
    const { records } = keeper({ links, task: async () => ({ title: 'Borrow two switches', status: 'todo' }) })
    const old = records.record('root')
    await vi.waitFor(() => expect(links).toHaveBeenCalledTimes(1))
    // This host linked a record for the thread while that read was out.
    records.worksChanged('child')
    const fresh = records.record('root')
    await vi.waitFor(() => expect(links).toHaveBeenCalledTimes(2))
    lands[1]!([{ ...link, title: 'after' }])
    expect((await fresh).works).toHaveLength(1)
    // The older read lands last: it answers its own asker, and the cache keeps the newer read.
    lands[0]!([])
    expect((await old).works).toEqual([])
    expect((await records.record('root')).works).toHaveLength(1)
    expect(links).toHaveBeenCalledTimes(2)
  })

  it('never waits on LifeOS past its bound: the answer says so with the local facts, and the late read is kept for the retry', async () => {
    vi.useFakeTimers()
    try {
      let land!: (rows: (typeof link)[]) => void
      const links = vi.fn(() => new Promise<(typeof link)[]>((resolve) => (land = resolve)))
      const { records } = keeper({ links })
      const asked = records.record('root')
      const second = records.record('root')
      await vi.advanceTimersByTimeAsync(WORKS_WAIT_MS)
      const late = await asked
      expect(late.worksDown).toBe(WORKS_LATE)
      expect(late.waits).toHaveLength(2)
      expect((await second).worksDown).toBe(WORKS_LATE)
      // Two asks, one read under way.
      expect(links.mock.calls.length).toBe(1)
      land([link])
      await vi.advanceTimersByTimeAsync(0)
      const retry = await records.record('root')
      expect(retry.worksDown).toBeUndefined()
      expect(retry.works).toHaveLength(1)
      expect(links.mock.calls.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the halves of the newest hundred roots, and a thread that is no longer a Work thread is refused whatever is kept', async () => {
    const metas = new Map<string, SessionMeta>()
    const links = vi.fn(async () => [])
    const records = new ThreadRecords(
      { waiting: () => [], results: () => [], requests: () => [], links, task: async () => null, rootOf: (id) => id, workspaceOf: () => null, log: () => {} },
      { get: (id) => metas.get(id) ?? null }
    )
    for (let i = 0; i <= WORKS_KEPT; i++) metas.set(`r${i}`, { id: `r${i}`, scope: 'work', ...idle } as unknown as SessionMeta)
    for (let i = 0; i <= WORKS_KEPT; i++) await records.record(`r${i}`)
    expect(links.mock.calls.length).toBe(WORKS_KEPT + 1)
    // The newest is kept, the oldest was let go.
    await records.record(`r${WORKS_KEPT}`)
    expect(links.mock.calls.length).toBe(WORKS_KEPT + 1)
    await records.record('r0')
    expect(links.mock.calls.length).toBe(WORKS_KEPT + 2)
    metas.delete('r5')
    await expect(records.record('r5')).rejects.toThrow(/unknown thread/)
  })
})
