/**
 * `--scene long` (budgets D04, D05, D11, D12): one agent-shaped thread of LONG_ROWS rows in two turns, its
 * last turn live (soakHost.ts SOAK_LONG), beside forty running threads. Four steps, each with its longest
 * task and its long tasks:
 *
 *   open    a cold open from the rail: the click to rows he can read (a row of the thread in the
 *           transcript's viewport, none on screen still an unparsed `invisible` text), and every long task in
 *           the LONG_TIMING.afterOpenMs after the click (the owner's Mac shows a 2.7 s freeze some 6 s
 *           after such an open); a CPU profile of that time is kept on disk
 *   stream  deltas into the live turn for LONG_TIMING.streamMs: main-thread ms a frame (a trace's top-level
 *           main-thread slices between one BeginMainFrame and the next), its p95, the longest task
 *   jump    a jump to a row older than the loaded tail (`window.__docket.open(id, { seq })`, a search hit's
 *           path): whether the row lands on screen, and when
 *   top     to the top through "Load earlier messages": the steps, their times, the longest task
 *
 * The page side is LONG_PAGE; the rest is pure (scripts/soak-idle-long-day.test.ts).
 */
import type { Verdict } from './soakJudge'
import { spread, type Spread } from './soakTyping'
import type { TraceEvent } from './soakTrace'

export const LONG_TIMING = { afterOpenMs: 15_000, readableWithinMs: 20_000, streamMs: 10_000, jumpWaitMs: 10_000, topBudgetMs: 180_000, topStepWaitMs: 30_000, topMaxSteps: 200 }

/** D05: no task over 100 ms in the 15 s after the open. D11: no task over 50 ms while streaming, 4 ms of main
 *  thread a frame at p95. D12: the old hit lands within 2 s. D04: rows readable within 1.2 s (its p95). */
export const LONG_RULE = { name: 'long', readableMs: 1_200, afterOpenTaskMs: 100, streamTaskMs: 50, frameMainP95Ms: 4, jumpLandsMs: 2_000 }

/** The jump's row: in the first turn, far older than any tail the window loads. */
export const LONG_JUMP_SEQ = 5_000

export const LONG_PAGE = `(() => {
  if (window.__long) return true
  const s = (window.__long = { tasks: [], frames: [] })
  new PerformanceObserver((list) => { for (const e of list.getEntries()) s.tasks.push({ start: e.startTime, duration: e.duration }) }).observe({ type: 'longtask' })
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration <= 50) continue
        const scripts = [...(e.scripts || [])].sort((a, b) => b.duration - a.duration).slice(0, 3)
        s.frames.push({ start: e.startTime, duration: e.duration, scripts: scripts.map((x) => (x.sourceFunctionName || x.invoker || '?') + ' ' + Math.round(x.duration) + ' ms') })
      }
    }).observe({ type: 'long-animation-frame' })
  } catch {}
  const pane = (id) => [...document.querySelectorAll('[data-session-drop="' + id + '"]')].find((e) => e.getBoundingClientRect().width > 0 && !e.closest('.tab-parked'))
  const seenRows = (id) => {
    const p = pane(id)
    const view = p && p.querySelector('.agent-transcript')
    if (!view) return []
    const box = view.getBoundingClientRect()
    return [...view.querySelectorAll('[data-row]')].filter((r) => { const b = r.getBoundingClientRect(); return b.height > 0 && b.bottom > box.top && b.top < box.bottom })
  }
  // Readable: a row of the thread in the transcript's viewport (an agent thread's rows are tall: a screen may hold
  // one tool table), and none on screen still an unparsed \`invisible\` text.
  s.readable = (id) => { const rows = seenRows(id); return rows.length >= 1 && !rows.some((r) => r.querySelector('.agent-markdown.invisible')) }
  s.rowSeen = (id, key) => seenRows(id).some((r) => (r.getAttribute('data-row') || '').includes(key))
  // Every frame until the test holds (the first frame it does), for \`ms\` at most: the poll reads layout, so it
  // must never outlive its step.
  s.arm = (what, test, ms) => {
    const run = (s[what] = { t0: performance.now(), at: null })
    const tick = () => { if (s[what] !== run) return; if (test()) { run.at = performance.now(); return } if (performance.now() - run.t0 < ms) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    return run.t0
  }
  s.disarm = (what) => { s[what] = { t0: 0, at: s[what] ? s[what].at : null }; return true }
  s.armOpen = (id) => s.arm('open', () => s.readable(id), ${LONG_TIMING.readableWithinMs})
  s.armJump = (id, key) => s.arm('jump', () => s.rowSeen(id, key), ${LONG_TIMING.jumpWaitMs})
  // Why a step found no pane: every pane on the page, the transcript, its rows and their state.
  s.census = (id) => {
    const panes = [...document.querySelectorAll('[data-session-drop]')].map((e) => { const r = e.getBoundingClientRect(); return { id: e.getAttribute('data-session-drop'), w: Math.round(r.width), h: Math.round(r.height), parked: !!e.closest('.tab-parked, .board-parked') } })
    const p = pane(id)
    const view = p && p.querySelector('.agent-transcript')
    const rows = view ? [...view.querySelectorAll('[data-row]')] : []
    return { panes, pane: !!p, transcript: !!view, rows: rows.length, seen: seenRows(id).length, invisible: rows.filter((r) => r.querySelector('.agent-markdown.invisible')).length, keys: rows.slice(0, 4).map((r) => r.getAttribute('data-row')), scroll: view ? { top: Math.round(view.scrollTop), height: view.scrollHeight, client: view.clientHeight } : null, buttons: p ? [...p.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /earlier/i.test(t)) : [] }
  }
  s.between = (t0, t1) => ({ tasks: s.tasks.filter((x) => x.start >= t0 && x.start < t1), frames: s.frames.filter((x) => x.start >= t0 && x.start < t1) })
  s.now = () => performance.now()
  // What the store holds of the thread: its blocks, its raw rows, the oldest seq loaded, and the block a seq jumps to.
  s.held = (id, seq) => {
    const st = window.__docket.sessionStore
    const entry = st.entries.get(id)
    const blocks = (entry && entry.session.blocks) || []
    let oldest = null, target = null
    for (const b of blocks) {
      if (b.seq === undefined) continue
      if (oldest === null || b.seq < oldest) oldest = b.seq
      if ((b.role === 'user' || b.role === 'assistant') && b.seq <= seq) target = b.id
    }
    return { blocks: blocks.length, rows: entry && entry.rows ? entry.rows.length : null, oldest, target, loaded: !!(entry && entry.loaded) }
  }
  return true
})()`

