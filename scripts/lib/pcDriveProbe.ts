/**
 * What the PC drive bench (scripts/bench-pc-drive.ts) puts in a window and what it makes of it: every request the
 * window sends on any link (its method, its params' shape, its time and answer size), the longest gap between two
 * frames and the longest task while a step runs, and the bytes each link's socket took in. Then the sums per step.
 */

/** Installed once per page over CDP; `__bench.begin()` and `__bench.end()` bracket a step. */
export const PROBE_JS = String.raw`(() => {
  if (window.__bench) return 'kept'
  const reg = window.__docket?.registry
  if (!reg) return 'no registry'
  const proto = Object.getPrototypeOf(reg.primary())
  const B = (window.__bench = { calls: [], on: false, gap: 0, task: 0, last: performance.now(), t0: 0, bytes: {} })
  const shape = (v, d) => {
    if (v === null || v === undefined || typeof v !== 'object') return typeof v === 'string' && v.length > 80 ? 'str(' + v.length + ')' : v
    if (Array.isArray(v)) return d > 1 ? '[' + v.length + ']' : v.length > 3 ? ['[' + v.length + ']', shape(v[0], d + 1)] : v.map((x) => shape(x, d + 1))
    if (d > 2) return '{…}'
    const o = {}
    for (const [k, x] of Object.entries(v)) o[k] = shape(x, d + 1)
    return o
  }
  const SIZED = /^work\.files\.(list|stat|across|places|open|tabOpen|preview|thumbs)$|^work\.office\.files/
  const orig = proto.request
  proto.request = function (method, params, options) {
    const p = orig.call(this, method, params, options)
    if (!B.on) return p
    const rec = { link: this.environmentId, method, inner: method === 'work.files.across' ? params && params.method : undefined, params: shape(params, 0), at: Math.round(performance.now() - B.t0), ms: null, ok: null, size: null, n: null }
    B.calls.push(rec)
    p.then(
      (r) => {
        rec.ms = Math.round(performance.now() - B.t0 - rec.at)
        rec.ok = true
        if (r && typeof r.data === 'string') rec.size = r.data.length
        else if (SIZED.test(method)) try { rec.size = JSON.stringify(r).length } catch {}
        if (r && Array.isArray(r.entries)) rec.n = r.entries.length
      },
      (e) => {
        rec.ms = Math.round(performance.now() - B.t0 - rec.at)
        rec.ok = false
        rec.error = String((e && e.message) || e).slice(0, 200)
      }
    )
    return p
  }
  const tick = (t) => {
    if (B.on && t - B.last > B.gap) B.gap = t - B.last
    B.last = t
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  try {
    new PerformanceObserver((l) => { if (B.on) for (const e of l.getEntries()) B.task = Math.max(B.task, e.duration) }).observe({ entryTypes: ['longtask'] })
  } catch {}
  const bytesNow = () => Object.fromEntries(reg.links().map((l) => [l.environmentId, l.bytesIn]))
  B.begin = () => {
    B.calls = []
    B.gap = 0
    B.task = 0
    B.t0 = performance.now()
    B.bytes = bytesNow()
    B.on = true
    return document.visibilityState
  }
  B.end = () => {
    B.on = false
    const now = bytesNow()
    const bytesIn = {}
    for (const [k, v] of Object.entries(now)) bytesIn[k] = v - (B.bytes[k] || 0)
    return { calls: B.calls, gap: Math.round(Math.max(B.gap, performance.now() - B.last)), task: Math.round(B.task), bytesIn, ms: Math.round(performance.now() - B.t0) }
  }
  return 'installed'
})()`

export interface Call {
  link: string
  method: string
  inner?: string
  params: unknown
  at: number
  ms: number | null
  ok: boolean | null
  size: number | null
  n: number | null
  error?: string
}
export interface WindowTake {
  calls: Call[]
  gap: number
  task: number
  bytesIn: Record<string, number>
  ms: number
}

/** A call's name as the step's sums read it: an across call by the method it carries. */
export const callName = (c: Pick<Call, 'method' | 'inner'>): string => (c.inner ? `${c.method}→${c.inner}` : c.method)

export interface CallSum {
  name: string
  n: number
  /** the slowest one, ms */
  maxMs: number
  /** all of them, ms (they may overlap) */
  sumMs: number
  /** answer characters, all of them */
  size: number
  failed: number
  pending: number
}

/** Calls per name, the slowest name first. */
export function sumCalls(calls: Call[]): CallSum[] {
  const by = new Map<string, CallSum>()
  for (const c of calls) {
    const name = callName(c)
    const s = by.get(name) ?? { name, n: 0, maxMs: 0, sumMs: 0, size: 0, failed: 0, pending: 0 }
    s.n++
    if (c.ms === null) s.pending++
    else {
      s.maxMs = Math.max(s.maxMs, c.ms)
      s.sumMs += c.ms
    }
    if (c.ok === false) s.failed++
    s.size += c.size ?? 0
    by.set(name, s)
  }
  return [...by.values()].sort((a, b) => b.sumMs - a.sumMs)
}

export function median(xs: number[]): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!s.length) return NaN
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** One line of where a step's time went: its calls by name, the slowest first. */
export function callLine(calls: Call[], top = 4): string {
  return sumCalls(calls)
    .slice(0, top)
    .map((s) => `${s.n}× ${s.name} (slowest ${(s.maxMs / 1000).toFixed(2)} s${s.size ? `, ${(s.size / 2 ** 20).toFixed(1)} MB answered` : ''}${s.failed ? `, ${s.failed} failed` : ''}${s.pending ? `, ${s.pending} unanswered` : ''})`)
    .join('; ')
}
