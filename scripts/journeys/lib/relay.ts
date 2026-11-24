import { createConnection, createServer, type Socket } from 'node:net'
import { startSlowLink, type Counters, type Shape } from '../../lib/slowLink'

/** A run-local socket hop. Cutting it closes only the links through this listener. */
export async function relay(host: string, target: number) {
  const sockets = new Set<Socket>()
  let cut = false
  const disconnect = (): void => {
    for (const socket of sockets) socket.destroy()
  }
  const server = createServer((client) => {
    if (cut) return void client.destroy()
    const upstream = createConnection(target, '127.0.0.1')
    for (const [socket, peer] of [[client, upstream], [upstream, client]] as const) {
      sockets.add(socket)
      socket.on('error', () => socket.destroy())
      socket.once('close', () => {
        sockets.delete(socket)
        peer.destroy()
      })
    }
    client.pipe(upstream).pipe(client)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The journey relay has no port')
  return {
    port: address.port,
    cut(on: boolean) {
      cut = on
      if (on) disconnect()
    },
    async stop() {
      disconnect()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }
}

/** The same hop with a delay and a rate each way (scripts/lib/slowLink.ts): his tunnel, for the perf kit. */
export async function shapedRelay(target: number, shape: Shape) {
  const link = await startSlowLink({ listen: 0, target, shape })
  return {
    port: link.port,
    cut: (on: boolean) => link.cut(on),
    stop: () => link.close(),
    /** Bytes and round trips on the wire since the last reset, then zero. */
    reset: (): Counters => link.reset()
  }
}
