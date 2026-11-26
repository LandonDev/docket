/**
 * What the perf kit reads from a window, without touching the product:
 *
 *  - In the page (`PROBE`, put there over CDP): "pressed" is stamped by a capture-phase listener on the first
 *    pointer or key event after a row arms it; "first sign" is the first DOM change inside the row's region after
 *    that; "usable" is the row's own predicate, tried on every animation frame. The longest task between pressed
 *    and usable comes from a PerformanceObserver. All three are the page's own clock, so the driver's polling
 *    adds nothing to them.
 *  - From CDP's Network domain (`Counter`): every WebSocket frame the window sends or gets, by socket. A frame
 *    with a `method` on the link to `box` is one round trip to the host (T), counted by method; a frame the
 *    window sends on LifeOS's socket is one round trip to LifeOS (C); bytes are counted both ways. These are the
 *    frames' own bytes, before the socket deflates them: the shaped link (scripts/lib/slowLink.ts) counts the wire.
 */
import type { Window } from '../../journeys/lib/window'

/** What draws while a view has no rows yet: any of these inside a region means it is not usable. */
export const BONES = [
  '[aria-busy="true"]', '[data-slot="skeleton"]', '[data-canvas-skeleton]', '[data-files-skeleton]', '[data-slides-skeleton]',
  '[data-files-bar-bones]', '[data-tasks-bones]', '[data-agenda-bones]', '[data-pdf-bones]', '[data-today-bone]', '[data-money-bone]', '[data-media-loading]'
].join(', ')

export const PROBE = `(() => {
  if (window.__perf) return;
  const p = window.__perf = { armed: false, region: 'body', usableIf: null, pressed: 0, first: 0, usable: 0, longest: 0, longestAfter: 0, tasksAfter: 0, stop: null };
  const stamp = () => { if (p.armed && !p.pressed) p.pressed = performance.now(); };
  for (const type of ['pointerdown', 'keydown']) addEventListener(type, stamp, true);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (p.pressed && !p.usable && entry.startTime + entry.duration >= p.pressed) p.longest = Math.max(p.longest, entry.duration);
        else if (p.usable && entry.startTime >= p.usable) { p.longestAfter = Math.max(p.longestAfter, entry.duration); if (entry.duration > 100) p.tasksAfter++; }
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
  p.arm = (region, usableIf) => {
    p.stop?.();
    Object.assign(p, { armed: true, region, usableIf, pressed: 0, first: 0, usable: 0, longest: 0, longestAfter: 0, tasksAfter: 0 });
    const inside = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest(region);
    const seen = new MutationObserver((changes) => {
      if (p.pressed && !p.first && changes.some((change) => inside(change.target))) p.first = performance.now();
    });
    seen.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    let live = true;
    p.stop = () => { live = false; seen.disconnect(); };
    const tick = () => {
      if (!live) return;
      if (p.pressed && !p.usable) {
        let ok = false;
        try { ok = !!usableIf(); } catch {}
        if (ok) { p.usable = performance.now(); if (!p.first) p.first = p.usable; p.armed = false; p.stop(); return; }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  p.read = () => ({ pressed: p.pressed, first: p.first ? p.first - p.pressed : null, usable: p.usable ? p.usable - p.pressed : null, longest: p.longest, longestAfter: p.longestAfter, tasksAfter: p.tasksAfter });
  // A region is usable once it is drawn, holds words, and draws no bones.
  p.settled = (selector) => {
    const el = [...document.querySelectorAll(selector)].find((e) => e.getClientRects().length && !e.closest('[inert], [aria-hidden="true"]'));
    return !!el && !el.matches(${JSON.stringify(BONES)}) && !el.querySelector(${JSON.stringify(BONES)}) && (el.innerText ?? '').trim().length > 0;
  };
})()`

export type SocketKind = 'box' | 'lifeos' | 'own' | 'other'
export interface Counts {
  /** round trips to the host over the link, by method */
  t: Record<string, number>
  tAll: number
  /** frames the window sent LifeOS */
  c: number
  /** the frames' own bytes, window to box and box to window */
  up: number
  down: number
}

const zero = (): Counts => ({ t: {}, tAll: 0, c: 0, up: 0, down: 0 })

/** Convex's keep-alives and transition acks are not asks of his. */
const LIFEOS_ASKS = new Set(['ModifyQuerySet', 'Mutation', 'Action', 'Authenticate', 'Connect'])

/** One ask's key for the twice-asked detector: its method and its params, the request id left out. */
export const askKey = (method: string, params: unknown): string => params === undefined ? method : `${method} ${JSON.stringify(params)}`

/** The asks a press made more than once with the same params (D03: none twice), each with its count. Pure. */
export function askedTwice(asks: ReadonlyMap<string, number>): string[] {
  return [...asks].filter(([, n]) => n > 1).map(([key, n]) => `${n}× ${key}`)
}

/**
 * One frame, counted. `asks`, where given, counts each request by method and params (askKey). Pure:
 * scripts/perf/perf.test.ts drives it.
 */
export function countFrame(counts: Counts, kind: SocketKind, sent: boolean, payload: string, asks?: Map<string, number>): void {
  if (kind === 'box') {
    if (sent) counts.up += payload.length
    else counts.down += payload.length
    if (!sent || !payload.startsWith('{')) return
    try {
      const frame = JSON.parse(payload) as { method?: unknown; params?: unknown }
      const method = frame.method
      if (typeof method !== 'string') return
      counts.t[method] = (counts.t[method] ?? 0) + 1
      counts.tAll += 1
      if (asks) {
        const key = askKey(method, frame.params)
        asks.set(key, (asks.get(key) ?? 0) + 1)
      }
    } catch {
      // not a request frame
    }
  } else if (kind === 'lifeos' && sent && payload.startsWith('{')) {
    try {
      if (LIFEOS_ASKS.has(String((JSON.parse(payload) as { type?: unknown }).type))) counts.c += 1
    } catch {
      // not a Convex message
    }
  }
}

