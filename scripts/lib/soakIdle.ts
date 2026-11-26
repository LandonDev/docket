/**
 * `--scene idle` (budgets D17 and D20, scripts/perf/budgets.ts): the window with a settled chat on screen
 * while forty threads run behind it and their metas move at the box's rate, and no stream shown
 * (soakLoad.ts IDLE_PROFILE). Three phases of equal length, each read for the renderer's CPU, a census of
 * the running animations beside the working rows on screen, the time of the store's flushes, and the React
 * components one meta push of a thread no screen shows renders. The page side is three scripts:
 *
 *   REACT_HOOK   installed before the page loads (Page.addScriptToEvaluateOnNewDocument): a stand-in for
 *                React DevTools' global hook, which a production React calls on every commit. Armed, it
 *                walks the commit's tree the way DevTools does (a subtree whose child list did not change
 *                was not visited; a component fiber with PerformedWork set, or new, rendered) and counts
 *                the components that rendered; unarmed it only stamps the commit's time.
 *   IDLE_PAGE    wraps the session store's `bump` (the flush every listener hears from) on the instance
 *                `window.__docket.sessionStore` holds, timing each flush and opening a window for it until
 *                the next task: a commit inside that window is the flush's (React renders a store change
 *                in a microtask after it). Nothing of the app's code changes.
 *   CENSUS       `document.getAnimations()` filtered to running, by name, element and whether its target
 *                is on screen, and the working rows on screen (a spinner's row in the viewport, outside a
 *                parked tab or board).
 *
 * The rest is pure (scripts/soak-idle-long-day.test.ts): a phase's summary and judgeIdle against IDLE_RULE.
 */
import type { Verdict } from './soakJudge'
import { spread, type Spread } from './soakTyping'

export const IDLE_PHASES = ['focused', 'unfocused', 'hidden'] as const
export type IdlePhaseName = (typeof IDLE_PHASES)[number]

/** Each phase's measured window, and the meta pushes timed one at a time after it with the load held. */
export const IDLE_TIMING = { phaseMs: 20_000, settleMs: 5_000, pushes: 5, pushGapMs: 1_000 }

/**
 * D17: renderer CPU by phase, in % of one core, and running animations no more than the working rows on
 * screen while the window is seen (a hidden page ticks none). D20: a flush at p95 within 2 ms, and one meta
 * push of a thread no screen shows renders 3 components at most.
 */
export const IDLE_RULE = {
  name: 'idle',
  cpuPct: { focused: 5, unfocused: 3, hidden: 1 } as Record<IdlePhaseName, number>,
  animationPhases: ['focused', 'unfocused'] as IdlePhaseName[],
  flushP95Ms: 2,
  rendersPerPush: 3
}

export const REACT_HOOK = `(() => {
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return
  const COMPONENT = new Set([0, 1, 11, 14, 15])
  const nameOf = (f) => { const t = f.type; if (!t) return '?'; if (typeof t === 'function') return t.displayName || t.name || '?'; return t.displayName || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || '?' }
  const count = (root) => {
    let n = 0
    const names = {}
    const stack = [[root.current, false]]
    while (stack.length) {
      const [f, mount] = stack.pop()
      const isNew = mount || !f.alternate
      if (COMPONENT.has(f.tag) && (isNew || (f.flags & 1) === 1)) { n++; const k = nameOf(f); names[k] = (names[k] || 0) + 1 }
      if (!isNew && f.child === f.alternate.child) continue
      for (let c = f.child; c; c = c.sibling) stack.push([c, isNew])
    }
    return { n, names }
  }
  const hook = {
    renderers: new Map(), supportsFiber: true, isDisabled: false, armed: false,
    inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id },
    checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(id, root) {
      try { if (this.onCommit) this.onCommit(this.armed ? count(root) : null) } catch {}
    }
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook
})()`

