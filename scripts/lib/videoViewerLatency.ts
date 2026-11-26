import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket, WebSocketServer } from 'ws'
import { parseHeader } from '../../src/shared/video/nsl1'
import { recordedMessages, restamped } from './videoLoopFeed'
import { percentile } from './videoProof'

/**
 * The box engine's own stream at the size the box ships, 2560×1600 (scale 2): 180 frames of a calm page, a keyframe
 * then deltas, recorded by `bun scripts/e2e-box-video.ts --record <file> --frames 180 --scale 2`. The phone's fixture
 * (fixtures/ios-test-server/box-stream.nsl1) stays at 1280×800, the size its Swift tests are written for.
 */
export const VIEWER_FIXTURE = 'scripts/fixtures/video/box-stream-2560.nsl1'
const WARMUP_MS = 2400
const SAMPLE_MS = 4000
const FRAME_MS = 1000 / 60
type Link = 'even' | 'jitter'
type Viewer = 'before' | 'after'

// Delay whole WebSocket messages on the downstream leg. As on TCP, later bytes
// cannot pass the delayed bytes. Input and acks take the reverse leg at once.
function jitterProxy(viewer: WebSocket, upstream: WebSocket, link: Link): void {
  const queue: { frame: ArrayBuffer; due: number }[] = []
  const spikes = [60, 100, 80, 100]
  let timer: ReturnType<typeof setTimeout> | undefined
  const pump = (): void => {
    while (queue.length && queue[0].due <= performance.now()) viewer.send(queue.shift()!.frame)
    timer = queue.length ? setTimeout(pump, queue[0].due - performance.now()) : undefined
  }
  upstream.binaryType = 'arraybuffer'
  upstream.on('message', (buffer) => {
    const frame = buffer as ArrayBuffer
    const { sequence } = parseHeader(frame)
    const delay = link === 'jitter' && sequence % 8 === 0 ? spikes[(sequence / 8 - 1) % spikes.length] : 0
    queue.push({ frame, due: Math.max(performance.now() + delay, queue.at(-1)?.due ?? 0) })
    if (!timer) pump()
  })
  viewer.on('message', (data) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data)
  })
  viewer.on('close', () => {
    clearTimeout(timer)
    upstream.close()
  })
  upstream.on('close', () => viewer.close())
  upstream.on('error', () => viewer.close())
  viewer.on('error', () => upstream.close())
}

const page = (viewer: Viewer, link: Link): string => `<!doctype html>
<meta charset="utf-8">
<canvas id="picture" style="width: 640px; height: 400px"></canvas>
<script type="module">
import { VideoInput, attachInput } from '/${viewer}/input.js'
const canvas = document.getElementById('picture')
const worker = new Worker('/${viewer}/worker.js')
const log = (record) => console.log(JSON.stringify(record))
worker.onmessage = ({ data }) => log(data)
const surface = canvas.transferControlToOffscreen()
worker.postMessage({ t: 'surface', surface: 1, canvas: surface }, [surface])
worker.postMessage({ t: 'bind', stream: 1, surface: 1 })
worker.postMessage({ t: 'open', stream: 1, url: 'ws://' + location.host + '/proxy/${link}', drive: true })
const raw = 'onpointerrawupdate' in canvas
const timestamps = new Map()
canvas.addEventListener('${viewer}' === 'after' && raw ? 'pointerrawupdate' : 'pointermove', (event) => {
  const latest = event.getCoalescedEvents?.().at(-1) ?? event
  timestamps.set(latest.clientX, latest.timeStamp)
}, true)
attachInput(canvas, new VideoInput(event => {
  worker.postMessage({ t: 'input', stream: 1, event })
  if (event.type === 'pointerMove') {
    const start = timestamps.get(Math.round(event.x * 640 + canvas.getBoundingClientRect().left))
    if (start !== undefined) log({ t: 'input-wait', wait: performance.now() - start })
  }
}, { mac: false, paste: () => {} }))
log({ t: 'ready', raw })
</script>`

// A proof-only worker shim samples actual draws. The NSL1 ack also covers
// dropped frames, so it cannot by itself measure arrival to draw.
const drawProbe = `
const arrival = new Map()
const Socket = self.WebSocket
self.WebSocket = class extends Socket {
  constructor(...args) {
    super(...args)
    this.addEventListener('message', ({ data }) => {
      const sequence = new DataView(data).getUint32(12)
      arrival.set(sequence, performance.now())
    })
  }
}
const draw = OffscreenCanvasRenderingContext2D.prototype.drawImage
OffscreenCanvasRenderingContext2D.prototype.drawImage = function(frame, ...args) {
  const start = arrival.get(frame.timestamp)
  const before = performance.now()
  draw.call(this, frame, ...args)
  if (start !== undefined) {
    self.postMessage({ t: 'draw-wait', wait: before - start, completed: performance.now() - start })
    for (const sequence of arrival.keys()) {
      if (sequence > frame.timestamp) break
      arrival.delete(sequence)
    }
  }
}
`

async function bundle(root: string, before: string): Promise<Map<string, string>> {
  const sources = 'src/renderer/src/lib/video'
  const result = new Map<string, string>()
  for (const viewer of ['before', 'after'] as const) {
    for (const [entry, output] of [['video.worker.ts', 'worker.js'], ['videoInput.ts', 'input.js']]) {
      const built = await Bun.build({
        entrypoints: [join(root, sources, entry)],
        target: 'browser',
        tsconfig: join(root, 'tsconfig.json'),
        plugins: viewer === 'before' ? [{
          name: 'viewer-before',
          setup(build) {
            build.onLoad({ filter: /[/\\]lib[/\\]video[/\\](video\.worker|pacing|player|videoInput|messages)\.ts$/ }, ({ path }) => ({
              contents: execFileSync('git', ['show', `${before}:${relative(root, path)}`], { cwd: root, encoding: 'utf8' }),
              loader: 'ts'
            }))
          },
        }] : [],
      })
      if (!built.success) throw new Error(built.logs.join('\n'))
      result.set(`/${viewer}/${output}`, (output === 'worker.js' ? drawProbe : '') + await built.outputs[0].text())
    }
  }
  return result
}

