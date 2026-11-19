import type { PublicRoute } from './route'
import { refuseUpgrade } from './route'

/**
 * `wss …/w/doc/<docId>`: the owner's editors, LifeOS's apps and the phone's
 * web view on one live document (architecture §8.1). The socket opens for
 * anyone; the first message must carry a collab token naming this document,
 * which the collab server checks (work-kit/collab-server), and a connection
 * is closed when its token runs out or its link goes.
 */
export const docRoute: PublicRoute = {
  name: 'live documents',
  milestone: 18,
  match: /^\/w\/doc\/([A-Za-z0-9][A-Za-z0-9._:%-]{0,250})$/,
  http: (_req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain', Upgrade: 'websocket', 'Cache-Control': 'no-store' })
    res.end('a live document is a socket')
  },
  upgrade(req, socket, head, ctx, m) {
    let doc: string
    try {
      doc = decodeURIComponent(m[1]!)
    } catch {
      return refuseUpgrade(socket, 404, 'no such document')
    }
    ctx.wss.handleUpgrade(req, socket, head, (ws) => {
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
      const accepted = ctx.collab.accept(ws, new Request(`http://localhost${req.url ?? '/'}`, { headers }), { doc })
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
        accepted.message(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      })
      ws.on('close', (code: number, reason: Buffer) => accepted.close(code, reason.toString()))
      ws.on('error', () => ws.terminate())
    })
  }
}