/** Counts a window's frames by socket. `kindOf` reads a socket's URL: the link to box, LifeOS, the window's own host. */
export class Counter {
  private readonly sockets = new Map<string, SocketKind>()
  private counts = zero()
  /** Each ask by method and params since the last take; `twice()` reads the one taken last. */
  private asks = new Map<string, number>()
  private taken = new Map<string, number>()

  constructor(page: Window, kindOf: (url: string) => SocketKind) {
    page.tap((method, params) => {
      if (method === 'Network.webSocketCreated') {
        const { requestId, url } = params as { requestId: string; url: string }
        this.sockets.set(requestId, kindOf(url))
      } else if (method === 'Network.webSocketClosed') {
        this.sockets.delete((params as { requestId: string }).requestId)
      } else if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
        const { requestId, response } = params as { requestId: string; response?: { payloadData?: string } }
        countFrame(this.counts, this.sockets.get(requestId) ?? 'other', method.endsWith('Sent'), response?.payloadData ?? '', this.asks)
      }
    })
  }

  /** The counts since the last take, then zero. */
  take(): Counts {
    const was = this.counts
    this.counts = zero()
    this.taken = this.asks
    this.asks = new Map()
    return was
  }

  /** The asks of the counts taken last that went out more than once with the same params. */
  twice(): string[] {
    return askedTwice(this.taken)
  }

  /** The counts so far, kept counting. */
  peek(): Counts {
    return { ...this.counts, t: { ...this.counts.t } }
  }
}

export interface Sample {
  /** pressed to the first change in the region, ms */
  first: number | null
  /** pressed to usable, ms; null when the row never became usable in its wait */
  usable: number | null
  /** the longest task between the two, ms */
  longest: number
  /** the longest task in the watch after usable (a row's `settle`), ms, and how many passed 100 ms: a freeze that follows an open */
  longestAfter?: number
  tasksAfter?: number
  /** asks up to usable */
  counts: Counts
  /** the asks up to usable sent more than once with the same params, as `<n>× <method> <params>` (D03: none twice) */
  twice?: string[]
  /** pressed to the shown thread's `session.events` ask leaving the page, ms (D07) */
  askAt?: number
  /** a picker's typing phase: each key to its rows, ms (null: its rows never changed), and the host asks each key sent */
  keyMs?: (number | null)[]
  asksPerKey?: number[]
  /** asks in the second after usable: what goes on behind the paint */
  after: Counts
  /** the wire's own bytes and round trips, where the link is shaped */
  wire?: { up: number; down: number; turns: number }
  /** round trips to LifeOS up to usable, by who asked, where the sandbox sits behind its hop: the window, and the host on its own */
  lifeos?: { window: number; host: number }
  error?: string
}

export interface MeasureOptions {
  /** the selector whose first change is the first sign */
  region: string
  /** a JavaScript expression, true once he can use it; `settled(sel)` is the usual one */
  usable: string
  /** the press itself: one click or key through CDP */
  press: () => Promise<void>
  /** how long to wait for usable */
  wait?: number
  /** how long to keep watching after usable, ms (1000): the asks and the long tasks behind the paint */
  settle?: number
}

export const settled = (selector: string): string => `window.__perf.settled(${JSON.stringify(selector)})`

/** One timed press. */
export async function measure(
  page: Window, counter: Counter, link: { reset(): { up: number; down: number; turns: number } } | undefined, options: MeasureOptions,
  lifeosLink?: { resetClasses(): Record<string, { turns: number }> }
): Promise<Sample> {
  await page.eval(PROBE)
  await page.eval(`window.__perf.arm(${JSON.stringify(options.region)}, () => (${options.usable}))`)
  counter.take()
  link?.reset()
  lifeosLink?.resetClasses()
  let error: string | undefined
  try {
    await options.press()
    await page.until('usable', options.wait ?? 30_000, () => page.eval('window.__perf.usable > 0'))
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }
  const counts = counter.take()
  const twice = counter.twice()
  const wire = link?.reset()
  const asked = lifeosLink?.resetClasses()
  await new Promise((resolve) => setTimeout(resolve, options.settle ?? 1000))
  const after = counter.take()
  const read = await page.eval<{ first: number | null; usable: number | null; longest: number; longestAfter: number; tasksAfter: number }>('window.__perf.read()')
  await page.eval('window.__perf.stop?.()')
  return { first: read.first, usable: read.usable, longest: Math.round(read.longest), ...(twice.length ? { twice } : {}), ...(options.settle ? { longestAfter: Math.round(read.longestAfter), tasksAfter: read.tasksAfter } : {}), counts, after, ...(wire ? { wire: { up: wire.up, down: wire.down, turns: wire.turns } } : {}), ...(asked ? { lifeos: { window: asked.window?.turns ?? 0, host: asked.host?.turns ?? 0 } } : {}), ...(error ? { error } : {}) }
}

/** The middle of three (or of however many ran): by usable time, an unfinished press last. */
export function middle(samples: Sample[]): Sample | undefined {
  const order = [...samples].sort((a, b) => (a.usable ?? Infinity) - (b.usable ?? Infinity))
  return order[Math.floor((order.length - 1) / 2)]
}