function stats(values: number[]) {
  return { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null }
}

export async function viewerLatency(root: string, before?: string): Promise<void> {
  if (!before || typeof Bun === 'undefined') throw new Error('Run with bun scripts/e2e-video-viewer.ts --latency <before-commit>')
  const baseline = execFileSync('git', ['rev-parse', '--verify', `${before}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
  const assets = await bundle(root, baseline)
  const frames = recordedMessages(join(root, VIEWER_FIXTURE))
  const work = mkdtempSync(join(tmpdir(), 'tc-viewer-latency-'))
  const phases: object[] = []
  const server = createServer((req, res) => {
    const match = /^\/(before|after)\/(even|jitter)$/.exec(req.url ?? '')
    const script = assets.get(req.url ?? '')
    if (match) res.writeHead(200, { 'Content-Type': 'text/html' }).end(page(match[1] as Viewer, match[2] as Link))
    else if (script) res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(script)
    else res.writeHead(404).end()
  })
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No loopback address for the viewer')
  const host = `127.0.0.1:${address.port}`
  server.on('upgrade', (req, socket, head) => {
    if (!['/source', '/proxy/even', '/proxy/jitter'].includes(req.url ?? '')) return socket.destroy()
    sockets.handleUpgrade(req, socket, head, (ws) => {
      if (req.url !== '/source') {
        jitterProxy(ws, new WebSocket(`ws://${host}/source`, 'nsl1'), req.url.endsWith('/jitter') ? 'jitter' : 'even')
        return
      }
      let sequence = 0
      const start = performance.now()
      const capture = process.hrtime.bigint() / 1000n
      const timer = setInterval(() => {
        const due = Math.floor((performance.now() - start) / FRAME_MS)
        while (sequence < due && ws.readyState === WebSocket.OPEN) {
          const stamp = capture + BigInt(Math.round(sequence * FRAME_MS * 1000))
          ws.send(restamped(frames[sequence % frames.length], 1, ++sequence, stamp))
        }
      }, 2)
      ws.on('close', () => clearInterval(timer))
      ws.on('error', () => clearInterval(timer))
    })
  })

  const run = async (viewer: Viewer, link: Link, trial: number): Promise<void> => {
    const child = spawn(join(root, 'node_modules/.bin/electron'), [join(root, 'scripts/lib/videoViewerElectron.cjs')], {
      cwd: root,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
        TC_VIEWER_DATA: join(work, 'electron'), TC_VIEWER_PAGE: `http://${host}/${viewer}/${link}`,
        TC_VIEWER_MOTION: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = once(child, 'exit')
    child.stdin.on('error', () => {})
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data })
    const draws: number[] = []
    const completed: number[] = []
    const inputs: number[] = []
    let raw = false
    let recording = false
    let screenHz = 0
    let closed: unknown
    const drawn = new Promise<void>((resolve) => {
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.startsWith('SCREEN ')) screenHz = Number(line.slice(7))
        if (!line.startsWith('PAGE ')) return
        try {
          const data = JSON.parse(line.slice(5))
          if (data.t === 'ready') raw = data.raw
          if (data.t === 'drawn') resolve()
          if (data.t === 'closed') closed = data
          if (recording && data.t === 'draw-wait') {
            draws.push(data.wait)
            completed.push(data.completed)
          }
          if (recording && data.t === 'input-wait') inputs.push(data.wait)
        } catch {
          // Chromium also writes its own console lines.
        }
      })
    })
    try {
      await Promise.race([
        drawn,
        exited.then(() => { throw new Error(`Electron exited: ${stderr}`) }),
        sleep(10_000, undefined, { ref: false }).then(() => { throw new Error(`No first frame: ${JSON.stringify(closed)} ${stderr}`) }),
      ])
      child.stdin.write('motion\n')
      await sleep(WARMUP_MS)
      recording = true
      await sleep(SAMPLE_MS)
      if (closed || !draws.length || !inputs.length) throw new Error(`Missing samples: ${JSON.stringify({ closed, draws: draws.length, inputs: inputs.length, stderr })}`)
      const row = { trial, viewer, link, screenHz, raw, drawMs: stats(draws), drawCompletedMs: stats(completed), inputMs: stats(inputs) }
      phases.push(row)
      console.log(JSON.stringify(row))
    } finally {
      child.stdin.end('quit\n')
      const ended = await Promise.race([exited.then(() => true), sleep(2000).then(() => false)])
      if (!ended) {
        child.kill('SIGKILL')
        await exited
      }
    }
  }

  try {
    for (const trial of [1, 2]) {
      for (const link of ['even', 'jitter'] as const) {
        const viewers = trial === 1 ? ['before', 'after'] as const : ['after', 'before'] as const
        for (const viewer of viewers) await run(viewer, link, trial)
      }
    }
  } finally {
    for (const ws of sockets.clients) ws.terminate()
    sockets.close()
    server.close()
    const path = join(work, 'report.json')
    writeFileSync(path, JSON.stringify({ baseline, warmupMs: WARMUP_MS, sampleMs: SAMPLE_MS, sourceFps: 60, phases }, null, 2) + '\n')
    console.log(`Report ${path}`)
  }
}
