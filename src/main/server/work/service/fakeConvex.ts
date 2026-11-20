import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A stand-in for LifeOS's Convex as the Work service calls it (M17.md): the
 * HTTP API's `/api/query|mutation`, `docs:get`, `docs:generateUploadUrl`, the
 * upload, `docs:store` (compare-and-set on `seq`), `docs:create`,
 * `docs:createThread`, `docs:remove`, and the versions and branches milestone 19 keeps, with files kept in memory. For
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

export interface FakeVersion {
  _id: string
  docId: string
  at: number
  cause: string
  label?: string
  clients: Record<string, string>
  epoch: number
  restoredFrom?: string
  /** base64, as Convex's JSON carries bytes */
  snapshot?: string
  blocksFile?: string
}

export interface FakeBranch {
  _id: string
  docId: string
  stateFile: string
  baseVersionId: string
  authors: string[]
  label: string
  state: 'pending' | 'merged' | 'dropped'
  at: number
  editedAt: number
}

export interface FakeConvex {
  url: string
  docs: Map<string, FakeDoc>
  /** LifeOS projects by id, as `projects:get` answers the part the service reads */
  projects: Map<string, { name: string; sector: string; shared: boolean }>
  versions: FakeVersion[]
  branches: FakeBranch[]
  files: Map<string, Uint8Array>
  threads: { docId: string; body: string; quote?: string; author?: string; threadId: string; replies?: { body: string; author?: string; commentId: string }[] }[]
  /** LifeOS sheets by id, each its op log (milestone 31's live proof opens one on the guest's page) */
  sheets: Map<string, { title: string; sector: string; ops: { rev: number; by: string; at: number; mutations: string }[] }>
  calls: string[]
  /** while true, every docs:store fails as a down backend would */
  failStores: boolean
  /** a store by someone else: moves the row's seq on, as a second writer would */
  bump(id: string): void
  close(): Promise<void>
}

export async function startFakeConvex(jwt = 'owner-jwt'): Promise<FakeConvex> {
  const docs = new Map<string, FakeDoc>()
  const projects: FakeConvex['projects'] = new Map()
  const files = new Map<string, Uint8Array>()
  const threads: FakeConvex['threads'] = []
  const versions: FakeVersion[] = []
  const branches: FakeBranch[] = []
  const calls: string[] = []
  const sheets: FakeConvex['sheets'] = new Map()
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
      case 'projects:get': {
        const project = projects.get(args.id as string)
        return project ? json(200, ok({ project })) : json(200, fail('not found'))
      }
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
      // A sheet as the service's sheet host reads it (M27): a row, its op log, and no suggestions.
      case 'sheets:get': {
        const sh = sheets.get(args.id as string)
        return json(200, ok(sh ? { _id: args.id, title: sh.title, sector: sh.sector, rev: sh.ops.at(-1)?.rev ?? 0, snapshotRev: 0, shared: false, snapshotUrl: null } : null))
      }
      case 'sheets:ops':
        return json(200, ok(sheets.get(args.sheetId as string)?.ops.filter((o) => o.rev > (args.after as number)) ?? []))
      case 'sheets:appendOps': {
        const sh = sheets.get(args.sheetId as string)
        if (!sh) return json(200, fail('not found'))
        const rev = sh.ops.at(-1)?.rev ?? 0
        if (args.baseRev !== rev) return json(200, fail('stale', { code: 'stale-rev', rev }))
        for (const o of args.ops as { by: string; mutations: string }[]) sh.ops.push({ rev: (sh.ops.at(-1)?.rev ?? 0) + 1, by: o.by, at: Date.now(), mutations: typeof o.mutations === 'string' ? o.mutations : JSON.stringify(o.mutations) })
        return json(200, ok({ rev: sh.ops.at(-1)!.rev }))
      }
      case 'sheets:suggestions':
        return json(200, ok([]))
      // A thread and its comments in M17's `docs.threads` shape (milestone 31's guest routes read and answer them).
      case 'docs:threads':
        return json(
          200,
          ok(
            threads
              .filter((t) => t.docId === args.docId)
              .map((t) => ({
                thread: { _id: t.threadId, quote: t.quote, resolved: false, at: 1, editedAt: 1 },
                comments: [{ _id: `${t.threadId}c`, author: t.author, body: t.body, at: 1, editedAt: 1 }, ...(t.replies ?? []).map((r) => ({ _id: r.commentId, author: r.author, body: r.body, at: 2, editedAt: 2 }))]
              }))
          )
        )
      case 'docs:addComment': {
        const t = threads.find((x) => x.threadId === args.threadId)
        if (!t) return json(200, fail('not found'))
        const commentId = `c${++n}`
        ;(t.replies ??= []).push({ body: args.body as string, author: args.author as string | undefined, commentId })
        return json(200, ok({ commentId }))
      }
      case 'docs:remove':
        docs.delete(args.id as string)
        return json(200, ok(null))
      // Versions and branches (M17's shapes; milestone 19 reads and writes them).
      case 'docs:cutVersion': {
        const id = `kv${++n}`
        const { snapshot, ...rest } = args as { snapshot: { $bytes: string } } & Record<string, unknown>
        versions.push({ ...rest, _id: id, at: Date.now(), epoch: (rest.epoch as number) ?? 0, snapshot: snapshot.$bytes } as FakeVersion)
        return json(200, ok(id))
      }
      case 'docs:versions': {
        const page = versions.filter((v) => v.docId === args.docId).reverse().map(({ snapshot, blocksFile: _b, ...v }) => ({ ...v, hasSnapshot: snapshot !== undefined }))
        return json(200, ok({ page, isDone: true, continueCursor: '' }))
      }
      case 'docs:version': {
        const v = versions.find((x) => x._id === args.id)
        if (!v) return json(200, ok(null))
        const { snapshot, blocksFile, ...rest } = v
        return json(200, ok({ ...rest, ...(snapshot ? { snapshot: { $bytes: snapshot } } : {}), blocksUrl: blocksFile ? `${url}/files/${blocksFile}` : null }))
      }
      case 'docs:setVersionBlocks': {
        const v = versions.find((x) => x._id === args.id)
        if (!v) return json(200, fail('not found'))
        delete v.snapshot
        v.blocksFile = args.blocksFile as string
        return json(200, ok(null))
      }
      case 'docs:branches':
        return json(200, ok(branches.filter((b) => b.docId === args.docId).map((b) => ({ ...b, stateUrl: `${url}/files/${b.stateFile}` }))))
      case 'docs:createBranch': {
        if (!versions.some((v) => v._id === args.baseVersionId && v.docId === args.docId)) return json(200, fail("that version is not this doc's"))
        const id = `kb${++n}`
        branches.push({ ...(args as Omit<FakeBranch, '_id' | 'state' | 'at' | 'editedAt'>), _id: id, state: 'pending', at: Date.now(), editedAt: Date.now() })
        return json(200, ok(id))
      }
      case 'docs:setBranch': {
        const b = branches.find((x) => x._id === args.id)
        if (!b) return json(200, fail('not found'))
        if (args.state) b.state = args.state as FakeBranch['state']
        if (args.stateFile) b.stateFile = args.stateFile as string
        b.editedAt = Date.now()
        return json(200, ok(null))
      }
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
    projects,
    files,
    threads,
    sheets,
    versions,
    branches,
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
