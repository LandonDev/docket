import { createServer, connect, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startSlowLink, type SlowLink } from './slowLink'

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
