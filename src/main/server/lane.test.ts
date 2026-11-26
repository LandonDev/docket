import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import { capabilityRefusal, type Capability } from '@shared/capabilities'
import { FocusSet } from './focus'
import { BULK_MAX_WAIT_MS, bulkKey, LaneGate, laneOf } from './lane'
import { setLagForTests } from './stalls'

const req = (method: string, params?: unknown, lane?: 'ui'): ClientRequest =>
  ({ id: '1', method, ...(params !== undefined ? { params } : {}), ...(lane ? { lane } : {}) }) as unknown as ClientRequest

/** One socket looking at `root` (with a subagent), another at `master` (with a batch child). */
function focusSet(): FocusSet {
  const parents: Record<string, string> = { sub: 'root', childSub: 'child' }
  const masters: Record<string, string> = { child: 'master' }
  const set = new FocusSet({ parentOf: (id) => parents[id] ?? null, masterOf: (id) => masters[id] ?? null })
  set.set(1, 'root')
  set.set(2, 'master')
  return set
}

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

afterEach(() => {
  setLagForTests(null)
  vi.useRealTimers()
})

describe('laneOf', () => {
  const focus = focusSet()

  it('a session.events that says shown is interactive; one without it is as before', () => {
    expect(laneOf(req('session.events', { sessionId: 'elsewhere', afterSeq: 0, tail: 300, shown: true }), focus)).toBe('interactive')
    expect(laneOf(req('session.events', { sessionId: 'elsewhere', afterSeq: 0, tail: 300 }), focus)).toBe('normal')
    expect(laneOf(req('session.events', { sessionId: 'elsewhere', afterSeq: 0, shown: false }), focus)).toBe('normal')
    // The word is session.events' alone: another method that carries it keeps its own lane.
    expect(laneOf(req('git.diffIndex', { cwd: '/repo', shown: true }), focus)).toBe('bulk')
    // It names no thread for the rest of the host: the focus set is unchanged.
    expect(focus.isInteractive('elsewhere')).toBe(false)
  })

  it('shown changes a lane, never a right: the wire keeps it, and every key is refused or let through as without it', () => {
    const parsed = ClientRequestSchema.parse({ id: '1', method: 'session.events', params: { sessionId: 's', tail: 300, shown: true } })
    expect(parsed.method === 'session.events' && parsed.params.shown).toBe(true)
    const keys: Capability[][] = [['read'], ['read', 'pending'] as Capability[], ['read', 'device'] as Capability[], ['read', 'operate', 'admin']]
    for (const caps of keys) {
      const plain = capabilityRefusal(caps, { method: 'session.events', params: { sessionId: 's', afterSeq: 0, tail: 300 } })
      expect(capabilityRefusal(caps, { method: 'session.events', params: { sessionId: 's', afterSeq: 0, tail: 300, shown: true } }), caps.join()).toBe(plain)
    }
  })

  it('a request naming a focused thread is interactive, whatever its method', () => {
    for (const method of ['session.events', 'session.send', 'session.subscribe', 'session.context', 'queue.list', 'session.notes.get', 'checkpoint.status'])
      expect(laneOf(req(method, { sessionId: 'root' }), focus), method).toBe('interactive')
    // Its subagents and a focused master's batch, the children's subagents too.
    expect(laneOf(req('session.events', { sessionId: 'sub' }), focus)).toBe('interactive')
    expect(laneOf(req('session.events', { sessionId: 'child' }), focus)).toBe('interactive')
    expect(laneOf(req('session.events', { sessionId: 'childSub' }), focus)).toBe('interactive')
    expect(laneOf(req('batch.get', { masterId: 'master' }), focus)).toBe('interactive')
  })

  it('a person\'s click is interactive; the polls and walks are bulk; the rest normal', () => {
    expect(laneOf(req('session.archive', { sessionId: 'elsewhere', archived: true }, 'ui'), focus)).toBe('interactive')
    expect(laneOf(req('session.batch', { action: 'stop', ids: ['a'] }, 'ui'), focus)).toBe('interactive')
    for (const method of ['project.changes', 'project.compare', 'git.diffStats', 'git.diffIndex', 'search.project', 'session.search', 'github.inbox', 'github.prStatus', 'resources.listAll', 'doctor.get', 'fs.watch', 'host.deploy', 'host.publish', 'harness.sync', 'memory.sync'])
      expect(laneOf(req(method, {}), focus), method).toBe('bulk')
    // Held answers (heldAnswer.ts): nothing to wait in the gate for.
    expect(laneOf(req('checkpoint.status', { sessionId: 'elsewhere' }), focus)).toBe('normal')
    expect(laneOf(req('commands.list', { provider: 'claude', cwd: '/x' }), focus)).toBe('normal')
    expect(laneOf(req('batch.get', { masterId: 'other-master' }), focus)).toBe('normal')
    for (const method of ['session.events', 'workspace.list', 'session.list', 'fs.read'])
      expect(laneOf(req(method, { sessionId: 'elsewhere' }), focus), method).toBe('normal')
  })
})

