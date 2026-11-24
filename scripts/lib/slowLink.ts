/**
 * A slow network link in user space, for the PC drive bench (scripts/bench-pc-drive.ts): a TCP proxy between QEMU's
 * guestfwd (`up.sh --guestfwd 10.0.2.100:445=44501`) and the SMB share on :44500, standing in for a mapped drive
 * over a campus VPN. Each direction has a fixed one-way delay and a rate cap, bytes keep their order, and it counts
 * per measured step: bytes each way and turns (a client→server burst after a server→client one, so one round trip).
 *
 * The rate is modelled as the wire's own: a chunk takes bytes×8/rate to go out after the one before it in the same
 * direction (all connections share it, as one VPN tunnel does), then the delay to arrive. A source that sends
 * faster than that is paused once a megabyte waits, so TCP's own flow control feels the link.
 *
 *   bun scripts/lib/slowLink.ts [--listen 44501] [--target 44500] [--delay 20] [--rate 8] [--control 44502]
 *
 * The control port answers GET /counters and POST /reset (the counts so far, then zero) and POST /shape?delay=&rate=.
 *
 * `slowLink` below is the renderer soak's older relay (one rate, host to window only, a backlog it reports); the
 * perf kit (scripts/perf) and the drive bench use `startSlowLink`.
 */
import { createServer as createHttp, type Server as HttpServer } from 'node:http'
import { connect, createServer, type Server, type Socket } from 'node:net'

const TICK_MS = 20

export interface Shape {
  /** one-way delay, ms */
  delayMs: number
  /** cap each direction, Mbit/s; 0 for none */
  rateMbit: number
}
export interface Counters {
  /** client→server bytes */
  up: number
  /** server→client bytes */
  down: number
  /** client→server bursts that followed a server→client one: round trips */
  turns: number
  /** connections opened */
  conns: number
  /** ms since the last reset */
  ms: number
}
export interface SlowLink {
  port: number
  shape: Shape
  counters(): Counters
  /** The counts since the last reset, then zero. */
  reset(): Counters
  /** Cut: every open connection is dropped and new ones refused until `cut(false)` (a socket lost, the far end still up). */
  cut(on: boolean): void
  close(): Promise<void>
}

const HIGH_WATER = 1 << 20

/** One direction of the link: every connection's chunks in that direction take turns on its wire. */
class Wire {
  private freeAt = 0
  constructor(private readonly shape: Shape) {}
  /** When a chunk of `n` bytes handed over now arrives at the far end. */
  arrival(n: number): number {
    const now = performance.now()
    const start = Math.max(now, this.freeAt)
    const end = this.shape.rateMbit > 0 ? start + (n * 8) / (this.shape.rateMbit * 1000) : start
    this.freeAt = end
    return end + this.shape.delayMs
  }
}

/** One connection's one direction: a FIFO drained in order, each chunk written at its arrival time. */
class Lane {
  private readonly queue: { at: number; data: Buffer }[] = []
  private held = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private ended = false
  constructor(
    private readonly wire: Wire,
    private readonly from: Socket,
    private readonly to: Socket
  ) {}
  push(data: Buffer): void {
    this.queue.push({ at: this.wire.arrival(data.length), data })
    this.held += data.length
    if (this.held > HIGH_WATER) this.from.pause()
    this.drain()
  }
  end(): void {
    this.ended = true
    this.drain()
  }
  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.queue.length = 0
  }
  private drain(): void {
    if (this.timer) return
    for (;;) {
      const head = this.queue[0]
      if (!head) {
        if (this.ended && !this.to.destroyed) this.to.end()
        return
      }
      const wait = head.at - performance.now()
      if (wait > 0.5) {
        this.timer = setTimeout(() => ((this.timer = null), this.drain()), Math.ceil(wait))
        return
      }
      this.queue.shift()
      this.held -= head.data.length
      if (!this.to.destroyed) this.to.write(head.data)
      if (this.held <= HIGH_WATER / 2 && this.from.isPaused()) this.from.resume()
    }
  }
}

