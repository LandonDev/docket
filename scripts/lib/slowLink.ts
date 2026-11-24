import { connect, createServer, type Socket } from 'node:net'

const TICK_MS = 20

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
