/**
 * The soak's idle, long and day scenes driven over CDP (scripts/measure-renderer-soak.ts `--scene idle|long|day`):
 * the window already shows the quiet chat and the synthetic host already runs the scene's load. Each writes
 * <root>/<label>.json and .md and returns its verdict; the pure parts are soakIdle.ts, soakLong.ts and soakDay.ts.
 */
import type { ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Cdp } from './packagedApp'
import { profileSummary, type CpuProfile } from '../profile-summary'
import { summarizeTrace, TRACE_CATEGORIES, type TraceEvent } from './soakTrace'
import type { Verdict } from './soakJudge'
import { spread } from './soakTyping'
import { CENSUS, flushesBetween, IDLE_PAGE, IDLE_PHASES, IDLE_RULE, IDLE_TIMING, judgeIdle, summarizeIdlePhase, type Census, type FlushRecord, type IdlePhase, type IdlePhaseName } from './soakIdle'
import { frameMainMs, judgeLong, LONG_JUMP_SEQ, LONG_PAGE, LONG_RULE, LONG_TIMING, taskList, type LongResult } from './soakLong'
import { DAY_RULE, DAY_TIMING, judgeDay, rawRows, STORE_CENSUS, type DayResult, type StoreCensus } from './soakDay'

export interface QuietCtx {
  c: Cdp
  /** the gate's form (renderer-soak-idle, renderer-soak-long): long climbs to no top and leaves the jump unjudged */
  gate?: boolean
  label: string
  root: string
  host: ChildProcess
  rendererPid: number
  /** the shown chat, the running threads (the long one last in the long scene) */
  quietId: string
  children: string[]
  /** the long scene: the long thread's rows on the host */
  longRows?: number
  cpuSeconds(pid: number): number
  log(msg: string): void
  waitFor(c: Cdp, expr: string, ms: number, what: string): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
const round = (n: number): number => Math.round(n * 10) / 10

/** The host's stdin and its JSON answers on stdout (soak-host.ts). */
function hostControl(host: ChildProcess): { ask<T extends object>(line: string, done: (o: Record<string, unknown>) => boolean, ms?: number): Promise<T>; close(): void } {
  if (!host.stdin || !host.stdout) throw new Error('the synthetic host has no stdin or stdout')
  const lines = createInterface({ input: host.stdout })
  return {
    ask: <T extends object>(line: string, done: (o: Record<string, unknown>) => boolean, ms = 15_000) =>
      new Promise<T>((ok, fail) => {
        const timer = setTimeout(() => (lines.off('line', on), fail(new Error(`the synthetic host did not answer "${line}"`))), ms)
        const on = (l: string): void => {
          if (!l.startsWith('{')) return
          const o = JSON.parse(l) as Record<string, unknown>
          if (!done(o)) return
          clearTimeout(timer)
          lines.off('line', on)
          ok(o as T)
        }
        lines.on('line', on)
        host.stdin!.write(`${line}\n`)
      }),
    close: () => lines.close()
  }
}

const verdictRows = (verdicts: readonly Verdict[]): string[] => ['| reading | got | limit | |', '|---|---|---|---|', ...verdicts.map((v) => `| ${v.what} | ${v.got} | ${v.limit} | ${v.ok ? 'pass' : 'FAIL'} |`)]

function finish(ctx: QuietCtx, scene: string, record: object, verdict: { ok: boolean; verdicts: Verdict[] }, md: string[]): boolean {
  writeFileSync(join(ctx.root, `${ctx.label}.json`), JSON.stringify({ label: ctx.label, scene, platform: process.platform, ...record, verdict }, null, 1))
  writeFileSync(join(ctx.root, `${ctx.label}.md`), [...md, '', ...verdictRows(verdict.verdicts)].join('\n') + '\n')
  for (const v of verdict.verdicts) console.log(`${v.ok ? '✓' : '✗'} ${v.what}: ${v.got} (limit ${v.limit})`)
  console.log(`${verdict.ok ? 'passed' : 'FAILED'}: ${ctx.root}/${ctx.label}.md`)
  return verdict.ok
}

// ── idle ─────────────────────────────────────────────────────────────────
/** How each phase is made: the window to the front, a second app window over it, the window hidden. */
async function enterPhase(c: Cdp, phase: IdlePhaseName): Promise<string> {
  if (phase === 'focused') {
    await c.send('Page.bringToFront')
    return 'the window shown with throttling as in the app (TEMP_CODE_SOAK_WINDOW off) and brought to the front (Page.bringToFront)'
  }
  if (phase === 'unfocused') {
    await c.eval('window.api.win.create().then(() => true)')
    return "a second app window opened over it (window.api.win.create) and given the focus; xvfb has no window manager and Chromium tracks no occlusion on Linux, so the covered window stays visible"
  }
  await c.eval('window.api.win.hide().then(() => true)')
  return 'the window hidden (window.api.win.hide: BrowserWindow.hide, the X window unmapped)'
}

export async function recordIdle(ctx: QuietCtx): Promise<boolean> {
  const { c, log } = ctx
  const host = hostControl(ctx.host)
  const ready = await c.eval<true | string>(IDLE_PAGE)
  if (ready !== true) throw new Error(`the idle scene cannot read the page: ${ready}`)
  const now = (): Promise<number> => c.eval<number>('window.__idle.now()')
  await sleep(3_000)
  const phases: IdlePhase[] = []
  for (const phase of IDLE_PHASES) {
    const how = await enterPhase(c, phase)
    // A second window boots a whole renderer: let it settle before the phase is read.
    await sleep(phase === 'unfocused' ? 2 * IDLE_TIMING.settleMs : IDLE_TIMING.settleMs)
    const state = await c.eval<{ visibility: string; focus: boolean }>('window.__idle.state()')
    const t0 = await now()
    const cpu0 = ctx.cpuSeconds(ctx.rendererPid)
    const w0 = Date.now()
    await sleep(IDLE_TIMING.phaseMs)
    const cpuS = ctx.cpuSeconds(ctx.rendererPid) - cpu0
    const wallS = (Date.now() - w0) / 1000
    const t1 = await now()
    const census = await c.eval<Census>(CENSUS)
    const seen = await c.eval<{ flushes: FlushRecord[]; tasks: { start: number; duration: number }[] }>(`window.__idle.since(${t0})`)
    // One push at a time with the load held, each counted by the flushes it caused.
    await host.ask('pause', (o) => o.paused === true)
    await sleep(1_500)
    await c.eval('window.__idle.arm(true)')
    const pushes: FlushRecord[][] = []
    for (let k = 0; k < IDLE_TIMING.pushes; k++) {
      const p0 = await now()
      await host.ask('meta', (o) => typeof o.meta === 'number')
      await sleep(IDLE_TIMING.pushGapMs)
      const p1 = await now()
      pushes.push(flushesBetween((await c.eval<{ flushes: FlushRecord[] }>(`window.__idle.since(${p0})`)).flushes, p0, p1))
    }
    await c.eval('window.__idle.arm(false)')
    await host.ask('resume', (o) => o.resumed === true)
    await c.eval(`window.__idle.drop(${await now()})`)
    const summary = summarizeIdlePhase({
      phase,
      state,
      how,
      cpuS,
      wallS,
      census,
      flushes: flushesBetween(seen.flushes, t0, t1),
      tasks: seen.tasks.filter((t) => t.start < t1),
      pushes
    })
    phases.push(summary)
    log(`${phase} (${state.visibility}, ${state.focus ? 'focused' : 'not focused'}): CPU ${summary.cpuPct}%, ${census.running} running animations (${census.onScreen} on screen) for ${census.workingRows} working rows on screen, ${summary.flushes.count} flushes p50 ${summary.flushes.ms.p50} / p95 ${summary.flushes.ms.p95} ms, a push renders ${summary.pushes.map((p) => p.rendered).join(', ')}`)
  }
  host.close()
  const verdict = judgeIdle(phases)
  const md = [
    `# ${ctx.label}: idle scene, ${ctx.children.length} running threads behind a settled chat (${process.platform})`,
    '',
    '| phase | page | renderer CPU % | running animations (on screen) | working rows on screen | flushes (meta) | flush ms p50 / p95 / max | to commits done p95 | long tasks (worst ms) | components a push |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...phases.map((p) => `| ${p.phase} | ${p.state.visibility}, ${p.state.focus ? 'focused' : 'not focused'} | ${p.cpuPct} | ${p.census.running} (${p.census.onScreen}) | ${p.census.workingRows} | ${p.flushes.count} (${p.flushes.meta}) | ${p.flushes.ms.p50} / ${p.flushes.ms.p95} / ${p.flushes.ms.max} | ${p.flushes.settledMs.p95} | ${p.longTasks.count} (${p.longTasks.maxMs}) | ${p.pushes.map((x) => x.rendered).join(', ')} |`),
    '',
    ...phases.flatMap((p) => [`**${p.phase}**: ${p.how}.`, '', '| running animation | count |', '|---|---|', ...Object.entries(p.census.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `| ${k} | ${n} |`), '', `Working rows on screen by kind: ${Object.entries(p.census.rowKinds ?? {}).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}.`, '', '| rendered for the pushes | count |', '|---|---|', ...p.pushNames.map(([k, n]) => `| ${k} | ${n} |`), ''])
  ]
  return finish(ctx, 'idle', { rule: IDLE_RULE, timing: IDLE_TIMING, phases }, verdict, md)
}

// ── long ─────────────────────────────────────────────────────────────────
type Held = { blocks: number; rows: number | null; oldest: number | null; target: string | null; loaded: boolean }

async function trace(c: Cdp, run: () => Promise<unknown>): Promise<TraceEvent[]> {
  const events: TraceEvent[] = []
  let complete: () => void = () => {}
  const done = new Promise<void>((ok) => (complete = ok))
  c.on('Tracing.tracingComplete', () => complete())
  c.on('Tracing.dataCollected', (p) => events.push(...(p as { value: TraceEvent[] }).value))
  await c.send('Tracing.start', { categories: TRACE_CATEGORIES, transferMode: 'ReportEvents' })
  await run()
  await c.send('Tracing.end')
  await done
  return events
}

/** A step that found nothing to read: what the page held, and a picture of it, beside the report. */
async function explain(ctx: QuietCtx, id: string, step: string): Promise<void> {
  const census = await ctx.c.eval<object>(`window.__long.census(${JSON.stringify(id)})`)
  const shot = (await ctx.c.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  const file = join(ctx.root, `${ctx.label}.${step}.png`)
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  ctx.log(`${step}: the page held ${JSON.stringify(census)} (${file})`)
}

export async function recordLong(ctx: QuietCtx): Promise<boolean> {
  const { c, log } = ctx
  const id = ctx.children[ctx.children.length - 1]!
  const host = hostControl(ctx.host)
  await c.eval(LONG_PAGE)
  const now = (): Promise<number> => c.eval<number>('window.__long.now()')
  const held = (seq = 0): Promise<Held> => c.eval<Held>(`window.__long.held(${JSON.stringify(id)}, ${seq})`)
  await ctx.waitFor(c, `window.__docket.sessionStore.metaOf(${JSON.stringify(id)})`, 60_000, 'the long thread on the host')
  await sleep(3_000)
  if ((await held()).loaded) log('the long thread was loaded before its open: the open is not cold')

  // The open: a click on its row in the rail, else the opener every build has.
  const at = await c.eval<{ x: number; y: number } | null>(`(() => {
    // Its row in the rail or the workspace column: a row's open button named by the thread's title, outside every pane.
    const title = window.__docket.sessionStore.metaOf(${JSON.stringify(id)})?.title ?? '\u0000'
    const row = [...document.querySelectorAll('[data-row-open]')].find((e) => (e.getAttribute('aria-label') || '').startsWith(title) && !e.closest('[data-session-drop]') && e.getBoundingClientRect().width > 0)
    if (!row) return null
    row.scrollIntoView({ block: 'nearest' })
    const r = row.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  await c.send('Profiler.enable')
  await c.send('Profiler.setSamplingInterval', { interval: 1000 })
  await c.send('Profiler.start')
  const t0 = await c.eval<number>(`window.__long.armOpen(${JSON.stringify(id)})`)
  if (at) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
    for (const type of ['mousePressed', 'mouseReleased'] as const) await c.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  } else {
    log('no row of the long thread in the rail: opened through window.__docket.open')
    await c.eval(`window.__docket.open(${JSON.stringify(id)}).then(() => true)`)
  }
  await sleep(LONG_TIMING.afterOpenMs)
  const { profile } = (await c.send('Profiler.stop')) as { profile: CpuProfile }
  const profilePath = join(ctx.root, `${ctx.label}.open.cpuprofile`)
  writeFileSync(profilePath, JSON.stringify(profile))
  const until = Date.now() + LONG_TIMING.readableWithinMs - LONG_TIMING.afterOpenMs
  while (Date.now() < until && (await c.eval<number | null>('window.__long.open.at')) === null) await sleep(250)
  const openAt = await c.eval<number | null>('window.__long.open.at')
  await c.eval("window.__long.disarm('open')")
  if (openAt === null) await explain(ctx, id, 'open')
  const afterOpen = await c.eval<{ tasks: { start: number; duration: number }[] }>(`window.__long.between(${t0}, ${t0 + LONG_TIMING.afterOpenMs})`)
  const heldOpen = await held()
  const open: LongResult['open'] = { by: at ? 'rail' : 'open', readableMs: openAt === null ? null : round(openAt - t0), tasks: taskList(afterOpen.tasks, t0), profile: profilePath, held: { blocks: heldOpen.blocks, rows: heldOpen.rows, oldest: heldOpen.oldest } }
  log(`open (${open.by}): readable ${open.readableMs ?? 'never'} ms, ${open.tasks.count} long tasks in ${LONG_TIMING.afterOpenMs / 1000} s, the longest ${open.tasks.maxMs} ms; ${heldOpen.blocks} blocks, ${heldOpen.rows ?? '–'} raw rows`)
  log(`the 15 s after the open, profiled:\n${profileSummary(profile).split('\n').slice(0, 14).join('\n')}`)

  // The stream into the live turn, traced.
  const s0 = await now()
  let sent: Record<string, number> = {}
  const events = await trace(c, async () => {
    sent = (await host.ask<{ streamed: Record<string, number> }>(`stream ${LONG_TIMING.streamMs}`, (o) => !!o.streamed, LONG_TIMING.streamMs + 15_000)).streamed
  })
  const s1 = await now()
  const summary = summarizeTrace(events)
  const frames = frameMainMs(events, summary.rendererPid, summary.mainTid)
  writeFileSync(join(ctx.root, `${ctx.label}.stream.trace.json`), JSON.stringify(events))
  const stream: LongResult['stream'] = { sent, frameMs: spread(frames), frames: frames.length, tasks: taskList((await c.eval<{ tasks: { start: number; duration: number }[] }>(`window.__long.between(${s0}, ${s1})`)).tasks, s0) }
  log(`stream: ${sent.delta ?? 0} deltas and ${sent.tool ?? 0} calls; main thread a frame p50 ${stream.frameMs.p50} / p95 ${stream.frameMs.p95} / max ${stream.frameMs.max} ms over ${frames.length} frames; ${stream.tasks.count} long tasks, the longest ${stream.tasks.maxMs} ms`)

  // A search hit's jump to a row older than the loaded tail.
  const before = await held(LONG_JUMP_SEQ)
  const j0 = await now()
  let armedFor: string | null = before.target
  await c.eval(`window.__long.armJump(${JSON.stringify(id)}, ${JSON.stringify(before.target ?? '\u0000')})`)
  await c.eval(`window.__docket.open(${JSON.stringify(id)}, { seq: ${LONG_JUMP_SEQ} }).then(() => true)`)
  const jumpUntil = Date.now() + LONG_TIMING.jumpWaitMs
  let landed: number | null = null
  while (Date.now() < jumpUntil && landed === null) {
    await sleep(100)
    landed = await c.eval<number | null>('window.__long.jump.at')
    const h = await held(LONG_JUMP_SEQ)
    // The row's block came into the store after the ask: watch for that block on screen from now.
    if (landed === null && h.target && h.target !== armedFor) {
      armedFor = h.target
      await c.eval(`(() => { const t = window.__long.jump.t0; window.__long.armJump(${JSON.stringify(id)}, ${JSON.stringify(h.target)}); window.__long.jump.t0 = t; return true })()`)
    }
  }
  await c.eval("window.__long.disarm('jump')")
  const j1 = await now()
  const jump: LongResult['jump'] = { seq: LONG_JUMP_SEQ, oldestLoaded: before.oldest, inLoaded: before.target !== null, landedMs: landed === null ? null : round(landed - j0), tasks: taskList((await c.eval<{ tasks: { start: number; duration: number }[] }>(`window.__long.between(${j0}, ${j1})`)).tasks, j0) }
  log(`jump to seq ${LONG_JUMP_SEQ} (oldest loaded ${before.oldest}): ${jump.landedMs === null ? `did not land in ${LONG_TIMING.jumpWaitMs / 1000} s` : `landed in ${jump.landedMs} ms`}`)

  // To the top, a "Load earlier messages" press at a time.
  const pane = `[...document.querySelectorAll('[data-session-drop=${JSON.stringify(id)}]')].find((e) => e.getBoundingClientRect().width > 0)`
  // A wheel up first: a transcript that follows its live turn lets go only for the reader's own scroll (as the scenarios scene does).
  const toTop = `(() => { const v = ${pane}?.querySelector('.agent-transcript'); if (!v) return false; v.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true })); v.scrollTop = 0; v.dispatchEvent(new Event('scroll')); return true })()`
  const pressMore = `(() => { const b = [...(${pane}?.querySelectorAll('button') ?? [])].find((e) => e.textContent.trim() === 'Load earlier messages'); if (!b) return false; b.click(); return true })()`
  const top0 = await now()
  const topStart = Date.now()
  const stepMs: number[] = []
  let reached = false
  while (!ctx.gate && Date.now() - topStart < LONG_TIMING.topBudgetMs && stepMs.length < LONG_TIMING.topMaxSteps) {
    await c.eval(toTop)
    let pressed = false
    for (let i = 0; i < 20 && !pressed; i++) {
      await sleep(100)
      const h = await held()
      pressed = await c.eval<boolean>(pressMore)
      if (pressed) {
        const p0 = Date.now()
        const until = p0 + LONG_TIMING.topStepWaitMs
        while (Date.now() < until && (await held()).oldest === h.oldest) await sleep(50)
        stepMs.push(Date.now() - p0)
      }
    }
    if (!pressed) {
      reached = true
      break
    }
  }
  if (!stepMs.length && !ctx.gate) await explain(ctx, id, 'top')
  const top1 = await now()
  const heldTop = await held()
  const top: LongResult['top'] = { steps: stepMs.length, reached, ms: Date.now() - topStart, stepMs: spread(stepMs), tasks: taskList((await c.eval<{ tasks: { start: number; duration: number }[] }>(`window.__long.between(${top0}, ${top1})`)).tasks, top0), heldAfter: { blocks: heldTop.blocks, rows: heldTop.rows, oldest: heldTop.oldest } }
  log(`top: ${top.steps} presses in ${(top.ms / 1000).toFixed(1)} s (${reached ? 'reached the top' : 'stopped at the budget'}), a press p50 ${top.stepMs.p50} / max ${top.stepMs.max} ms, ${top.tasks.count} long tasks, the longest ${top.tasks.maxMs} ms; oldest seq now ${heldTop.oldest}`)
  host.close()

  const result: LongResult = { rows: ctx.longRows ?? 0, open, stream, jump, top }
  const verdict = judgeLong(result, LONG_RULE, ctx.gate)
  const md = [
    `# ${ctx.label}: long scene, one agent-shaped thread beside ${ctx.children.length - 1} running threads (${process.platform})`,
    '',
    '| step | time | long tasks | longest ms | |',
    '|---|---|---|---|---|',
    `| open from the ${open.by === 'rail' ? 'rail' : 'opener'} | readable ${open.readableMs ?? 'never'} ms | ${open.tasks.count} in 15 s | ${open.tasks.maxMs} | ${open.held.blocks} blocks, ${open.held.rows ?? '–'} raw rows |`,
    `| stream ${LONG_TIMING.streamMs / 1000} s | a frame p50 ${stream.frameMs.p50} / p95 ${stream.frameMs.p95} / max ${stream.frameMs.max} ms | ${stream.tasks.count} | ${stream.tasks.maxMs} | ${frames.length} frames, ${sent.delta ?? 0} deltas |`,
    `| jump to seq ${LONG_JUMP_SEQ} | ${jump.landedMs === null ? 'did not land' : `${jump.landedMs} ms`} | ${jump.tasks.count} | ${jump.tasks.maxMs} | oldest loaded ${jump.oldestLoaded} |`,
    `| to the top | ${top.steps} presses, ${(top.ms / 1000).toFixed(1)} s, a press p50 ${top.stepMs.p50} / max ${top.stepMs.max} ms | ${top.tasks.count} | ${top.tasks.maxMs} | ${ctx.gate ? 'not climbed (the gate runs no climb)' : top.reached ? 'reached' : 'stopped at the budget'}, oldest ${top.heldAfter.oldest} |`,
    '',
    `Long tasks after the open (ms from the click: length): ${open.tasks.list.map((t) => `${t.at}: ${t.ms}`).join(', ') || 'none'}.`,
    '',
    `The CPU profile of the 15 s after the open: ${profilePath} (bun scripts/profile-summary.ts ${profilePath}).`
  ]
  return finish(ctx, 'long', { rule: LONG_RULE, timing: LONG_TIMING, thread: id, result }, verdict, md)
}

