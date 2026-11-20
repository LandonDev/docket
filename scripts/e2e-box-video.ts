/**
 * Live video of the box's browser, measured (docs/agents/live-video.md "The
 * proofs"): the real Chromium headed on its private display, the real engine,
 * our relay and the stream's own socket, with a viewer that acks each frame
 * as it arrives.
 *
 *  1. scroll: a page of text scrolling every frame, 1280×800, on loopback
 *       the stream holds 110 fps over 15 s
 *       capture to relay p95 is under 15 ms
 *       the engine uses less than 1.2 cores
 *  2. thin link: the same scene through 5 Mbit/s with 30 ms each way holds 100 fps
 *  3. cut: a link cut for 4 s closes the stream, and the next open plays
 *
 * Scenes 1 and 2 run `--runs` times each (5), turn about, and the medians are
 * judged: the box is shared and a single run says little. The browser, the
 * display and the engine are pinned to cores of their own (`--cores a-b`,
 * the last eight by default) so a sibling's build does not decide the result.
 * The load average is printed beside every figure.
 *
 * Needs the video tools installed (`bun scripts/work-tools/install.ts --data
 * <dir> --only screen-relay`): `--data <dir>`, else TEMP_CODE_TEST_VIDEO_TOOLS,
 * else TEMP_CODE_USER_DATA. Nothing here touches the box's live service, its
 * browser profile or its display: everything lives under a temp folder.
 *
 * Run: bun run script:e2e-box-video [-- --runs 5 --secs 15 --cores 24-31]
 * The report is /tmp/tc-box-video-proof/report.json. Exit 1 when a rule fails.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttp, type Server } from 'node:http'
import { connect, createServer as createTcp, type Socket } from 'node:net'
import { availableParallelism, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFIType, dlopen, ptr } from 'bun:ffi'
import { WebSocket } from 'ws'
import { VIDEO_CLOSE } from '../src/shared/contract-video'
import { encodeAck, parseFrame } from '../src/shared/video/nsl1'
import type { StreamClaim } from '../src/main/server/remote/auth'
import { BoxChromium, findChromium } from '../src/main/server/work/browser/box/chromium'
import { BoxXDisplay } from '../src/main/server/work/browser/box/display'
import { BoxEngines } from '../src/main/server/work/browser/box/engine'
import { EngineFeed } from '../src/main/server/work/browser/box/engineFeed'
import { BoxStage } from '../src/main/server/work/browser/box/stage'
import { videoToolsAt } from '../src/main/server/work/browser/box/videoSetting'
import { VideoRelay } from '../src/main/server/video/relay'
import { VideoSockets, refuseVideoUpgrade } from '../src/main/server/video/sockets'

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1]! : fallback
}
const RUNS = Number(arg('runs', '5'))
const SECS = Number(arg('secs', '15'))
const cpus = availableParallelism()
const CORES = arg('cores', cpus >= 16 ? `${cpus - 8}-${cpus - 1}` : `0-${cpus - 1}`)
const OUT = '/tmp/tc-box-video-proof'
const RULES = { scrollFps: 110, relayP95Ms: 15, engineCores: 1.2, thinFps: 100 }

const dataDir = process.argv.includes('--data') ? arg('data', '') : (process.env.TEMP_CODE_TEST_VIDEO_TOOLS ?? process.env.TEMP_CODE_USER_DATA ?? '')
const tools = dataDir ? videoToolsAt(dataDir) : null
const bin = findChromium()
if (process.platform !== 'linux' || !tools || !bin) {
  console.error('e2e-box-video: needs Linux, a Chromium, and the video tools (bun scripts/work-tools/install.ts --data <dir> --only screen-relay; name the dir with --data)')
  process.exit(2)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
// A frame is stamped with the engine's capture time on the kernel's monotonic clock. Bun's own clock counts from
// the start of this process, so the monotonic clock is read from libc once and the difference kept.
const libc = dlopen('libc.so.6', { clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } })
const monotonicUs = (): number => {
  const spec = new BigInt64Array(2)
  libc.symbols.clock_gettime(1, ptr(spec))
  return Number(spec[0]! * 1_000_000n + spec[1]! / 1000n)
}
const ownUs = (): number => Number(process.hrtime.bigint() / 1000n)
const clockOffsetUs = Math.min(...Array.from({ length: 16 }, () => monotonicUs() - ownUs()))
const nowUs = (): number => ownUs() + clockOffsetUs
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const quantile = (sorted: number[], q: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! : NaN)
const load = (): string => loadavg()[0]!.toFixed(1)
/** user and system time a process has used, in clock ticks (100 a second) */
const ticks = (pid: number): number => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(fields[11]) + Number(fields[12])
  } catch {
    return 0
  }
}
/** every child runs on the proof's own cores */
const pinned = ((cmd: string, args: string[], options: object) => spawn('taskset', ['-c', CORES, cmd, ...args], options)) as never as typeof spawn

