import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { WorkResult } from '@shared/contract-work-outbox'
import type { SessionMeta } from '@shared/events'
import { workText } from '@shared/work'
import type { ActKindDef, WorkModule } from '../modules'
import { outbox as outboxModule, NOT_A_PERSON } from './index'
import { approveKey, cast, makeRig, readKey, type Rig } from './rig'
import { ALREADY_UNDONE, CANNOT_UNDO } from './results'

/**
 * Results (docs/agents/work-outbox.md, "Results"): what a Work thread
 * changed that lasts, listed for its panel and for the return from Away,
 * each with its way back, run once by a person's press.
 */

let rig: Rig
let pillar: WorkModule
const removed: unknown[] = []
const failNext = { on: false }

/** A pillar that writes a task and can take it back, and posts with a way back. */
async function boot(): Promise<void> {
  pillar = {
    id: 'tasks',
    ensure() {},
    tools: () => [
      {
        name: 'tasks_remove',
        description: 'Remove a task',
        input: z.object({ id: z.string() }),
        readOnly: false,
        run: async (args) => {
          if (failNext.on) return { ...workText('LifeOS did not answer'), isError: true }
          removed.push(args)
          return workText('removed')
        }
      }
    ],
    acts: [
      {
        kind: 'teams.post',
        store: 'host',
        payload: z.object({ to: z.string() }),
        words: (p: { to: string }) => ({ summary: `Post in ${p.to}`, verb: 'Post' }),
        execute: async (p: { to: string }) => ({ summary: `Posted in ${p.to}`, ref: { message: 'm1' } }),
        wayBack: (r) => ({ pillar: 'tasks', verb: 'remove', args: { id: (r.ref as { message: string }).message }, label: 'Delete the post' })
      } as unknown as ActKindDef
    ]
  }
  rig = await makeRig({ modules: [outboxModule, pillar] })
  const { WORK_MODULES } = await import('../modules')
  WORK_MODULES.push(pillar)
  cast(rig)
}

afterEach(async () => {
  const { WORK_MODULES } = await import('../modules')
  WORK_MODULES.splice(WORK_MODULES.indexOf(pillar), 1)
  removed.length = 0
  failNext.on = false
  await rig.close()
})

describe('ctx.results', () => {
  it("lists a write under its thread's root, newest first, and pushes it", async () => {
    await boot()
    rig.thread('t-sub', { scope: 'work', workspaceId: 'ws-purdue', parentId: 't-work' } as Partial<SessionMeta>)
    rig.work.ctx.results.add({ sessionId: 't-work', kind: 'task', summary: 'Added a task', account: 'Spring LAN', undo: { pillar: 'tasks', verb: 'remove', args: { id: 'k1' } } })
    rig.work.ctx.results.add({ sessionId: 't-sub', kind: 'cells', summary: 'Changed 6 cells' })
    const { results } = await rig.rpc<{ results: WorkResult[] }>('work.outbox.results', { sessionId: 't-work' }, readKey)
    expect(results.map((r) => [r.summary, r.sessionId, r.workspaceId])).toEqual([
      ['Changed 6 cells', 't-sub', 'ws-purdue'],
      ['Added a task', 't-work', 'ws-purdue']
    ])
    expect(results[1]).toMatchObject({ account: 'Spring LAN', undo: { pillar: 'tasks', verb: 'remove' }, undoneAt: null })
    expect(results[0]!.rootId).toBe('t-work')
    // a subagent asking gets its own
    const sub = await rig.rpc<{ results: WorkResult[] }>('work.outbox.results', { sessionId: 't-sub' })
    expect(sub.results.map((r) => r.summary)).toEqual(['Changed 6 cells'])
    expect(rig.pushes.filter((p) => p.push === 'work.outbox.result')).toHaveLength(2)
  })

  it('answers every result since a time, for the return from Away', async () => {
    await boot()
    rig.work.ctx.results.add({ sessionId: 't-work', kind: 'task', summary: 'Before' })
    const since = Date.now() + 1
    await new Promise((r) => setTimeout(r, 5))
    rig.work.ctx.results.add({ sessionId: 't-work', kind: 'task', summary: 'After' })
    const { results } = await rig.rpc<{ results: WorkResult[] }>('work.outbox.results', { since })
    expect(results.map((r) => r.summary)).toEqual(['After'])
  })
})