// ── day ──────────────────────────────────────────────────────────────────
async function heapAfterGc(c: Cdp): Promise<number> {
  await c.send('HeapProfiler.collectGarbage')
  await c.send('HeapProfiler.collectGarbage')
  const heap = (await c.send('Runtime.getHeapUsage')) as { usedSize: number }
  return round(heap.usedSize / 2 ** 20)
}

export async function recordDay(ctx: QuietCtx): Promise<boolean> {
  const { c, log } = ctx
  await c.send('HeapProfiler.enable')
  await sleep(DAY_TIMING.warmMs)
  const heapStartMb = await heapAfterGc(c)
  const start = await c.eval<StoreCensus>(STORE_CENSUS)
  const cpu0 = ctx.cpuSeconds(ctx.rendererPid)
  const w0 = Date.now()
  const opened: string[] = []
  for (let i = 0; i < DAY_TIMING.opens; i++) {
    const due = w0 + (i * DAY_TIMING.windowMs) / DAY_TIMING.opens
    while (Date.now() < due) await sleep(100)
    const id = ctx.children[i]!
    await c.eval(`window.__docket.open(${JSON.stringify(id)}).then(() => true)`)
    await ctx.waitFor(c, `[...document.querySelectorAll('[data-session-drop=${JSON.stringify(id)}] [data-row]')].length > 0`, 20_000, `the rows of ${id}`)
    opened.push(id)
    log(`opened ${id} at ${((Date.now() - w0) / 1000).toFixed(1)} s`)
  }
  while (Date.now() < w0 + DAY_TIMING.windowMs) await sleep(100)
  const cpuPct = round(((ctx.cpuSeconds(ctx.rendererPid) - cpu0) / ((Date.now() - w0) / 1000)) * 100)
  const heapEndMb = await heapAfterGc(c)
  const end = await c.eval<StoreCensus>(STORE_CENSUS)
  const result: DayResult = { heapStartMb, heapEndMb, opened, start, end }
  const verdict = judgeDay(result)
  const raw = rawRows(end)
  log(`heap after GC ${heapStartMb} → ${heapEndMb} MB; ${end.loaded.length} transcripts loaded, ${end.mounted} mounted (${end.closure ?? '–'} with their closure), raw rows ${raw.total} (the most ${raw.max}, ${raw.perLoaded} a loaded one); CPU ${cpuPct}%`)
  const md = [
    `# ${ctx.label}: day scene, ${opened.length} threads opened and left inside ${DAY_TIMING.windowMs / 1000} s while ${ctx.children.length} stream (${process.platform})`,
    '',
    `Heap after GC ${heapStartMb} MB at the start, ${heapEndMb} MB at the end. Renderer CPU ${cpuPct}% of one core over the window.`,
    '',
    `At the end: ${end.loaded.length} transcripts loaded, ${end.mounted} mounted (${end.closure ?? '–'} with their subagents and batch), ${end.recent ?? '–'} kept as recently shown; raw rows kept ${raw.total} in all, the most ${raw.max}, ${raw.perLoaded} a loaded transcript.`,
    '',
    '| loaded transcript | mounted | busy | blocks | raw rows |',
    '|---|---|---|---|---|',
    ...end.loaded.map((l) => `| ${l.id} | ${l.mounted ? 'yes' : 'no'} | ${l.busy ? 'yes' : 'no'} | ${l.blocks} | ${l.rows ?? '–'} |`)
  ]
  return finish(ctx, 'day', { rule: DAY_RULE, timing: DAY_TIMING, cpuPct, rawRows: raw, result }, verdict, md)
}