export const IDLE_PAGE = `(() => {
  if (window.__idle) return true
  const store = window.__docket.sessionStore
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__
  if (typeof store.bump !== 'function') return 'the session store has no bump to time'
  if (!hook || !hook.renderers || !hook.renderers.size) return 'React never reached the hook'
  const s = (window.__idle = { flushes: [], tasks: [] })
  new PerformanceObserver((list) => { for (const e of list.getEntries()) s.tasks.push({ start: e.startTime, duration: e.duration }) }).observe({ type: 'longtask' })
  let open = null
  const bump = store.bump
  store.bump = function () {
    const rec = { at: performance.now(), ms: 0, meta: this.metaPending === true, commits: 0, rendered: 0, names: {}, settledMs: 0 }
    open = rec
    const ch = new MessageChannel()
    ch.port1.onmessage = () => { if (open === rec) open = null }
    ch.port2.postMessage(0)
    try { return bump.apply(this, arguments) } finally { rec.ms = performance.now() - rec.at; rec.settledMs = rec.ms; s.flushes.push(rec) }
  }
  hook.onCommit = (counted) => {
    const rec = open
    if (!rec) return
    rec.commits++
    rec.settledMs = performance.now() - rec.at
    if (!counted) return
    rec.rendered += counted.n
    for (const k in counted.names) rec.names[k] = (rec.names[k] || 0) + counted.names[k]
  }
  s.arm = (on) => { hook.armed = on; return on }
  s.since = (t) => ({ flushes: s.flushes.filter((f) => f.at >= t), tasks: s.tasks.filter((x) => x.start >= t) })
  s.now = () => performance.now()
  s.state = () => ({ visibility: document.visibilityState, focus: document.hasFocus() })
  s.drop = (t) => { s.flushes = s.flushes.filter((f) => f.at >= t); s.tasks = s.tasks.filter((x) => x.start >= t); return true }
  return true
})()`

export const CENSUS = `(() => {
  const vw = innerWidth, vh = innerHeight
  const shown = (e) => {
    if (!e || !e.isConnected || e.closest('.tab-parked, .board-parked')) return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw
  }
  const running = document.getAnimations().filter((a) => a.playState === 'running')
  const kinds = {}
  let onScreen = 0
  for (const a of running) {
    const t = a.effect && a.effect.target
    let name = a.animationName || a.id
    if (!name && a.effect && a.effect.getKeyframes) name = [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((x) => !['offset', 'easing', 'composite', 'computedOffset'].includes(x))))].join('+')
    const el = !t ? 'no target' : (t.getAttribute('data-slot') ? '[data-slot=' + t.getAttribute('data-slot') + ']' : t.tagName.toLowerCase()) + (a.effect.pseudoElement || '')
    const seen = shown(t)
    if (seen) onScreen++
    const key = (name || 'web animation') + ' on ' + el + (seen ? '' : ', off screen')
    kinds[key] = (kinds[key] || 0) + 1
  }
  const rows = new Set()
  for (const sp of document.querySelectorAll('[data-slot="spinner"]')) {
    if (!shown(sp)) continue
    rows.add(sp.closest('[data-thread-row], [data-project-row], [role="tab"], [data-row], [data-batch-row], li') || sp)
  }
  return { running: running.length, onScreen, kinds, workingRows: rows.size }
})()`

export interface Census {
  running: number
  onScreen: number
  kinds: Record<string, number>
  workingRows: number
}

/** One flush as IDLE_PAGE kept it: its own ms, and to the end of the commits it caused. */
export interface FlushRecord {
  at: number
  ms: number
  meta: boolean
  commits: number
  rendered: number
  names: Record<string, number>
  settledMs: number
}

export interface IdlePhase {
  phase: IdlePhaseName
  /** what the page said of itself during the phase */
  state: { visibility: string; focus: boolean }
  /** how the phase was made, in words */
  how: string
  cpuPct: number
  wallS: number
  census: Census
  flushes: { count: number; meta: number; ms: Spread; settledMs: Spread }
  longTasks: { count: number; maxMs: number }
  /** each timed push of the thread no screen shows: the components it rendered, by flush */
  pushes: { rendered: number; flushes: number; commits: number; ms: number }[]
  /** the components those pushes rendered, by name, most first */
  pushNames: [string, number][]
}