describe('bulkKey', () => {
  it('a read has a key by method and params; a write and a per-socket watch have none and never join', () => {
    const status = bulkKey(req('git.diffStats', { cwd: '/repo' }))
    expect(status).toBe(bulkKey(req('git.diffStats', { cwd: '/repo' })))
    expect(status).not.toBe(bulkKey(req('git.diffStats', { cwd: '/other' })))
    expect(bulkKey(req('resources.remove', { id: 'r' }))).toBeNull()
    expect(bulkKey(req('fs.watch', { projectId: 'p', subscribe: true }))).toBeNull()
  })
})

describe('LaneGate', () => {
  it('a duplicate joins the one waiting or running and gets its answer; after it lands the next runs again', async () => {
    const gate = new LaneGate({ lag: () => 0 })
    const answer = deferred<string>()
    let runs = 0
    const task = () => {
      runs++
      return answer.promise
    }
    const asks = Array.from({ length: 5 }, () => gate.run('bulk', 'k', task))
    expect(runs).toBe(1)
    expect(gate.joins).toBe(4)
    answer.resolve('clean')
    expect(await Promise.all(asks)).toEqual(['clean', 'clean', 'clean', 'clean', 'clean'])
    await flush()
    await gate.run('bulk', 'k', async () => {
      runs++
      return 'again'
    })
    expect(runs).toBe(2)
  })

  it('requests with no key run each in turn: subscribe, unsubscribe, subscribe all land', async () => {
    const gate = new LaneGate({ lag: () => 0, maxRunning: 1 })
    const ran: string[] = []
    const first = deferred<void>()
    const block = gate.run('bulk', 'k', () => first.promise)
    const asks = ['on', 'off', 'on'].map((state) =>
      gate.run('bulk', null, async () => {
        ran.push(state)
      })
    )
    expect(gate.stats()).toEqual({ running: 1, held: 3 })
    first.resolve()
    await block
    await Promise.all(asks)
    expect(ran).toEqual(['on', 'off', 'on'])
  })

  it('a failure reaches every request that joined it', async () => {
    const gate = new LaneGate({ lag: () => 0 })
    let rejectWith!: (e: Error) => void
    const task = () => new Promise<never>((_, rej) => (rejectWith = rej))
    const a = gate.run('bulk', 'k', task)
    const b = gate.run('bulk', 'k', task)
    rejectWith(new Error('not a repo'))
    await expect(a).rejects.toThrow('not a repo')
    await expect(b).rejects.toThrow('not a repo')
  })

  it('runs two at a time; the third starts when one lands', async () => {
    const gate = new LaneGate({ lag: () => 0 })
    const done = [deferred<void>(), deferred<void>(), deferred<void>()]
    const started: number[] = []
    const asks = done.map((d, i) =>
      gate.run('bulk', `k${i}`, () => {
        started.push(i)
        return d.promise
      })
    )
    expect(started).toEqual([0, 1])
    expect(gate.stats()).toEqual({ running: 2, held: 1 })
    done[1].resolve()
    await flush()
    expect(started).toEqual([0, 1, 2])
    done[0].resolve()
    done[2].resolve()
    await Promise.all(asks)
    expect(gate.stats()).toEqual({ running: 0, held: 0 })
  })

  it('waits while the loop lags (the stalls seam); interactive and normal never wait', async () => {
    vi.useFakeTimers()
    setLagForTests({ meanMs: 80, maxMs: 200, ewmaMs: 60 })
    const gate = new LaneGate()
    let bulkRan = false
    const bulk = gate.run('bulk', 'k', async () => {
      bulkRan = true
      return 'bulk'
    })
    expect(await gate.run('interactive', 'i', async () => 'now')).toBe('now')
    expect(await gate.run('normal', 'n', async () => 'now too')).toBe('now too')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(bulkRan).toBe(false)
    expect(gate.stats().held).toBe(1)
    setLagForTests({ meanMs: 10, maxMs: 30, ewmaMs: 40 })
    await vi.advanceTimersByTimeAsync(60)
    expect(bulkRan).toBe(true)
    expect(await bulk).toBe('bulk')
    gate.dispose()
  })

  it('a bulk request waiting 20 s runs anyway, lag or no lag', async () => {
    vi.useFakeTimers()
    setLagForTests({ meanMs: 500, maxMs: 900, ewmaMs: 400 })
    const gate = new LaneGate()
    let ran = false
    const ask = gate.run('bulk', 'k', async () => {
      ran = true
      return 'late'
    })
    await vi.advanceTimersByTimeAsync(BULK_MAX_WAIT_MS - 1)
    expect(ran).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(ran).toBe(true)
    expect(await ask).toBe('late')
    gate.dispose()
  })
})

