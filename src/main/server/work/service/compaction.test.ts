import { describe, expect, it } from 'vitest'
import { COMPACTION, compactionSchedule } from './compaction'

/** A clock, the connections each document holds, and the compactions asked for. */
function rig() {
  const state = { now: 0, open: new Map<string, number>(), ran: [] as { name: string; file?: string; minBytes: number }[], fail: false, logs: [] as string[] }
  const schedule = compactionSchedule({
    now: () => state.now,
    connections: (name) => state.open.get(name) ?? 0,
    compact: async (name, file, minBytes) => {
      if (state.fail) throw new Error('the store is away')
      state.ran.push({ name, ...(file ? { file: file.path } : {}), minBytes })
    },
    log: (line) => state.logs.push(line)
  })
  return { state, schedule }
}

describe('when a live document is compacted', () => {
  it('a little after its last connection leaves, once the last store has had time to land, and not before', async () => {
    const { state, schedule } = rig()
    state.open.set('kdoc', 2)
    schedule.seen('kdoc')
    schedule.seen('kdoc')
    state.open.set('kdoc', 1)
    schedule.left('kdoc')
    state.now += COMPACTION.settleMs + 1
    await schedule.tick()
    // One editor is still in: nothing runs.
    expect(state.ran).toEqual([])
    state.open.set('kdoc', 0)
    schedule.left('kdoc')
    state.now += COMPACTION.settleMs - 1
    await schedule.tick()
    expect(state.ran).toEqual([])
    state.now += 1
    await schedule.tick()
    expect(state.ran).toEqual([{ name: 'kdoc', minBytes: COMPACTION.minBytes }])
    // Tried once: it is let go until someone opens it again.
    state.now += 60 * 60_000
    await schedule.tick()
    expect(state.ran).toHaveLength(1)
    expect(schedule.size()).toBe(0)
  })

  it('a document kept as a file is compacted as that file', async () => {
    const { state, schedule } = rig()
    schedule.seen('file:abc', { path: '/work/Plan.tcdoc' })
    schedule.left('file:abc')
    state.now += COMPACTION.settleMs
    await schedule.tick()
    expect(state.ran).toEqual([{ name: 'file:abc', file: '/work/Plan.tcdoc', minBytes: COMPACTION.minBytes }])
  })

  it('someone who comes back before the try puts it off until they leave again', async () => {
    const { state, schedule } = rig()
    schedule.seen('kdoc')
    schedule.left('kdoc')
    state.now += 5_000
    state.open.set('kdoc', 1)
    schedule.seen('kdoc')
    state.now += COMPACTION.settleMs
    await schedule.tick()
    expect(state.ran).toEqual([])
    state.open.set('kdoc', 0)
    schedule.left('kdoc')
    state.now += COMPACTION.settleMs
    await schedule.tick()
    expect(state.ran).toHaveLength(1)
  })

  it("a document whose last editor passed no socket (an agent's write holds it open as the socket leaves) is tried once it has stood idle ten minutes", async () => {
    const { state, schedule } = rig()
    state.open.set('kdoc', 1)
    schedule.seen('kdoc')
    // The socket leaves while an agent's own connection still holds the document: nothing is due.
    schedule.left('kdoc')
    state.now += COMPACTION.settleMs
    await schedule.tick()
    expect(state.ran).toEqual([])
    state.open.set('kdoc', 0)
    state.now += COMPACTION.idleMs - 1
    await schedule.tick()
    expect(state.ran).toEqual([])
    state.now += 1
    await schedule.tick()
    expect(state.ran).toHaveLength(1)
  })

  it('a try that fails is logged and stops nothing else', async () => {
    const { state, schedule } = rig()
    schedule.seen('a')
    schedule.left('a')
    schedule.seen('b')
    schedule.left('b')
    state.fail = true
    state.now += COMPACTION.settleMs
    await schedule.tick()
    expect(state.logs).toEqual(['a: not compacted: the store is away', 'b: not compacted: the store is away'])
  })
})
