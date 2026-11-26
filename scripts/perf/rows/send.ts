/**
 * Send to first token (G01 to G06), in his shape: he types a line in a box thread's composer and presses Enter, and
 * the loopback provider answers with its first byte exactly FIRST_BYTE_MS (100 ms) later (lib/load.ts
 * `perfProvider`). A press keeps his own row on screen (`first`), the first word of the answer on screen
 * (`usable`), `ours` (usable less the provider's 100 ms), the round trips the window made before the host had the
 * turn (`beforeTurn`, by method, up to the `session.send`), and the host's own stamps for that send from the isolated
 * box's stalls.log (`send`: queue, handle-wait, mcp, gateway-dispatch, first-byte, first-row, first-content and the
 * phases; src/main/server/sendSpans.ts).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIRST_BYTE_MS, SEND_MARK, answerWord } from '../../journeys/lib/fakeProvider'
import { hostRows } from '../../journeys/lib/thread'
import { INPUT } from '../../journeys/lib/lifeosJourney'
import { SEED_SHORT } from '../lib/seedNames'
import { WireLog, methodsUntil, tally } from '../lib/frames'
import { PRESSES, type PerfCtx, type Row } from '../lib/row'
import type { MeasureOptions, Sample } from '../lib/probe'
import { paneReady } from './code'

/** A send's sample: the probe's, with the host's stamps and our side's share. */
export type SendSample = Sample & {
  /** the host's span for this send (sendSpans.ts), ms from the RPC's arrival; `-` fields left out */
  send?: Record<string, number>
  /** how the harness was had: live, warm or cold */
  handle?: string
  /** usable less the provider's own FIRST_BYTE_MS */
  ours?: number
  /** the window's asks before the host had the turn, by method, up to and including `session.send` */
  beforeTurn?: Record<string, number>
  /** the asks before the turn, all methods */
  beforeTurnAll?: number
  /** ms from the press to the `session.send` frame leaving the window: what the window did first */
  sendLeft?: number
  /** the cap row's own times */
  link?: Record<string, number | null>
}

/** One parsed `send session=<id> …` line of stalls.log. */
export interface SendLine {
  /** when it was written, epoch ms */
  at: number
  session: string
  handle?: string
  parts: Record<string, number>
}

