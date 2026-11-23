import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ROUTINES_CAPS, type RoutineRow } from '@shared/contract-work-routines'
import type { OutboxGrant, OutboxItem } from '@shared/contract-work-outbox'
import type { SessionMeta } from '@shared/events'
import type { WorkToolResult } from '@shared/work'
import { outbox as outboxModule } from '../outbox/index'
import { cast, makeRig, type Rig } from '../outbox/rig'
import { WORK_MODULES, type WorkModule } from '../modules'
import { routinesHost, type RoutinesHost } from './host'
import { routines, routinesEngine, routinesSeams } from './index'

/**
 * Routines on the hold's own rig (work/outbox/rig.ts): a real add-on host
 * and gate, the outbox module beside this one, a fake registry. What it
 * proves is where routines meet the hold: a watch reads only with a tool
 * the owner set to Runs, no thread makes or starts a routine on its own,
 * and a routine's held act goes only on one of that routine's own grants.
 */

let rig: Rig
const clock = { now: Date.parse('2026-11-16T09:00:00-05:00') }
const text = (r: WorkToolResult | { content: unknown[] }): string => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n')
const call = (sessionId: string, name: string, args: Record<string, unknown>) => rig.work.tools.call(rig.sessions.get(sessionId)!, name, args, new AbortController().signal)
const list = async () => (await rig.rpc<{ routines: RoutineRow[] }>('work.routines.list', { workspaceId: 'ws-purdue' })).routines

beforeEach(async () => {
  // The host's own add-on handles (host.ts, made by buildWorkCtx), with the registry's parts played here.
  routinesSeams.current = {
    interval: false,
    now: () => clock.now,
    host: {
      workspace: (id) => rig.workspaces.get(id) ?? null,
      addon: (ws, name) => routinesHost()!.addon(ws, name),
      mayRead: (addon, tool) => routinesHost()!.mayRead(addon, tool),
      read: (addon, tool, args) => routinesHost()!.read(addon, tool, args),
      session: (id) => rig.sessions.get(id) ?? null,
      onMeta: () => () => {},
      markRead: () => {},
      markUnread: () => {},
      heldIn: () => 0,
      busyBelow: () => false,
      threadOfRun: () => null,
      readOnly: (addon, tool) => routinesHost()!.readOnly(addon, tool),
      words: () => []
    } satisfies RoutinesHost
  }
  rig = await makeRig({ modules: [outboxModule, routines] })
  cast(rig)
})
afterEach(async () => {
  await rig.close()
  routinesSeams.current = null
})

describe('watch_create', () => {
  it('takes only a tool he set to Runs, then reads it as the host with no thread and wakes the thread that set it', async () => {
    const outlook = await rig.addon('outlook', 'ws-purdue')
    const refused = await call('t-work', 'watch_create', { name: 'Reply from events booking', addon: 'outlook', tool: 'read', arguments: { key: 'events' } })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/is not set to Runs/)
    expect(await list()).toEqual([])

    await rig.rpc('work.outbox.setRules', { addonId: outlook.id, rules: { read: 'runs' } })
    const made = await call('t-work', 'watch_create', { name: 'Reply from events booking', addon: 'outlook', tool: 'read', arguments: { key: 'events' }, everyMinutes: 10 })
    expect(text(made)).toBe('Watching “Reply from events booking”: every 10 minutes, until it first changes. This thread will be woken with the new answer; nothing else runs.')
    const [watch] = await list()
    expect(watch).toMatchObject({ kind: 'watch', createdBy: 'model', resumeSessionId: 't-work', ends: { kind: 'once' }, trigger: { on: 'read', addon: outlook.id, tool: 'read', args: { key: 'events' } } })

    // the first read is the host's own call through the gate: it reaches the server with the fixed arguments
    await routinesEngine(rig.work.ctx).tick()
    await routinesEngine(rig.work.ctx).drain()
    expect(rig.downstream).toEqual([{ addonId: outlook.id, tool: 'read', arguments: { key: 'events' } }])
    expect(rig.woke).toEqual([])

    // he sets the tool back to Held: the watch reads nothing more, and the gate itself would refuse the host's call
    await rig.rpc('work.outbox.setRules', { addonId: outlook.id, rules: { read: 'held' } })
    clock.now += 11 * 60_000
    await routinesEngine(rig.work.ctx).tick()
    await routinesEngine(rig.work.ctx).drain()
    expect(rig.downstream).toHaveLength(1)
    expect((await list())[0]!.lastWords).toBe('Waiting: its tool is not set to Runs')
    const direct = await routinesHost()!.read(outlook.id, 'read', { key: 'events' })
    expect(direct.isError).toBe(true)
    expect(text(direct)).toMatch(/a watch may call only tools that run without his press/)
    expect(rig.downstream).toHaveLength(1)
  })
})

