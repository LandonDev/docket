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
 *  0. first frame (P01), recorded, never judged: `video.open` through the
 *       host's own `VideoRpc` and `BoxVideo` to the first frame at the viewer,
 *       cold (the browser starts for this open: its start and the page's
 *       load are in the time), warm (the browser up, an engine left warm by
 *       the last viewer) and with the engine cold (the browser up, no engine).
 *       Then how long an engine lives after its viewer goes. The viewer here
 *       does not decode: decode and draw are e2e-video-viewer's.
 *
 * `--scale 2` (or 1.5) runs the display at that many pixels for each of the
 * page's, the page still 1280×800: the rule to ship such a display is that
 * scene 1 holds 100 fps with the engine under 3 cores.
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
 * Run: bun run script:e2e-box-video [-- --runs 5 --secs 15 --cores 24-31 --scale 1]
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
import { MESSAGE_TYPES, encodeAck, h264Codec, messageType, parseFrame } from '../src/shared/video/nsl1'
import type { Principal } from '../src/shared/capabilities'
import type { StreamClaim } from '../src/main/server/remote/auth'
import { BoxChromium, findChromium } from '../src/main/server/work/browser/box/chromium'
import { BoxXDisplay } from '../src/main/server/work/browser/box/display'
import { BoxEngines } from '../src/main/server/work/browser/box/engine'
import { EngineFeed } from '../src/main/server/work/browser/box/engineFeed'
import { BoxStage } from '../src/main/server/work/browser/box/stage'
import { videoToolsAt } from '../src/main/server/work/browser/box/videoSetting'
import { VideoRelay } from '../src/main/server/video/relay'
import { VideoRpc } from '../src/main/server/video/rpc'
import { BoxVideo } from '../src/main/server/work/browser/box/video'
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
const SCALE = Number(arg('scale', '1'))
const RULES = SCALE === 1 ? { scrollFps: 110, relayP95Ms: 15, engineCores: 1.2, thinFps: 100 } : { scrollFps: 100, relayP95Ms: 15, engineCores: 3, thinFps: 100 }

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
  /** the stream's frames, width×height */
  size: string
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

