/**
 * The window's link to the box (L01 to L06), on the shaped hop of his tunnel (`--link 60/10/j8`): opening it from
 * nothing, back after a cut, after the box restarts, a link that died with no close, the catch-up after a cut while
 * 40 threads stream, and the shown stream while a big frame is in flight. Each records; none asserts a time.
 * The CDP times come from lib/frames.ts (`WireLog`), set on the epoch clock beside the page's own.
 */
import { randomBytes } from 'node:crypto'
import { PART_CHARS } from '../../../src/shared/answerParts'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SEED_SHORT, SEED_THREADS } from '../lib/seedNames'
import { WireLog, gaps, spread, type WireEvent } from '../lib/frames'
import { PRESSES, type PerfCtx, type Row } from '../lib/row'
import type { Counts, Sample } from '../lib/probe'
import { paneReady } from './code'
import { boxHostOf, boxSocket, idle, nextSend, opened, paneOf, shownThread, standIns } from './send'

/** A link row's sample: the probe's, with named times (ms) and counts the probe has no field for. */
export type LinkSample = Sample & { link?: Record<string, number | null>; asks?: Record<string, unknown> }

const transport = (ctx: PerfCtx): string => `window.__docket?.registry.has(${boxHostOf(ctx)}) ? window.__docket.registry.statusOf(${boxHostOf(ctx)}).transport : 'none'`
const openNow = (ctx: PerfCtx): string => `(${transport(ctx)}) === 'open'`
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const none = (): Counts => ({ t: {}, tAll: 0, c: 0, up: 0, down: 0 })
const rowsHold = (id: string, words: string): string =>
  `[...document.querySelectorAll(${JSON.stringify(paneOf(id) + ' [data-row]')})].some((r) => (r.innerText ?? '').includes(${JSON.stringify(words)}))`

/** The page's epoch time of a probe stamp (performance.now() on its clock). */
const pageEpoch = async (ctx: PerfCtx, expr: string): Promise<number | null> =>
  ctx.page.eval<number | null>(`(() => { const t = ${expr}; return t ? performance.timeOrigin + t : null; })()`)

/** The first event after `mark` on the box's socket matching `test`, opened after `from` (epoch ms). */
function firstOnBox(ctx: PerfCtx, log: WireLog, events: WireEvent[], test: (e: WireEvent) => boolean): WireEvent | undefined {
  const onBox = boxSocket(ctx, log)
  return events.find((e) => onBox(e) && test(e))
}

/**
 * The window's open of the link, split: from navigation start (the page's time origin) to the ticket asked of its own
 * host (`remote.environments.ticket`), the ticket back, the socket asked, the socket open, the hello, and the link
 * `open` in the registry. Pure over the log's events: rows.test.ts drives it.
 */
export function openParts(events: WireEvent[], origin: number, isBox: (e: WireEvent) => boolean, openAt: number | null): Record<string, number | null> {
  const rel = (e: WireEvent | undefined): number | null => (e ? Math.round(e.at - origin) : null)
  const ticket = events.find((e) => e.kind === 'sent' && e.method === 'remote.environments.ticket')
  const back = ticket ? events.find((e) => e.kind === 'received' && e.socket === ticket.socket && e.id === ticket.id) : undefined
  const asked = events.find((e) => isBox(e) && e.kind === 'handshake')
  const open = asked ? events.find((e) => e.socket === asked.socket && e.kind === 'open') : undefined
  const hello = asked ? events.find((e) => e.socket === asked.socket && e.kind === 'received' && e.push === 'hello') : undefined
  return { ticketAsked: rel(ticket), ticketBack: rel(back), socketAsked: rel(asked), socketOpen: rel(open), hello: rel(hello), open: openAt === null ? null : Math.round(openAt - origin) }
}

