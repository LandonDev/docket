/**
 * The desktop's viewer on the Mac (plan task 3.4, docs/agents/live-video.md "The proofs"): the viewer's own worker
 * (src/renderer/src/lib/video/video.worker.ts, bundled for the browser with `bun build`) in a real Chromium, an
 * Electron window of this checkout (scripts/lib/videoViewerElectron.cjs), on a stream of TC Probe's busy window from
 * the real tc-computer through the in-process host (scripts/lib/videoRig.ts). The page hands the worker a canvas
 * (`transferControlToOffscreen`) and posts `surface`, `open` and `bind` as streams.ts does; the worker's `drawn`,
 * `count` and `closed` come back through the page's console.
 *
 *  1. 10 s after 2 s: frames drawn a second (110 or more from a source that sends 119, or the screen's own rate
 *     when lower), no `closed`, and the viewer's wait from arrival to draw read at the host from the acks
 *  2. 10 s more with the page's main thread kept busy 8 ms of every 16: the worker's rate must not fall
 *  3. `VideoDecoder.isConfigSupported` for the stream's codec string, by default and with `prefer-hardware`
 *
 * It shows windows, so it starts only after five minutes with no input, waiting at most 45 minutes, and stops the
 * moment input returns. Nothing stays but report.json and trace.log under /tmp/tc-video-viewer-proof.
 *
 * Run on the Mac: bun run script:e2e-video-viewer (esbuild → node).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { h264Codec, parseFrame } from '../src/shared/video/nsl1'
import { gateScreenSkip } from './lib/macScreen'
import { repoRoot } from './lib/repoRoot'
import { waitForComputerProof } from './lib/computerProofGate'
import { sweepComputerProofProcesses } from './lib/computerProofProcesses'
import { startVideoRig, type VideoRig } from './lib/videoRig'
import { idleGate, InputReturned, percentile, watchInput } from './lib/videoProof'

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

const WORK = '/tmp/tc-video-viewer-proof'
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
  screenHz: 0,
  load: [] as number[],
  loadMax: 0,
  idleAtStart: 0,
  codec: '',
  support: null as null | { default: boolean; preferHardware: boolean },
  checks: [] as { name: string; outcome: 'passed' | 'failed' | 'not run' | 'finding'; detail: string }[],
  phases: [] as Record<string, unknown>[],
  page: [] as string[]
}
const save = (): void => writeFileSync(REPORT, JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2))
const check = (name: string, ok: boolean | 'finding' | 'not run', detail: string): void => {
  const outcome = ok === 'finding' || ok === 'not run' ? ok : ok ? 'passed' : 'failed'
  report.checks.push({ name, outcome, detail })
  console.log(`${outcome === 'passed' ? 'PASS' : outcome === 'failed' ? 'FAIL' : outcome === 'finding' ? 'FIND' : 'SKIP'}  ${name} — ${detail}`)
}
const loads = (): number[] => execFileSync('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' }).replace(/[{}]/g, '').trim().split(/\s+/).map(Number)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>TC video viewer proof</title>
<style>html,body{margin:0;background:#111}canvas{width:640px;height:416px;display:block}</style></head>
<body><canvas id="c"></canvas><script>
const log = (kind, data) => console.log(JSON.stringify({ kind, at: Date.now(), ...data }))
const worker = new Worker('/page/worker.js')
worker.onmessage = (e) => log('worker', e.data)
worker.onerror = (e) => log('error', { message: String(e.message) })
const canvas = document.getElementById('c').transferControlToOffscreen()
worker.postMessage({ t: 'surface', surface: 1, canvas }, [canvas])
// as streams.ts does on video.open's answer: the stream opened and bound to the canvas
window.go = (url) => {
  worker.postMessage({ t: 'open', stream: 1, url })
  worker.postMessage({ t: 'bind', surface: 1, stream: 1 })
  log('go', {})
}
log('ready', {})
let burning = null
let burnt = 0
window.burn = (on) => {
  clearInterval(burning)
  burning = on ? setInterval(() => { const end = performance.now() + 8; while (performance.now() < end) {} burnt++ }, 16) : null
  log('burn', { on })
}
// the main thread's own frames, to show it is the one kept busy
let mainFrames = 0
const count = () => { mainFrames++; requestAnimationFrame(count) }
requestAnimationFrame(count)
setInterval(() => log('main', { frames: mainFrames, burnt }), 1000)
window.support = async (codec, w, h) => {
  const base = { codec, codedWidth: w, codedHeight: h }
  const plain = await VideoDecoder.isConfigSupported(base)
  const hard = await VideoDecoder.isConfigSupported({ ...base, hardwareAcceleration: 'prefer-hardware' })
  log('support', { default: plain.supported === true, preferHardware: hard.supported === true })
}
</script></body></html>`

let rig: VideoRig | null = null
let electron: ChildProcess | null = null

interface PageLine { kind: string; at: number; t?: string; stream?: number; frames?: number; fps?: number; code?: number; fault?: string; width?: number; height?: number; on?: boolean; default?: boolean; preferHardware?: boolean; message?: string; burnt?: number }

async function run(): Promise<void> {
  execFileSync('xcrun', ['swiftc', '-O', '-o', PROBE, join(ROOT, 'scripts/mac/computer-proof-probe.swift')], { stdio: 'pipe' })
  execFileSync('codesign', ['-s', '-', '--force', PROBE], { stdio: 'pipe' })
  const probe = <T>(command: string): T => JSON.parse(execFileSync(PROBE, command.split(' '), { encoding: 'utf8', timeout: 10_000 })) as T
  // the worker for the browser, as the app's renderer bundles it
  // TC_VIEWER_PROBE=1: the same worker behind a shim that counts its clock, decoder and socket (lib/viewerProbe)
  const entry = process.env.TC_VIEWER_PROBE === '1' ? 'scripts/lib/viewerProbe/entry.ts' : 'src/renderer/src/lib/video/video.worker.ts'
  execFileSync('bun', ['build', join(ROOT, entry), '--target=browser', '--format=iife', `--outfile=${join(WORK, 'worker.js')}`], { cwd: ROOT, stdio: 'pipe' })
  const gate = await idleGate(() => probe<{ seconds: number }>('idle').seconds, console.log)
  report.idleAtStart = gate.idle
  if (!gate.ok) return check('the idle gate', 'not run', gate.why)
  report.load = loads()
  watchInput.start(() => probe<{ seconds: number }>('idle').seconds)
  rig = await startVideoRig({ root: ROOT, work: WORK, trace: TRACE, probe: PROBE, frontmost: () => probe('frontmost') })
  rig.serve('worker.js', 'text/javascript', readFileSync(join(WORK, 'worker.js')))
  rig.serve('viewer.html', 'text/html', PAGE)

  const page = `http://127.0.0.1:${rig.port}/page/viewer.html`
  const lines: PageLine[] = []
  electron = spawn(join(ROOT, 'node_modules/.bin/electron'), [join(ROOT, 'scripts/lib/videoViewerElectron.cjs')], {
    cwd: ROOT,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')), TC_VIEWER_DATA: join(WORK, 'electron'), TC_VIEWER_PAGE: page },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  createInterface({ input: electron.stdout! }).on('line', (line) => {
    if (line.startsWith('SCREEN ')) report.screenHz = Number(line.slice(7))
    else if (line.startsWith('PAGE ')) {
      try {
        const parsed = JSON.parse(line.slice(5)) as PageLine
        lines.push(parsed)
        if (parsed.kind !== 'main' && parsed.t !== 'count' && parsed.t !== 'probe') report.page.push(line.slice(5))
        if (parsed.t === 'probe') report.page.push(line.slice(5))
      } catch {
        report.page.push(line.slice(5))
      }
    } else if (line.trim()) report.page.push(line)
  })
  createInterface({ input: electron.stderr! }).on('line', (line) => /error/i.test(line) && !/disk_cache|simple_/.test(line) && report.page.push(`stderr: ${line}`))
  for (const until = Date.now() + 20_000; !lines.some((l) => l.kind === 'ready') && Date.now() < until; ) await watchInput.nap(50)
  if (!lines.some((l) => l.kind === 'ready')) return check('the page loaded', false, report.page.slice(-3).join(' | '))

  // video.open, and the viewer's socket at once, as the app's viewer does; the codec string from the first keyframe
  const conn = await rig.service.connection()
  let codec = ''
  const off = conn.onBytes((_stream, message) => {
    if (codec) return
    try {
      const frame = parseFrame(message)
      if (frame.keyframe) codec = h264Codec(frame.data)
    } catch {
      /* an ack or a frame without its SPS */
    }
  })
  const opened = await rig.open(3_840)
  electron.stdin!.write(`eval window.go(${JSON.stringify(opened.url)})\n`)
  for (const until = Date.now() + 5_000; !codec && Date.now() < until; ) await watchInput.nap(25)
  off()
  report.codec = codec
  electron.stdin!.write(`eval window.support(${JSON.stringify(codec)}, ${opened.width}, ${opened.height})\n`)

  const loadSeen: number[] = []
  const sampler = setInterval(() => loadSeen.push(loads()[0]), 1_000)
  for (const until = Date.now() + 10_000; !lines.some((l) => l.t === 'drawn') && Date.now() < until; ) await watchInput.nap(50)
  if (!lines.some((l) => l.t === 'drawn')) {
    clearInterval(sampler)
    return check('the worker drew the stream', false, `nothing drawn in 10 s; page: ${JSON.stringify(lines.slice(-5))} ${report.page.slice(-3).join(' | ')}`)
  }
  await watchInput.nap(2_000)
  const phase = async (name: string): Promise<Record<string, number | string>> => {
    const from = Date.now()
    await watchInput.nap(10_000)
    const to = Date.now()
    const counts = lines.filter((l) => l.t === 'count' && l.at >= from && l.at <= to)
    const before = [...lines].reverse().find((l) => l.t === 'count' && l.at < from)
    const drawn = (counts.at(-1)?.frames ?? 0) - (before?.frames ?? 0)
    const seconds = ((counts.at(-1)?.at ?? to) - (before?.at ?? from)) / 1000
    const waits = rig!.waits.filter((w) => w.at >= from && w.at <= to).map((w) => w.micros / 1000)
    const main = lines.filter((l) => l.kind === 'main' && l.at >= from && l.at <= to)
    const span = main.length > 1 ? (main.at(-1)!.at - main[0].at) / 1000 : 0
    const mainFps = span ? (main.at(-1)!.frames! - main[0].frames!) / span : 0
    // the 8 ms burns the page's timer made a second: about 62 when it holds its 16 ms beat
    const burns = span ? (main.at(-1)!.burnt! - main[0].burnt!) / span : 0
    const out = { name, drawn, seconds, fps: drawn / seconds, waitP50: percentile(waits, 0.5), waitP95: percentile(waits, 0.95), acks: waits.length, mainFps, burns }
    report.phases.push(out)
    return out
  }
  const calm = await phase('calm')
  electron.stdin!.write('eval window.burn(true)\n')
  await watchInput.nap(500)
  const busy = await phase('main thread busy 8 ms of every 16')
  electron.stdin!.write('eval window.burn(false)\n')
  clearInterval(sampler)
  report.loadMax = Math.max(...loadSeen, loads()[0])
  const closed = lines.filter((l) => l.t === 'closed')
  const support = [...lines].reverse().find((l) => l.kind === 'support')
  report.support = support ? { default: support.default === true, preferHardware: support.preferHardware === true } : null

  const f = (n: number, d = 1): string => Number(n).toFixed(d)
  const hz = report.screenHz
  const want = Math.min(110, hz > 0 ? hz - 2 : 110)
  if (report.loadMax >= 12) check('measured on a quiet Mac', 'not run', `the 1-minute load reached ${f(report.loadMax)} during the windows (another job): the rates are void`)
  else {
    check(`frames drawn a second, ${want} or more (screen ${hz} Hz)`, Number(calm.fps) >= want, `${f(Number(calm.fps))} fps (${calm.drawn} drawn in ${f(Number(calm.seconds), 2)} s)`)
    check(`with the page's main thread busy the worker's rate holds`, Number(busy.fps) >= want && Number(busy.fps) >= Number(calm.fps) - 5, `${f(Number(busy.fps))} fps against ${f(Number(calm.fps))} calm; the main thread burnt 8 ms ${f(Number(busy.burns))} times a second (${f(Number(busy.burns) * 0.8)}% of it) and drew ${f(Number(busy.mainFps))} frames a second against ${f(Number(calm.mainFps))}`)
  }
  check('the viewer\'s wait from arrival to draw (the acks, read at the host)', 'finding', `calm p50 ${f(Number(calm.waitP50), 2)} ms, p95 ${f(Number(calm.waitP95), 2)} ms; busy p50 ${f(Number(busy.waitP50), 2)} ms, p95 ${f(Number(busy.waitP95), 2)} ms`)
  check('the stream never closed', closed.length === 0, closed.length ? JSON.stringify(closed) : 'no closed message')
  check(`VideoDecoder.isConfigSupported for ${codec || 'the codec'}`, report.support ? (report.support.default ? true : false) : false, report.support ? `default ${report.support.default}, prefer-hardware ${report.support.preferHardware}` : 'no answer from the page')
}

const cleanup = async (): Promise<void> => {
  watchInput.stop()
  if (electron && electron.exitCode === null) {
    electron.stdin?.write('quit\n')
    await new Promise((r) => setTimeout(r, 1_000))
    if (electron.exitCode === null) electron.kill('SIGKILL')
  }
  electron = null
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