const PAGE = `<!doctype html><meta charset=utf-8><title>scroll</title><style>html,body{margin:0;height:100%;overflow:hidden}#doc{position:absolute;inset:0;overflow:auto;padding:24px 15%;background:#fff;color:#111;font:15px/1.5 system-ui,sans-serif}</style><div id=doc></div><script>
const doc=document.getElementById('doc');let s='';for(let i=0;i<600;i++)s+='<h3>Section '+i+'</h3><p>'+('The quick brown fox jumps over the lazy dog, row '+i+'. ').repeat(8)+'</p>';doc.innerHTML=s
let n=0;(function frame(){n++;doc.scrollTop=(n*6)%(doc.scrollHeight-doc.clientHeight);requestAnimationFrame(frame)})()
</script>`

/** A TCP proxy that carries `kbit` a second each way, each byte `delayMs` late; `cut` stops it dead for a while. */
function link(target: number, kbit: number, delayMs: number): Promise<{ port: number; cut(ms: number): void; close(): void }> {
  const bytesPerMs = (kbit * 1000) / 8 / 1000
  let cutUntil = 0
  const pipe = (from: Socket, to: Socket): void => {
    const queue: { at: number; buf: Buffer }[] = []
    let busy = false
    let ended = false
    const pump = async (): Promise<void> => {
      if (busy) return
      busy = true
      while (queue.length) {
        const { at, buf } = queue[0]!
        const wait = Math.max(at, cutUntil) - Date.now()
        if (wait > 0) await sleep(wait)
        if (Date.now() < cutUntil) continue
        let off = 0
        while (off < buf.length) {
          const n = kbit ? Math.max(1, Math.min(buf.length - off, Math.ceil(bytesPerMs * 4))) : buf.length - off
          if (!to.destroyed) to.write(buf.subarray(off, off + n))
          off += n
          if (kbit) await sleep(n / bytesPerMs)
        }
        queue.shift()
        if (queue.length < 64) from.resume()
      }
      busy = false
      // what was on its way when the sender closed is delivered first: a close frame says why
      if (ended) to.end()
    }
    from.on('data', (buf: Buffer) => {
      queue.push({ at: Date.now() + delayMs, buf })
      if (queue.length >= 64) from.pause()
      void pump()
    })
    from.on('close', () => {
      ended = true
      void pump()
    })
    from.on('error', () => {})
  }
  const sockets = new Set<Socket>()
  const server = createTcp((client) => {
    const upstream = connect(target, '127.0.0.1')
    client.setNoDelay(true)
    upstream.setNoDelay(true)
    sockets.add(client).add(upstream)
    pipe(client, upstream)
    pipe(upstream, client)
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as { port: number }).port,
        cut: (ms) => void (cutUntil = Date.now() + ms),
        close: () => {
          for (const s of sockets) s.destroy()
          server.close()
        }
      })
    )
  )
}

interface Run {
  fps: number
  kbit: number
  relayP50: number
  relayP95: number
  viewerP50: number
  viewerP95: number
  engineCores: number
  load: string
}

const root = mkdtempSync(join(tmpdir(), 'tc-box-video-'))
mkdirSync(OUT, { recursive: true })
const checks: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
}

