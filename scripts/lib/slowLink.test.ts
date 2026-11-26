import { createServer, connect, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { HIS_JITTER, seeded, startSlowLink, Wire, type SlowLink } from './slowLink'

let echo: Server | null = null
let link: SlowLink | null = null
const sockets: Socket[] = []

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await link?.close()
  await new Promise<void>((done) => (echo ? echo.close(() => done()) : done()))
  echo = link = null
})

async function echoServer(): Promise<number> {
  echo = createServer((s) => {
    sockets.push(s)
    s.on('data', (d) => s.write(d))
  })
  await new Promise<void>((ok) => echo!.listen(0, '127.0.0.1', ok))
  return (echo.address() as { port: number }).port
}

async function client(port: number): Promise<{ socket: Socket; read: (n: number) => Promise<Buffer> }> {
  const socket = connect(port, '127.0.0.1')
  sockets.push(socket)
  await new Promise<void>((ok) => socket.once('connect', ok))
  let got = Buffer.alloc(0)
  let want: { n: number; ok: (b: Buffer) => void } | null = null
  const check = (): void => {
    if (want && got.length >= want.n) {
      const out = got.subarray(0, want.n)
      got = got.subarray(want.n)
      const w = want
      want = null
      w.ok(out)
    }
  }
  socket.on('data', (d: Buffer) => ((got = Buffer.concat([got, d])), check()))
  return { socket, read: (n) => new Promise((ok) => ((want = { n, ok }), check())) }
}

describe('slowLink', () => {
  it('adds the one-way delay each direction: an echo takes two of them', async () => {
    link = await startSlowLink({ listen: 0, target: await echoServer(), shape: { delayMs: 40, rateMbit: 0 } })
    const c = await client(link.port)
    const times: number[] = []
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      c.socket.write(Buffer.from(`ping ${i}`))
      expect((await c.read(6)).toString()).toBe(`ping ${i}`)
      times.push(performance.now() - t0)
    }
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(78)
      expect(t).toBeLessThan(200)
    }
    const counted = link.reset()
    expect(counted).toMatchObject({ up: 18, down: 18, turns: 3, conns: 1 })
    expect(link.counters()).toMatchObject({ up: 0, down: 0, turns: 0 })
  })

  it('caps the rate each direction and keeps every byte in order', async () => {
    link = await startSlowLink({ listen: 0, target: await echoServer(), shape: { delayMs: 0, rateMbit: 16 } })
    const c = await client(link.port)
    const data = Buffer.alloc(256 * 1024)
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 9)) & 0xff
    const t0 = performance.now()
    c.socket.write(data)
    const back = await c.read(data.length)
    const ms = performance.now() - t0
    expect(back.equals(data)).toBe(true)
    // 256 KiB at 16 Mbit/s is 131 ms one way; the echo's way back overlaps it, chunk by chunk.
    expect(ms).toBeGreaterThanOrEqual(125)
    expect(ms).toBeLessThan(600)
    expect(link.counters()).toMatchObject({ up: data.length, down: data.length, turns: 1 })
  })

  it('takes a new shape while it runs', async () => {
    link = await startSlowLink({ listen: 0, target: await echoServer(), shape: { delayMs: 0, rateMbit: 0 } })
    const c = await client(link.port)
    let t0 = performance.now()
    c.socket.write('a')
    await c.read(1)
    expect(performance.now() - t0).toBeLessThan(40)
    link.shape.delayMs = 50
    t0 = performance.now()
    c.socket.write('b')
    expect((await c.read(1)).toString()).toBe('b')
    expect(performance.now() - t0).toBeGreaterThanOrEqual(98)
  })
})

describe('the Host a relay presents', () => {
  it("says the target's address in the first request's head, the head split over two writes, and leaves the rest untouched", async () => {
    const target = await echoServer()
    link = await startSlowLink({ listen: 0, target, hostHeader: `127.0.0.1:${target}`, shape: { delayMs: 0, rateMbit: 1000 } })
    const { socket, read } = await client(link.port)
    const first = `GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nHost: 127.0.0.1:${link.port}\r\nOrigin: tempcode-app://app\r\n`
    socket.write(first)
    socket.write('\r\nbody Host: kept')
    const said = `GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nHost: 127.0.0.1:${target}\r\nOrigin: tempcode-app://app\r\n\r\nbody Host: kept`
    expect((await read(Buffer.byteLength(said))).toString()).toBe(said)
    // What follows on the connection goes as sent.
    socket.write('Host: later')
    expect((await read(11)).toString()).toBe('Host: later')
  })
})

