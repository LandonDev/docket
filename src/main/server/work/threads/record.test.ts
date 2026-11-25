import { describe, expect, it, vi } from 'vitest'
import type { OutboxItem, WorkResult } from '@shared/contract-work-outbox'
import type { SessionMeta } from '@shared/events'
import { heldWords } from '@shared/work/threadRecord'
import { outcomeOf, threadRecord, ThreadRecords, type OutcomeMeta, type RecordFacts, type RecordSources } from './record'

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
})
