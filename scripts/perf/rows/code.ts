/**
 * The rest of Docket, in his shape (`bun run perf --family code`): a window paired to a box that holds a plain
 * workspace on a scratch repo and the seeded threads (scripts/perf/seed-box.ts), 40 plain threads streaming beside.
 * Each row is one thing he does outside Work; `scripts/perf/budgets.ts` (D, G and L) says which budget it times.
 */
import { SEED_CHILDREN, SEED_MASTER, SEED_SHORT, SEED_THREADS, SEED_WORKSPACE } from '../lib/seedNames'
import { thrice, type PerfCtx, type Row } from '../lib/row'
import type { Sample } from '../lib/probe'

const RAIL = 'nav [data-rail-path] button'
const boxHost = (ctx: PerfCtx): string => JSON.stringify(ctx.pair.box.host)

/** A thread's pane with rows he can read: mounted, on screen, not loading, rows drawn. */
export const paneReady = (id: string): string => `(() => {
  const pane = document.querySelector('[data-session-drop=${JSON.stringify(id)}]');
  // A parked tab keeps its box under content-visibility: hidden, which checkVisibility sees.
  return !!pane && pane.getClientRects().length > 0 && pane.checkVisibility() && !pane.closest('[inert], [aria-hidden="true"]')
    && !pane.querySelector('[data-transcript-loading], [data-transcript-empty]') && pane.querySelectorAll('[data-row]').length > 0;
})()`

/**
 * A rail or column row by its spoken name: a row's label is its name, then what it is doing (", unread",
 * ", working", workspaceRowAriaLabel in ProjectRail.tsx), so a name is matched whole or before a comma.
 */
