/**
 * Driving Files in a window for the PC drive bench (scripts/bench-pc-drive.ts): the rows on screen, a row found by
 * scrolling the list, a real double-click, Back, and what the page says when it gives up.
 */
import type { Window } from './pcRig'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The names of the rows the list draws now, and whether it says it is loading or gave up. */
export interface ListLook {
  names: string[]
  /** every drawn row shows its change time */
  timed: boolean
  /** the list is scrolled to its end */
  atEnd: boolean
  loading: boolean
  /** a line the page shows when a listing failed ("did not answer", "not reachable") */
  error: string | null
  /** the active tab's title */
  tab: string | null
}

export const LOOK_JS = String.raw`(() => {
  const list = document.querySelector('[data-files-list]')
  const rows = list ? [...list.querySelectorAll('[data-files-row]')] : []
  const names = rows.map((r) => (r.querySelector('[data-files-name]')?.textContent ?? '').trim())
  const timed = rows.length > 0 && rows.every((r) => (r.lastElementChild?.textContent ?? '').trim().length > 0)
  const atEnd = !!list && list.scrollTop + list.clientHeight >= list.scrollHeight - 2
  const loading = !!document.querySelector('[role=status][aria-label=Loading], [data-files-list] [aria-busy]')
  const text = document.body.innerText
  const err = /([^\n]*(did not answer|is not reachable|did not load|did not open|not there any more)[^\n]*)/i.exec(text)
  const tab = document.querySelector('[role=tab][aria-selected=true]')?.textContent?.trim() ?? null
  return { names, timed, atEnd, loading, error: err ? err[1].slice(0, 200) : null, tab }
})()`

export const look = (w: Window): Promise<ListLook> => w.eval<ListLook>(LOOK_JS)

/** Scrolls the list until a row named `name` is drawn; true when it is. */
export async function findRow(w: Window, name: string): Promise<boolean> {
  return w.eval<boolean>(`(async () => {
    const list = document.querySelector('[data-files-list]')
    if (!list) return false
    const has = () => [...list.querySelectorAll('[data-files-row] [data-files-name]')].some((e) => e.textContent.trim() === ${JSON.stringify(name)})
    list.scrollTop = 0
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => requestAnimationFrame(() => r()))
      if (has()) {
        const el = [...list.querySelectorAll('[data-files-row]')].find((r) => r.querySelector('[data-files-name]')?.textContent.trim() === ${JSON.stringify(name)})
        el.scrollIntoView({ block: 'center' })
        // The list draws its rows again after a scroll: the row is pressed only once that settles.
        for (let k = 0; k < 3; k++) await new Promise((r) => requestAnimationFrame(() => r()))
        return true
      }
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 2) return false
      list.scrollTop += list.clientHeight * 0.8
    }
    return false
  })()`)
}

/** A real double-click on the row named `name` (drawn already). */
export async function openRow(w: Window, name: string): Promise<boolean> {
  // Looked up for up to a second: a list that just scrolled may still be drawing it.
  const at = await w.eval<{ x: number; y: number } | null>(`(async () => {
    for (let k = 0; k < 20; k++) {
      const row = [...document.querySelectorAll('[data-files-list] [data-files-row]')].find((r) => r.querySelector('[data-files-name]')?.textContent.trim() === ${JSON.stringify(name)})
      const r = row?.getBoundingClientRect()
      if (r && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight) return { x: r.left + r.width * 0.4, y: r.top + r.height / 2 }
      await new Promise((ok) => setTimeout(ok, 50))
    }
    return null
  })()`)
  if (!at) return false
  for (const n of [1, 2]) for (const type of ['mousePressed', 'mouseReleased'] as const) await w.cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: n })
  return true
}

/** Back in the page bar. */
export const back = (w: Window): Promise<boolean> => w.click('Back', 'button[aria-label=Back]')

/** Scrolls the list one screen further toward its end. */
export const scrollOn = (w: Window): Promise<unknown> => w.eval(`(() => { const l = document.querySelector('[data-files-list]'); if (l) l.scrollTop = l.scrollHeight })()`)

/**
 * Polls `test` every 100 ms up to `capMs`; the time it first held, or null. `onTick` runs each poll (a scroll, a
 * check of the page's error line), and a string it returns ends the wait as that failure.
 */
export async function waitFor<T>(capMs: number, test: () => Promise<T | null | false>, onTick?: () => Promise<string | null>): Promise<{ ms: number | null; value: T | null; failed: string | null }> {
  const t0 = performance.now()
  while (performance.now() - t0 < capMs) {
    const v = await test().catch(() => null)
    if (v) return { ms: Math.round(performance.now() - t0), value: v as T, failed: null }
    const failed = onTick ? await onTick().catch(() => null) : null
    if (failed) return { ms: null, value: null, failed }
    await sleep(100)
  }
  return { ms: null, value: null, failed: `nothing within ${Math.round(capMs / 1000)} s` }
}