/** A phase's readings into its summary: CPU from the renderer's CPU seconds over the wall seconds. */
export function summarizeIdlePhase(input: {
  phase: IdlePhaseName
  state: { visibility: string; focus: boolean }
  how: string
  cpuS: number
  wallS: number
  census: Census
  flushes: readonly FlushRecord[]
  tasks: readonly { start: number; duration: number }[]
  /** per push, the flushes that came after it and before the next */
  pushes: readonly (readonly FlushRecord[])[]
}): IdlePhase {
  const names = new Map<string, number>()
  for (const push of input.pushes) for (const f of push) for (const [k, n] of Object.entries(f.names)) names.set(k, (names.get(k) ?? 0) + n)
  return {
    phase: input.phase,
    state: input.state,
    how: input.how,
    cpuPct: input.wallS > 0 ? Math.round((input.cpuS / input.wallS) * 1000) / 10 : 0,
    wallS: Math.round(input.wallS * 10) / 10,
    census: input.census,
    flushes: {
      count: input.flushes.length,
      meta: input.flushes.filter((f) => f.meta).length,
      ms: spread(input.flushes.map((f) => f.ms)),
      settledMs: spread(input.flushes.map((f) => f.settledMs))
    },
    longTasks: { count: input.tasks.length, maxMs: Math.round(Math.max(0, ...input.tasks.map((t) => t.duration))) },
    pushes: input.pushes.map((p) => ({
      rendered: p.reduce((s, f) => s + f.rendered, 0),
      flushes: p.length,
      commits: p.reduce((s, f) => s + f.commits, 0),
      ms: Math.round(p.reduce((s, f) => s + f.settledMs, 0) * 10) / 10
    })),
    pushNames: [...names].sort((a, b) => b[1] - a[1]).slice(0, 25)
  }
}

/** Every phase against the rule: CPU, animations while seen, a flush at p95, renders for the worst push. */
export function judgeIdle(phases: readonly IdlePhase[], rule = IDLE_RULE): { ok: boolean; verdicts: Verdict[] } {
  const verdicts: Verdict[] = []
  for (const p of phases) {
    const cpu = rule.cpuPct[p.phase]
    verdicts.push({ what: `${p.phase}: renderer CPU, % of one core`, got: p.cpuPct, limit: cpu, ok: p.cpuPct <= cpu })
    if (rule.animationPhases.includes(p.phase)) {
      verdicts.push({ what: `${p.phase}: running animations over the working rows on screen`, got: p.census.running - p.census.workingRows, limit: 0, ok: p.census.running <= p.census.workingRows })
    }
    const p95 = p.flushes.ms.p95 ?? 0
    verdicts.push({ what: `${p.phase}: a store flush at p95, ms`, got: p95, limit: rule.flushP95Ms, ok: p95 <= rule.flushP95Ms })
    // No push timed is a run that measured nothing: it fails rather than passing at 0.
    const worst = p.pushes.length ? Math.max(...p.pushes.map((x) => x.rendered)) : Number.POSITIVE_INFINITY
    verdicts.push({ what: `${p.phase}: components rendered for one off-screen meta push, the most`, got: worst, limit: rule.rendersPerPush, ok: worst <= rule.rendersPerPush })
  }
  if (phases.length !== IDLE_PHASES.length) verdicts.push({ what: 'phases measured', got: phases.length, limit: IDLE_PHASES.length, ok: false })
  return { ok: verdicts.every((v) => v.ok), verdicts }
}

/** Flushes in [from, to) of a list kept by IDLE_PAGE's clock. */
export const flushesBetween = (flushes: readonly FlushRecord[], from: number, to: number): FlushRecord[] => flushes.filter((f) => f.at >= from && f.at < to)