export function startSlowLink(opts: { listen: number; target: number; host?: string; shape?: Partial<Shape> }): Promise<SlowLink> {
  const shape: Shape = { delayMs: opts.shape?.delayMs ?? 20, rateMbit: opts.shape?.rateMbit ?? 8 }
  const upWire = new Wire(shape)
  const downWire = new Wire(shape)
  const zero = (): Counters => ({ up: 0, down: 0, turns: 0, conns: 0, ms: 0 })
  let count = zero()
  let since = performance.now()
  const open = new Set<Socket>()
  let cut = false

  const server: Server = createServer((client) => {
    if (cut) return void client.destroy()
    count.conns++
    const upstream = connect(opts.target, opts.host ?? '127.0.0.1')
    for (const s of [client, upstream]) {
      s.setNoDelay(true)
      open.add(s)
    }
    const up = new Lane(upWire, client, upstream)
    const down = new Lane(downWire, upstream, client)
    // A connection's last direction: a client burst after the server spoke is the next round trip.
    let last: 'up' | 'down' | null = null
    client.on('data', (d: Buffer) => {
      count.up += d.length
      if (last !== 'up') count.turns++
      last = 'up'
      up.push(d)
    })
    upstream.on('data', (d: Buffer) => {
      count.down += d.length
      last = 'down'
      down.push(d)
    })
    client.on('end', () => up.end())
    upstream.on('end', () => down.end())
    const done = (): void => {
      up.stop()
      down.stop()
      for (const s of [client, upstream]) {
        open.delete(s)
        s.destroy()
      }
    }
    client.on('close', done)
    upstream.on('close', done)
    client.on('error', done)
    upstream.on('error', done)
  })

  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(opts.listen, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      ok({
        port,
        shape,
        counters: () => ({ ...count, ms: Math.round(performance.now() - since) }),
        reset() {
          const was = { ...count, ms: Math.round(performance.now() - since) }
          count = zero()
          since = performance.now()
          return was
        },
        cut(on) {
          cut = on
          if (on) for (const s of open) s.destroy()
        },
        close: () =>
          new Promise<void>((done) => {
            for (const s of open) s.destroy()
            server.close(() => done())
          })
      })
    })
  })
}

/** The control port: GET /counters, POST /reset, POST /shape?delay=&rate=. */
export function controlPort(link: SlowLink, port: number): Promise<HttpServer> {
  const http = createHttp((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const json = (body: unknown): void => void (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)))
    if (url.pathname === '/counters') return json(link.counters())
    if (url.pathname === '/reset' && req.method === 'POST') return json(link.reset())
    if (url.pathname === '/shape' && req.method === 'POST') {
      const delay = url.searchParams.get('delay')
      const rate = url.searchParams.get('rate')
      if (delay !== null) link.shape.delayMs = Number(delay)
      if (rate !== null) link.shape.rateMbit = Number(rate)
      return json(link.shape)
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((ok, fail) => (http.once('error', fail), http.listen(port, '127.0.0.1', () => ok(http))))
}

/**
 * A TCP relay that gives the window `bytesPerSec` from the host and the host
 * whatever the window sends: the Mac's link to the box is a tunnel, and a
 * loopback socket never shows what a reconnect does to a slow one (the
 * answers queue behind the tunnel, a probe waits behind them). Like a tunnel
 * endpoint it reads the host at once and holds what the window has not had
 * yet: `peak()` is the most it held for one window since `resetPeak()`. A
 * socket the host drops is dropped for the window at once, the bytes it held
 * with it.
 */
export async function slowLink(
  target: { host: string; port: number },
  bytesPerSec: number
): Promise<{ port: number; peak(): number; resetPeak(): void; close(): void }> {
  const pairs = new Set<() => void>()
  const perTick = Math.max(1, Math.round((bytesPerSec * TICK_MS) / 1000))
  let peak = 0
  const server = createServer((client: Socket) => {
    const host = connect(target.port, target.host)
    client.pipe(host)
    const queue: Buffer[] = []
    let held = 0
    const timer = setInterval(() => {
      let budget = perTick
      while (budget > 0 && queue.length > 0) {
        const head = queue[0]
        const piece = head.length <= budget ? head : head.subarray(0, budget)
        client.write(piece)
        budget -= piece.length
        held -= piece.length
        if (piece === head) queue.shift()
        else queue[0] = head.subarray(piece.length)
      }
    }, TICK_MS)
    host.on('data', (chunk: Buffer) => {
      queue.push(chunk)
      held += chunk.length
      peak = Math.max(peak, held)
    })
    const drop = (): void => {
      clearInterval(timer)
      pairs.delete(drop)
      client.destroy()
      host.destroy()
    }
    pairs.add(drop)
    host.on('end', drop)
    host.on('close', drop)
    host.on('error', drop)
    client.on('close', drop)
    client.on('error', drop)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    port,
    peak: () => peak,
    resetPeak: () => {
      peak = 0
    },
    close() {
      for (const drop of [...pairs]) drop()
      server.close()
    }
  }
}

if (import.meta.main) {
  const arg = (name: string, d: number): number => (process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : d)
  const link = await startSlowLink({ listen: arg('--listen', 44501), target: arg('--target', 44500), shape: { delayMs: arg('--delay', 20), rateMbit: arg('--rate', 8) } })
  const control = arg('--control', 44502)
  await controlPort(link, control)
  console.log(`slow link :${link.port} → :${arg('--target', 44500)}, ${link.shape.delayMs} ms each way, ${link.shape.rateMbit} Mbit/s each way; control on :${control}`)
}
