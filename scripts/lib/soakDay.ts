/**
 * `--scene day` (budget D18): his long day pressed into one window of DAY_TIMING.windowMs. Every running
 * thread streams (soakLoad.ts DAY_PROFILE); DAY_TIMING.opens of them are opened one after another, as a click
 * opens a thread, and left. Read at the window's start and end: the heap after GC, and the transcripts the
 * store holds (STORE_CENSUS, off `window.__docket.sessionStore` in any build): how many are loaded against the
 * panes mounted, and the raw rows each loaded one keeps (the remote profile's `rows`, kept for a refold).
 * Pure apart from the page script (scripts/soak-idle-long-day.test.ts).
 */
import type { Verdict } from './soakJudge'

export const DAY_TIMING = { windowMs: 50_000, opens: 10, warmMs: 5_000 }

/** D18: heap after GC no more than 6 MB up over the window (the soak's rule), and no more transcripts loaded
 *  than those mounted plus the six the store keeps for a switch back (KEEP_RECENT). */
export const DAY_RULE = { name: 'day', heapGrowthMb: 6, keptAboveMounted: 6 }

export const STORE_CENSUS = `(() => {
  const st = window.__docket.sessionStore
  const mounted = st.mounted ? [...st.mounted] : []
  const closure = typeof st.mountedClosure === 'function' ? st.mountedClosure() : null
  const kept = typeof st.keptLoaded === 'function' ? st.keptLoaded() : null
  const recent = Array.isArray(st.recent) ? st.recent : []
  // Why a loaded transcript stays: kept (mounted, its closure, recently shown), or the unload's refusal.
  const why = (e) => {
    const id = e.meta.id
    if (mounted.includes(id)) return 'mounted'
    if (closure && closure.has(id)) return 'closure'
    if (kept && kept.has(id)) return recent.includes(id) ? 'recent' : 'kept'
    if (e.loading) return 'refused: a load in flight'
    if (e.session.blocks.some((b) => b.pending)) return 'refused: a send pending'
    return st.unloadTimer ? 'the unload pass is on its way' : 'no unload pass since it left the kept set'
  }
  const loaded = []
  for (const e of st.entries.values()) {
    if (!e.meta || !e.loaded) continue
    loaded.push({ id: e.meta.id, rows: e.rows ? e.rows.length : null, blocks: e.session.blocks.length, busy: !!e.session.busy, mounted: mounted.includes(e.meta.id), why: why(e) })
  }
  return { mounted: mounted.length, closure: closure ? closure.size : null, recent: recent.length, loaded }
})()`

export interface StoreCensus {
  mounted: number
  closure: number | null
  recent: number | null
  loaded: { id: string; rows: number | null; blocks: number; busy: boolean; mounted: boolean; why?: string }[]
}

/** The loaded transcripts past the kept set, each with why it stays: what a day over its bound reads. */
export function extraLoaded(c: StoreCensus): { id: string; why: string }[] {
  return c.loaded.filter((l) => l.why && !['mounted', 'closure', 'recent', 'kept'].includes(l.why)).map((l) => ({ id: l.id, why: l.why! }))
}

export interface DayResult {
  heapStartMb: number
  heapEndMb: number
  opened: string[]
  start: StoreCensus
  end: StoreCensus
}

/** The raw rows the loaded transcripts keep: all of them, the most one keeps, and per loaded transcript. */
export function rawRows(c: StoreCensus): { total: number; max: number; perLoaded: number } {
  const rows = c.loaded.map((l) => l.rows ?? 0)
  const total = rows.reduce((s, n) => s + n, 0)
  return { total, max: Math.max(0, ...rows), perLoaded: c.loaded.length ? Math.round(total / c.loaded.length) : 0 }
}

export function judgeDay(r: DayResult, rule = DAY_RULE): { ok: boolean; verdicts: Verdict[] } {
  const growth = Math.round((r.heapEndMb - r.heapStartMb) * 10) / 10
  const over = r.end.loaded.length - r.end.mounted
  const verdicts: Verdict[] = [
    { what: 'heap after GC growth over the window, MB', got: growth, limit: rule.heapGrowthMb, ok: growth <= rule.heapGrowthMb },
    { what: 'transcripts loaded beyond those mounted', got: over, limit: rule.keptAboveMounted, ok: over <= rule.keptAboveMounted },
    // A run that opened fewer measured less than the day: it fails.
    { what: 'threads opened and left', got: r.opened.length, limit: DAY_TIMING.opens, ok: r.opened.length >= DAY_TIMING.opens }
  ]
  return { ok: verdicts.every((v) => v.ok), verdicts }
}