describe('work.outbox.undo', () => {
  it("runs the pillar's way back once, as the thread that wrote; a second press runs nothing", async () => {
    await boot()
    rig.work.ctx.results.add({ sessionId: 't-work', kind: 'task', summary: 'Added a task', undo: { pillar: 'tasks', verb: 'remove', args: { id: 'k1' } } })
    const [r] = (await rig.rpc<{ results: WorkResult[] }>('work.outbox.results', { sessionId: 't-work' })).results
    const done = await rig.rpc<WorkResult>('work.outbox.undo', { id: r!.id }, approveKey)
    expect(done.undoneAt).toBeTypeOf('number')
    await expect(rig.rpc('work.outbox.undo', { id: r!.id })).rejects.toThrow(ALREADY_UNDONE)
    expect(removed).toEqual([{ id: 'k1' }])
  })

  it('gives the claim back when the way back fails, so he can try again', async () => {
    await boot()
    rig.work.ctx.results.add({ sessionId: 't-work', kind: 'task', summary: 'Added a task', undo: { pillar: 'tasks', verb: 'remove', args: { id: 'k1' } } })
    const [r] = (await rig.rpc<{ results: WorkResult[] }>('work.outbox.results', { sessionId: 't-work' })).results
    failNext.on = true
    await expect(rig.rpc('work.outbox.undo', { id: r!.id })).rejects.toThrow(/couldn't undo: LifeOS did not answer/)
    failNext.on = false
    await rig.rpc('work.outbox.undo', { id: r!.id })
    expect(removed).toEqual([{ id: 'k1' }])
  })

  it('refuses one with no way back, a read-only key, and a thread', async () => {
    await boot()
    rig.work.ctx.results.add({ sessionId: 't-work', kind: 'mail.send', summary: 'Sent to Dana' })
    rig.work.ctx.results.add({ sessionId: 't-work', kind: 'task', summary: 'Added', undo: { pillar: 'tasks', verb: 'remove', args: { id: 'k2' } } })
    const [undoable, mail] = (await rig.rpc<{ results: WorkResult[] }>('work.outbox.results', { sessionId: 't-work' })).results
    await expect(rig.rpc('work.outbox.undo', { id: mail!.id })).rejects.toThrow(CANNOT_UNDO)
    await expect(rig.rpc('work.outbox.undo', { id: undoable!.id }, readKey)).rejects.toThrow()
    const req = { id: '1', method: 'work.outbox.undo', params: { id: undoable!.id } } as never
    await expect(outboxModule.handle!(req, rig.work.ctx, { kind: 'model', caps: ['read', 'approve', 'admin'], sessionId: 't-work' })).rejects.toThrow(NOT_A_PERSON)
    expect(removed).toEqual([])
  })
})

describe('a send that left', () => {
  it("makes a Result with its kind's way back", async () => {
    await boot()
    const item = rig.work.ctx.held.create({ kind: 'teams.post', sessionId: 't-work', payload: { to: 'Esports staff' } })
    await rig.rpc('work.outbox.send', { ref: item.ref })
    const [r] = (await rig.rpc<{ results: WorkResult[] }>('work.outbox.results', { sessionId: 't-work' })).results
    expect(r).toMatchObject({ kind: 'teams.post', summary: 'Posted in Esports staff', undo: { pillar: 'tasks', verb: 'remove', args: { id: 'm1' }, label: 'Delete the post' } })
    expect(r!.ref).toMatchObject({ held: item.ref, open: { message: 'm1' } })
  })

  it('a discarded act makes none', async () => {
    await boot()
    const item = rig.work.ctx.held.create({ kind: 'teams.post', sessionId: 't-work', payload: { to: 'Esports staff' } })
    await rig.rpc('work.outbox.discard', { ref: item.ref })
    expect((await rig.rpc<{ results: WorkResult[] }>('work.outbox.results', { sessionId: 't-work' })).results).toEqual([])
  })
})
