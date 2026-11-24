import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OWNER_PREFIX } from '../../../remote/crossHostThreads'
import { DAY, HOUR, makeRig, MIN, MON, WEEK, type Rig } from '../testkit'
import { jobsOf } from './common'
import { FAR_OWNER_PREFIX, ROW_MOST, scanThreads } from './threads'

/** The bounded read of this host's Work threads: whose messages count, how run time is measured, and what is never opened. */

let rig: Rig
beforeEach(() => {
  rig = makeRig()
})
afterEach(() => rig.close())

const scan = (week = WEEK, before: { from: number; to: number } | null = null) => scanThreads(rig.db, week, before, jobsOf(rig.db))
const T = MON + 10 * HOUR

describe('his messages are the points', () => {
  it('counts a row he wrote, at this host or with a key that could approve, and no other', async () => {
    rig.session('t1')
    rig.said('t1', T, { kind: 'owner' })
    rig.said('t1', T + MIN, { kind: 'key', keyId: 'k', owner: true })
    rig.said('t1', T + 2 * MIN, { kind: 'key', keyId: 'k', owner: false })
    rig.said('t1', T + 3 * MIN, { kind: 'thread', sessionId: 'other' })
    rig.said('t1', T + 4 * MIN, { kind: 'host', environmentId: 'mac' })
    rig.said('t1', T + 5 * MIN, { kind: 'app' })
    const got = await scan()
    expect(got.points).toEqual([
      [T, 0, 'said'],
      [T + MIN, 0, 'said']
    ])
  })

  it('reads a row with no writer by the old rule: only at the top of a tree no model could have written into', async () => {
    rig.session('plain')
    rig.session('routine', { routineRunId: 'run1' })
    rig.session('batch', { masterId: 'm1' })
    rig.session('started', { startedBy: 'plain' })
    rig.session('far')
    rig.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(`${FAR_OWNER_PREFIX}far`, 'env_mac')
    rig.session('child', { parent: 'plain' })
    for (const id of ['plain', 'routine', 'batch', 'started', 'far', 'child']) rig.said(id, T, null)
    const got = await scan()
    expect(got.points).toEqual([[T, 0, 'said']])
    expect(got.cost.threads).toBe(6)
  })

  it('names the far owner by the host’s own setting key', () => {
    expect(FAR_OWNER_PREFIX).toBe(OWNER_PREFIX)
  })

  it('counts a subagent’s thread under its top thread’s job', async () => {
    rig.session('top', { workspace: 'w-cosmic' })
    // A child row that names another workspace, or none, still belongs to its top thread's job.
    rig.session('sub', { parent: 'top', workspace: null })
    rig.session('subsub', { parent: 'sub', workspace: 'w-purdue' })
    rig.said('subsub', T)
    rig.status('sub', T, 'running')
    rig.status('sub', T + 30 * MIN, 'idle')
    const got = await scan()
    expect(got.points).toEqual([[T, 1, 'said']])
    expect(got.ran).toEqual([[1, 30 * MIN]])
  })

  it('leaves out a code thread, a Work Chat and a thread of no job on this host', async () => {
    rig.session('code', { scope: 'code', workspace: 'code' })
    rig.session('chat', { workspace: null })
    rig.session('gone', { workspace: 'w-deleted' })
    for (const id of ['code', 'chat', 'gone']) rig.said(id, T)
    expect((await scan()).points).toEqual([])
  })

  it('reads an archived thread from the cold file', async () => {
    rig.session('cold', { cold: true })
    rig.said('cold', T)
    expect((await scan()).points).toEqual([[T, 0, 'said']])
  })
})