const browser = new BoxChromium({ root, bin: () => bin, video: () => tools, spawn: pinned, makeDisplay: (t) => new BoxXDisplay({ root, tools: t, spawn: pinned }) })
const stage = new BoxStage({ endpoint: () => browser.endpoint(), display: () => browser.display })
const engines = new BoxEngines({ root, tools: () => browser.tools, display: () => browser.display, spawn: pinned })
const relay = new VideoRelay()
/** capture to relay, in ms, for every frame the relay passes while a scene is measured */
let relayLat: number[] | null = null
const tickets = new Map<string, StreamClaim>()
const sockets = new VideoSockets(relay, { consumeStreamTicket: (ticket, stream) => (tickets.get(ticket)?.stream === stream ? tickets.get(ticket)! : null) })
let http: Server
let site: Server
const kids: ChildProcess[] = []

/** One stream of the page, through the relay and its socket at `port`; the viewer acks each frame on arrival. */
async function view(port: number): Promise<{ ws: WebSocket; frames: () => number; bytes: () => number; lat: number[]; enginePid: number; closed: Promise<number> }> {
  const lease = (await engines.lease())!
  const feed = new EngineFeed(lease, false)
  const real = feed.start.bind(feed)
  feed.start = (sink) =>
    real({
      frame: (bytes) => {
        if (relayLat) relayLat.push((nowUs() - Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(24))) / 1000)
        sink.frame(bytes)
      },
      end: sink.end
    })
  const holder = { keyId: 'proof' }
  const stream = relay.open({ thread: 'proof', scope: 'watch', holder, connection: {}, feed })
  const ticket = `t-${stream}`
  tickets.set(ticket, { stream, scope: 'watch', holder })
  const ws = new WebSocket(`ws://127.0.0.1:${port}/video/${stream}?ticket=${ticket}`, ['nsl1'])
  ws.binaryType = 'nodebuffer'
  let frames = 0
  let bytes = 0
  const lat: number[] = []
  ws.on('message', (data: Buffer) => {
    const frame = parseFrame(data)
    frames++
    bytes += data.length
    lat.push((nowUs() - frame.timestamp) / 1000)
    ws.send(encodeAck(frame.generation, frame.sequence, 0))
  })
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  return { ws, frames: () => frames, bytes: () => bytes, lat, enginePid: lease.pid ?? 0, closed }
}

async function measure(port: number): Promise<Run> {
  const v = await view(port)
  // the first second is the keyframe and the encoder finding its rate
  await sleep(2_000)
  const f0 = v.frames()
  const b0 = v.bytes()
  const t0 = ticks(v.enginePid)
  v.lat.length = 0
  relayLat = []
  const started = Date.now()
  await sleep(SECS * 1000)
  const wall = (Date.now() - started) / 1000
  const frames = v.frames() - f0
  const bytes = v.bytes() - b0
  const engineCores = (ticks(v.enginePid) - t0) / 100 / wall
  const relayed = [...relayLat].sort((a, b) => a - b)
  relayLat = null
  const seen = [...v.lat].sort((a, b) => a - b)
  v.ws.close()
  await v.closed
  await sleep(300)
  return {
    fps: +(frames / wall).toFixed(1),
    kbit: Math.round((bytes * 8) / 1000 / wall),
    relayP50: +quantile(relayed, 0.5).toFixed(1),
    relayP95: +quantile(relayed, 0.95).toFixed(1),
    viewerP50: +quantile(seen, 0.5).toFixed(1),
    viewerP95: +quantile(seen, 0.95).toFixed(1),
    engineCores: +engineCores.toFixed(2),
    load: load()
  }
}

