import { createConnection, createServer, type Socket } from 'node:net'
import { withinDeadline } from '../e2e-work-lib'
import { withHost } from './slowLink'
import { paragraphsOf, unescapeXml } from '../../src/main/server/work/templates/ooxml'

/** Routes the scratch Mac's link to the scratch box. The window and the Mac's native peer use separate sockets. */
export async function proofPeerLink(boxPort: number): Promise<{ port: number; unplug(): void; plugIn(): void; close(): Promise<void> }> {
  const clients = new Set<Socket>()
  const peers = new Set<Socket>()
  let unplugged = false
  const server = createServer((client) => {
    clients.add(client)
    client.once('close', () => {
      clients.delete(client)
      peers.delete(client)
    })
    client.on('error', () => client.destroy())

    let first = Buffer.alloc(0)
    function identify(chunk: Buffer): void {
      first = Buffer.concat([first, chunk])
      const end = first.indexOf('\r\n\r\n')
      if (end < 0) {
        if (first.length > 32_768) client.destroy()
        return
      }
      client.off('data', identify)
      const headers = first.subarray(0, end).toString()
      // Chromium sends Origin on its upgrades. The native Node peer does not.
      const peer = /^Upgrade:\s*websocket\s*$/im.test(headers) && !/^Origin:/im.test(headers)
      if (peer && unplugged) {
        client.destroy()
        return
      }
      if (peer) peers.add(client)
      const upstream = createConnection({ host: '127.0.0.1', port: boxPort })
      client.once('close', () => upstream.destroy())
      upstream.once('close', () => client.destroy())
      upstream.on('error', () => upstream.destroy())
      // Box's own Host, as his tunnel presents it: box refuses a page's socket that names another.
      upstream.write(withHost(first, end, `127.0.0.1:${boxPort}`))
      client.pipe(upstream).pipe(client)
    }
    client.on('data', identify)
  })
  const port = await withinDeadline('listen for the scratch Mac', 5000, (signal) => new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port: 0, host: '127.0.0.1', signal }, () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('No port for the scratch Mac'))
      else resolve(address.port)
    })
  }))
  return {
    port,
    unplug() {
      unplugged = true
      for (const peer of peers) peer.destroy()
    },
    plugIn() { unplugged = false },
    async close() {
      for (const client of clients) client.destroy()
      await withinDeadline('close the scratch Mac link', 5000, () => new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      ))
    }
  }
}

/** PowerPoint can split one word across several XML runs within a paragraph. */
export function slideParagraphs(xml: string): string[] {
  return paragraphsOf(xml, ['a:p'], 'a:t', ['a:br']).map((runs) =>
    runs.map(({ start, end }) => unescapeXml(xml.slice(start, end))).join('')
  )
}
