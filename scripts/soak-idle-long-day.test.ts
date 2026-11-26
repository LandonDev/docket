import { describe, expect, it } from 'vitest'
import { perfThread } from './lib/ios-perf-seeds'
import { DAY_PROFILE, declaredRates, IDLE_PROFILE, liveTail, LONG_INDEX, LONG_PROFILE, LONG_STREAM_PROFILE, owedAt, profileOf, RUNNING_THREADS } from './lib/soakLoad'
import { gateBudgetMs, parseSoakArgs } from './lib/soakJudge'
import { flushesBetween, IDLE_PHASES, IDLE_RULE, judgeIdle, summarizeIdlePhase, type Census, type FlushRecord, type IdlePhase } from './lib/soakIdle'
import { frameMainMs, judgeLong, LONG_RULE, taskList, type LongResult } from './lib/soakLong'
import { DAY_RULE, DAY_TIMING, judgeDay, rawRows, type DayResult, type StoreCensus } from './lib/soakDay'
import type { TraceEvent } from './lib/soakTrace'

const flush = (at: number, ms: number, rendered = 0, names: Record<string, number> = {}): FlushRecord => ({ at, ms, meta: true, commits: rendered ? 1 : 0, rendered, names, settledMs: ms + 1 })
const census = (running: number, workingRows: number): Census => ({ running, onScreen: running, kinds: { 'transform on [data-slot=spinner]': running }, workingRows })

function phase(name: (typeof IDLE_PHASES)[number], o: { cpuS?: number; running?: number; rows?: number; flushMs?: number[]; rendered?: number[] } = {}): IdlePhase {
  return summarizeIdlePhase({
    phase: name,
    state: { visibility: name === 'hidden' ? 'hidden' : 'visible', focus: name === 'focused' },
    how: 'by hand',
    cpuS: o.cpuS ?? 0.2,
    wallS: 20,
    census: census(o.running ?? 2, o.rows ?? 2),
    flushes: (o.flushMs ?? [0.5, 1, 1.5]).map((ms, i) => flush(i * 100, ms)),
    tasks: [],
    pushes: (o.rendered ?? [2, 3]).map((n, i) => [flush(i * 1000, 0.4, n, { RailRow: n })])
  })
}

describe('the idle, long and day scenes: their load', () => {
  it('runs forty threads whose metas move ten times a second in all, and nothing else in idle', () => {
    expect(IDLE_PROFILE.children).toBe(RUNNING_THREADS)
    expect(declaredRates(IDLE_PROFILE)).toMatchObject({ meta: 10, delta: 0, tool: 0, log: 0 })
    // The phases spread the forty over the period: one second owes ten, never forty at once.
    const owed = IDLE_PROFILE.streams.reduce((n, s) => n + owedAt(s, 1_000), 0)
    expect(owed).toBe(10)
    expect(profileOf('idle')).toBe(IDLE_PROFILE)
  })

  it('puts the long thread after the running ones and streams it only on its own profile', () => {
    expect(LONG_PROFILE.children).toBe(RUNNING_THREADS + 1)
    expect(LONG_PROFILE.streams.every((s) => s.kind === 'meta' && s.child !== LONG_INDEX)).toBe(true)
    expect(LONG_STREAM_PROFILE.streams.every((s) => s.child === LONG_INDEX)).toBe(true)
    expect(declaredRates(LONG_STREAM_PROFILE)).toMatchObject({ delta: 20, tool: 0.5 })
  })

  it('streams every running thread in the day scene', () => {
    expect(new Set(DAY_PROFILE.streams.filter((s) => s.kind === 'delta').map((s) => s.child)).size).toBe(RUNNING_THREADS)
    const rates = declaredRates(DAY_PROFILE)
    expect(rates).toMatchObject({ meta: 10, delta: 80 })
    expect(rates.tool).toBeCloseTo(4)
  })

  it("leaves the long thread's last turn open: 30,000 rows less its close, two turns", () => {
    const events = liveTail(perfThread('t', { rows: 30_000, turns: 2, seed: 31 }))
    expect(events).toHaveLength(29_998)
    expect(events.filter((e) => e.type === 'user-text')).toHaveLength(2)
    expect(events.filter((e) => e.type === 'turn-complete')).toHaveLength(1)
    expect(() => liveTail(events)).toThrow('perfThread ends otherwise')
  })

  it('takes the scenes on the synthetic host alone, shown as their quiet chat, by hand', () => {
    expect(parseSoakArgs(['--scene', 'idle'])).toMatchObject({ scene: 'idle', view: 'stream', host: 'synthetic', label: 'synthetic-prod-idle' })
    for (const scene of ['long', 'day']) expect(parseSoakArgs(['--scene', scene])).toMatchObject({ scene, view: 'stream' })
    expect(() => parseSoakArgs(['--scene', 'idle', '--host', 'box'])).toThrow('synthetic host')
    expect(parseSoakArgs(['--scene', 'long', '--gate'])).toMatchObject({ scene: 'long', gate: true, label: 'gate-long' })
    expect(parseSoakArgs(['--scene', 'idle', '--gate'])).toMatchObject({ scene: 'idle', gate: true })
    expect(() => parseSoakArgs(['--scene', 'day', '--gate'])).toThrow('no gate row yet')
    expect(gateBudgetMs('idle')).toBeGreaterThan(gateBudgetMs('board'))
    expect(() => parseSoakArgs(['--scene', 'day', '--minutes', '2'])).toThrow('runs its own steps')
    expect(() => parseSoakArgs(['--scene', 'idle', '--view', 'board'])).toThrow('runs its own steps')
  })
})