describe("his Wi-Fi's late chunks", () => {
  const arrivals = (seed: number, count = 8000): number[] => {
    const wire = new Wire({ delayMs: 30, rateMbit: 0, jitter: { ...HIS_JITTER, seed } })
    // A chunk every 200 ms on a clock of its own, so no spike holds the next chunk back: the arrival minus the
    // hand-over minus the delay is the lateness.
    return Array.from({ length: count }, (_, i) => wire.arrival(100, i * 200))
  }

  it('keeps every chunk behind the one before it', () => {
    const wire = new Wire({ delayMs: 30, rateMbit: 0, jitter: HIS_JITTER })
    // Chunks 5 ms apart: a late one would be passed by the next dozen without the rule.
    const at = Array.from({ length: 4000 }, (_, i) => wire.arrival(100, i * 5))
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThanOrEqual(at[i - 1]!)
    expect(at.some((t, i) => t - i * 5 - 30 >= 50)).toBe(true)
  })

  it('makes one chunk in eight 50 to 90 ms late, and the same ones for the same seed', () => {
    const at = arrivals(8)
    const late = at.map((t, i) => t - i * 200 - 30)
    const spikes = late.filter((ms) => ms >= 50).length
    expect(spikes).toBeGreaterThan(8000 / 8 * 0.8)
    expect(spikes).toBeLessThan(8000 / 8 * 1.2)
    expect(Math.max(...late)).toBeLessThanOrEqual(90)
    expect(Math.min(...late)).toBe(0)
    const mean = late.reduce((sum, ms) => sum + ms, 0) / late.length
    // 70 ms an eighth of the time is 8.75 ms.
    expect(mean).toBeGreaterThan(7.5)
    expect(mean).toBeLessThan(10)
    expect(arrivals(8)).toEqual(at)
    expect(arrivals(9)).not.toEqual(at)
  })

  it('adds nothing with no jitter, and the generator repeats', () => {
    const wire = new Wire({ delayMs: 30, rateMbit: 0 })
    expect(wire.arrival(100, 1000)).toBe(1030)
    const a = seeded(5)
    const b = seeded(5)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})

describe('a stall and a dead link', () => {
  it('a stall holds both ways for its time and then delivers everything in order, the socket kept', async () => {
    link = await startSlowLink({ listen: 0, target: await echoServer(), shape: { delayMs: 0, rateMbit: 0 } })
    const c = await client(link.port)
    c.socket.write('a')
    await c.read(1)
    link.stall(150)
    const t0 = performance.now()
    c.socket.write('bc')
    c.socket.write('de')
    expect((await c.read(4)).toString()).toBe('bcde')
    expect(performance.now() - t0).toBeGreaterThanOrEqual(145)
    expect(c.socket.destroyed).toBe(false)
    expect(link.counters().conns).toBe(1)
  })

  it('a blackhole drops bytes both ways with no close, and resets what lost bytes when it lifts', async () => {
    let served = 0
    link = await startSlowLink({ listen: 0, target: await echoServer(), shape: { delayMs: 0, rateMbit: 0 } })
    echo!.on('connection', () => served++)
    const c = await client(link.port)
    c.socket.write('a')
    await c.read(1)
    let closed = false
    let got = 0
    c.socket.on('close', () => (closed = true))
    c.socket.on('data', (d: Buffer) => (got += d.length))
    link.blackhole(true)
    c.socket.write('lost')
    await new Promise((ok) => setTimeout(ok, 120))
    // Nothing came back and nobody was told.
    expect(got).toBe(0)
    expect(closed).toBe(false)
    link.blackhole(false)
    await new Promise((ok) => setTimeout(ok, 60))
    expect(closed).toBe(true)
    // A new connection passes.
    const again = await client(link.port)
    again.socket.write('b')
    expect((await again.read(1)).toString()).toBe('b')
  })
})

describe('whose round trips', () => {
  it("counts each connection under the name its first request's head gives it", async () => {
    const target = await echoServer()
    link = await startSlowLink({ listen: 0, target, shape: { delayMs: 0, rateMbit: 0 }, classify: (head) => (/^user-agent:.*Chrome/im.test(head) ? 'window' : 'host') })
    const page = await client(link.port)
    const head = 'GET / HTTP/1.1\r\nUser-Agent: Mozilla/5.0 Chrome/140\r\n\r\n'
    page.socket.write(head)
    await page.read(head.length)
    page.socket.write('x')
    await page.read(1)
    const host = await client(link.port)
    const plain = 'GET / HTTP/1.1\r\nUser-Agent: node\r\n\r\n'
    host.socket.write(plain)
    await host.read(plain.length)
    const by = link.resetClasses()
    expect(by.window).toMatchObject({ conns: 1, turns: 2, up: head.length + 1, down: head.length + 1 })
    expect(by.host).toMatchObject({ conns: 1, turns: 1, up: plain.length })
    host.socket.write('y')
    await host.read(1)
    expect(link.resetClasses().host).toMatchObject({ turns: 1, up: 1, down: 1 })
  })
})
