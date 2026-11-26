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
  const p = window.__perf = { armed: false, region: 'body', usableIf: null, pressed: 0, first: 0, usable: 0, longest: 0, stop: null };
  const stamp = () => { if (p.armed && !p.pressed) p.pressed = performance.now(); };
  for (const type of ['pointerdown', 'keydown']) addEventListener(type, stamp, true);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (p.pressed && !p.usable && entry.startTime + entry.duration >= p.pressed) p.longest = Math.max(p.longest, entry.duration);
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
  p.arm = (region, usableIf) => {
    p.stop?.();
    Object.assign(p, { armed: true, region, usableIf, pressed: 0, first: 0, usable: 0, longest: 0 });
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
  p.read = () => ({ pressed: p.pressed, first: p.first ? p.first - p.pressed : null, usable: p.usable ? p.usable - p.pressed : null, longest: p.longest });
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

/** One frame, counted. Pure: scripts/perf/perf.test.ts drives it. */
export function countFrame(counts: Counts, kind: SocketKind, sent: boolean, payload: string): void {
  if (kind === 'box') {
    if (sent) counts.up += payload.length
    else counts.down += payload.length
    if (!sent || !payload.startsWith('{')) return
    try {
      const method = (JSON.parse(payload) as { method?: unknown }).method
      if (typeof method !== 'string') return
      counts.t[method] = (counts.t[method] ?? 0) + 1
      counts.tAll += 1
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

  constructor(page: Window, kindOf: (url: string) => SocketKind) {
    page.tap((method, params) => {
      if (method === 'Network.webSocketCreated') {
        const { requestId, url } = params as { requestId: string; url: string }
        this.sockets.set(requestId, kindOf(url))
      } else if (method === 'Network.webSocketClosed') {
        this.sockets.delete((params as { requestId: string }).requestId)
      } else if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
        const { requestId, response } = params as { requestId: string; response?: { payloadData?: string } }
        countFrame(this.counts, this.sockets.get(requestId) ?? 'other', method.endsWith('Sent'), response?.payloadData ?? '')
      }
    })
  }

  /** The counts since the last take, then zero. */
  take(): Counts {
    const was = this.counts
    this.counts = zero()
    return was
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
  /** asks up to usable */
  counts: Counts
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
  const wire = link?.reset()
  const asked = lifeosLink?.resetClasses()
  const read = await page.eval<{ first: number | null; usable: number | null; longest: number }>('window.__perf.read()')
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const after = counter.take()
  await page.eval('window.__perf.stop?.()')
  return { first: read.first, usable: read.usable, longest: Math.round(read.longest), counts, after, ...(wire ? { wire: { up: wire.up, down: wire.down, turns: wire.turns } } : {}), ...(asked ? { lifeos: { window: asked.window?.turns ?? 0, host: asked.host?.turns ?? 0 } } : {}), ...(error ? { error } : {}) }
}

/** The middle of three (or of however many ran): by usable time, an unfinished press last. */
export function middle(samples: Sample[]): Sample | undefined {
  const order = [...samples].sort((a, b) => (a.usable ?? Infinity) - (b.usable ?? Infinity))
  return order[Math.floor((order.length - 1) / 2)]
}