describe('judgeIdle', () => {
  it('passes a quiet window: CPU under each phase bound, animations within the working rows, a cheap flush and push', () => {
    const phases = [phase('focused', { cpuS: 0.8 }), phase('unfocused', { cpuS: 0.4 }), phase('hidden', { cpuS: 0.1, running: 9, rows: 0 })]
    expect(phases[0]!.cpuPct).toBe(4)
    const v = judgeIdle(phases)
    expect(v.ok).toBe(true)
    // A hidden page ticks no animation: its census is read, not judged.
    expect(v.verdicts.some((x) => x.what.startsWith('hidden: running animations'))).toBe(false)
    expect(v.verdicts).toHaveLength(3 * 3 + 2)
  })

  it('fails each bound on its own', () => {
    const v = judgeIdle([phase('focused', { cpuS: 1.2 }), phase('unfocused', { running: 40, rows: 3 }), phase('hidden', { flushMs: [1, 2, 9], rendered: [2, 12] })])
    const failed = v.verdicts.filter((x) => !x.ok).map((x) => x.what)
    expect(failed).toEqual([
      'focused: renderer CPU, % of one core',
      'unfocused: running animations over the working rows on screen',
      'hidden: a store flush at p95, ms',
      'hidden: components rendered for one off-screen meta push, the most'
    ])
    expect(v.verdicts.find((x) => x.what.startsWith('unfocused: running'))!.got).toBe(37)
  })

  it("the gate's form reports CPU and still fails an animation off screen or a push that renders", () => {
    const hot = [phase('focused', { cpuS: 2 }), phase('unfocused', { cpuS: 2 }), phase('hidden', { cpuS: 1 })]
    const reported = judgeIdle(hot, IDLE_RULE, { cpuReportOnly: true })
    expect(reported.ok).toBe(true)
    expect(reported.verdicts.filter((x) => x.what.includes('CPU')).every((x) => x.reportOnly && !x.ok)).toBe(true)
    expect(judgeIdle([phase('focused', { running: 78, rows: 40 }), phase('unfocused'), phase('hidden')], IDLE_RULE, { cpuReportOnly: true }).ok).toBe(false)
    expect(judgeIdle([phase('focused', { rendered: [64] }), phase('unfocused'), phase('hidden')], IDLE_RULE, { cpuReportOnly: true }).ok).toBe(false)
  })

  it('fails a run that timed no push or missed a phase', () => {
    const none = phase('focused', { rendered: [] })
    expect(judgeIdle([none, phase('unfocused'), phase('hidden')]).verdicts.find((x) => x.what.startsWith('focused: components'))!.ok).toBe(false)
    expect(judgeIdle([phase('focused')]).verdicts.at(-1)).toMatchObject({ what: 'phases measured', got: 1, ok: false })
  })

  it('sums a push over its flushes and names what rendered', () => {
    const p = summarizeIdlePhase({
      phase: 'focused', state: { visibility: 'visible', focus: true }, how: '', cpuS: 0, wallS: 0, census: census(0, 0), flushes: [], tasks: [{ start: 1, duration: 70 }],
      pushes: [[flush(0, 1, 4, { A: 3, B: 1 }), flush(16, 1, 2, { A: 2 })]]
    })
    expect(p.pushes).toEqual([{ rendered: 6, flushes: 2, commits: 2, ms: 4 }])
    expect(p.pushNames).toEqual([['A', 5], ['B', 1]])
    expect(p.cpuPct).toBe(0)
    expect(p.longTasks).toEqual({ count: 1, maxMs: 70 })
    expect(flushesBetween([flush(5, 1), flush(10, 1), flush(15, 1)], 10, 15).map((f) => f.at)).toEqual([10])
    expect(IDLE_RULE.cpuPct).toEqual({ focused: 5, unfocused: 3, hidden: 1 })
  })
})

