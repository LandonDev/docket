import type { ShowLive, ShowPress, ShowPressAct, ShowPressAnswer, SlidesShowPush } from '@shared/contract-work-slides'
import { handled, type Handled } from '@shared/work'
import type { Caller, WorkCtx } from '../modules'
import { fenceItem, itemOf, pushFor } from '../pdf/file'

/**
 * The clicker (docs/agents/work-slides.md "The clicker"): a running show driven from any of his own devices. The
 * show runs in one window, which holds its state (renderer show/state.ts); that window tells the deck's host the
 * show's public state with `work.slides.show.run`, a call the host holds until a press comes for it. A clicker
 * reads the state (`work.slides.show.state`, the push `work.slides.show`) and presses (`work.slides.show.press`);
 * the host hands the press to the window, which runs it through the same reducer as a key and answers whether it
 * did. A press made on a state that moved on, or for a show that ended, is dropped and answered as dropped.
 *
 * Kept in memory only: a show is forgotten when its window says it ended, when that window's socket goes while
 * its call waits, or when no call of it has come for `GONE_MS`.
 */

/** How long a window's call waits for a press before it is answered with none (and asked again at once). */
export const RUN_HOLD_MS = 20_000
/** A show whose window has not called for this long is gone. */
export const GONE_MS = 45_000
/** How long a press waits for the window to take it, and then to answer it. */
export const TAKE_MS = 5_000
export const ANSWER_MS = 10_000

export const NOT_A_THREAD = 'A thread never drives a show: a show is his, from his own devices.'
export const NOT_HIS = 'Only his own devices drive a show.'

type Ctx = Pick<WorkCtx, 'canvas' | 'reaches' | 'push' | 'host' | 'dataDir'>

interface Waiter {
  resolve(answer: { press: ShowPress | null }): void
}
interface Pending {
  press: ShowPress
  taken: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  done(answer: ShowPressAnswer): void
}
interface Show {
  showId: string
  itemId: string
  live: Omit<ShowLive, 'showId' | 'itemId'>
  /** when `live` came, by this host's clock: the time he has talked is counted on from it */
  at: number
  waiter: Waiter | null
  pending: Pending[]
  gone: ReturnType<typeof setTimeout> | undefined
}

const shows = new Map<string, Show>()
let seq = 0
let clock: () => number = Date.now

/** A test's clock. */
export const setClickerClock = (now: () => number): void => void (clock = now)

/** The show's state as of now: the time he has talked counted on while the timer runs. */
function liveOf(show: Show): ShowLive {
  const { timer } = show.live
  const elapsed = timer.paused ? timer.elapsed : timer.elapsed + Math.max(0, clock() - show.at)
  return { ...show.live, showId: show.showId, itemId: show.itemId, timer: { ...timer, elapsed } }
}

function tell(ctx: Ctx, show: Show, live: ShowLive | null): void {
  const item = ctx.canvas.get(show.itemId)
  if (!item) return
  ctx.push({ push: 'work.slides.show', itemId: show.itemId, showId: show.showId, live } satisfies SlidesShowPush, pushFor(item))
}

function forget(ctx: Ctx, show: Show): void {
  if (shows.get(show.showId) !== show) return
  shows.delete(show.showId)
  clearTimeout(show.gone)
  show.waiter?.resolve({ press: null })
  show.waiter = null
  for (const p of show.pending.splice(0)) p.done({ dropped: 'ended', live: null })
  tell(ctx, show, null)
}

/** No call of the show's window for `GONE_MS`: the window went without a word. */
function armGone(ctx: Ctx, show: Show): void {
  clearTimeout(show.gone)
  show.gone = setTimeout(() => forget(ctx, show), GONE_MS)
  show.gone.unref?.()
}

/** Hands the first press not yet taken to the waiting call, if there is one of each. */
function hand(show: Show): void {
  const next = show.pending.find((p) => !p.taken)
  if (!next || !show.waiter) return
  next.taken = true
  clearTimeout(next.timer)
  // Taken but never answered: the window went with it.
  next.timer = setTimeout(() => settle(show, next, { dropped: 'ended', live: null }), ANSWER_MS)
  next.timer.unref?.()
  const waiter = show.waiter
  show.waiter = null
  waiter.resolve({ press: next.press })
}

function settle(show: Show, pending: Pending, answer: ShowPressAnswer): void {
  const at = show.pending.indexOf(pending)
  if (at < 0) return
  show.pending.splice(at, 1)
  clearTimeout(pending.timer)
  pending.done(answer)
}

/** Who may: the owner's own window and devices. A thread never; a key that may only read never presses. */
function refuse(by: Caller, press: boolean): void {
  if (by.kind === 'model') throw new Error(NOT_A_THREAD)
  if (press && by.kind === 'remote' && !by.caps.includes('operate')) throw new Error(NOT_HIS)
}

/** The deck a show is of, if the caller could name its file; a show it may not see is as good as none. */
function visible(ctx: Ctx, by: Caller, show: Show): boolean {
  try {
    fenceItem(ctx, by, itemOf(ctx, show.itemId, 'slides'), 'work.slides.show.state')
    return true
  } catch {
    return false
  }
}