describe('a watch on a global add-on', () => {
  it('reads nothing once the add-on is no longer For Work: the gate refuses the host\'s call, and the watch ends', async () => {
    const outlook = await rig.addon('outlook', null, { forWork: true })
    await rig.rpc('work.outbox.setRules', { addonId: outlook.id, rules: { read: 'runs' } })
    expect((await call('t-work', 'watch_create', { name: 'Reply from events booking', addon: 'outlook', tool: 'read', arguments: { key: 'events' }, everyMinutes: 10 })).isError).toBeFalsy()
    await routinesEngine(rig.work.ctx).tick()
    await routinesEngine(rig.work.ctx).drain()
    expect(rig.downstream).toHaveLength(1)

    rig.addons.setWorkMarks(outlook.id, { forWork: false })
    // the host's own Work call is judged by the Work gate, and outside Work no rule of his stands
    const direct = await routinesHost()!.read(outlook.id, 'read', { key: 'events' })
    expect(direct.isError).toBe(true)
    expect(routinesHost()!.mayRead(outlook.id, 'read')).toBe(false)
    clock.now += 11 * 60_000
    await routinesEngine(rig.work.ctx).tick()
    await routinesEngine(rig.work.ctx).drain()
    expect(rig.downstream).toHaveLength(1)
    expect((await list())[0]).toMatchObject({ ended: true, lastWords: 'Its add-on is no longer in this workspace' })
  })
})

describe('a routine', () => {
  it('is never made by a thread: a proposal runs nothing until his click, and a thread cannot save, start or change one', async () => {
    const proposed = await call('t-work', 'routine_propose', { name: 'Morning sweep', prompt: 'Read Purdue mail and tell me what needs me.', days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '07:00' })
    expect(text(proposed)).toBe('Proposed “Morning sweep” (Weekdays at 7:00 AM). It waits in Routines for the owner to create; nothing runs until he does.')
    const [row] = await list()
    expect(row).toMatchObject({ proposed: true, enabled: false, nextAt: null, createdBy: 'model', madeIn: 't-work' })
    // a week of ticks fires nothing
    const e = routinesEngine(rig.work.ctx)
    for (let i = 0; i < 7; i++) {
      clock.now += 24 * 3600_000
      await e.tick()
    }
    expect(e.store.runs(row!.id)).toEqual([])
    await expect(rig.rpc('work.routines.runNow', { id: row!.id })).rejects.toThrow('a proposal runs nothing until the owner creates it')

    // a thread's own call is refused whatever it asks, and a key without admin cannot save
    const asModel = { kind: 'model' as const, caps: ['read', 'operate', 'approve', 'admin'], sessionId: 't-work' }
    for (const [method, params] of [
      ['work.routines.save', { id: row!.id, workspaceId: 'ws-purdue', name: 'x', prompt: 'x', trigger: row!.trigger, ends: { kind: 'never' } }],
      ['work.routines.runNow', { id: row!.id }],
      ['work.routines.pause', { id: row!.id, paused: true }],
      ['work.routines.remove', { id: row!.id }]
    ] as const) {
      await expect(routines.handle!({ id: '1', method, params } as never, rig.work.ctx, asModel)).rejects.toThrow('only the owner makes or changes a routine')
    }
    // and the socket's gate lets only a key with admin save or remove one
    expect([ROUTINES_CAPS['work.routines.save'], ROUTINES_CAPS['work.routines.remove']]).toEqual(['admin', 'admin'])

    // his Create: the proposal becomes a routine with a next due time
    const made = await rig.rpc<RoutineRow>('work.routines.save', { id: row!.id, workspaceId: 'ws-purdue', name: row!.name, prompt: row!.prompt, trigger: row!.trigger, ends: { kind: 'never' } })
    expect(made).toMatchObject({ proposed: false, enabled: true, words: 'Weekdays at 7:00 AM' })
    expect(made.nextAt).toBeGreaterThan(clock.now)
  })

  it("has its held act go only on one of its own grants: a grant from another thread's act does not fit it", async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    const e = routinesEngine(rig.work.ctx)
    const r = await rig.rpc<RoutineRow>('work.routines.save', { workspaceId: 'ws-purdue', name: 'Standup', prompt: 'Post the standup.', trigger: { on: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=30', tz: 'America/New_York' }, ends: { kind: 'never' } })
    const other = await rig.rpc<RoutineRow>('work.routines.save', { workspaceId: 'ws-purdue', name: 'Other', prompt: 'x', trigger: { on: 'lifeos', kinds: ['task.created'] }, ends: { kind: 'never' } })
    // two runs of the routine and one of another, as the engine writes them; their threads as the registry would hold them
    const run1 = e.store.newRun(r.id, clock.now, 'Weekdays at 9:30 AM', 0, 'running')
    const run2 = e.store.newRun(r.id, clock.now + 1, 'Weekdays at 9:30 AM', 0, 'running')
    const runB = e.store.newRun(other.id, clock.now + 2, 'A task is filed', 0, 'running')
    rig.thread('t-r1', { scope: 'work', workspaceId: 'ws-purdue', routineRunId: run1.id } as Partial<SessionMeta>)
    rig.thread('t-r2', { scope: 'work', workspaceId: 'ws-purdue', routineRunId: run2.id } as Partial<SessionMeta>)
    rig.thread('t-b', { scope: 'work', workspaceId: 'ws-purdue', routineRunId: runB.id } as Partial<SessionMeta>)
    const grant = (item: OutboxItem, routine?: boolean) => rig.rpc<OutboxGrant>('work.outbox.grant', { from: item.ref, matcher: { addonId: slack.id, tool: 'echo' }, ...(routine ? { routine: true } : {}) })

    // an ordinary grant, made from a hand-run thread's act, never lets the routine post
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'by hand' })
    await grant((await rig.waiting())[0]!)
    expect(text(await rig.claudeCall('t-r1', slack.id, 'echo', { text: 'standup 1' }))).toMatch(/^Held as item 2:/)
    expect(rig.downstream.filter((d) => d.tool === 'echo')).toEqual([])
    // "Send, and let this routine send ones like it": from its own held act
    const g = await grant((await rig.waiting()).find((i) => i.routineRunId === run1.id)!, true)
    expect(g.routineId).toBe(r.id)
    expect(text(await rig.claudeCall('t-r2', slack.id, 'echo', { text: 'standup 2' }))).toBe('standup 2')
    // and only this routine's runs
    expect(text(await rig.claudeCall('t-b', slack.id, 'echo', { text: 'other' }))).toMatch(/^Held as item/)
  })
})

