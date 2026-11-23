import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { RoutineRun } from '@shared/contract-work-routines'
import type { SessionMeta } from '@shared/events'
import type { Tell } from '@shared/work/tell'
import type { ThreadNotice } from '../../remote/notifier'
import type { WorkCtx, WorkModule } from '../modules'
import { makeGate, RUN_NOW_CAUSE, runPressed, type GateDeps } from './gate'
import { ROUTINE_ASKS_WAIT } from './rule'

/** The gate for threads that started on their own: what waits for the digest, and what still reaches him at once. */

let told: Tell[]
let logs: string[]
let on: boolean
let quiet: Set<string>
let pressed: Map<string, boolean | null | Error>

const deps = (): GateDeps => ({
  enabled: () => on,
  isQuiet: (id) => quiet.has(id),
  workspaceOf: () => 'ws-cosmic',
  pressed: async (runId) => {
    const answer = pressed.get(runId) ?? null
    if (answer instanceof Error) throw answer
    return answer
  },
  tell: (t) => void told.push(t),
  log: (l) => void logs.push(l)
})
const thread = (over: Partial<SessionMeta> = {}): SessionMeta => ({ id: 't1', parentId: null, scope: 'work', title: 'Morning summary', routineRunId: 'run-1', ...over }) as SessionMeta
const notice = (event: ThreadNotice['event'], body: string, over: Partial<ThreadNotice> = {}): ThreadNotice => ({ event, kind: event === 'needs_you' ? 'approval' : event, threadId: 't1', title: 'Morning summary', body, ts: 1, seq: 4, ...over })

beforeEach(() => {
  told = []
  logs = []
  on = true
  quiet = new Set()
  pressed = new Map([['run-1', false]])
})

describe("a routine's run that started on its own", () => {
  it('its done, failed and stuck notices are kept back, and each becomes a tell on the thread', async () => {
    const gate = makeGate(deps())
    expect(await gate(notice('finished', 'Done in 12m'), thread())).toBe(true)
    expect(await gate(notice('failed', 'Failed: the sign-in to the tracker lapsed'), thread())).toBe(true)
    expect(await gate(notice('stuck', 'No output for 12m'), thread())).toBe(true)
    expect(told).toEqual([
      { kind: 'routines.done', workspaceId: 'ws-cosmic', title: 'Morning summary', detail: 'Done in 12m', key: 'thread:t1', open: { thread: 't1' } },
      { kind: 'routines.failed', workspaceId: 'ws-cosmic', title: 'Morning summary', detail: 'Failed: the sign-in to the tracker lapsed', key: 'thread:t1', open: { thread: 't1' } },
      { kind: 'routines.stuck', workspaceId: 'ws-cosmic', title: 'Morning summary', detail: 'No output for 12m', key: 'thread:t1', open: { thread: 't1' } }
    ])
  })
  it('its question or approval still reaches him at once, with Allow and Deny', () => {
    expect(ROUTINE_ASKS_WAIT).toBe(false)
    const gate = makeGate(deps())
    expect(gate(notice('needs_you', 'Run bun test?', { requestId: 'r1' }), thread())).toBe(false)
    expect(told).toEqual([])
  })
  it("a held act's notice is the Outbox's own and passes", () => {
    const gate = makeGate(deps())
    expect(gate(notice('needs_you', 'Held: Send to Dana Reyes', { kind: 'waiting', held: { at: 'host', id: 'h1' } }), thread())).toBe(false)
  })
})

describe('a run he started himself', () => {
  it('Run now is his own press: every notice goes as today', async () => {
    pressed.set('run-1', true)
    const gate = makeGate(deps())
    expect(await gate(notice('finished', 'Done in 3m'), thread())).toBe(false)
    expect(await gate(notice('failed', 'Failed'), thread())).toBe(false)
    expect(told).toEqual([])
  })
  it('when the cause cannot be learned, or reading it fails, the notice goes: nothing goes quiet on a doubt', async () => {
    const gate = makeGate(deps())
    pressed.set('run-1', null)
    expect(await gate(notice('finished', 'Done'), thread())).toBe(false)
    pressed.set('run-1', new Error('routines are not running'))
    expect(await gate(notice('finished', 'Done'), thread())).toBe(false)
    expect(told).toEqual([])
    expect(logs).toEqual(["digest: a run's cause could not be read, so its notice goes: routines are not running"])
  })
})