export interface RunParams {
  itemId: string
  showId: string
  live: Omit<ShowLive, 'showId' | 'itemId'> | null
  answered?: { seq: number; applied: boolean }
}

/** The window that runs a show: its state, and its wait for the next press. */
export async function runShow(ctx: Ctx, by: Caller, p: RunParams, signal?: AbortSignal): Promise<{ press: ShowPress | null }> {
  refuse(by, true)
  const item = itemOf(ctx, p.itemId, 'slides')
  fenceItem(ctx, by, item, 'work.slides.show.run')
  let show = shows.get(p.showId)
  if (show && show.itemId !== p.itemId) throw new Error('That show is of another deck.')
  if (show && p.answered) {
    const pending = show.pending.find((x) => x.press.seq === p.answered!.seq && x.taken)
    if (pending) settle(show, pending, p.answered.applied ? { applied: true, live: p.live ? { ...p.live, showId: show.showId, itemId: show.itemId } : null } : { dropped: 'moved', live: p.live ? { ...p.live, showId: show.showId, itemId: show.itemId } : null })
  }
  if (!p.live) {
    if (show) forget(ctx, show)
    return { press: null }
  }
  const changed = !show || show.live.rev !== p.live.rev
  if (!show) {
    show = { showId: p.showId, itemId: p.itemId, live: p.live, at: clock(), waiter: null, pending: [], gone: undefined }
    shows.set(p.showId, show)
  } else {
    show.live = p.live
    show.at = clock()
  }
  // A press made on a state the window has since left is dropped before it is ever handed over.
  for (const pending of [...show.pending]) if (!pending.taken && pending.press.rev !== p.live.rev) settle(show, pending, { dropped: 'moved', live: liveOf(show) })
  if (changed) tell(ctx, show, liveOf(show))
  // A newer call of the same show takes the place of the one before.
  show.waiter?.resolve({ press: null })
  show.waiter = null
  clearTimeout(show.gone)
  const mine = show
  return await new Promise<{ press: ShowPress | null }>((resolve) => {
    let over = false
    const end = (answer: { press: ShowPress | null }): void => {
      if (over) return
      over = true
      clearTimeout(hold)
      signal?.removeEventListener('abort', onAbort)
      if (mine.waiter === waiter) mine.waiter = null
      if (shows.get(mine.showId) === mine) armGone(ctx, mine)
      resolve(answer)
    }
    const waiter: Waiter = { resolve: end }
    // The window's socket went while it waited: the show went with it.
    const onAbort = (): void => {
      end({ press: null })
      forget(ctx, mine)
    }
    const hold = setTimeout(() => end({ press: null }), RUN_HOLD_MS)
    hold.unref?.()
    mine.waiter = waiter
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    hand(mine)
  })
}

/** The running shows the caller may see: of one deck, or of every deck. */
export function showStates(ctx: Ctx, by: Caller, itemId?: string): { shows: ShowLive[] } {
  refuse(by, false)
  return { shows: [...shows.values()].filter((s) => (itemId === undefined || s.itemId === itemId) && visible(ctx, by, s)).map(liveOf) }
}

/** A clicker's press: handed to the show's window, and answered with what it did. */
export async function pressShow(ctx: Ctx, by: Caller, p: { showId: string; act: ShowPressAct; at?: number; rev: number }): Promise<ShowPressAnswer> {
  refuse(by, true)
  const show = shows.get(p.showId)
  if (!show || !visible(ctx, by, show)) return { dropped: 'ended', live: null }
  if (p.rev !== show.live.rev) return { dropped: 'moved', live: liveOf(show) }
  if (p.act === 'goto' && p.at === undefined) throw new Error('A jump names a slide by its number.')
  const press: ShowPress = { seq: ++seq, act: p.act, rev: p.rev, ...(p.act === 'goto' ? { at: p.at } : {}) }
  return await new Promise<ShowPressAnswer>((done) => {
    const pending: Pending = { press, taken: false, timer: undefined, done }
    // Not taken in time: the window is not calling, so the press is never handed over late.
    pending.timer = setTimeout(() => settle(show, pending, { dropped: 'ended', live: shows.get(show.showId) === show ? liveOf(show) : null }), TAKE_MS)
    pending.timer.unref?.()
    show.pending.push(pending)
    hand(show)
  })
}

/** Work turned off: every show is forgotten. */
export function stopClicker(ctx: Ctx): void {
  for (const show of [...shows.values()]) forget(ctx, show)
}

/** The clicker's three methods, before the module fences an item of its own (they name a show, or no deck at all). */
export async function clickerHandle(req: { method: string; params?: unknown }, ctx: Ctx, by: Caller, signal?: AbortSignal): Promise<Handled | null> {
  switch (req.method) {
    case 'work.slides.show.run':
      return handled(await runShow(ctx, by, req.params as RunParams, signal))
    case 'work.slides.show.state':
      return handled(showStates(ctx, by, (req.params as { itemId?: string }).itemId))
    case 'work.slides.show.press':
      return handled(await pressShow(ctx, by, req.params as { showId: string; act: ShowPressAct; at?: number; rev: number }))
  }
  return null
}
