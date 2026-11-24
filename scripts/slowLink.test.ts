import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { slowLink } from './lib/slowLink'

let server: Server | null = null
let relay: { close(): void } | null = null
afterEach(() => {
  relay?.close()
  server?.close()
})

async function host(onClient: (s: Socket) => void): Promise<number> {
  server = createServer(onClient)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

it('gives the window the host bytes at the rate, and what the window sends at once', async () => {
  let fromWindow = ''
  const port = await host((s) => {
    s.on('data', (d) => (fromWindow += d.toString()))
    s.write(Buffer.alloc(100 * 1024, 120))
  })
  const link = await slowLink({ host: '127.0.0.1', port }, 200 * 1024)
  relay = link
  const window = connect(link.port, '127.0.0.1')
  window.write('hello')
  let got = 0
  const started = Date.now()
  await new Promise<void>((resolve) =>
    window.on('data', (d) => {
      got += d.length
      if (got >= 100 * 1024) resolve()
    })
  )
  // 100 KiB at 200 KiB/s: about half a second, never at once.
  expect(Date.now() - started).toBeGreaterThan(350)
  expect(fromWindow).toBe('hello')
  window.destroy()
})

it('drops the window at once when the host drops the socket, the bytes it held with it, and says the most it held', async () => {
  const port = await host((s) => {
    s.write(Buffer.alloc(512 * 1024, 120))
    setTimeout(() => s.destroy(), 50)
  })
  const link = await slowLink({ host: '127.0.0.1', port }, 64 * 1024)
  relay = link
  const window = connect(link.port, '127.0.0.1')
  let got = 0
  window.on('data', (d) => (got += d.length))
  const started = Date.now()
  await new Promise<void>((resolve) => window.on('close', () => resolve()))
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(got).toBeLessThan(512 * 1024)
  expect(link.peak()).toBeGreaterThan(256 * 1024)
  link.resetPeak()
  expect(link.peak()).toBe(0)
})