const browser = new BoxChromium({ root, bin: () => bin, video: () => tools, spawn: pinned, makeDisplay: (t) => new BoxXDisplay({ root, tools: t, scale: SCALE, spawn: pinned }) })
const stage = new BoxStage({ endpoint: () => browser.endpoint(), wm: () => browser.wm })
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
async function view(port: number): Promise<{ ws: WebSocket; frames: () => number; bytes: () => number; size: () => string; lat: number[]; enginePid: number; closed: Promise<number> }> {
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
  let size = ''
  const lat: number[] = []
  ws.on('message', (data: Buffer) => {
    const frame = parseFrame(data)
    size ||= `${frame.width}×${frame.height}`
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
  return { ws, frames: () => frames, bytes: () => bytes, size: () => size, lat, enginePid: lease.pid ?? 0, closed }
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
    size: v.size(),
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

/** One `video.open` as the host answers it, its ticket joined and the first frame in: the times from the ask, in ms. */
interface FirstFrame {
  /** `video.open` answered with a stream and a ticket */
  answered: number
  /** the viewer's socket open */
  joined: number
  /** the first frame (the keyframe) at the viewer */
  frame: number
  /** the first frame's size */
  size: string
  load: string
}

// the box has no desktop: a viewer is his client key over the tunnel, as the host's own `video.open` sees it
const video = new VideoRpc(relay, { mintStreamTicket: (claim) => (tickets.set(`t-${claim.stream}`, claim), { ticket: `t-${claim.stream}`, expiresIn: 30 }) }, () => false)
const VIEWER: Principal = { kind: 'remote', keyId: 'proof', name: 'proof', audience: 'client', caps: ['approve'] }
let page: { target: string; url: string } | null = null
const boxVideo = new BoxVideo({
  browser,
  stage,
  engines,
  relay,
  pageOf: () => page?.target ?? null,
  paneOf: (thread) => thread,
  drives: () => false,
  urlOf: async () => page?.url ?? null,
  closed: () => false,
  setting: () => true,
  installed: () => true
})
video.addSource(boxVideo)
/** the engine the last lease handed out: the one a stream just opened holds */
let leasedPid = 0
const leaseOf = engines.lease.bind(engines)
engines.lease = async () => {
  const lease = await leaseOf()
  leasedPid = lease?.pid ?? 0
  return lease
}

/** `video.open` from `t0` (performance.now()) to the first frame; the socket stays open until `done` is called. */
async function firstFrame(port: number, t0: number): Promise<FirstFrame & { done(): Promise<number>; enginePid: () => number }> {
  const answer = await video.open({ threadId: 'proof', maxEdge: 2560 }, { principal: VIEWER, connection: {}, connectionId: 'proof' })
  if (!answer.ok) throw new Error(`video.open was refused: ${answer.reason}`)
  const answered = performance.now() - t0
  const ws = new WebSocket(`ws://127.0.0.1:${port}/video/${answer.stream}?ticket=${answer.ticket}`, ['nsl1'])
  ws.binaryType = 'nodebuffer'
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
  let joined = 0
  const first = await new Promise<{ at: number; size: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no frame in 20 s')), 20_000)
    ws.on('open', () => void (joined = performance.now() - t0))
    ws.on('error', reject)
    ws.on('message', (data: Buffer) => {
      if (messageType(data) !== MESSAGE_TYPES.frame) return
      const frame = parseFrame(data)
      ws.send(encodeAck(frame.generation, frame.sequence, 0))
      clearTimeout(timer)
      resolve({ at: performance.now() - t0, size: `${frame.width}×${frame.height}` })
    })
  })
  const pid = leasedPid
  return {
    answered: Math.round(answered),
    joined: Math.round(joined),
    frame: Math.round(first.at),
    size: first.size,
    load: load(),
    enginePid: () => pid,
    done: async () => (ws.close(), closed)
  }
}

/** Milliseconds until the process is gone, polled every 250 ms, at most `capMs`; -1 when it outlived the cap. */
async function lifeAfter(pid: number, capMs: number): Promise<number> {
  const t0 = performance.now()
  while (performance.now() - t0 < capMs) {
    try {
      process.kill(pid, 0)
    } catch {
      return Math.round(performance.now() - t0)
    }
    await sleep(250)
  }
  return -1
}

/**
 * `--record <file>`: no scenes. The first `--frames` messages (120) of a calm page's stream are written to the file
 * as they came off the socket, one NSL1 message after another, and the script ends. The file is the box's own
 * engine's bytes for a client's decoder test (the phone's fixture): a keyframe, then deltas.
 */
const RECORD = process.argv.includes('--record') ? arg('record', '') : ''
/** A page that changes a little on every frame: a counter and a bar on a page of text, so each frame is small. */
const CALM = `<!doctype html><meta charset=utf-8><title>calm</title><body style="margin:0;font:15px/1.5 system-ui,sans-serif;background:#fff;color:#111"><div style="padding:24px 15%"><h2>Expense report</h2><p>${'The quick brown fox jumps over the lazy dog. '.repeat(40)}</p></div><div id=c style="position:fixed;left:40px;top:20px;font:28px monospace"></div><div id=b style="position:fixed;left:0;bottom:0;height:12px;background:#2563eb"></div><script>let n=0;(function f(){n++;document.getElementById('c').textContent=String(n).padStart(6,'0');document.getElementById('b').style.width=(n%240)/2.4+'%';requestAnimationFrame(f)})()</script>`

let code = 1
try {
  site = createHttp((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(RECORD ? CALM : PAGE)
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()))
  http = createHttp((_req, res) => res.writeHead(426).end())
  http.on('upgrade', (req, socket, head) => {
    const refused = sockets.upgrade(req, socket, head, 'remote')
    if (refused !== null) refuseVideoUpgrade(socket, refused)
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
  const direct = (http.address() as { port: number }).port

  console.log(`e2e-box-video: ${RUNS} runs of ${SECS} s a scene at scale ${SCALE}, pinned to cores ${CORES}; load ${load()}`)
  const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`
  // 0. cold: the browser starts for this open, as it does when a thread's first page is shown
  const coldAt = performance.now()
  await browser.endpoint()
  if (!browser.display) throw new Error('the browser did not start headed')
  const browserMs = Math.round(performance.now() - coldAt)
  const target = await stage.open(siteUrl)
  const pageMs = Math.round(performance.now() - coldAt)
  page = { target, url: siteUrl }
  let cold: (FirstFrame & { browser: number; page: number }) | null = null
  if (RECORD) await stage.watch(target)
  else {
    const c = await firstFrame(direct, coldAt)
    await c.done()
    cold = { answered: c.answered, joined: c.joined, frame: c.frame, size: c.size, load: c.load, browser: browserMs, page: pageMs }
    console.log(`  first frame, cold: ${JSON.stringify(cold)}`)
  }
  // the notice that says how to leave full screen is gone after a few seconds
  await sleep(5_000)

  if (RECORD) {
    const want = Number(arg('frames', '120'))
    const lease = (await engines.lease())!
    const feed = new EngineFeed(lease, false)
    const got: Uint8Array[] = []
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`only ${got.length} of ${want} frames came`)), 20_000)
      feed.start({
        frame: (bytes) => {
          // the engine also sends the pointer's shape, which is no frame
          if (got.length >= want || messageType(bytes) !== MESSAGE_TYPES.frame) return
          got.push(new Uint8Array(bytes))
          const f = parseFrame(bytes)
          feed.ack(encodeAck(f.generation, f.sequence, 0))
          if (got.length === want) (clearTimeout(timer), resolve())
        },
        end: (reason) => reject(new Error(`the stream ended: ${reason}`))
      })
    })
    feed.close()
    writeFileSync(RECORD, Buffer.concat(got))
    const first = parseFrame(got[0]!)
    console.log(`recorded ${got.length} frames (${first.width}×${first.height}, ${h264Codec(first.data)}, ${Buffer.concat(got).length} bytes) to ${RECORD}`)
    code = 0
    throw new Error('recorded')
  }

  // 0. warm: the browser up and an engine left warm by the last viewer; then with no engine left
  const keep = ({ answered, joined, frame, size, load }: FirstFrame): FirstFrame => ({ answered, joined, frame, size, load })
  const warm: FirstFrame[] = []
  const engineCold: FirstFrame[] = []
  for (let i = 0; i < 3; i++) {
    const w = await firstFrame(direct, performance.now())
    await w.done()
    warm.push(keep(w))
    console.log(`  first frame, warm ${i + 1}/3: ${JSON.stringify(warm.at(-1))}`)
    await sleep(500)
  }
  for (let i = 0; i < 3; i++) {
    await engines.stopAll()
    await sleep(500)
    const e = await firstFrame(direct, performance.now())
    await e.done()
    engineCold.push(keep(e))
    console.log(`  first frame, engine cold ${i + 1}/3: ${JSON.stringify(engineCold.at(-1))}`)
  }
  const medianOf = (xs: FirstFrame[], key: 'answered' | 'joined' | 'frame'): number => median(xs.map((x) => x[key]))
  console.log(`first frame (video.open to the keyframe at the viewer): cold ${cold!.frame} ms (browser up at ${cold!.browser}, page at ${cold!.page}, answered at ${cold!.answered}); warm median ${medianOf(warm, 'frame')} ms (runs ${warm.map((w) => w.frame).join(', ')}); engine cold median ${medianOf(engineCold, 'frame')} ms (runs ${engineCold.map((w) => w.frame).join(', ')}); load ${load()}`)

  // the scenes below show the page with no source of the host's: the last stream's going took it off the display
  boxVideo.close()
  await stage.watch(target)
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
  const med = (runs: Run[], key: keyof Omit<Run, 'load' | 'size'>): number => median(runs.map((r) => r[key]))
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
  // how long an engine lives once its viewer has gone (ENGINE_IDLE_MS): nothing else opens a stream meanwhile
  const engineAfterViewerMs = await lifeAfter(again.enginePid, 90_000)
  console.log(`an engine after its viewer went: ${engineAfterViewerMs === -1 ? 'still up after 90 s' : `gone after ${engineAfterViewerMs} ms`}; load ${load()}`)

  const firstFrames = { cold, warm, engineCold }
  writeFileSync(join(OUT, 'report.json'), `${JSON.stringify({ at: new Date().toISOString(), runs: RUNS, secs: SECS, cores: CORES, scale: SCALE, rules: RULES, firstFrames, engineAfterViewerMs, scroll, thin: slow, checks }, null, 2)}\n`)
  code = checks.every((c) => c.ok) ? 0 : 1
  console.log(`\n${code === 0 ? 'ALL PASS' : 'FAILED'}  (${join(OUT, 'report.json')}; load ${load()})`)
} catch (err) {
  if (!(err instanceof Error && err.message === 'recorded')) console.error('e2e-box-video failed:', err)
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
