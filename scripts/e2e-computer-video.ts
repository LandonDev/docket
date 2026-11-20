/**
 * The Mac proof of live video's host path (plan task 6.6, docs/computer-protocol.md §30 "Measured"): the real
 * tc-computer under the in-process host pieces index.ts wires (scripts/lib/videoRig.ts), a viewer that is a
 * `ws` socket on the loopback server's `/video/<stream>`, parsing each frame and acking it at once. TC Probe runs
 * `--busy`, so its window changes on every refresh.
 *
 *  1. `video.open` on the local socket's principal, at the window's own size (maxEdge 3840, `quality`): 10 s
 *     measured after 2 s
 *  2. the same through the publish leg's ask (`budget`, 1280 on the long edge)
 *
 * Each measures frames a second at the viewer, capture to host arrival (the service stamps CLOCK_UPTIME_RAW in
 * µs; the host reads `process.hrtime`, which libuv takes from the same mach clock on macOS, checked at the start
 * against CLOCK_UPTIME_RAW read by another process), the service's CPU, the host's event-loop lag, the bitrate
 * through it, and the encode times the service's trace gives.
 *
 * It shows a window, so it starts only after five minutes with no input, the screen unlocked and awake, waiting at
 * most 45 minutes, and stops the moment input returns. Nothing stays but report.json and trace.log under
 * /tmp/tc-video-proof.
 *
 * Run on the Mac: bun run script:e2e-computer-video (esbuild → node, as script:e2e-computer-preview).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { WebSocket } from 'ws'
import { encodeAck, parseFrame, SUBPROTOCOL } from '../src/shared/video/nsl1'
import { gateScreenSkip } from './lib/macScreen'
import { repoRoot } from './lib/repoRoot'
import { waitForComputerProof } from './lib/computerProofGate'
import { sweepComputerProofProcesses } from './lib/computerProofProcesses'
import { startVideoRig, type VideoRig } from './lib/videoRig'
import { idleGate, InputReturned, percentile, sameClock, screenRefresh, serviceCpuSeconds, watchInput } from './lib/videoProof'

if (process.platform !== 'darwin') {
  console.log('skipped: macOS only')
  process.exit(0)
}
const ROOT = repoRoot()
const screenSkip = gateScreenSkip(false, ROOT)
if (screenSkip) {
  console.log(screenSkip)
  process.exit(0)
}
await waitForComputerProof(console.log)
sweepComputerProofProcesses(console.log)

const WORK = '/tmp/tc-video-proof'
const REPORT = join(WORK, 'report.json')
const TRACE = join(WORK, 'trace.log')
const KEEP = new Set(['report.json', 'trace.log'])
const PROBE = join(WORK, 'computer-proof-probe')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
writeFileSync(TRACE, '')

const report = {
  startedAt: new Date().toISOString(),
  finishedAt: '',
  machine: '',
  display: { hz: 0 },
  load: [] as number[],
  idleAtStart: 0,
  clock: '',
  checks: [] as { name: string; outcome: 'passed' | 'failed' | 'not run' | 'finding'; detail: string }[],
  runs: [] as Record<string, unknown>[]
}
const save = (): void => writeFileSync(REPORT, JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2))
const check = (name: string, ok: boolean | 'finding' | 'not run', detail: string): void => {
  const outcome = ok === 'finding' || ok === 'not run' ? ok : ok ? 'passed' : 'failed'
  report.checks.push({ name, outcome, detail })
  console.log(`${outcome === 'passed' ? 'PASS' : outcome === 'failed' ? 'FAIL' : outcome === 'finding' ? 'FIND' : 'SKIP'}  ${name} — ${detail}`)
}
const loads = (): number[] => execFileSync('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' }).replace(/[{}]/g, '').trim().split(/\s+/).map(Number)

let rig: VideoRig | null = null

async function measure(rig: VideoRig, name: string, maxEdge: number, published: boolean, hz: number): Promise<void> {
  const opened = await rig.open(maxEdge, published)
  const ws = new WebSocket(opened.url, [SUBPROTOCOL])
  ws.binaryType = 'nodebuffer'
  const frames: { at: bigint; captured: bigint; bytes: number; width: number; height: number }[] = []
  let closed: { code: number; reason: string } | null = null
  ws.on('message', (data: Buffer, binary: boolean) => {
    if (!binary) return
    const at = process.hrtime.bigint()
    const frame = parseFrame(data)
    frames.push({ at, captured: BigInt(frame.timestamp) * 1_000n, bytes: data.byteLength, width: frame.width, height: frame.height })
    ws.send(encodeAck(frame.generation, frame.sequence, 0))
  })
  ws.on('close', (code, reason) => (closed = { code, reason: String(reason) }))
  await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)))
  await watchInput.nap(2_000)
  // a 1 ms sampling timer: an idle loop reads about 1 ms, which the figures include
  const lag = monitorEventLoopDelay({ resolution: 1 })
  const loadSeen: number[] = []
  const sampler = setInterval(() => loadSeen.push(loads()[0]), 1_000)
  const from = process.hrtime.bigint()
  const fromMs = Date.now()
  const cpu0 = serviceCpuSeconds(rig.servicePid)
  const waits0 = rig.waits.length
  lag.enable()
  await watchInput.nap(10_000)
  lag.disable()
  clearInterval(sampler)
  const busiest = Math.max(...loadSeen, loads()[0])
  const cpu1 = serviceCpuSeconds(rig.servicePid)
  const to = process.hrtime.bigint()
  const seconds = Number(to - from) / 1e9
  ws.close()
  const window = frames.filter((f) => f.at >= from && f.at < to)
  const fps = window.length / seconds
  const latency = window.map((f) => Number(f.at - f.captured) / 1e6)
  const mbps = (window.reduce((n, f) => n + f.bytes, 0) * 8) / seconds / 1e6
  const cores = (cpu1 - cpu0) / seconds
  const encodes = rig.encodes.filter((e) => e.at >= fromMs + 1_000 && e.at <= fromMs + 11_000).flatMap((e) => e.micros.map((m) => m / 1_000))
  const size = window.at(-1) ? `${window.at(-1)!.width}×${window.at(-1)!.height}` : `${opened.width}×${opened.height}`
  const run = {
    name,
    mode: published ? 'budget' : 'quality',
    size,
    seconds,
    frames: window.length,
    fps,
    captureToViewerMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95) },
    serviceCores: cores,
    eventLoopMs: { p50: lag.percentile(50) / 1e6, p95: lag.percentile(95) / 1e6, max: lag.max / 1e6 },
    mbps,
    encodeMs: { p50: percentile(encodes, 0.5), p95: percentile(encodes, 0.95), samples: encodes.length },
    acks: rig.waits.length - waits0,
    closed,
    loadMax: busiest
  }
  report.runs.push(run)
  const f = (n: number, d = 1): string => n.toFixed(d)
  // the figures of a busy Mac say nothing of the stream
  if (busiest >= 12) {
    check(`${name}: measured on a quiet Mac`, 'not run', `the 1-minute load reached ${f(busiest)} during the window (another job): its figures are void`)
    return void (await watchInput.nap(500))
  }
  if (!published) check(`${name}: 100 fps or more at the viewer on a ${hz} Hz display`, hz >= 120 ? fps >= 100 : 'finding', `${f(fps)} fps (${window.length} frames in ${f(seconds, 2)} s) at ${size}`)
  else check(`${name}: frames a second at the viewer`, 'finding', `${f(fps)} fps at ${size}`)
  check(`${name}: capture to the host's viewer socket`, report.clock.startsWith('same') ? 'finding' : 'not run', report.clock.startsWith('same') ? `p50 ${f(run.captureToViewerMs.p50, 2)} ms, p95 ${f(run.captureToViewerMs.p95, 2)} ms` : `the clocks could not be shown to be one: ${report.clock}`)
  check(`${name}: the service under half a core`, cores < 0.5, `${f(cores, 3)} cores`)
  check(`${name}: the host's event loop`, 'finding', `lag p50 ${f(run.eventLoopMs.p50, 2)} ms, p95 ${f(run.eventLoopMs.p95, 2)} ms, max ${f(run.eventLoopMs.max, 2)} ms; ${f(mbps, 2)} Mbit/s through it`)
  check(`${name}: encode p95 under 12 ms (the service's trace)`, encodes.length ? run.encodeMs.p95 < 12 : 'not run', encodes.length ? `p50 ${f(run.encodeMs.p50, 2)} ms, p95 ${f(run.encodeMs.p95, 2)} ms over ${encodes.length} frames` : 'no encode line in the trace')
  check(`${name}: the stream stayed open`, closed === null, closed ? `closed ${(closed as { code: number }).code}` : 'open until the proof closed it')
  await watchInput.nap(500)
}

async function run(): Promise<void> {
  execFileSync('xcrun', ['swiftc', '-O', '-o', PROBE, join(ROOT, 'scripts/mac/computer-proof-probe.swift')], { stdio: 'pipe' })
  execFileSync('codesign', ['-s', '-', '--force', PROBE], { stdio: 'pipe' })
  const probe = <T>(command: string): T => JSON.parse(execFileSync(PROBE, command.split(' '), { encoding: 'utf8', timeout: 10_000 })) as T
  report.machine = execFileSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).trim() + ', ' + execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim()
  report.clock = sameClock()
  const gate = await idleGate(() => probe<{ seconds: number }>('idle').seconds, console.log)
  report.idleAtStart = gate.idle
  if (!gate.ok) {
    check('the idle gate', 'not run', gate.why)
    return
  }
  report.load = loads()
  watchInput.start(() => probe<{ seconds: number }>('idle').seconds)
  rig = await startVideoRig({ root: ROOT, work: WORK, trace: TRACE, probe: PROBE, frontmost: () => probe('frontmost') })
  const hz = screenRefresh(WORK, rig.probePid)
  report.display.hz = hz
  console.log(`display ${hz} Hz, load ${report.load.join(' ')}, idle ${gate.idle} s, clock: ${report.clock}`)
  await measure(rig, 'quality, the window\'s own size', 3_840, false, hz)
  await measure(rig, 'budget, as the publish leg asks', 1_280, true, hz)
  report.load.push(...loads())
}

const cleanup = async (): Promise<void> => {
  watchInput.stop()
  const cleaned = (await rig?.close().catch(() => [])) ?? []
  rig = null
  if (cleaned.length) console.log(`cleanup: ${cleaned.join('; ')}`)
  save()
  for (const name of readdirSync(WORK)) if (!KEEP.has(name)) rmSync(join(WORK, name), { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void cleanup().finally(() => process.exit(1)))

try {
  await run()
} catch (e) {
  if (e instanceof InputReturned) check('the run', 'not run', e.message)
  else check('the run finished', false, ((e as Error).stack ?? String(e)).split('\n').slice(0, 4).join(' '))
} finally {
  await cleanup()
}
const failed = report.checks.filter((c) => c.outcome === 'failed').length
console.log(`\n${report.checks.filter((c) => c.outcome === 'passed').length} passed, ${failed} failed; report ${REPORT}`)
process.exit(failed ? 1 : 0)