describe('a thread a pillar marked quiet', () => {
  it('waits for the digest as a routine run does, with no run to ask about', () => {
    quiet.add('t1')
    const gate = makeGate(deps())
    expect(gate(notice('finished', 'Done in 2m'), thread({ routineRunId: null, title: 'Prep for Budget review' }))).toBe(true)
    expect(told).toMatchObject([{ kind: 'routines.done', detail: 'Done in 2m', open: { thread: 't1' } }])
    expect(gate(notice('needs_you', 'Which room?'), thread({ routineRunId: null }))).toBe(false)
  })
})

describe('everything else is untouched', () => {
  it('a thread he started by hand, a code thread and a subagent pass, whatever they say', () => {
    const gate = makeGate(deps())
    for (const event of ['finished', 'failed', 'stuck', 'needs_you'] as const) {
      expect(gate(notice(event, 'x'), thread({ routineRunId: null }))).toBe(false)
      expect(gate(notice(event, 'x'), thread({ scope: 'code' }))).toBe(false)
      expect(gate(notice(event, 'x'), thread({ scope: undefined }))).toBe(false)
      expect(gate(notice(event, 'x'), thread({ parentId: 'root' }))).toBe(false)
    }
    expect(told).toEqual([])
  })
  it('with Work off the gate keeps nothing', () => {
    on = false
    quiet.add('t1')
    const gate = makeGate(deps())
    expect(gate(notice('finished', 'Done'), thread())).toBe(false)
    expect(told).toEqual([])
  })
})

describe("a run's cause", () => {
  const run = (id: string, cause: string): RoutineRun => ({ id, routineId: 'r', sessionId: null, firedAt: 1, cause, folded: 0, state: 'quiet', summary: '' })
  function routines(byRoutine: Record<string, RoutineRun[]>): { module: WorkModule; calls: string[] } {
    const calls: string[] = []
    const module = {
      id: 'routines',
      ensure: () => {},
      handle: async (req: { method: string; params: { id?: string; workspaceId?: string } }) => {
        calls.push(`${req.method}:${req.params.id ?? req.params.workspaceId ?? ''}`)
        if (req.method === 'work.routines.list') return { handled: true, result: { routines: Object.keys(byRoutine).map((id) => ({ id })) } }
        if (req.method === 'work.routines.runs') return { handled: true, result: { runs: byRoutine[req.params.id!] ?? [] } }
        return { handled: false }
      }
    } as unknown as WorkModule
    return { module, calls }
  }
  it("is read through the routines module's own methods, the workspace's routines then their runs, and asked once a run", async () => {
    const { module, calls } = routines({ morning: [run('run-1', 'Weekdays at 7:00 AM'), run('run-2', RUN_NOW_CAUSE)], nightly: [run('run-3', '2 new mail')] })
    const read = runPressed({} as WorkCtx, () => [module])
    expect(await read('run-2', 'ws-cosmic')).toBe(true)
    expect(calls).toEqual(['work.routines.list:ws-cosmic', 'work.routines.runs:morning'])
    // the same read learned its neighbour: no second ask
    expect(await read('run-1', 'ws-cosmic')).toBe(false)
    expect(calls).toHaveLength(2)
    expect(await read('run-3', 'ws-cosmic')).toBe(false)
    expect(await read('run-9', 'ws-cosmic')).toBeNull()
  })
  it('is unknown while routines are not running on this host', async () => {
    expect(await runPressed({} as WorkCtx, () => [])('run-1', null)).toBeNull()
  })
  it("is the engine's own word for Run now", () => {
    // routines/engine.ts writes it; the gate reads it. Held together here so neither changes alone.
    expect(readFileSync(join(__dirname, '../routines/engine.ts'), 'utf8')).toContain(`this.fire(r, '${RUN_NOW_CAUSE}', 0, { force: true })`)
  })
})
