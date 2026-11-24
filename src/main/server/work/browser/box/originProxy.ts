import { lookup } from 'node:dns/promises'
import { createConnection, createServer, isIP, type Socket } from 'node:net'
import { isTempCodeOrigin, type TempCodeOrigins } from '../../../remote/tempcodeOrigins'

/** Chromium sends HTTP, HTTPS and WebSocket connections through this local SOCKS5 proxy. */
export async function startOriginProxy(
  origins: () => TempCodeOrigins,
  refused: () => void
): Promise<{ port: number; refresh(): void; close(): void }> {
  const sockets = new Set<Socket>()
  const openRoutes = new Map<Socket, { hosts: string[]; port: number }>()
  const track = (socket: Socket): void => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  }
  const server = createServer((client) => {
    track(client)
    client.on('error', () => client.destroy())
    client.once('close', () => openRoutes.delete(client))
    client.setTimeout(10_000, () => client.destroy())
    let data = Buffer.alloc(0)
    let greeting = true
    const read = (chunk: Buffer): void => {
      data = Buffer.concat([data, chunk])
      if (greeting) {
        if (data.length < 2 || data.length < 2 + data[1]!) return
        if (data[0] !== 5 || !data.subarray(2, 2 + data[1]!).includes(0)) {
          client.end(Buffer.from([5, 255]))
          return
        }
        client.write(Buffer.from([5, 0]))
        data = data.subarray(2 + data[1]!)
        greeting = false
      }
      if (data.length < 5) return
      const type = data[3]
      const offset = type === 3 ? 5 : 4
      const size = type === 3 ? data[4]! : type === 1 ? 4 : type === 4 ? 16 : 0
      if (data[0] !== 5 || data[1] !== 1 || data[2] !== 0 || !size) {
        client.end(reply(7))
        return
      }
      if (data.length < offset + size + 2) return
      const bytes = data.subarray(offset, offset + size)
      const host =
        type === 3
          ? bytes.toString('ascii')
          : type === 1
            ? Array.from(bytes).join('.')
            : Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(':')
      const port = data.readUInt16BE(offset + size)
      client.pause()
      client.off('data', read)
      const pending = data.subarray(offset + size + 2)
      void forward(host, port, client, pending)
    }
    client.on('data', read)
  })

  async function forward(
    host: string,
    port: number,
    client: Socket,
    pending: Buffer
  ): Promise<void> {
    const reject = (): void => {
      refused()
      client.end(reply(2))
    }
    try {
      if (!port || (!isIP(host) && !/^[a-z\d_.-]+$/i.test(host))) return void client.end(reply(8))
      if (denied(host, port, origins())) return reject()
      const addresses = isIP(host)
        ? [host]
        : (await lookup(host, { all: true })).map((row) => row.address)
      const current = origins()
      if ([host, ...addresses].some((address) => denied(address, port, current))) return reject()
      if (client.destroyed) return
      // The addresses were checked above. The socket must use those same answers.
      const upstream = createConnection({
        host,
        port,
        lookup: (_host, _options, callback) =>
          callback(
            null,
            addresses.map((address) => ({ address, family: isIP(address) }))
          ),
        autoSelectFamily: true
      })
      track(upstream)
      openRoutes.set(client, { hosts: [host, ...addresses], port })
      let connected = false
      upstream.once('error', () => {
        if (!connected) client.end(reply(5))
        else if (!client.destroyed) client.destroy()
      })
      client.once('close', () => upstream.destroy())
      upstream.once('connect', () => {
        connected = true
        client.setTimeout(0)
        client.write(reply(0))
        if (pending.length) upstream.write(pending)
        upstream.pipe(client).pipe(upstream)
      })
    } catch {
      client.end(reply(4))
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.unref()
  // A linked route can change while Chromium is holding an idle connection or a live WebSocket.
  const refresh = (): void => {
    if (!openRoutes.size) return
    try {
      const current = origins()
      for (const [client, route] of openRoutes) {
        if (route.hosts.some((host) => denied(host, route.port, current))) client.destroy()
      }
    } catch {
      for (const client of openRoutes.keys()) client.destroy()
    }
  }
  const timer = setInterval(refresh, 1_000)
  timer.unref()
  const bound = server.address()
  if (!bound || typeof bound === 'string') throw new Error('the browser origin proxy did not bind')
  return {
    port: bound.port,
    refresh,
    close() {
      clearInterval(timer)
      server.close()
      for (const socket of sockets) socket.destroy()
    }
  }
}

function denied(host: string, port: number, origins: TempCodeOrigins): boolean {
  const authority = isIP(host) === 6 ? `[${host}]` : host
  return isTempCodeOrigin(`http://${authority}:${port}`, origins)
}

const reply = (status: number): Buffer => Buffer.from([5, status, 0, 1, 0, 0, 0, 0, 0, 0])