const named = (selector: string, name: string): string => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => {
  const label = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
  return (label === ${JSON.stringify(name)} || label.startsWith(${JSON.stringify(name + ',')})) && b.getClientRects().length && !b.closest('[inert], [aria-hidden="true"]');
})`

/** Clicks a row found by `named`, scrolled into view first, as he would. */
async function clickNamed(ctx: PerfCtx, selector: string, name: string): Promise<void> {
  const at = await ctx.page.eval<{ x: number; y: number } | null>(`(() => {
    const row = ${named(selector, name)};
    if (!row) return null;
    row.scrollIntoView({ block: 'nearest' });
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  if (!at) throw new Error(`No row "${name}" (${selector})`)
  await ctx.page.click(at)
}

/** The workspace selected in the rail. */
const current = (name: string): string => `!!${named(RAIL + '[aria-current="true"]', name)}`

/**
 * A thread's tab in the title bar's strip. A code workspace's column lists a project as one card whose lines are
 * words, not rows: its threads open from the strip, where each holds a tab (`data-menu-id` is the thread's id).
 */
const tabOf = (id: string): string => `[...document.querySelectorAll(${JSON.stringify(`[data-menu-id=${JSON.stringify(id)}] [role="tab"]`)})]
  .find((t) => t.getClientRects().length && !t.closest('[inert], [aria-hidden="true"]'))`

/** The seeded workspace shown in the rail, with the thread's tab in the strip. */
export async function shownCode(ctx: PerfCtx, thread: { id: string; title: string } = SEED_THREADS.long): Promise<void> {
  const page = ctx.page
  await page.dismissPopups()
  if (!await page.eval(current(SEED_WORKSPACE))) await clickNamed(ctx, RAIL, SEED_WORKSPACE)
  await page.until(`${thread.title}'s tab`, 30_000, () => page.eval(`!!${tabOf(thread.id)}`))
}

/** Clicks a thread's tab, the strip scrolled to it first, as he would. */
export const pressThread = (ctx: PerfCtx, thread: { id: string; title: string }) => async (): Promise<void> => {
  const at = await ctx.page.eval<{ x: number; y: number; covered: string | null } | null>(`(() => {
    const tab = ${tabOf(thread.id)};
    if (!tab) return null;
    // To the strip's middle: at its edge the strip's scroll arrows cover a tab.
    tab.scrollIntoView({ block: 'nearest', inline: 'center' });
    const r = tab.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const under = document.elementFromPoint(x, y);
    return { x, y, covered: tab.contains(under) ? null : (under?.getAttribute('aria-label') ?? under?.tagName ?? 'nothing') };
  })()`)
  if (!at) throw new Error(`No tab for "${thread.title}"`)
  if (at.covered) throw new Error(`The tab for "${thread.title}" is under ${at.covered}`)
  await ctx.page.click(at)
}

/** The window's document started again and linked to box: every thread is unseen once more. */
export async function fresh(ctx: PerfCtx): Promise<void> {
  await ctx.page.reload()
  await ctx.page.until('the window link to box again', 60_000, () => ctx.page.eval(
    `window.__docket?.registry.has(${boxHost(ctx)}) && window.__docket.registry.statusOf(${boxHost(ctx)}).transport === 'open'`))
}

/** D04, D05: a box thread not yet seen, from the rail, and the 15 s after it. */
const threadOpenFar: Row = {
  id: 'thread-open-far',
  family: 'code',
  title: 'Open the 30,000-row box thread from the rail, never seen by this window; then watch 15 s for a freeze',
  run: (ctx) => thrice(ctx, () => ({
    region: 'main',
    usable: paneReady(SEED_THREADS.long.id),
    press: pressThread(ctx, SEED_THREADS.long),
    settle: 15_000,
    wait: 60_000
  }), () => coldLong(ctx))
}

/** D08: back and forth between two threads both seen. */
/** Whatever thread pane is on screen, drawn: its rows, or a master's board. */
const shownPaneReady = `(() => {
  const pane = [...document.querySelectorAll('[data-session-drop]')].find((p) => p.getClientRects().length && p.checkVisibility() && !p.closest('[inert], [aria-hidden="true"]'));
  if (!pane) return false;
  return (!pane.querySelector('[data-transcript-loading], [data-transcript-empty]') && pane.querySelectorAll('[data-row]').length > 0)
    || pane.querySelectorAll('[data-board-pane] > [data-group]').length > 0;
})()`

const threadSwitch: Row = {
  id: 'thread-switch',
  family: 'code',
  title: 'Switch between two threads this window has seen (a rail row)',
  run: async (ctx) => {
    const [a, b] = [SEED_SHORT[0]!, SEED_SHORT[1]!]
    await shownCode(ctx, a)
    for (const thread of [a, b, a]) {
      await pressThread(ctx, thread)()
      await ctx.page.until(thread.title + ' drawn', 30_000, () => ctx.page.eval(paneReady(thread.id)))
    }
    return thrice(ctx, (i) => {
      const to = i % 2 ? a : b
      return { region: 'main', usable: paneReady(to.id), press: pressThread(ctx, to) }
    })
  }
}

/** D09: the other workspace and back, each with a thread shown. */
const projectSwitch: Row = {
  id: 'project-switch',
  family: 'code',
  title: 'Switch to another workspace of the box and back to a thread seen',
  run: async (ctx) => {
    const thread = SEED_SHORT[0]!
    await shownCode(ctx, thread)
    await pressThread(ctx, thread)()
    await ctx.page.until(thread.title + ' drawn', 30_000, () => ctx.page.eval(paneReady(thread.id)))
    return thrice(ctx, () => ({
      region: 'main, nav',
      // The window returns to a thread of its own choosing (it has gone back to the pinned master's board): the
      // workspace is usable once whatever pane it shows is drawn.
      usable: `${current(SEED_WORKSPACE)} && ${shownPaneReady}`,
      press: () => clickNamed(ctx, RAIL, SEED_WORKSPACE)
    }), async () => {
      await clickNamed(ctx, RAIL, ctx.other.name)
      await ctx.page.until('the other workspace', 20_000, () => ctx.page.eval(current(ctx.other.name)))
    })
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const linkOpen = (ctx: PerfCtx): string =>
  `window.__docket?.registry.has(${boxHost(ctx)}) && window.__docket.registry.statusOf(${boxHost(ctx)}).transport === 'open'`

/** A thread shown with its rows drawn: pressed in the rail unless it is already on screen. */
async function showThread(ctx: PerfCtx, thread: { id: string; title: string }): Promise<void> {
  await shownCode(ctx, thread)
  if (!await ctx.page.eval(paneReady(thread.id))) await pressThread(ctx, thread)()
  await ctx.page.until(thread.title + ' drawn', 30_000, () => ctx.page.eval(paneReady(thread.id)))
}

/**
 * A tap on the page's sockets, measuring code put in by the rows (never the product): `drop(id)` makes the answer to
 * the next `session.events` ask for that thread vanish before the window's code reads it, the socket kept open and
 * every other frame passed (D06: one answer lost); `stamp(id)` notes when that ask leaves the page, on the page's clock
 * (D07). It wraps `WebSocket.prototype.send` and the `onmessage` setter, so it must run before the window's link is
 * made for a drop (a script for new documents) and may run at any time for a stamp. Pure in the page's globals:
 * scripts/perf/perf.test.ts drives it with a stand-in socket.
 */
export const WIRE_TAP = `(() => {
  if (window.__perfWire) return;
  const w = window.__perfWire = { target: null, dropId: null, dropped: 0, stampFor: null, sentAt: 0,
    drop(id) { w.target = id; w.dropId = null; w.dropped = 0; },
    stamp(id) { w.stampFor = id; w.sentAt = 0; } };
  const proto = WebSocket.prototype;
  const send = proto.send;
  proto.send = function (data) {
    if (typeof data === 'string' && (w.target || w.stampFor) && data.includes('"session.events"')) {
      try {
        const frame = JSON.parse(data);
        const id = frame.method === 'session.events' ? frame.params?.sessionId : null;
        if (id && id === w.stampFor && !w.sentAt) w.sentAt = performance.now();
        if (id && id === w.target) { w.dropId = String(frame.id); w.target = null; }
      } catch {}
    }
    return send.call(this, data);
  };
  const handler = Object.getOwnPropertyDescriptor(proto, 'onmessage');
  Object.defineProperty(proto, 'onmessage', {
    configurable: true,
    enumerable: handler.enumerable,
    get() { return handler.get.call(this); },
    set(fn) {
      handler.set.call(this, typeof fn !== 'function' ? fn : function (event) {
        if (w.dropId !== null && typeof event.data === 'string' && event.data.includes('"' + w.dropId + '"')) {
          try {
            if (String(JSON.parse(event.data).id) === w.dropId) { w.dropId = null; w.dropped = performance.now(); return; }
          } catch {}
        }
        return fn.call(this, event);
      });
    }
  });
})()`

/** D01, D03: the window's document from its start to the rail whole and the shown long thread's rows drawn. */
const launchCode: Row = {
  id: 'launch-code',
  family: 'code',
  title: "The window's document from its start to usable: the rail whole and the shown 30,000-row thread's rows drawn (a reload: the main process is up); its asks to usable, and any asked twice",
  run: async (ctx) => {
    const long = SEED_THREADS.long
    await showThread(ctx, long)
    // Put in each new document before the window's own code: painted, the rail whole (main.tsx's tc:rail-complete),
    // usable, and the longest task before it.
    const watch = `(() => {
      const boot = window.__perfBoot = { usable: 0, painted: 0, rail: 0, longest: 0 };
      try {
        new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!boot.usable) boot.longest = Math.max(boot.longest, e.duration); })
          .observe({ entryTypes: ['longtask'] });
      } catch {}
      const look = () => {
        if (boot.usable) return;
        boot.painted ||= performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0;
        boot.rail ||= performance.getEntriesByName('tc:rail-complete')[0]?.startTime ?? 0;
        let ok = false;
        try { ok = boot.rail > 0 && ${paneReady(long.id)}; } catch {}
        if (ok) boot.usable = performance.now(); else requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    })()`
    await ctx.page.send('Page.enable')
    const { identifier } = await ctx.page.send('Page.addScriptToEvaluateOnNewDocument', { source: watch }) as { identifier: string }
    try {
      const samples: Sample[] = []
      for (let i = 0; i < 3; i++) {
        ctx.counter.take()
        ctx.pair.windowLink?.reset()
        await ctx.page.reload()
        let error: string | undefined
        await ctx.page.until('the window usable again', 60_000, () => ctx.page.eval('window.__perfBoot?.usable > 0')).catch((cause) => { error = String(cause?.message ?? cause) })
        const boot = await ctx.page.eval<{ usable: number; painted: number; longest: number }>('window.__perfBoot')
        const counts = ctx.counter.take()
        const twice = ctx.counter.twice()
        const wire = ctx.pair.windowLink?.reset()
        await sleep(1000)
        samples.push({
          first: boot.painted ? Math.round(boot.painted) : null, usable: boot.usable ? Math.round(boot.usable) : null, longest: Math.round(boot.longest),
          ...(twice.length ? { twice } : {}), counts, after: ctx.counter.take(),
          ...(wire ? { wire: { up: wire.up, down: wire.down, turns: wire.turns } } : {}), ...(error ? { error } : {})
        })
        if (!boot.usable) break
      }
      return samples
    } finally {
      await ctx.page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
    }
  }
}

/** Back to a document that has never seen the long thread, a short one shown (the window restores what it showed). */
async function coldLong(ctx: PerfCtx): Promise<void> {
  await showThread(ctx, SEED_SHORT[0]!)
  await fresh(ctx)
  await showThread(ctx, SEED_SHORT[0]!)
}

/**
 * D06: the cold open of thread-open-far with its first transcript answer lost. WIRE_TAP drops the answer to the
 * first `session.events` ask for the thread after the click, in the page, before the window's code reads it; the
 * socket stays open and every other frame passes. It models an answer that never comes back on a live link (lost
 * by a hop, or held past its deadline), the case the window's request deadline and the store's retry decide: today
 * that is the 30 s deadline, then a retry a second later. A cut or a blackhole would model a dead link instead, which
 * the link's own reconnect answers (L02, L04). Recorded, never asserted.
 */
const threadOpenLost: Row = {
  id: 'thread-open-lost',
  family: 'code',
  title: 'Open the 30,000-row box thread never seen, its first transcript answer lost on a live socket (dropped in the page), to rows drawn',
  run: async (ctx) => {
    const long = SEED_THREADS.long
    await ctx.page.send('Page.enable')
    const { identifier } = await ctx.page.send('Page.addScriptToEvaluateOnNewDocument', { source: WIRE_TAP }) as { identifier: string }
    try {
      const samples: Sample[] = []
      for (let i = 0; i < 3; i++) {
        await coldLong(ctx)
        await ctx.page.eval(`window.__perfWire.drop(${JSON.stringify(long.id)})`)
        const sample = await ctx.time({ region: 'main', usable: paneReady(long.id), press: pressThread(ctx, long), wait: 45_000 })
        const dropped = await ctx.page.eval<boolean>('window.__perfWire.dropped > 0')
        samples.push(dropped ? sample : { ...sample, error: [sample.error, 'no answer was dropped: the open asked no session.events for the thread'].filter(Boolean).join('; ') })
        if (sample.usable === null) break
      }
      return samples
    } finally {
      await ctx.page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
    }
  }
}

/**
 * D07: the link cut for 3 s while seven threads are kept, then the never-seen long thread clicked the moment the link
 * is open again, while the window catches its kept threads up. Click to rows, and click to its `session.events` ask
 * leaving the page (`askAt`, WIRE_TAP's stamp on the page's clock).
 */
const threadOpenCatchup: Row = {
  id: 'thread-open-catchup',
  family: 'code',
  title: 'Open the 30,000-row box thread never seen, clicked as the link comes back from a 3 s cut with seven threads kept; click to its ask and to rows',
  run: async (ctx) => {
    const long = SEED_THREADS.long
    const samples: Sample[] = []
    for (let i = 0; i < 3; i++) {
      await coldLong(ctx)
      // Threads he has open, each with a transcript to catch up after the cut.
      for (const thread of [SEED_THREADS.chat, ...SEED_SHORT.slice(1), SEED_SHORT[0]!]) await showThread(ctx, thread)
      await ctx.page.eval(WIRE_TAP)
      ctx.pair.cutWindowLink(true)
      await sleep(3000)
      ctx.pair.cutWindowLink(false)
      await ctx.page.until('the link open again', 60_000, () => ctx.page.eval(linkOpen(ctx)))
      await ctx.page.eval(`window.__perfWire.stamp(${JSON.stringify(long.id)})`)
      const sample = await ctx.time({ region: 'main', usable: paneReady(long.id), press: pressThread(ctx, long), wait: 30_000 })
      const askAt = await ctx.page.eval<number | null>('(() => { const w = window.__perfWire, p = window.__perf; return w.sentAt && p.pressed ? w.sentAt - p.pressed : null; })()')
      samples.push({ ...sample, ...(askAt !== null ? { askAt: Math.round(askAt) } : {}) })
      if (sample.usable === null) break
    }
    return samples
  }
}

/** The master's board drawn: its pane on screen, rows in it, and the board's screen filled (or all 30 drawn). */
export const boardDrawn = (id: string, rows: number): string => `(() => {
  const pane = document.querySelector('[data-session-drop=${JSON.stringify(id)}]');
  if (!pane || !pane.getClientRects().length || !pane.checkVisibility() || pane.closest('[inert], [aria-hidden="true"]')) return false;
  const scroller = pane.querySelector('[data-board-scroller]');
  const drawn = [...(pane.querySelectorAll('[data-board-pane] > [data-group]'))];
  if (!scroller || !drawn.length) return false;
  if (drawn.length >= ${rows}) return true;
  return Math.max(...drawn.map((row) => row.getBoundingClientRect().bottom)) >= scroller.getBoundingClientRect().bottom - 1;
})()`

/** D10: the pinned master's board of 30 children from the rail; the first press in a document that never saw it. */
const boardOpen: Row = {
  id: 'board-open',
  family: 'code',
  title: "Open a pinned master's board of 30 children from the rail (the first press cold, the next two back from another thread)",
  run: (ctx) => thrice(ctx, () => ({
    region: 'main',
    usable: boardDrawn(SEED_MASTER.id, SEED_CHILDREN.length),
    press: pressThread(ctx, SEED_MASTER)
  }), async (i) => {
    if (i === 0) await fresh(ctx)
    await showThread(ctx, SEED_SHORT[0]!)
  })
}

interface Picker {
  id: string
  title: string
  /** the picker's rows: their first change after a key is its first sign */
  region: string
  /** open, true once its first rows are drawn */
  shown: string
  /** the press that opens it */
  open(ctx: PerfCtx): Promise<void>
  /** closes it and waits until it is gone */
  close(ctx: PerfCtx): Promise<void>
  /** the five keys typed */
  query: string
  /** true once the rows for what is typed so far are drawn */
  ready(typed: string): string
}

const shownIn = (selector: string): string =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].some((el) => el.getClientRects().length && !el.closest('[inert], [aria-hidden="true"], [data-ending-style]'))`
const gone = async (ctx: PerfCtx, what: string, selector: string): Promise<void> =>
  ctx.page.until(what + ' closed', 10_000, async () => !await ctx.page.eval(shownIn(selector)))

/**
 * D16: five keys typed one at a time, each timed from its key to the rows for what is typed so far (the region's first
 * change, then the picker's own test), with the host asks each key sent up to 150 ms after its rows.
 */
async function typing(ctx: PerfCtx, picker: Picker): Promise<Pick<Sample, 'keyMs' | 'asksPerKey'>> {
  const keyMs: (number | null)[] = []
  const asksPerKey: number[] = []
  for (let i = 0; i < picker.query.length; i++) {
    const sample = await ctx.time({
      region: picker.region,
      usable: `window.__perf.first > 0 && (${picker.ready(picker.query.slice(0, i + 1))})`,
      press: () => ctx.page.key(picker.query[i]!),
      wait: 5000,
      settle: 150
    })
    keyMs.push(sample.usable === null ? null : Math.round(sample.usable))
    asksPerKey.push(sample.counts.tAll + sample.after.tAll)
  }
  return { keyMs, asksPerKey }
}

/** D15, D16: a picker opened three times inside 30 s from a short thread of the 20,000-file project, then typed in. */
const picker = (p: Picker): Row => ({
  id: p.id,
  family: 'code',
  title: p.title,
  run: async (ctx) => {
    await showThread(ctx, SHOWN)
    const samples = await thrice(ctx, () => ({ region: p.region, usable: p.shown, press: () => p.open(ctx) }), async (i) => {
      if (i > 0) await p.close(ctx)
    })
    try {
      if (samples.length === 3 && samples.every((sample) => sample.usable !== null)) Object.assign(samples[2]!, await typing(ctx, p))
    } finally {
      await p.close(ctx)
    }
    return samples
  }
})

const valueOf = (selector: string): string => `(document.querySelector(${JSON.stringify(selector)})?.value ?? '')`
const rowsIn = (selector: string): string => `document.querySelectorAll(${JSON.stringify(selector)}).length > 0`

const SEARCH = '[data-app-search]'
const pickerSearch = picker({
  id: 'picker-search',
  title: 'Open Search (Ctrl+K) to its field ready; then type "folds", a key at a time',
  region: '[data-search-results]',
  shown: `${shownIn(SEARCH)} && !!document.activeElement?.closest(${JSON.stringify(SEARCH)})`,
  open: (ctx) => ctx.page.key('Control+k'),
  close: async (ctx) => {
    if (await ctx.page.eval(shownIn(SEARCH))) await ctx.page.key('Escape')
    await gone(ctx, 'Search', SEARCH)
  },
  query: 'folds',
  ready: (typed) => `${valueOf(SEARCH + ' input')} === ${JSON.stringify(typed)} && !document.querySelector('${SEARCH} [aria-label="Searching"]')`
})

const FILES = '[data-file-picker]'
const pickerFile = picker({
  id: 'picker-file',
  // It draws no rows before a key ("Type a file name to search"): open is to its list in hand, not "Indexing files…".
  title: 'Open Go to File (Ctrl+P) in the 20,000-file project to its list in hand; then type "12345", a key at a time',
  region: FILES,
  shown: `${shownIn(FILES)} && !!document.activeElement?.closest(${JSON.stringify(FILES)}) && !document.querySelector(${JSON.stringify(FILES)}).innerText.includes('Indexing files')`,
  open: (ctx) => ctx.page.key('Control+p'),
  close: async (ctx) => {
    if (await ctx.page.eval(shownIn(FILES))) await ctx.page.key('Escape')
    await gone(ctx, 'Go to File', FILES)
  },
  query: '12345',
  ready: (typed) => `${valueOf(FILES + ' input')} === ${JSON.stringify(typed)} && ${rowsIn(FILES + ' [role="option"]')}`
})

/** The composer and its model button in the shown thread's pane (another pane may hold a hidden one). */
const SHOWN = SEED_SHORT[0]!
const inPane = (selector: string): string => `[data-session-drop=${JSON.stringify(SHOWN.id)}] ${selector}`
const MENTIONS = '[data-command-popover]'
const MENTION_ROWS = MENTIONS + ' [role="option"]:not([data-command-empty]):not([data-command-note])'
const COMPOSER = inPane('[data-composer-input]')
const inComposer = `!!document.activeElement?.closest(${JSON.stringify(COMPOSER)})`
const composerText = `(document.activeElement?.closest(${JSON.stringify(COMPOSER)})?.textContent ?? '')`
const pickerAt = picker({
  id: 'picker-at',
  title: "The composer's @ in the 20,000-file project, to its first rows; then type \"12345\", a key at a time",
  region: MENTIONS,
  shown: `${shownIn(MENTIONS)} && ${rowsIn(MENTION_ROWS)}`,
  open: async (ctx) => {
    if (!await ctx.page.eval(inComposer)) await ctx.page.clickOn(COMPOSER)
    await ctx.page.key('@')
  },
  close: async (ctx) => {
    // The typed words go too: a draft left in the composer would follow the next row.
    if (await ctx.page.eval(inComposer)) {
      await ctx.page.key('Control+a')
      await ctx.page.key('Backspace')
    }
    if (await ctx.page.eval(shownIn(MENTIONS))) await ctx.page.key('Escape')
    await gone(ctx, 'the mentions', MENTIONS)
  },
  query: '12345',
  ready: (typed) => `${composerText}.endsWith(${JSON.stringify('@' + typed)}) && ${rowsIn(MENTION_ROWS)}`
})

const MODELS = '[data-model-picker]'
const pickerModel = picker({
  id: 'picker-model',
  // A fresh profile has no favourites: the picker opens on Favorites, its list the line that says so.
  title: "The composer's model picker, to its list drawn; then type \"sonne\", a key at a time",
  region: MODELS,
  shown: `${shownIn(MODELS)} && !!document.activeElement?.closest(${JSON.stringify(MODELS)}) && document.querySelector(${JSON.stringify(MODELS)}).innerText.trim().length > 0`,
  open: (ctx) => ctx.page.clickOn(inPane('[data-composer] button[aria-keyshortcuts]')),
  close: async (ctx) => {
    if (await ctx.page.eval(shownIn(MODELS))) await ctx.page.key('Escape')
    await gone(ctx, 'the model picker', MODELS)
  },
  query: 'sonne',
  ready: (typed) => `${valueOf(MODELS + ' input')} === ${JSON.stringify(typed)} && ${rowsIn(MODELS + ' [role="option"]')}`
})

/**
 * D19: the window brought forward with a thread of the 20,000-file project shown: its asks to the host by method in
 * the 2 s after (git.diffIndex among them) and the longest task. Under xvfb no window manager moves the OS focus and
 * `Page.bringToFront` fires a focus but leaves the page hidden, so the row uses CDP's focus emulation: turned off the
 * page is blurred and hidden (he went to another app), turned on it gets the window's `focus` and a
 * `visibilitychange` to visible, the two events the window's refreshes listen for (lib/gitIndexStore.ts,
 * hooks/useProjectBranches.ts). Away 6 s each time: past the 5 s the budget gives between two git.diffIndex asks.
 * The row ends with the emulation on (focused and visible).
 */
const windowForward: Row = {
  id: 'window-forward',
  family: 'code',
  title: 'Bring the window forward from 6 s behind another app with a thread of the 20,000-file project shown: asks in the 2 s after, git.diffIndex counted, and the longest task',
  run: async (ctx) => {
    await showThread(ctx, SEED_SHORT[0]!)
    await ctx.page.eval(`(() => { window.__perfFocus = 0; addEventListener('focus', (e) => { if (e.target === window) window.__perfFocus++; }, true); })()`)
    const samples: Sample[] = []
    try {
      for (let i = 0; i < 3; i++) {
        await ctx.page.send('Emulation.setFocusEmulationEnabled', { enabled: false })
        await sleep(6000)
        const sample = await ctx.time({
          region: 'main',
          // Usable is the 2 s watch's end: the counts are the asks inside it, the longest task the one inside it.
          usable: 'performance.now() - window.__perf.pressed >= 2000',
          press: async () => {
            await ctx.page.eval('window.__perfFocus = 0; window.__perf.pressed = performance.now()')
            await ctx.page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
          },
          wait: 5000,
          settle: 0
        })
        const focused = await ctx.page.eval<number>('window.__perfFocus')
        samples.push(focused ? sample : { ...sample, error: [sample.error, 'no focus event reached the window'].filter(Boolean).join('; ') })
        if (sample.usable === null) break
      }
    } finally {
      await ctx.page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    }
    return samples
  }
}

export const CODE_ROWS: Row[] = [
  threadOpenFar, threadSwitch, projectSwitch, launchCode, threadOpenLost, threadOpenCatchup, boardOpen,
  pickerSearch, pickerFile, pickerAt, pickerModel, windowForward
]