it('overdue requests bypass lag but stop at twice the running cap', async () => {
  vi.useFakeTimers()
  const gate = new LaneGate({ lag: () => 500 })
  const done = Array.from({ length: 12 }, () => deferred<void>())
  const started: number[] = []
  const asks = done.map((d, i) => gate.run('bulk', null, () => { started.push(i); return d.promise }))
  await vi.advanceTimersByTimeAsync(BULK_MAX_WAIT_MS)
  expect(started).toEqual([0, 1, 2, 3])
  await vi.advanceTimersByTimeAsync(1000)
  expect(gate.stats()).toEqual({ running: 4, held: 8 })
  done[0].resolve()
  await flush()
  expect(started).toEqual([0, 1, 2, 3, 4])
  for (const d of done) d.resolve()
  await Promise.all(asks)
  gate.dispose()
})

describe('LaneGate.cancel (request.cancel)', () => {
  /** A gate the lag holds shut until `open()`: every bulk request waits. */
  function held(): { gate: LaneGate; open: () => void } {
    let lag = 1_000
    const gate = new LaneGate({ lag: () => lag, maxWaitMs: 60_000 })
    return {
      gate,
      open: () => {
        lag = 0
        vi.advanceTimersByTime(60)
      }
    }
  }

  it('a cancelled bulk read leaves the queue, never runs, and its asker hears no answer', async () => {
    vi.useFakeTimers()
    const { gate, open } = held()
    const task = vi.fn(async () => 'answer')
    const asked = gate.run('bulk', 'search.project\0q', task, '1\0a1')
    const outcome = asked.then(
      () => 'answered',
      (e: Error) => e.name
    )
    expect(gate.stats().held).toBe(1)
    expect(gate.cancel('1\0a1')).toBe(true)
    expect(gate.stats().held).toBe(0)
    expect(gate.cancelled).toBe(1)
    open()
    await flush()
    expect(task).not.toHaveBeenCalled()
    expect(await outcome).toBe('LaneCancelled')
    gate.dispose()
  })

  it("a cancel naming another socket's request id changes nothing and is refused", async () => {
    vi.useFakeTimers()
    const { gate, open } = held()
    const task = vi.fn(async () => 'answer')
    const asked = gate.run('bulk', 'search.project\0q', task, '1\0a1')
    expect(gate.cancel('2\0a1')).toBe(false)
    expect(gate.stats().held).toBe(1)
    open()
    expect(await asked).toBe('answer')
    expect(task).toHaveBeenCalledTimes(1)
    // Answered, it is no one's to cancel.
    expect(gate.cancel('1\0a1')).toBe(false)
    gate.dispose()
  })

  it('a cancel of a write is refused, and the write runs', async () => {
    vi.useFakeTimers()
    const { gate, open } = held()
    const write = vi.fn(async () => 'deployed')
    // A write never joins (no key), so it is never its socket's to cancel.
    const asked = gate.run('bulk', bulkKey(req('host.deploy', {})), write, '1\0w1')
    expect(gate.cancel('1\0w1')).toBe(false)
    open()
    expect(await asked).toBe('deployed')
    gate.dispose()
  })

  it('refuses a request outside the bulk lane', async () => {
    const gate = new LaneGate({ lag: () => 0 })
    const asked = gate.run('normal', 'session.list\0null', async () => 'list', '1\0n1')
    expect(gate.cancel('1\0n1')).toBe(false)
    expect(await asked).toBe('list')
  })

  it("one socket's cancel leaves a joined asker's read running; the last cancel aborts the running read", async () => {
    vi.useFakeTimers()
    const gate = new LaneGate({ lag: () => 0 })
    const answer = deferred<string>()
    let signal!: AbortSignal
    const task = vi.fn((s: AbortSignal) => {
      signal = s
      return answer.promise
    })
    const first = gate.run('bulk', 'search.project\0q', task, '1\0a1')
    const joined = gate.run('bulk', 'search.project\0q', task, '2\0b1')
    expect(task).toHaveBeenCalledTimes(1)
    first.catch(() => undefined)
    expect(gate.cancel('1\0a1')).toBe(true)
    expect(signal.aborted).toBe(false)
    // A later duplicate still joins the run another socket wants.
    const third = gate.run('bulk', 'search.project\0q', task, '3\0c1')
    expect(gate.cancel('3\0c1')).toBe(true)
    third.catch(() => undefined)
    expect(signal.aborted).toBe(false)
    answer.resolve('rows')
    expect(await joined).toBe('rows')
    // Now running alone: its one asker's cancel tells it to stop.
    const stop = deferred<string>()
    let stopping!: AbortSignal
    const lone = gate.run('bulk', 'search.project\0other', (s) => {
      stopping = s
      return stop.promise
    }, '1\0a2')
    lone.catch(() => undefined)
    expect(gate.cancel('1\0a2')).toBe(true)
    expect(stopping.aborted).toBe(true)
    // A new ask of the same read starts its own run rather than joining the stopping one.
    const fresh = vi.fn(async () => 'fresh')
    expect(await gate.run('bulk', 'search.project\0other', fresh, '1\0a3')).toBe('fresh')
    stop.resolve('late')
    gate.dispose()
  })
})