describe('only the span is read', () => {
  it('finds the span’s rows by bisection and counts nothing outside it', async () => {
    rig.session('long')
    for (let i = 0; i < 300; i++) rig.said('long', WEEK.from - 300 * HOUR + i * HOUR)
    rig.said('long', T)
    rig.said('long', WEEK.to + HOUR)
    for (let i = 0; i < 200; i++) rig.said('long', WEEK.to + DAY + i * HOUR)
    const got = await scan()
    expect(got.points).toEqual([[T, 0, 'said']])
    // 502 rows in the thread, one in the week: the read touched a handful, not all of them.
    expect(got.cost.rows).toBeLessThan(10)
  })

  it('never opens a thread the span did not touch', async () => {
    rig.session('old', { created: MON - 60 * DAY, updated: MON - 20 * DAY })
    rig.session('new', { created: WEEK.to + HOUR, updated: WEEK.to + 2 * HOUR })
    rig.said('old', MON - 21 * DAY)
    rig.said('new', WEEK.to + HOUR)
    const got = await scan()
    expect(got.cost.threads).toBe(0)
    expect(got.points).toEqual([])
  })

  it('files a message of the week before under the same span of that week', async () => {
    rig.session('t1')
    const before = { from: WEEK.from - 7 * DAY, to: WEEK.from - 7 * DAY + 3 * DAY }
    rig.said('t1', before.from + HOUR)
    rig.said('t1', before.to + HOUR)
    rig.said('t1', T)
    const got = await scan({ from: WEEK.from, to: WEEK.from + 3 * DAY }, before)
    expect(got.before).toEqual([[before.from + HOUR, 0, 'said']])
    expect(got.points).toEqual([[T, 0, 'said']])
  })

  it('hands the loop back between slices, so a long thread never holds the host', async () => {
    rig.session('busy')
    for (let i = 0; i < 3_000; i++) rig.said('busy', T + i * 1_000)
    let turns = 0
    const tick = setInterval(() => turns++, 0)
    const got = await scan()
    clearInterval(tick)
    expect(got.points).toHaveLength(3_000)
    expect(got.cost.slices).toBeGreaterThan(1)
    expect(turns).toBeGreaterThan(0)
  })

  it('never loads a row too long to be typing, and sizes a slice by the bytes it will load', async () => {
    rig.session('big')
    rig.said('big', T)
    // A paste past the cap is no sign of typing; a tool's long output between two messages is skipped unread.
    rig.event('big', T + MIN, { type: 'user-text', text: 'x'.repeat(ROW_MOST + 1), by: { kind: 'owner' } })
    for (let i = 0; i < 40; i++) rig.event('big', T + 2 * MIN + i, { type: 'tool-result', output: 'y'.repeat(60_000) })
    rig.said('big', T + 3 * MIN)
    const got = await scan()
    expect(got.points).toEqual([
      [T, 0, 'said'],
      [T + 3 * MIN, 0, 'said']
    ])
    // 2.4 MB of tool output is more than one slice's first budget: the read took several.
    expect(got.cost.slices).toBeGreaterThan(2)
  })

  it('stops when asked to', async () => {
    rig.session('t1')
    rig.said('t1', T)
    const stop = new AbortController()
    stop.abort()
    await expect(scanThreads(rig.db, WEEK, null, jobsOf(rig.db), stop.signal)).rejects.toThrow('stopped')
  })
})

describe('how long the threads worked', () => {
  it('measures running to settled, and adds the threads of one job', async () => {
    rig.session('a')
    rig.session('b')
    rig.status('a', T, 'starting')
    rig.status('a', T + MIN, 'running')
    rig.status('a', T + 20 * MIN, 'waiting')
    rig.status('a', T + 25 * MIN, 'running')
    rig.status('a', T + 40 * MIN, 'idle')
    rig.status('b', T, 'running')
    rig.status('b', T + 10 * MIN, 'done')
    expect((await scan()).ran).toEqual([[0, (20 + 15 + 10) * MIN]])
  })

  it('cuts a turn to the week: one running when the week began, and one still running at its end', async () => {
    rig.session('early', { status: 'idle' })
    rig.status('early', WEEK.from - HOUR, 'running')
    rig.status('early', WEEK.from + 30 * MIN, 'idle')
    rig.session('late', { status: 'running' })
    rig.status('late', WEEK.to - 20 * MIN, 'running')
    rig.said('late', WEEK.to + HOUR)
    expect((await scan()).ran).toEqual([[0, 30 * MIN + 20 * MIN]])
  })

  it('counts a turn across the week’s end to the cut when its closing status came after it, with only a tool’s output in the week', async () => {
    // Sunday 11:40 PM to Monday 12:20 AM, read after it settled: the thread is idle now.
    rig.session('edge', { status: 'idle' })
    rig.status('edge', WEEK.to - 20 * MIN, 'running')
    rig.event('edge', WEEK.to - 5 * MIN, { type: 'tool-result', callId: 'c1', output: 'made-up output' })
    rig.status('edge', WEEK.to + 20 * MIN, 'idle')
    expect((await scan()).ran).toEqual([[0, 20 * MIN]])
  })

  it('counts a quiet week whole for a turn open across it: no row of its own in the span', async () => {
    rig.session('quiet', { status: 'idle' })
    rig.status('quiet', WEEK.from - HOUR, 'running')
    rig.status('quiet', WEEK.to + HOUR, 'idle')
    expect((await scan()).ran).toEqual([[0, WEEK.to - WEEK.from]])
  })

  it('ends an interrupted turn at its last row of any kind, a tool’s output too', async () => {
    rig.session('stop', { status: 'stopped' })
    rig.status('stop', T, 'running')
    rig.event('stop', T + 12 * MIN, { type: 'tool-result', callId: 'c1', output: 'made-up output' })
    expect((await scan()).ran).toEqual([[0, 12 * MIN]])
  })

  it('ends a turn its host never closed at the thread’s last row, not at the week’s end', async () => {
    rig.session('cut', { status: 'stopped' })
    rig.status('cut', T, 'running')
    rig.said('cut', T + 5 * MIN, { kind: 'app' })
    expect((await scan()).ran).toEqual([[0, 5 * MIN]])
  })
})
