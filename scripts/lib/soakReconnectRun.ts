import type { ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { sleep, type Cdp } from './packagedApp'
import { judgeReconnect } from './soakJudge'
import { RECONNECT_CUT_MS, RECONNECT_TIMEOUT_MS, reconnectRows, reconnectTasks, type ReconnectPhase, type ReconnectTask, type ReconnectWire } from './soakReconnect'

export type ReconnectSeed = Record<string, { rows: number; eventBytes: number }>

const OBSERVER = `(() => {
  if (window.__reconnectTasks) return
  const tasks = []
  const collect = (entries) => {
    for (const e of entries) tasks.push({ at: performance.timeOrigin + e.startTime, ms: e.duration })
  }
  const observer = new PerformanceObserver((list) => collect(list.getEntries()))
  observer.observe({ type: 'longtask', buffered: true })
  window.__reconnectTasks = () => {
    collect(observer.takeRecords())
    return tasks
  }
})()`

/** Read the real store without loading or reordering history, once each window has ended. */
async function readWindow(c: Cdp, ids: string[], focus: string, wire: ReconnectWire) {
  const [first, last] = [JSON.stringify(wire.before), JSON.stringify(wire.through)]
  const state = await c.eval<{
    tasks: ReconnectTask[]
    rows: Record<string, number[]>
    loaded: number
    focusedBusy: boolean
    focusedAdvanced: boolean
  }>(`(() => {
    const store = window.__monocode.sessionStore
    const before = ${first}, through = ${last}, focus = ${JSON.stringify(focus)}
    const rows = Object.fromEntries(${JSON.stringify(ids)}.map((id) => [
      id, (store.entries.get(id)?.rows ?? [])
        .filter((row) => row.seq > before[id] && row.seq <= through[id]).map((row) => row.seq)
    ]))
    return {
      tasks: window.__reconnectTasks(),
      rows,
      loaded: ${JSON.stringify(ids)}.filter((id) => store.get(id)?.load.phase === 'loaded' && store.mounted.has(id)).length,
      focusedBusy: store.get(focus)?.busy ?? false,
      focusedAdvanced: store.get(focus)?.blocks.some((block) => block.role === 'assistant' && block.seq > ${wire.connected[focus]}) ?? false
    }
  })()`)
  const { tasks, stats } = reconnectTasks(state.tasks, wire.start, wire.end)
  const exact = reconnectRows(wire.before, wire.through, state.rows)
  const { phase, start, end, connectedAt, connections, refusedUpgrades, remote, bytes, socketBytes, maxUnsentBytes, answers } = wire
  const summary = {
    phase, elapsedMs: end - start, connectMs: connectedAt === null ? null : connectedAt - start,
    connections, refusedUpgrades, remote, bytes, socketBytes, maxUnsentBytes, answers, longTasks: stats,
    rows: exact, loaded: state.loaded,
    streaming: connectedAt !== null && state.focusedBusy && state.focusedAdvanced
  }
  return { summary, tasks, expected: wire, observed: state.rows }
}

function hostPhase(host: ChildProcess, phase: ReconnectPhase, onBegan: () => Promise<unknown>): Promise<ReconnectWire> {
  if (!host.stdin || !host.stdout) throw new Error('the reconnect host needs piped stdin and stdout')
  const input = host.stdin
  const lines = createInterface({ input: host.stdout })
  return new Promise((resolve, reject) => {
    const clean = (): void => {
      clearTimeout(timer)
      lines.close()
      host.off('exit', failed)
    }
    const fail = (error: unknown): void => {
      clean()
      reject(error)
    }
    const failed = (code: number | null): void => fail(new Error(`the reconnect host exited (${code})`))
    const timer = setTimeout(() => fail(new Error(`the host did not finish ${phase}`)), RECONNECT_TIMEOUT_MS + 5_000)
    host.once('exit', failed)
    lines.on('line', (line) => {
      if (!line.startsWith('{')) return
      const result = JSON.parse(line) as { began?: ReconnectPhase; wire?: ReconnectWire }
      if (result.began === phase) void onBegan().catch(fail)
      if (result.wire?.phase === phase) {
        clean()
        resolve(result.wire)
      }
    })
    input.write(phase === 'cut' ? `cut ${RECONNECT_CUT_MS}\n` : 'relaunch\n', (err) => { if (err) fail(err) })
  })
}

/** `TC_RECONNECT_PROFILE=<file prefix>`: a CPU profile of the window across each phase, `<prefix>-<phase>.cpuprofile`. */
async function profiled<T>(c: Cdp, phase: ReconnectPhase, run: () => Promise<T>): Promise<T> {
  const prefix = process.env.TC_RECONNECT_PROFILE
  if (!prefix) return run()
  await c.send('Profiler.enable')
  await c.send('Profiler.setSamplingInterval', { interval: 500 })
  await c.send('Profiler.start')
  try {
    return await run()
  } finally {
    const { profile } = (await c.send('Profiler.stop')) as { profile: unknown }
    writeFileSync(`${prefix}-${phase}.cpuprofile`, JSON.stringify(profile))
  }
}

export async function recordReconnect(
  c: Cdp,
  host: ChildProcess,
  seed: ReconnectSeed,
  focus: string,
  environmentId: string,
  waitFor: (c: Cdp, expr: string, ms: number, what: string) => Promise<void>,
  log: (msg: string) => void,
  options: { still?: boolean; probeEveryMs?: number; link?: { peak(): number; resetPeak(): void } } = {}
) {
  const ids = Object.keys(seed)
  if (ids.length !== 6 || !ids.includes(focus)) throw new Error('the reconnect host must seed six threads, including the focused stream')
  await c.send('Page.enable')
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER })
  await c.eval(OBSERVER)
  const link = `window.__monocode.registry.linkOf(${JSON.stringify(environmentId)})`
  await waitFor(c, `${link}?.connected && ${link}.profile === 'remote'`, 60_000, 'the remote wire profile')
  const store = 'window.__monocode.sessionStore'
  const entry = (id: string): string => `${store}.entries.get(${JSON.stringify(id)})`
  const ordered = [...ids.filter((id) => id !== focus), focus]
  for (const [index, id] of ordered.entries()) {
    await waitFor(c, `${store}.metaOf(${JSON.stringify(id)})`, 60_000, `remote thread ${id}`)
    // Hold the promise on the page while CDP waits for the open handler.
    await c.eval(`window.__reconnectOpen = window.__monocode.open(${JSON.stringify(id)}, { split: ${index > 0} }).then(() => true)`)
  }
  await waitFor(c, ids.map((id) => `(${store}.mounted.has(${JSON.stringify(id)}) && ${entry(id)}?.load.phase === 'loaded' && ${entry(id)}?.rows?.length > 0 && !${entry(id)}?.held)`).join(' && '),
    60_000, 'the six mounted remote transcripts to load and settle')
  // Let the saved layout and the transcript rendering settle before cutting.
  await sleep(2_000)
  const loadedRows = await c.eval<number[]>(`[${ids.map((id) => `${entry(id)}.rows.length`).join(', ')}]`)
  log(`six remote transcripts loaded (${loadedRows.join(', ')} rows in the store)`)
  log('cutting the remote WebSocket for 6 s')
  // His clicks on the window: each one probes the link (registry.probeAll('foreground')).
  const forward = (): (() => void) => {
    if (!options.probeEveryMs) return () => undefined
    const timer = setInterval(() => void c.eval(`window.__monocode.registry.probeAll('foreground'), true`).catch(() => undefined), options.probeEveryMs)
    return () => clearInterval(timer)
  }
  options.link?.resetPeak()
  const stopCut = forward()
  const cutWire = await profiled(c, 'cut', () => hostPhase(host, 'cut', async () => {})).finally(stopCut)
  const cutHeld = options.link?.peak()
  const cut = await readWindow(c, ids, focus, cutWire)
  if (cutHeld !== undefined) Object.assign(cut.summary, { linkHeldBytes: cutHeld })
  log(`cut recorded, ${cut.summary.connections} connection(s), ${cut.summary.longTasks.maxMs} ms longest task`)
  log('reloading the window with its saved layout')
  options.link?.resetPeak()
  const stopRelaunch = forward()
  const relaunchWire = await hostPhase(host, 'relaunch', () => c.send('Page.reload')).finally(stopRelaunch)
  const relaunchHeld = options.link?.peak()
  const relaunch = await readWindow(c, ids, focus, relaunchWire)
  if (relaunchHeld !== undefined) Object.assign(relaunch.summary, { linkHeldBytes: relaunchHeld })
  const verdict = judgeReconnect([cut.summary, relaunch.summary], undefined, options)
  return { seed, loadedRows, cut, relaunch, verdict }
}