let code = 1
try {
  site = createHttp((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(PAGE)
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()))
  http = createHttp((_req, res) => res.writeHead(426).end())
  http.on('upgrade', (req, socket, head) => {
    const refused = sockets.upgrade(req, socket, head, 'remote')
    if (refused !== null) refuseVideoUpgrade(socket, refused)
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
  const direct = (http.address() as { port: number }).port

  console.log(`e2e-box-video: ${RUNS} runs of ${SECS} s a scene, pinned to cores ${CORES}; load ${load()}`)
  await browser.endpoint()
  if (!browser.display) throw new Error('the browser did not start headed')
  const target = await stage.open(`http://127.0.0.1:${(site.address() as { port: number }).port}/`)
  await stage.watch(target)
  // the notice that says how to leave full screen is gone after a few seconds
  await sleep(5_000)

  const thin = await link(direct, 5_000, 30)
  const scroll: Run[] = []
  const slow: Run[] = []
  for (let i = 0; i < RUNS; i++) {
    scroll.push(await measure(direct))
    console.log(`  scroll ${i + 1}/${RUNS}: ${JSON.stringify(scroll.at(-1))}`)
    slow.push(await measure(thin.port))
    console.log(`  thin   ${i + 1}/${RUNS}: ${JSON.stringify(slow.at(-1))}`)
  }
  const med = (runs: Run[], key: keyof Omit<Run, 'load'>): number => median(runs.map((r) => r[key]))
  console.log('')
  check(`scroll: the stream holds ${RULES.scrollFps} fps`, med(scroll, 'fps') >= RULES.scrollFps, `median ${med(scroll, 'fps')} fps at ${med(scroll, 'kbit')} kbit/s (runs ${scroll.map((r) => r.fps).join(', ')}; load ${scroll.map((r) => r.load).join(', ')})`)
  check(`scroll: capture to relay p95 under ${RULES.relayP95Ms} ms`, med(scroll, 'relayP95') < RULES.relayP95Ms, `median p50 ${med(scroll, 'relayP50')} ms, p95 ${med(scroll, 'relayP95')} ms; to the viewer p50 ${med(scroll, 'viewerP50')} ms, p95 ${med(scroll, 'viewerP95')} ms`)
  check(`scroll: the engine under ${RULES.engineCores} cores`, med(scroll, 'engineCores') < RULES.engineCores, `median ${med(scroll, 'engineCores')} of a core (runs ${scroll.map((r) => r.engineCores).join(', ')})`)
  check(`thin link (5 Mbit/s, 30 ms each way): the stream holds ${RULES.thinFps} fps`, med(slow, 'fps') >= RULES.thinFps, `median ${med(slow, 'fps')} fps at ${med(slow, 'kbit')} kbit/s, to the viewer p50 ${med(slow, 'viewerP50')} ms, p95 ${med(slow, 'viewerP95')} ms (runs ${slow.map((r) => r.fps).join(', ')})`)

  // 3. a link cut for four seconds: the engine hears no ack for three and closes the stream
  const cutLink = await link(direct, 0, 0)
  const v = await view(cutLink.port)
  await sleep(1_500)
  const before = v.frames()
  cutLink.cut(4_000)
  const closedWith = await Promise.race([v.closed, sleep(12_000).then(() => -1)])
  check('cut: a link cut for 4 s closes the stream', before > 0 && closedWith !== -1, `${before} frames before the cut; the socket closed with ${closedWith}${closedWith === VIDEO_CLOSE.slow ? ' (slow: the viewer opens again)' : ''}`)
  await sleep(500)
  const again = await view(direct)
  await sleep(1_500)
  check('cut: the next open plays', again.frames() > 30, `${again.frames()} frames in 1.5 s`)
  again.ws.close()
  cutLink.close()
  thin.close()

  writeFileSync(join(OUT, 'report.json'), `${JSON.stringify({ at: new Date().toISOString(), runs: RUNS, secs: SECS, cores: CORES, rules: RULES, scroll, thin: slow, checks }, null, 2)}\n`)
  code = checks.every((c) => c.ok) ? 0 : 1
  console.log(`\n${code === 0 ? 'ALL PASS' : 'FAILED'}  (${join(OUT, 'report.json')}; load ${load()})`)
} catch (err) {
  console.error('e2e-box-video failed:', err)
} finally {
  relay.shutdown()
  sockets.close()
  await engines.stopAll().catch(() => {})
  stage.close()
  await browser.stop().catch(() => {})
  for (const k of kids) k.kill()
  http!?.close()
  site!?.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
process.exit(code)
