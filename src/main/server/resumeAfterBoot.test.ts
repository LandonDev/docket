import { describe, expect, it } from 'vitest'
import { BootResumer, type BootResumerDeps } from './resumeAfterBoot'

/** The boot resumer's order (resumeAfterBoot.ts): what a window shows comes back first. Fakes for the store and the registry. */

function setup(threads: { id: string; parentId?: string; recordedAt: number }[], o: { width?: number } = {}) {
  const started: string[] = []
  const gates = new Map<string, () => void>()
  const ledger = new Set(threads.map((t) => t.id))
  const deps: BootResumerDeps = {
    store: {
      listResumeAfterBoot: () => threads.filter((t) => ledger.has(t.id)).map((t) => ({ sessionId: t.id, recordedAt: t.recordedAt, lastUserSeq: null, shutdownAt: 5 })),
      clearResumeAfterBoot: (ids: string[]) => void ids.forEach((id) => ledger.delete(id)),
      getSession: (id: string) => {
        const t = threads.find((x) => x.id === id)
        return t ? ({ id, parentId: t.parentId ?? null, archived: false, status: 'running' } as never) : null
      }
    } as BootResumerDeps['store'],
    registry: {
      resumePending: new Set<string>(),
      resumeStopped: (id: string) => {
        started.push(id)
        return new Promise<boolean>((resolve) => gates.set(id, () => resolve(true)))
      }
    } as unknown as BootResumerDeps['registry'],
    width: o.width ?? 1,
    gapMs: 0,
    now: () => 9,
    log: () => {}
  }
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const finish = async (id: string): Promise<void> => {
    gates.get(id)!()
    await settle()
  }
  return { resumer: new BootResumer(deps), started, finish, settle }
}

const forty = Array.from({ length: 40 }, (_, i) => ({ id: `t${i + 1}`, recordedAt: i + 1 }))

describe('the boot resume, with a window that shows a thread', () => {
  it('moves the shown thread ahead of every one not yet started, and starts each thread once', async () => {
    const t = setup(forty)
    const run = t.resumer.run()
    await t.settle()
    expect(t.started).toEqual(['t1'])
    // 39 wait; he looks at the thirtieth.
    expect(t.resumer.prefer(['t30'])).toBeGreaterThan(0)
    await t.finish('t1')
    expect(t.started).toEqual(['t1', 't30'])
    // The rest keep their order, and t30 is not started again when its old place comes.
    for (let i = 1; i < 40; i++) await t.finish(t.started[i]!)
    const result = await run
    expect(t.started).toEqual(['t1', 't30', ...forty.map((x) => x.id).filter((id) => id !== 't1' && id !== 't30')])
    expect(result.resumed).toHaveLength(40)
    expect(new Set(t.started).size).toBe(40)
  })

  it('brings the threads above the shown one with it, the shown one first', async () => {
    const t = setup([
      { id: 'a', recordedAt: 1 }, { id: 'b', recordedAt: 2 }, { id: 'root', recordedAt: 3 },
      { id: 'kid', parentId: 'root', recordedAt: 4 }, { id: 'c', recordedAt: 5 }
    ])
    // By depth and age the order is kid, a, b, root, c. He shows the kid's sibling-less root's child: kid, then root.
    t.resumer.prefer(['kid'])
    const run = t.resumer.run()
    await t.settle()
    for (let i = 0; i < 5; i++) await t.finish(t.started[i]!)
    await run
    expect(t.started).toEqual(['kid', 'root', 'a', 'b', 'c'])
  })

  it('a focus that lands before the queue is made is kept for it; one after the run, or for a started thread, moves nothing', async () => {
    const t = setup(forty.slice(0, 3))
    t.resumer.prefer(['t3'])
    const run = t.resumer.run()
    await t.settle()
    expect(t.started).toEqual(['t3'])
    // Already started: nothing to move.
    expect(t.resumer.prefer(['t3'])).toBe(0)
    // A thread this boot never recorded.
    expect(t.resumer.prefer(['elsewhere'])).toBe(0)
    await t.finish('t3')
    await t.finish('t1')
    await t.finish('t2')
    await run
    expect(t.resumer.prefer(['t2'])).toBe(0)
    expect(t.started).toEqual(['t3', 't1', 't2'])
  })
})