export interface TaskList {
  count: number
  maxMs: number
  /** every long task: start ms from the step's start, and its length */
  list: { at: number; ms: number }[]
}

export const taskList = (tasks: readonly { start: number; duration: number }[], t0: number): TaskList => ({
  count: tasks.length,
  maxMs: Math.round(Math.max(0, ...tasks.map((t) => t.duration))),
  list: tasks.map((t) => ({ at: Math.round(t.start - t0), ms: Math.round(t.duration) }))
})

/**
 * Main-thread ms a frame from a trace: the renderer main thread's top-level slices summed between one
 * `ProxyMain::BeginMainFrame` start and the next, one figure a frame.
 */
export function frameMainMs(events: readonly TraceEvent[], pid: number, tid: number): number[] {
  const main = events.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X' && typeof e.dur === 'number').sort((a, b) => a.ts - b.ts || b.dur! - a.dur!)
  const starts = main.filter((e) => e.name === 'ProxyMain::BeginMainFrame').map((e) => e.ts)
  if (starts.length < 2) return []
  const top: TraceEvent[] = []
  let end = -Infinity
  for (const e of main) {
    if (e.ts >= end) {
      top.push(e)
      end = e.ts + e.dur!
    }
  }
  const out: number[] = []
  let i = 0
  for (let f = 0; f + 1 < starts.length; f++) {
    let us = 0
    while (i < top.length && top[i]!.ts < starts[f]!) i++
    for (let j = i; j < top.length && top[j]!.ts < starts[f + 1]!; j++) us += top[j]!.dur!
    out.push(Math.round(us / 100) / 10)
  }
  return out
}

export interface LongResult {
  rows: number
  open: { by: 'rail' | 'open'; readableMs: number | null; tasks: TaskList; profile: string | null; held: { blocks: number; rows: number | null; oldest: number | null } }
  stream: { sent: Record<string, number>; frameMs: Spread; frames: number; tasks: TaskList }
  jump: { seq: number; oldestLoaded: number | null; inLoaded: boolean; landedMs: number | null; tasks: TaskList }
  top: { steps: number; reached: boolean; ms: number; stepMs: Spread; tasks: TaskList; heldAfter: { blocks: number; rows: number | null; oldest: number | null } }
}

/** Every step against LONG_RULE; a step that never finished fails at Infinity. */
/** The long scene against its rule. The gate's form (`gate`, budgets D04, D05 and D11) leaves the jump
 *  (D12) out of the verdict: it is reported, and the climb to the top is a hand run's. */
export function judgeLong(r: LongResult, rule = LONG_RULE, gate = false): { ok: boolean; verdicts: Verdict[] } {
  const inf = (n: number | null): number => (n === null ? Number.POSITIVE_INFINITY : Math.round(n))
  const verdicts: Verdict[] = [
    { what: 'open: click to rows readable, ms', got: inf(r.open.readableMs), limit: rule.readableMs, ok: inf(r.open.readableMs) <= rule.readableMs },
    { what: 'open: longest task in the 15 s after, ms', got: r.open.tasks.maxMs, limit: rule.afterOpenTaskMs, ok: r.open.tasks.maxMs <= rule.afterOpenTaskMs },
    { what: 'stream: longest task, ms', got: r.stream.tasks.maxMs, limit: rule.streamTaskMs, ok: r.stream.tasks.maxMs <= rule.streamTaskMs },
    { what: 'stream: main thread a frame at p95, ms', got: r.stream.frameMs.p95 ?? Number.POSITIVE_INFINITY, limit: rule.frameMainP95Ms, ok: (r.stream.frameMs.p95 ?? Number.POSITIVE_INFINITY) <= rule.frameMainP95Ms },
    ...(gate ? [] : [{ what: 'jump: an old hit lands, ms', got: inf(r.jump.landedMs), limit: rule.jumpLandsMs, ok: inf(r.jump.landedMs) <= rule.jumpLandsMs }])
  ]
  return { ok: verdicts.every((v) => v.ok), verdicts }
}
