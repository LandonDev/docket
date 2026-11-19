import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A stand-in for LifeOS's Convex as the Work service calls it (M17.md): the
 * HTTP API's `/api/query|mutation`, `docs:get`, `docs:generateUploadUrl`, the
 * upload, `docs:store` (compare-and-set on `seq`), `docs:create`,
 * `docs:createThread` and `docs:remove`, with files kept in memory. For
 * tests and the proof only; it checks the bearer is the one it was given.
 */

export interface FakeDoc {
  _id: string
  sector: string
  seq: number
  title: string
  shared: boolean
  markdown: string
  plain: string
  seed?: string
  stateFile?: string
}

export interface FakeConvex {
  url: string
  docs: Map<string, FakeDoc>
  files: Map<string, Uint8Array>
  threads: { docId: string; body: string; quote?: string; author?: string; threadId: string }[]
  calls: string[]
  /** while true, every docs:store fails as a down backend would */
  failStores: boolean
  /** a store by someone else: moves the row's seq on, as a second writer would */
  bump(id: string): void
  close(): Promise<void>
}

export async function startFakeConvex(jwt = 'owner-jwt'): Promise<FakeConvex> {
  const docs = new Map<string, FakeDoc>()
  const files = new Map<string, Uint8Array>()
  const threads: FakeConvex['threads'] = []
  const calls: string[] = []
  let n = 0
  const state = { failStores: false }
  let url = ''
  const read = (req: import('node:http').IncomingMessage): Promise<Buffer> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks)))
    })
  const ok = (value: unknown) => ({ status: 'success', value })
  const fail = (errorMessage: string, errorData?: unknown) => ({ status: 'error', errorMessage, ...(errorData ? { errorData } : {}) })
  const server: Server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const body = await read(req)
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(v))
    }
    if (path === '/upload' && req.method === 'POST') {
      const id = `st${++n}`
      files.set(id, new Uint8Array(body))
      return json(200, { storageId: id })
    }
    if (path.startsWith('/files/')) {
      const file = files.get(path.slice(7))
      if (!file) return json(404, {})
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      return res.end(Buffer.from(file))
    }
    const kind = /^\/api\/(query|mutation|action)$/.exec(path)?.[1]
    if (!kind) return json(404, {})
    if (req.headers.authorization !== `Bearer ${jwt}`) return json(401, fail('Unauthenticated'))
    const { path: fn, args } = JSON.parse(body.toString()) as { path: string; args: Record<string, unknown> }
    calls.push(fn)
    const doc = typeof args.id === 'string' ? docs.get(args.id) : undefined
    switch (fn) {
      case 'docs:get':
        return json(200, ok(doc ? { ...doc, stateUrl: doc.stateFile ? `${url}/files/${doc.stateFile}` : null } : null))
      case 'docs:generateUploadUrl':
        return json(200, ok(`${url}/upload`))
      case 'docs:store': {
        if (state.failStores) return json(503, fail('down'))
        if (!doc) return json(200, fail('not found'))
        if (args.seq !== doc.seq) return json(200, fail('stale', { code: 'stale-seq', seq: doc.seq }))
        Object.assign(doc, { seq: doc.seq + 1, stateFile: args.stateFile as string, markdown: args.markdown as string, plain: args.plain as string })
        return json(200, ok({ seq: doc.seq }))
      }
      case 'docs:create': {
        const id = `kd${++n}`
        docs.set(id, { _id: id, sector: (args.sector as string) ?? 'life', seq: 0, title: args.title as string, shared: false, markdown: '', plain: '' })
        return json(200, ok(id))
      }
      case 'docs:createThread': {
        const threadId = `th${++n}`
        threads.push({ ...(args as { docId: string; body: string; quote?: string; author?: string }), threadId })
        return json(200, ok({ threadId, commentId: `c${n}` }))
      }
      case 'docs:remove':
        docs.delete(args.id as string)
        return json(200, ok(null))
      default:
        return json(200, fail(`no function ${fn}`))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const fake: FakeConvex = {
    url,
    get failStores() {
      return state.failStores
    },
    set failStores(v) {
      state.failStores = v
    },
    docs,
    files,
    threads,
    calls,
    bump(id) {
      const doc = docs.get(id)
      if (doc) doc.seq += 1
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
  return fake
}