/** L01: reload the window; navigation start to the link open, by part. */
const linkOpen: Row = {
  id: 'link-open',
  family: 'code',
  title: "The saved host's link from nothing (the window reloaded): ticket, socket and hello, to the link open",
  run: async (ctx) => {
    const host = boxHostOf(ctx)
    const log = new WireLog(ctx.page)
    // Stamps the moment the link opens on the new document's own clock, from its first script on.
    await ctx.page.send('Page.enable')
    const { identifier } = await ctx.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const tick = setInterval(() => {
        try {
          if (window.__docket?.registry.has(${host}) && window.__docket.registry.statusOf(${host}).transport === 'open') { window.__perfOpen = performance.now(); clearInterval(tick); }
        } catch {}
      }, 5);
    })()` }) as { identifier: string }
    const samples: LinkSample[] = []
    try {
      for (let i = 0; i < PRESSES; i++) {
        const mark = log.mark()
        ctx.counter.take()
        ctx.pair.windowLink?.reset()
        await ctx.page.reload()
        let error: string | undefined
        await ctx.page.until('the link open', 60_000, () => ctx.page.eval(`!!window.__perfOpen || (${openNow(ctx)})`)).catch((cause) => { error = String(cause?.message ?? cause) })
        const origin = await ctx.page.eval<number>('performance.timeOrigin')
        const openAt = await pageEpoch(ctx, 'window.__perfOpen')
        const parts = openParts(log.since(mark), origin, boxSocket(ctx, log), openAt)
        // The registry says open on the hello (transport.ts): where the page's own stamp did not run, the hello is it.
        if (parts.open === null && parts.hello !== null && !error) parts.open = parts.hello
        const wire = ctx.pair.windowLink?.reset()
        samples.push({ first: parts.hello, usable: parts.open, longest: 0, counts: ctx.counter.take(), after: none(), link: parts, ...(wire ? { wire: { up: wire.up, down: wire.down, turns: wire.turns } } : {}), ...(error ? { error } : {}) })
        if (parts.open === null) break
        // The rest of the window's opening settles before the next reload.
        await sleep(3000)
      }
    } finally {
      await ctx.page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => undefined)
    }
    return samples
  }
}

/** A message on box for a thread, through the host alone (the window not asked): its answer's first word. */
async function sentOnBox(ctx: PerfCtx, id: string): Promise<string> {
  const send = nextSend()
  await ctx.pair.rpc(ctx.pair.box, 'session.send', { sessionId: id, text: send.words }, 60_000)
  await idle(ctx, id)
  return send.answer
}

/**
 * L02: a seeded thread shown, the link cut 3 s while box adds a turn to it, then given back. `usable` is from the
 * link's return; `link.fromSocket` from the new socket's open to the thread current (rows drawn, the new answer in).
 */
const reconnectCode: Row = {
  id: 'reconnect-code',
  family: 'code',
  needs: { fake: true },
  title: 'The link cut 3 s while the shown thread gets a new turn on box, then back: the thread current again',
  run: async (ctx) => {
    const thread = SEED_SHORT[4]!
    const log = new WireLog(ctx.page)
    const samples: LinkSample[] = []
    try {
      for (let i = 0; i < PRESSES; i++) {
        await shownThread(ctx, thread.id)
        ctx.pair.cutWindowLink(true)
        await ctx.page.until('the window to lose the link', 30_000, () => ctx.page.eval(`!(${openNow(ctx)})`))
        const answer = await sentOnBox(ctx, thread.id)
        await sleep(3000)
        const mark = log.mark()
        const sample: LinkSample = await ctx.time({
          region: paneOf(thread.id),
          usable: `${openNow(ctx)} && ${paneReady(thread.id)} && ${rowsHold(thread.id, answer)}`,
          // No press of his: the clock starts as the link comes back.
          press: async () => {
            await ctx.page.eval('window.__perf.pressed = performance.now()')
            ctx.pair.cutWindowLink(false)
          },
          wait: 60_000
        })
        const usableAt = await pageEpoch(ctx, 'window.__perf.usable')
        const pressedAt = await pageEpoch(ctx, 'window.__perf.pressed')
        const events = log.since(mark)
        const open = firstOnBox(ctx, log, events, (e) => e.kind === 'open')
        const hello = firstOnBox(ctx, log, events, (e) => e.kind === 'received' && e.push === 'hello')
        const between = (from: WireEvent | number | null | undefined, to: WireEvent | number | null | undefined): number | null =>
          from == null || to == null ? null : Math.round((typeof to === 'number' ? to : to.at) - (typeof from === 'number' ? from : from.at))
        // socketOpen: the link given back to the new socket open; fromSocket and fromHello: those to the thread current.
        sample.link = { socketOpen: between(pressedAt, open), fromSocket: between(open, usableAt), fromHello: between(hello, usableAt) }
        samples.push(sample)
        if (sample.usable === null) break
      }
    } finally {
      ctx.pair.cutWindowLink(false)
    }
    return samples
  }
}

/**
 * L03: box stopped and started again (the window's key, the thread and its rows kept on box's disk) while the window
 * shows a seeded thread that got a new turn just before. One press: the clock starts at box's start;
 * `link.fromHello` is box's first hello on the window's new socket to the thread current.
 */
const restartBox: Row = {
  id: 'restart-box',
  family: 'code',
  needs: { fake: true },
  title: 'Box restarted while the window shows a thread: from box answering (its hello) to the thread current',
  run: async (ctx) => {
    const thread = SEED_SHORT[5]!
    const log = new WireLog(ctx.page)
    await shownThread(ctx, thread.id)
    // The new turn lands while the window cannot see it, so only the catch-up after the restart can draw it.
    ctx.pair.cutWindowLink(true)
    await ctx.page.until('the window to lose the link', 30_000, () => ctx.page.eval(`!(${openNow(ctx)})`))
    let answer: string
    try {
      answer = await sentOnBox(ctx, thread.id)
      await ctx.pair.halt(ctx.pair.box)
    } finally {
      ctx.pair.cutWindowLink(false)
    }
    const mark = log.mark()
    const sample: LinkSample = await ctx.time({
      region: paneOf(thread.id),
      usable: `${openNow(ctx)} && ${paneReady(thread.id)} && ${rowsHold(thread.id, answer)}`,
      press: async () => {
        await ctx.page.eval('window.__perf.pressed = performance.now()')
        await ctx.pair.restart(ctx.pair.box)
      },
      wait: 120_000
    })
    const usableAt = await pageEpoch(ctx, 'window.__perf.usable')
    const pressedAt = await pageEpoch(ctx, 'window.__perf.pressed')
    const hello = firstOnBox(ctx, log, log.since(mark), (e) => e.kind === 'received' && e.push === 'hello')
    sample.link = {
      hello: hello && pressedAt ? Math.round(hello.at - pressedAt) : null,
      fromHello: hello && usableAt ? Math.round(usableAt - hello.at) : null
    }
    return [sample]
  }
}

/**
 * L04: the link turned into a black hole (no bytes either way, no close) while the window is visible and idle: to
 * the moment the window's registry says the link is no longer open, read by the probe each frame (up to 100 s).
 * Then the hole lifted: `link.back` is to the link open again.
 */
const deadLink: Row = {
  id: 'dead-link',
  family: 'code',
  title: 'A link that died with no close (lid shut, Wi-Fi gone) while the window is visible and idle: until the window notices',
  run: async (ctx) => {
    const link = ctx.pair.windowLink
    if (!link) throw new Error('The dead-link row needs the shaped hop (--link)')
    await shownThread(ctx, SEED_SHORT[0]!.id)
    let sample: LinkSample
    try {
      sample = await ctx.time({
        region: 'body',
        usable: `!(${openNow(ctx)})`,
        press: async () => {
          await ctx.page.eval('window.__perf.pressed = performance.now()')
          link.blackhole(true)
        },
        wait: 100_000,
        settle: 0
      })
      // What the registry said once it noticed: reconnecting, offline, connecting.
      sample.asks = { status: await ctx.page.eval(transport(ctx)) }
    } finally {
      link.blackhole(false)
    }
    const lifted = Date.now()
    const back = await ctx.page.until('the link open again', 120_000, () => ctx.page.eval(openNow(ctx))).then(() => Date.now() - lifted, () => null)
    sample.link = { back }
    return [sample]
  }
}

const CATCHUP_TABS = [SEED_THREADS.chat.id, SEED_THREADS.long.id, SEED_SHORT[2]!.id, SEED_SHORT[3]!.id]
const CATCHUP_PANES = [SEED_SHORT[0]!.id, SEED_SHORT[1]!.id]

/** The transcript asks after a cut, by the kind of thread each names. Pure: rows.test.ts drives it. */
export function asksByPlace(events: WireEvent[], isBox: (e: WireEvent) => boolean, place: (session: string) => string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const e of events) {
    if (e.kind !== 'sent' || !e.method || !e.session || !isBox(e)) continue
    if (!/^(session\.(events|subscribe|rowBody)|queue\.list)$/.test(e.method)) continue
    const where = place(e.session)
    const row = (out[where] ??= {})
    row[e.method] = (row[e.method] ?? 0) + 1
  }
  return out
}

/**
 * L05: six seeded threads open (two panes on screen, four tabs behind), the link cut 5 s while the 40 stand-ins
 * stream, then back: to the shown panes current, then 20 s watched. Records the longest task and the tasks over
 * 100 ms in those 20 s, the wire's bytes down, and the transcript asks by thread: mounted, kept in a tab, only in
 * the rail, or a stand-in.
 */
const catchup40: Row = {
  id: 'catchup-40',
  family: 'code',
  needs: { fake: true },
  title: 'Six threads open, the link cut 5 s while the load streams, then back with Retry: the catch-up, its longest task and its asks by thread',
  run: async (ctx) => {
    const log = new WireLog(ctx.page)
    const link = ctx.pair.windowLink
    for (const id of CATCHUP_TABS) await shownThread(ctx, id)
    await shownThread(ctx, CATCHUP_PANES[0]!)
    await shownThread(ctx, CATCHUP_PANES[1]!, true)
    const load = new Set((await standIns(ctx)).map((row) => row.id))
    const samples: LinkSample[] = []
    try {
      for (let i = 0; i < PRESSES; i++) {
        const mounted = new Set(await ctx.page.eval<string[]>(`[...document.querySelectorAll('[data-session-drop]')].map((el) => el.getAttribute('data-session-drop'))`))
        const place = (id: string): string => mounted.has(id) ? 'mounted' : opened.has(id) ? 'tab' : load.has(id) ? 'stand-in' : 'rail'
        ctx.pair.cutWindowLink(true)
        await ctx.page.until('the window to lose the link', 30_000, () => ctx.page.eval(`!(${openNow(ctx)})`))
        await sleep(5000)
        const mark = log.mark()
        const sample: LinkSample = await ctx.time({
          region: 'main',
          usable: `${openNow(ctx)} && ${CATCHUP_PANES.map(paneReady).join(' && ')}`,
          // The link back and Retry pressed (registry.retry, the button's own act): catch-up, not the redial's backoff.
          press: async () => {
            await ctx.page.eval('window.__perf.pressed = performance.now()')
            ctx.pair.cutWindowLink(false)
            await ctx.page.eval(`window.__docket.registry.retry(${boxHostOf(ctx)})`)
          },
          wait: 60_000,
          settle: 20_000
        })
        const tail = link?.reset()
        const usableAt = await pageEpoch(ctx, 'window.__perf.usable')
        const open = firstOnBox(ctx, log, log.since(mark), (e) => e.kind === 'open')
        const asks = asksByPlace(log.since(mark), boxSocket(ctx, log), place)
        sample.asks = { byPlace: asks, railFetched: !!asks.rail, standInFetched: !!asks['stand-in'] }
        sample.link = { fromSocket: open && usableAt ? Math.round(usableAt - open.at) : null, wireDown: (sample.wire?.down ?? 0) + (tail?.down ?? 0), wireDownAfter: tail?.down ?? null }
        samples.push(sample)
        if (sample.usable === null) break
      }
    } finally {
      ctx.pair.cutWindowLink(false)
    }
    return samples
  }
}

/**
 * The shown thread's frame times across a bulk read: the last before it was asked, every one until it was done, and
 * the first after, so a read that held every frame back shows as one long gap. Pure: rows.test.ts drives it.
 */
export function bulkWindow(beforeFrames: number[], afterFrames: number[], doneAt: number): number[] {
  const inside = afterFrames.filter((t) => t <= doneAt)
  const next = afterFrames.find((t) => t > doneAt)
  return [...beforeFrames.slice(-1), ...inside, ...(next === undefined ? [] : [next])]
}

/** The bulk read's file: a little under fs.read's 2 MiB cap, of words that do not deflate. */
export const BULK_BYTES = 2 * 1024 * 1024 - 64 * 1024
export const BULK_FILE = 'perf-bulk.txt'
const BULK_READS = 2

/**
 * L06: a streaming stand-in shown; 5 s of its frames as they reach the page, then two `fs.read`s of a 1.94 MiB file
 * of the seeded project asked at once over the same socket (about 3.9 MiB in flight); the gaps between the shown
 * thread's pushes before and during the reads (CDP's received times): p50, p95, max.
 */
const streamUnderBulk: Row = {
  id: 'stream-under-bulk',
  family: 'code',
  needs: { fake: true },
  title: 'One streaming thread shown while two 1.94 MiB fs.read answers cross the same socket: the gaps between its frames',
  run: async (ctx) => {
    if (!ctx.seeded) throw new Error('The bulk row reads a file of the seeded project (--family code)')
    const file = join(ctx.seeded.path, BULK_FILE)
    // Base64 of random bytes: the socket's deflate cannot shrink it to nothing.
    if (!existsSync(file)) writeFileSync(file, randomBytes(Math.floor((BULK_BYTES * 3) / 4)).toString('base64'))
    const streaming = (await standIns(ctx)).find((row) => row.status === 'running')
    if (!streaming) throw new Error('No stand-in thread is streaming: the bulk row needs the load (--load 40)')
    const log = new WireLog(ctx.page)
    await shownThread(ctx, streaming.id)
    const onBox = boxSocket(ctx, log)
    const frames = (events: WireEvent[]): number[] => events.filter((e) => onBox(e) && e.kind === 'received' && e.push && e.session === streaming.id).map((e) => e.at)
    const samples: LinkSample[] = []
    for (let i = 0; i < PRESSES; i++) {
      const before = log.mark()
      await sleep(5000)
      const during = log.mark()
      const sample: LinkSample = await ctx.time({
        region: paneOf(streaming.id),
        usable: `window.__perfBulk?.done === ${BULK_READS}`,
        press: async () => {
          await ctx.page.eval('window.__perf.pressed = performance.now()')
          await ctx.page.eval(`(() => {
            const bulk = window.__perfBulk = { done: 0, bytes: 0, error: null };
            const link = window.__docket.registry.linkOf(${boxHostOf(ctx)});
            for (let n = 0; n < ${BULK_READS}; n++) link.request('fs.read', { projectId: ${JSON.stringify(ctx.seeded!.projectId)}, path: ${JSON.stringify(BULK_FILE)} })
              .then((r) => { bulk.bytes += (r?.content ?? '').length; bulk.done++; }, (e) => { bulk.error = String(e?.message ?? e); bulk.done++; });
          })()`)
        },
        wait: 60_000
      })
      const bulk = await ctx.page.eval<{ bytes: number; error: string | null }>('({ bytes: window.__perfBulk?.bytes ?? 0, error: window.__perfBulk?.error ?? null })')
      // The read done: its last big answer as CDP saw it arrive, on the same clock as the stream's frames. A host that
      // sends big answers in parts (src/shared/answerParts.ts) sends no frame past a part: its last part is the end.
      const big = log.since(during).filter((e) => onBox(e) && e.kind === 'received' && (e.bytes ?? 0) >= PART_CHARS)
      const doneAt = big.at(-1)?.at ?? (await pageEpoch(ctx, 'window.__perf.usable')) ?? Infinity
      const calmFrames = frames(log.since(before).slice(0, during - before))
      const calm = spread(gaps(calmFrames))
      const busy = spread(gaps(bulkWindow(calmFrames, frames(log.since(during)), doneAt)))
      sample.link = { beforeP50: calm.p50, beforeP95: calm.p95, beforeMax: calm.max, beforeN: calm.n, duringP50: busy.p50, duringP95: busy.p95, duringMax: busy.max, duringN: busy.n, bulkBytes: bulk.bytes }
      if (bulk.error) sample.error = bulk.error
      samples.push(sample)
      if (sample.usable === null) break
    }
    return samples
  }
}

// restart-box before dead-link: a run that takes both spends dead-link's long wait last.
export const LINK_ROWS: Row[] = [linkOpen, reconnectCode, catchup40, streamUnderBulk, restartBox, deadLink]