describe('a routine that runs a host job', () => {
  const review: WorkModule = { id: 'docs', ensure: () => {}, jobs: [{ id: 'review.make', name: "Makes the week's review", run: async () => ({ words: 'Review made' }) }] }
  const FRIDAYS = { on: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0', tz: 'America/New_York' } as const
  beforeEach(() => void WORK_MODULES.push(review))
  afterEach(() => void WORK_MODULES.splice(WORK_MODULES.indexOf(review), 1))

  it('is saved only by the owner with a job some pillar has, needs no words, and lists the job by name', async () => {
    await expect(rig.rpc('work.routines.save', { workspaceId: 'ws-purdue', name: 'Week review', prompt: '', job: 'review.gone', trigger: FRIDAYS, ends: { kind: 'never' } })).rejects.toThrow('No such job: review.gone')
    const asModel = { kind: 'model' as const, caps: ['read', 'operate', 'approve', 'admin'], sessionId: 't-work' }
    const params = { workspaceId: 'ws-purdue', name: 'Week review', prompt: '', job: 'review.make', trigger: FRIDAYS, ends: { kind: 'never' } }
    await expect(routines.handle!({ id: '1', method: 'work.routines.save', params } as never, rig.work.ctx, asModel)).rejects.toThrow('only the owner makes or changes a routine')
    const made = await rig.rpc<RoutineRow>('work.routines.save', params)
    expect(made).toMatchObject({ job: 'review.make', jobName: "Makes the week's review", prompt: '', words: 'Fridays at 4:00 PM' })
    // an edit that leaves the job out keeps it
    const renamed = await rig.rpc<RoutineRow>('work.routines.save', { id: made.id, workspaceId: 'ws-purdue', name: 'The week', prompt: '', trigger: FRIDAYS, ends: { kind: 'never' } })
    expect(renamed).toMatchObject({ name: 'The week', job: 'review.make' })
    expect((await list()).find((r) => r.id === made.id)).toMatchObject({ job: 'review.make', jobName: "Makes the week's review" })
    // a thread's proposal can never carry one
    await call('t-work', 'routine_propose', { name: 'Sneaky', prompt: 'x', everyMinutes: 30, job: 'review.make' })
    expect((await list()).find((r) => r.name === 'Sneaky')!.job).toBeUndefined()
  })
})