describe('the long scene', () => {
  const X = (name: string, ts: number, dur: number, tid = 1): TraceEvent => ({ name, ph: 'X', pid: 7, tid, ts, dur })

  it('reads main-thread ms a frame from the top-level slices between frame starts', () => {
    const events = [
      X('ThreadControllerImpl::RunTask', 0, 3_000),
      X('ProxyMain::BeginMainFrame', 500, 2_000), // inside the task above: not top-level
      X('ThreadControllerImpl::RunTask', 4_000, 1_000),
      X('ProxyMain::BeginMainFrame', 16_000, 4_000),
      X('ThreadControllerImpl::RunTask', 21_000, 6_000),
      X('ThreadControllerImpl::RunTask', 22_000, 1_000), // nested
      X('ProxyMain::BeginMainFrame', 33_000, 1_000),
      X('ThreadControllerImpl::RunTask', 4_000, 9_000, 2) // another thread
    ]
    // Frame 1 (500 to 16,000): the task at 4,000. Frame 2 (16,000 to 33,000): its own 4 ms and the 6 ms task.
    expect(frameMainMs(events, 7, 1)).toEqual([1, 10])
    expect(frameMainMs([X('ProxyMain::BeginMainFrame', 0, 1)], 7, 1)).toEqual([])
  })

  const result = (o: Partial<{ readable: number | null; openTask: number; streamTask: number; p95: number | null; landed: number | null }> = {}): LongResult => ({
    rows: 29_999,
    open: { by: 'rail', readableMs: o.readable === undefined ? 900 : o.readable, tasks: taskList([{ start: 6_100, duration: o.openTask ?? 80 }], 100), profile: null, held: { blocks: 300, rows: 300, oldest: 29_700 } },
    stream: { sent: { delta: 200, tool: 5 }, frameMs: { n: 3, p50: 2, p95: o.p95 === undefined ? 3 : o.p95, p99: 3, max: 3 }, frames: 3, tasks: taskList(o.streamTask ? [{ start: 0, duration: o.streamTask }] : [], 0) },
    jump: { seq: 5_000, oldestLoaded: 29_700, inLoaded: false, landedMs: o.landed === undefined ? 400 : o.landed, tasks: taskList([], 0) },
    top: { steps: 3, reached: false, ms: 1, stepMs: { n: 0, p50: null, p95: null, p99: null, max: null }, tasks: taskList([], 0), heldAfter: { blocks: 0, rows: 0, oldest: 1 } }
  })

  it('lists the long tasks from the step start', () => {
    expect(taskList([{ start: 6_100, duration: 2_712.4 }, { start: 200, duration: 60 }], 100)).toEqual({ count: 2, maxMs: 2712, list: [{ at: 6_000, ms: 2_712 }, { at: 100, ms: 60 }] })
  })

  it('passes within every bound and fails each on its own, a step that never came at Infinity', () => {
    expect(judgeLong(result()).ok).toBe(true)
    const failed = (r: LongResult): string[] => judgeLong(r).verdicts.filter((v) => !v.ok).map((v) => v.what)
    expect(failed(result({ openTask: 2_700 }))).toEqual(['open: longest task in the 15 s after, ms'])
    expect(failed(result({ streamTask: 51 }))).toEqual(['stream: longest task, ms'])
    expect(failed(result({ p95: 4.1 }))).toEqual(['stream: main thread a frame at p95, ms'])
    expect(failed(result({ p95: null }))).toEqual(['stream: main thread a frame at p95, ms'])
    expect(failed(result({ readable: null, landed: null }))).toEqual(['open: click to rows readable, ms', 'jump: an old hit lands, ms'])
    expect(judgeLong(result({ landed: null })).verdicts.at(-1)!.got).toBe(Number.POSITIVE_INFINITY)
    expect(LONG_RULE).toMatchObject({ afterOpenTaskMs: 100, streamTaskMs: 50 })
  })

  it("the gate's form judges D04, D05 and D11 and leaves the jump reported", () => {
    const gated = judgeLong(result({ landed: null }), LONG_RULE, true)
    expect(gated.ok).toBe(true)
    expect(gated.verdicts.map((v) => v.what)).not.toContain('jump: an old hit lands, ms')
    expect(judgeLong(result({ p95: 9 }), LONG_RULE, true).ok).toBe(false)
  })
})

describe('the day scene', () => {
  const store = (loaded: number, mounted: number, rows = 300): StoreCensus => ({
    mounted,
    closure: mounted,
    recent: Math.max(0, loaded - mounted),
    loaded: Array.from({ length: loaded }, (_, i) => ({ id: `t${i}`, rows: i === 0 ? null : rows + i, blocks: 10, busy: true, mounted: i < mounted }))
  })
  const day = (o: Partial<DayResult>): DayResult => ({ heapStartMb: 40, heapEndMb: 44, opened: Array.from({ length: DAY_TIMING.opens }, (_, i) => `t${i}`), start: store(0, 1), end: store(7, 1), ...o })

  it('counts the raw rows the loaded transcripts keep', () => {
    expect(rawRows(store(3, 1))).toEqual({ total: 301 + 302, max: 302, perLoaded: 201 })
    expect(rawRows(store(0, 0))).toEqual({ total: 0, max: 0, perLoaded: 0 })
  })

  it('holds the heap to 6 MB and the loaded to the mounted and six', () => {
    expect(judgeDay(day({})).ok).toBe(true)
    const v = judgeDay(day({ heapEndMb: 46.1, end: store(11, 1) }))
    expect(v.verdicts.filter((x) => !x.ok).map((x) => [x.what, x.got])).toEqual([
      ['heap after GC growth over the window, MB', 6.1],
      ['transcripts loaded beyond those mounted', 10]
    ])
    expect(judgeDay(day({ opened: ['t0'] })).ok).toBe(false)
    expect(DAY_RULE).toEqual({ name: 'day', heapGrowthMb: 6, keptAboveMounted: 6 })
  })
})