/** A stalls.log line, read as a send span; undefined for any other line. Pure: rows.test.ts drives it. */
export function parseSendLine(line: string): SendLine | undefined {
  const head = line.match(/^(\S+) send session=(\S+) /)
  if (!head) return
  const at = Date.parse(head[1]!)
  if (!Number.isFinite(at)) return
  const parts: Record<string, number> = {}
  for (const [, key, value] of line.slice(head[0].length).matchAll(/(?:^|\s)([\w-]+)=(\d+(?:\.\d+)?)(?=[\s(]|$)/g)) parts[key!] = Number(value)
  const handle = line.match(/ handle=\d+\((live|warm|cold)[ )]/)?.[1]
  return { at, session: head[2]!, ...(handle ? { handle } : {}), parts }
}

/** The first span line of a thread written at or after `since` (epoch ms). */
export function sendLineAfter(text: string, session: string, since: number): SendLine | undefined {
  for (const line of text.split('\n')) {
    const parsed = parseSendLine(line)
    if (parsed && parsed.session === session && parsed.at >= since) return parsed
  }
  return undefined
}

export const stallsOf = (ctx: PerfCtx): string => join(ctx.pair.box.data, 'logs', 'stalls.log')

/** Waits up to `ms` for the thread's span line: the host writes it once the first row has gone out, off the loop. */
export async function readSendLine(ctx: PerfCtx, session: string, since: number, ms = 8000): Promise<SendLine | undefined> {
  const file = stallsOf(ctx)
  const end = Date.now() + ms
  for (;;) {
    const line = existsSync(file) ? sendLineAfter(readFileSync(file, 'utf8'), session, since) : undefined
    if (line || Date.now() > end) return line
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

let sends = 0
/** A fresh mark for one send: the words he types and the word the answer opens with. */
export function nextSend(): { nonce: string; words: string; answer: string } {
  const nonce = `n${Date.now().toString(36)}${++sends}`
  return { nonce, words: `${SEND_MARK} ${nonce} what time is practice?`, answer: answerWord(nonce) }
}

const rowsHold = (scope: string, words: string): string =>
  `[...document.querySelectorAll(${JSON.stringify(scope + ' [data-row]')})].some((r) => (r.innerText ?? '').includes(${JSON.stringify(words)}))`

/**
 * Watches the page for his own row: stamps `window.__perfSend.mine` on the first frame a transcript row holds his
 * words. The probe's `first` is any change in the region (the composer clearing is one); this is the row itself.
 */
const watchMine = (scope: string, words: string): string => `(() => {
  const s = window.__perfSend = { mine: 0 };
  const tick = () => {
    if (s !== window.__perfSend) return;
    if (${rowsHold(scope, words)}) { s.mine = performance.now(); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`

export const boxHostOf = (ctx: PerfCtx): string => JSON.stringify(ctx.pair.box.host)
/**
 * Whether an event was on the window's socket to box: by its URL when the log saw the socket open, else by the
 * run's Counter, which saw every socket from before the run's first reload (its map is private to probe.ts, which
 * this file may not change, so it is read as it is at run time).
 */
export const boxSocket = (ctx: PerfCtx, log: WireLog) => (e: { socket: string }): boolean => {
  const url = log.urlOf(e.socket)
  if (url) return new URL(url).port === String(ctx.pair.windowLink?.port ?? ctx.pair.box.remote)
  return (ctx.counter as unknown as { sockets?: Map<string, string> }).sockets?.get(e.socket) === 'box'
}

/** The press of a send and what it keeps, beyond the probe: his row, the host's stamps, the asks before the turn. */
async function timedSend(ctx: PerfCtx, log: WireLog, scope: string, session: () => Promise<string | undefined>, options: Omit<MeasureOptions, 'usable' | 'region'> & { words: string; answer: string }): Promise<SendSample> {
  await ctx.page.eval(watchMine(scope, options.words))
  const mark = log.mark()
  const since = Date.now() - 1000
  const sample: SendSample = await ctx.time({
    region: scope,
    usable: rowsHold(scope, options.answer),
    press: options.press,
    wait: options.wait ?? 60_000,
    ...(options.settle ? { settle: options.settle } : {})
  })
  const read = await ctx.page.eval<{ mine: number; pressed: number }>('({ mine: window.__perfSend?.mine ?? 0, pressed: window.__perf?.pressed ?? 0 })')
  if (read.mine && read.pressed) sample.first = Math.round(read.mine - read.pressed)
  if (sample.usable !== null) sample.ours = Math.round(sample.usable - FIRST_BYTE_MS)
  const events = log.since(mark)
  const before = methodsUntil(events, 'session.send', boxSocket(ctx, log))
  const left = events.find((e) => e.kind === 'sent' && e.method === 'session.send')
  const pressedAt = read.pressed ? await ctx.page.eval<number>(`performance.timeOrigin + ${read.pressed}`) : null
  if (left && pressedAt) sample.sendLeft = Math.round(left.at - pressedAt)
  sample.beforeTurn = tally(before)
  sample.beforeTurnAll = before.length
  const id = await session()
  const line = id ? await readSendLine(ctx, id, since) : undefined
  if (line) {
    sample.send = line.parts
    if (line.handle) sample.handle = line.handle
  }
  return sample
}

/** Every thread a row of this run put on screen: kept in a tab after, so never "only in the rail". */
export const opened = new Set<string>()

export const paneOf = (id: string): string => `[data-session-drop=${JSON.stringify(id)}]`

/**
 * A box thread on screen with rows drawn, opened as a click opens it (`window.__docket.open`, lib/docketOpen.ts):
 * the rows never press the rail, whose rows differ by workspace kind. `split` puts it in a pane beside the focused one.
 */
export async function shownThread(ctx: PerfCtx, id: string, split = false): Promise<void> {
  opened.add(id)
  if (await ctx.page.eval(paneReady(id))) return
  await ctx.page.eval(`window.__docket.open(${JSON.stringify(id)}${split ? ', { split: true }' : ''})`)
  await ctx.page.until(`${id} drawn`, 60_000, () => ctx.page.eval(paneReady(id)))
}

/** New Thread as he asks for it (the menu's CmdOrCtrl+N), to its composer focused; the title bar's button if the key did nothing. */
async function newThreadComposer(ctx: PerfCtx): Promise<void> {
  const focused = `document.activeElement?.matches(${JSON.stringify(INPUT)}) && !document.activeElement.textContent.trim()`
  await ctx.page.key('Control+n')
  const keyed = await ctx.page.until('the new thread composer', 3000, () => ctx.page.eval(focused)).then(() => true, () => false)
  if (keyed) return
  await ctx.page.clickOn('header button[aria-label="New thread"], [data-title-bar] button[aria-label="New thread"]')
  await ctx.page.until('the new thread composer', 20_000, () => ctx.page.eval(focused))
}

/** The thread on screen with its composer, then his words typed in it (not timed). */
async function typed(ctx: PerfCtx, id: string, words: string): Promise<string> {
  const scope = paneOf(id)
  await shownThread(ctx, id)
  await ctx.page.clickOn(`${scope} ${INPUT}`)
  await ctx.page.typeKeys(words)
  return scope
}

/** The thread's turn over, so the next send is a follow-up and not a queued one. */
export async function idle(ctx: PerfCtx, id: string, ms = 60_000): Promise<void> {
  await ctx.page.until(`${id} idle`, ms, async () => {
    const rows = await hostRows<{ status: string }>(ctx.pair, 'SELECT status FROM sessions WHERE id=?', id)
    return rows[0] && !['running', 'starting'].includes(rows[0].status)
  })
}

/** G01, G02 to G05: a follow-up in a seeded short thread, three presses (the first harness cold, then live). */
const sendFirstToken: Row = {
  id: 'send-first-token',
  family: 'code',
  title: 'Type a line in a seeded box thread and press Enter: his row, then the first word of the answer (provider 100 ms)',
  run: async (ctx) => {
    const thread = SEED_SHORT[2]!
    const log = new WireLog(ctx.page)
    const samples: SendSample[] = []
    for (let i = 0; i < PRESSES; i++) {
      const send = nextSend()
      const scope = await typed(ctx, thread.id, send.words)
      const sample = await timedSend(ctx, log, scope, async () => thread.id, { ...send, press: () => ctx.page.key('Enter') })
      samples.push(sample)
      if (sample.usable === null) break
      await idle(ctx, thread.id)
    }
    return samples
  }
}

/** G01 for a new thread: New thread in the seeded workspace, his words, Enter; every ask before the turn counted. */
const sendFirstTokenNew: Row = {
  id: 'send-first-token-new',
  family: 'code',
  title: 'Open a new thread in the seeded workspace, type a line and press Enter: the round trips before the turn, and the first word back',
  run: async (ctx) => {
    const log = new WireLog(ctx.page)
    const workspace = ctx.seeded?.workspaceId ?? ctx.workspace.id
    const ours = (): Promise<{ id: string }[]> => hostRows<{ id: string }>(ctx.pair,
      'SELECT id FROM sessions WHERE workspace_id=? OR project_id IN (SELECT id FROM projects WHERE workspace_id=?)', workspace, workspace)
    const samples: SendSample[] = []
    for (let i = 0; i < PRESSES; i++) {
      // A seeded thread shown puts its workspace on screen: New thread opens there.
      await shownThread(ctx, SEED_SHORT[2]!.id)
      const known = new Set((await ours()).map((row) => row.id))
      await ctx.page.dismissPopups()
      await newThreadComposer(ctx)
      const send = nextSend()
      await ctx.page.typeKeys(send.words)
      const found = async (): Promise<string | undefined> => {
        let id: string | undefined
        await ctx.page.until('the new thread on box', 20_000, async () => (id = (await ours()).map((row) => row.id).find((row) => !known.has(row)))).catch(() => undefined)
        return id
      }
      const sample = await timedSend(ctx, log, 'main', found, { ...send, press: () => ctx.page.key('Enter') })
      samples.push(sample)
      if (sample.usable === null) break
    }
    return samples
  }
}

/** The ids of the stand-in threads streaming in box (lib/load.ts), from box's own database. */
export async function standIns(ctx: PerfCtx): Promise<{ id: string; status: string }[]> {
  return hostRows<{ id: string; status: string }>(ctx.pair, "SELECT id, status FROM sessions WHERE title LIKE 'Stand-in %' ORDER BY created_at")
}

/** Box's running cap as its admission holds it: `pinned` is the setting (null for the default), `running` its count. */
const admission = (ctx: PerfCtx): Promise<{ cap: number; pinned: number | null; running: number; queued: number }> =>
  ctx.pair.rpc(ctx.pair.box, 'admission.get')

/**
 * G06: a send parked at the running cap, then a slot freed. His own send on a focused thread is admitted over the cap
 * (scheduler.ts FOCUSED_OVER_CAP: "the person is never held"), and an interrupted thread keeps its handle and its
 * slot, so the parked send is a new background thread's first message sent on box (the window not asked) while the
 * cap equals the running count, and the slot is freed by raising the cap by one (admission.set schedules a pass, as
 * a thread settling does). `usable` is the cap raised to the parked turn started (box's queued count back to 0,
 * asked every 25 ms); `link.firstContent` adds the host's own leave-queue to first content from its span line.
 */
const sendAtCap: Row = {
  id: 'send-at-cap',
  family: 'code',
  needs: { fake: true },
  title: 'A background send parked at the running cap: one slot freed to the parked turn started, and to its first content',
  run: async (ctx) => {
    const was = (await admission(ctx)).pinned
    const project = ctx.seeded?.projectId
    const samples: SendSample[] = []
    try {
      for (let i = 0; i < PRESSES; i++) {
        // The cap first: a create starts its harness at once while there is room (sessions.ts create).
        const full = Math.max(1, (await admission(ctx)).running)
        await ctx.pair.rpc(ctx.pair.box, 'admission.set', { cap: full })
        const { id } = await ctx.pair.rpc<{ id: string }>(ctx.pair.box, 'session.create', {
          ...(project ? { projectId: project } : { workspaceId: ctx.workspace.id }), title: `Perf parked ${i + 1}`, provider: 'claude', permission: 'auto', threadType: 'chat'
        })
        const send = nextSend()
        const since = Date.now() - 1000
        await ctx.pair.rpc(ctx.pair.box, 'session.send', { sessionId: id, text: send.words }, 60_000)
        let error: string | undefined
        await ctx.page.until('the host to queue it', 20_000, async () => (await admission(ctx)).queued > 0).catch((cause) => { error = String(cause?.message ?? cause) })
        let started: number | null = null
        if (!error) {
          const t0 = performance.now()
          await ctx.pair.rpc(ctx.pair.box, 'admission.set', { cap: full + 1 })
          const end = Date.now() + 30_000
          while (Date.now() < end) {
            if ((await admission(ctx)).queued === 0) { started = Math.round(performance.now() - t0); break }
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
          if (started === null) error = 'the parked turn never started within 30 s'
        }
        const line = await readSendLine(ctx, id, since, 20_000)
        const content = line?.parts['first-content']
        samples.push({
          first: null, usable: started, longest: 0, counts: (ctx.counter.take(), { t: {}, tAll: 0, c: 0, up: 0, down: 0 }), after: { t: {}, tAll: 0, c: 0, up: 0, down: 0 },
          ...(line ? { send: line.parts, ...(line.handle ? { handle: line.handle } : {}) } : {}),
          link: { started, firstContent: started !== null && content !== undefined ? started + content : null, queue: line?.parts.queue ?? null },
          ...(error ? { error } : {})
        } as SendSample)
        await ctx.pair.rpc(ctx.pair.box, 'admission.set', { cap: was }).catch(() => undefined)
        if (started === null) break
      }
    } finally {
      await ctx.pair.rpc(ctx.pair.box, 'admission.set', { cap: was }).catch(() => undefined)
    }
    return samples
  }
}

export const SEND_ROWS: Row[] = [sendFirstToken, sendFirstTokenNew, sendAtCap]
