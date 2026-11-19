import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A fake Frame.io for tests and proofs (docs/agents/work-frameio.md,
 * "Proving it"): Adobe IMS's authorize and token routes with PKCE, and the
 * V4 routes the pillar calls, answering in the shapes the formats research
 * recorded from Frame.io's OpenAPI spec: `{ data }`, `links.next` with an
 * `after` cursor, `{ errors: [{ detail }] }`, comments with `timestamp`
 * counted from 1, `annotation` as stringified JSON, webhooks signed
 * `v0=<hex>` over `v0:<time>:<body>`. Pages are cut at `pageCap` rows so
 * paging is exercised. Webhooks are delivered to `deliverTo` when set (the
 * tunnel, in a test), else to the address they were made with.
 */

export interface FakeUser {
  id: string
  name: string
  email: string
}
interface FakeFile {
  id: string
  name: string
  media_type: string
  parent_id: string
  project_id: string
  file_size: number
  created_at: string
  bytes: Buffer
  uploaded?: boolean
}
interface FakeComment {
  id: string
  file_id: string
  text: string
  timestamp?: number
  duration?: number
  annotation?: string
  anchor?: { x: number; y: number }
  completed_at: string | null
  created_at: string
  owner: FakeUser
  parent?: string
}

export class FakeFrameio {
  server!: Server
  base = ''
  readonly me: FakeUser = { id: 'usr-landon', name: 'Landon', email: 'landon@example.test' }
  readonly reviewer: FakeUser = { id: 'usr-dana', name: 'Dana Lee', email: 'dana@example.test' }
  readonly account = 'acc-1'
  readonly workspace = 'ws-hypixel'
  readonly project = { id: 'prj-1', name: 'Hypixel trailers', root_folder_id: 'fld-root', workspace_id: 'ws-hypixel' }
  readonly folders = new Map<string, { id: string; name: string; parent_id: string; project_id: string }>([['fld-cuts', { id: 'fld-cuts', name: 'Cuts', parent_id: 'fld-root', project_id: 'prj-1' }]])
  readonly stacks = new Map<string, { id: string; name: string; parent_id: string; project_id: string; files: string[] }>()
  readonly files = new Map<string, FakeFile>()
  readonly comments = new Map<string, FakeComment>()
  readonly hooks = new Map<string, { id: string; url: string; events: string[]; secret: string; workspace_id: string }>()
  /** every write the pillar sent: method, path and body */
  readonly writes: Array<{ method: string; path: string; body: unknown }> = []
  /** IMS: codes waiting for their verifier, refresh tokens, live access tokens */
  private readonly codes = new Map<string, { challenge: string; clientId: string }>()
  private readonly refreshes = new Set<string>()
  readonly access = new Set<string>()
  expiresIn = 3600
  pageCap = 2
  deliverTo: string | null = null
  deliveries: Array<{ status: number; type: string }> = []

  constructor() {
    const bytes = (n: number): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => i % 251))
    this.stacks.set('vs-cut12', { id: 'vs-cut12', name: 'Cut 12', parent_id: 'fld-cuts', project_id: 'prj-1', files: ['file-v2', 'file-v1'] })
    const file = (id: string, name: string, parent: string, at: string, media_type = 'video/quicktime'): void =>
      void this.files.set(id, { id, name, media_type, parent_id: parent, project_id: 'prj-1', file_size: 4096, created_at: at, bytes: bytes(4096), uploaded: true })
    file('file-v1', 'cut12_v1.mov', 'vs-cut12', '2026-11-01T10:00:00Z')
    file('file-v2', 'cut12_v2.mov', 'vs-cut12', '2026-11-10T10:00:00Z')
    file('file-thumb', 'thumbnail.png', 'fld-cuts', '2026-11-02T10:00:00Z', 'image/png')
    this.comment({ file_id: 'file-v1', text: 'Old cut note', timestamp: 1, owner: this.reviewer })
    const c = this.comment({
      file_id: 'file-v2',
      text: 'The logo pops a frame early',
      timestamp: 25,
      duration: 12,
      anchor: { x: 0.5, y: 0.25 },
      annotation: JSON.stringify([{ tool: 'rect', color: '#F22237', size: 8, x: 0.27, y: 0.12, w: 0.31, h: 0.53, ix: 0.27, iy: 0.12, radius: 8 }]),
      owner: this.reviewer
    })
    this.comment({ file_id: 'file-v2', text: 'Agreed, fixing', owner: this.me, parent: c.id })
    this.comment({ file_id: 'file-v2', text: 'Colour is good now', timestamp: 241, owner: this.me, completed_at: '2026-11-11T10:00:00Z' })
  }

  comment(c: Partial<FakeComment> & { file_id: string; text: string; owner: FakeUser }): FakeComment {
    const made: FakeComment = { id: `cmt-${randomUUID().slice(0, 8)}`, completed_at: null, created_at: new Date().toISOString(), ...c }
    this.comments.set(made.id, made)
    return made
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.route(req, res).catch((err) => this.send(res, 500, { errors: [{ detail: String(err) }] })))
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }
  stop = (): Promise<void> => new Promise((r) => this.server.close(() => r()))
  get api(): string {
    return `${this.base}/v4`
  }

  /** What the person's browser does at Adobe: signs in and is sent back to the redirect with a code. */
  approve(authorizeUrl: string): string {
    const u = new URL(authorizeUrl)
    const q = u.searchParams
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) throw new Error('no PKCE')
    const code = randomBytes(8).toString('hex')
    this.codes.set(code, { challenge: q.get('code_challenge')!, clientId: q.get('client_id')! })
    const back = new URL(q.get('redirect_uri')!)
    back.searchParams.set('code', code)
    back.searchParams.set('state', q.get('state')!)
    return back.toString()
  }

  /** A reviewer comments in Frame.io's own player; Frame.io tells every webhook. */
  async reviewerComments(fileId: string, text: string, timestamp: number, by = this.reviewer): Promise<FakeComment> {
    const c = this.comment({ file_id: fileId, text, timestamp, owner: by })
    await this.deliver('comment.created', { id: c.id, type: 'comment' }, by)
    return c
  }

  async deliver(type: string, resource: { id: string; type: string }, by: FakeUser, o: { badSecret?: boolean } = {}): Promise<void> {
    for (const h of this.hooks.values()) {
      if (!h.events.includes(type)) continue
      const body = JSON.stringify({ type, resource, account: { id: this.account }, workspace: { id: h.workspace_id }, project: { id: this.project.id }, user: { id: by.id } })
      const ts = String(Math.floor(Date.now() / 1000))
      const sig = `v0=${createHmac('sha256', o.badSecret ? 'wrong' : h.secret).update(`v0:${ts}:${body}`).digest('hex')}`
      const target = this.deliverTo ?? h.url
      const res = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Frameio-Request-Timestamp': ts, 'X-Frameio-Signature': sig }, body })
      this.deliveries.push({ status: res.status, type })
    }
  }

  private send(res: ServerResponse, status: number, body?: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'api-version': '4.0' })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }

  private page<T>(res: ServerResponse, url: URL, rows: T[]): void {
    const size = Math.min(this.pageCap, Number(url.searchParams.get('page_size') ?? 50))
    const from = Number(url.searchParams.get('after') ?? 0)
    const next = from + size < rows.length ? `${url.pathname}?after=${from + size}` : null
    this.send(res, 200, { data: rows.slice(from, from + size), links: { next } })
  }

  private fileOut(f: FakeFile, include: string | null): Record<string, unknown> {
    const out: Record<string, unknown> = { id: f.id, name: f.name, type: 'file', media_type: f.media_type, parent_id: f.parent_id, project_id: f.project_id, file_size: f.file_size, created_at: f.created_at, status: 'transcoded' }
    if (include?.includes('media_links')) {
      const hq = `${this.base}/cdn/${f.id}/hq.mp4?Expires=1`
      out.media_links = { original: { download_url: `${this.base}/cdn/${f.id}/original`, inline_url: null }, high_quality: { url: hq }, efficient: { url: hq } }
    }
    return out
  }

  private commentOut(c: FakeComment, include: string | null): Record<string, unknown> {
    const out: Record<string, unknown> = { id: c.id, file_id: c.file_id, text: c.text, timestamp: c.timestamp ?? null, duration: c.duration ?? null, annotation: c.annotation ?? null, anchor: c.anchor ?? null, completed_at: c.completed_at, created_at: c.created_at }
    if (include?.includes('owner')) out.owner = c.owner
    if (include?.includes('replies')) out.replies = [...this.comments.values()].filter((r) => r.parent === c.id).map((r) => this.commentOut(r, 'owner'))
    return out
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const parts: Buffer[] = []
    for await (const b of req) parts.push(b as Buffer)
    return Buffer.concat(parts)
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.base)
    const path = url.pathname
    const method = req.method ?? 'GET'
    const raw = await this.body(req)

    if (path === '/ims/token/v3' && method === 'POST') {
      const f = new URLSearchParams(raw.toString())
      const grant = f.get('grant_type')
      if (grant === 'authorization_code') {
        const code = this.codes.get(f.get('code') ?? '')
        const verifier = f.get('code_verifier') ?? ''
        if (!code || createHash('sha256').update(verifier).digest('base64url') !== code.challenge || code.clientId !== f.get('client_id')) return this.send(res, 400, { error: 'invalid_grant', error_description: 'code or verifier wrong' })
        this.codes.delete(f.get('code')!)
      } else if (grant === 'refresh_token') {
        if (!this.refreshes.has(f.get('refresh_token') ?? '')) return this.send(res, 400, { error: 'invalid_grant', error_description: 'refresh token unknown' })
      } else return this.send(res, 400, { error: 'unsupported_grant_type' })
      const access = `at-${randomBytes(6).toString('hex')}`
      const refresh = `rt-${randomBytes(6).toString('hex')}`
      this.access.add(access)
      this.refreshes.add(refresh)
      return this.send(res, 200, { access_token: access, refresh_token: refresh, expires_in: this.expiresIn, token_type: 'bearer' })
    }

    const cdn = /^\/cdn\/([^/]+)\/(hq\.mp4|original)$/.exec(path)
    if (cdn) {
      const f = this.files.get(cdn[1])
      if (!f) return this.send(res, 404)
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': f.bytes.length })
      return void res.end(f.bytes)
    }
    const put = /^\/upload\/([^/]+)\/(\d+)$/.exec(path)
    if (put && method === 'PUT') {
      const f = this.files.get(put[1])
      if (!f || req.headers['x-amz-acl'] !== 'private') return this.send(res, 403)
      f.bytes = Buffer.concat([f.bytes, raw])
      if (f.bytes.length >= f.file_size) f.uploaded = true
      res.writeHead(200)
      return void res.end()
    }

    if (!path.startsWith('/v4/')) return this.send(res, 404, { errors: [{ detail: 'Not found' }] })
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (!this.access.has(token)) return this.send(res, 401, { errors: [{ detail: 'Unauthorized', title: 'Unauthorized' }] })
    if (method !== 'GET') this.writes.push({ method, path, body: raw.length ? JSON.parse(raw.toString()) : null })
    const p = path.slice(3).split('/').filter(Boolean)
    const include = url.searchParams.get('include')
    const data = <T>(d: T): void => this.send(res, 200, { data: d })
    const notFound = (): void => this.send(res, 404, { errors: [{ detail: 'Not found', title: 'Not Found' }] })
    const json = (raw.length ? JSON.parse(raw.toString()) : {}) as { data?: Record<string, unknown> }

    if (p[0] === 'me') return data(this.me)
    if (p[0] === 'accounts' && p.length === 1) return this.page(res, url, [{ id: this.account, display_name: 'Hypixel Studio' }])
    if (p[0] !== 'accounts' || p[1] !== this.account) return notFound()
    const [, , kind, id, sub, sub2] = p
    if (kind === 'workspaces' && !id) return this.page(res, url, [{ id: this.workspace, name: 'Hypixel' }])
    if (kind === 'workspaces' && sub === 'projects') return id === this.workspace ? this.page(res, url, [this.project]) : notFound()
    if (kind === 'workspaces' && sub === 'webhooks' && method === 'POST') {
      const d = json.data as { name: string; url: string; events: string[] }
      const hook = { id: `wh-${randomUUID().slice(0, 8)}`, url: d.url, events: d.events, secret: randomBytes(16).toString('hex'), workspace_id: id }
      this.hooks.set(hook.id, hook)
      return data({ ...hook })
    }
    if (kind === 'workspaces' && sub === 'webhooks') return this.page(res, url, [...this.hooks.values()].map(({ secret: _s, ...h }) => h))
    if (kind === 'webhooks' && method === 'DELETE') return void (this.hooks.delete(id) ? this.send(res, 204) : notFound())
    if (kind === 'projects' && id === this.project.id) return data(this.project)
    if (kind === 'folders' && sub === 'children') {
      const rows = [
        ...[...this.folders.values()].filter((f) => f.parent_id === id).map((f) => ({ ...f, type: 'folder' })),
        ...[...this.stacks.values()].filter((s) => s.parent_id === id).map(({ files: _f, ...s }) => ({ ...s, type: 'version_stack' })),
        ...[...this.files.values()].filter((f) => f.parent_id === id && f.uploaded).map((f) => this.fileOut(f, include))
      ]
      return this.page(res, url, rows)
    }
    if (kind === 'folders' && sub === 'files' && sub2 === 'local_upload' && method === 'POST') {
      const d = json.data as { name: string; file_size: number }
      const fid = `file-${randomUUID().slice(0, 8)}`
      const f: FakeFile = { id: fid, name: d.name, media_type: 'video/mp4', parent_id: id, project_id: 'prj-1', file_size: d.file_size, created_at: new Date().toISOString(), bytes: Buffer.alloc(0) }
      this.files.set(fid, f)
      // Two parts, as Frame.io cuts a file into parts of its own choosing.
      const first = Math.ceil(d.file_size / 2)
      return data({ ...this.fileOut(f, null), upload_urls: [{ size: first, url: `${this.base}/upload/${fid}/0` }, { size: d.file_size - first, url: `${this.base}/upload/${fid}/1` }] })
    }
    if (kind === 'folders' && sub === 'version_stacks' && method === 'POST') {
      const ids = (json.data as { file_ids: string[] }).file_ids
      const vs = { id: `vs-${randomUUID().slice(0, 8)}`, name: this.files.get(ids[0])?.name ?? 'Stack', parent_id: id, project_id: 'prj-1', files: [...ids].reverse() }
      this.stacks.set(vs.id, vs)
      for (const f of ids) this.files.get(f)!.parent_id = vs.id
      return data({ id: vs.id })
    }
    if (kind === 'version_stacks') {
      const vs = this.stacks.get(id)
      if (!vs) return notFound()
      if (sub === 'children') return this.page(res, url, vs.files.map((f) => this.fileOut(this.files.get(f)!, include)))
      const { files: _f, ...out } = vs
      return data({ ...out, type: 'version_stack' })
    }
    if (kind === 'files') {
      const f = this.files.get(id)
      if (!f) return notFound()
      if (!sub) return data(this.fileOut(f, include))
      if (sub === 'status') return data({ upload_complete: !!f.uploaded, upload_failed: false })
      if (sub === 'move' && method === 'PATCH') {
        const parent = (json.data as { parent_id: string }).parent_id
        const vs = this.stacks.get(parent)
        if (vs) vs.files.unshift(f.id)
        f.parent_id = parent
        return data(this.fileOut(f, null))
      }
      if (sub === 'comments' && method === 'POST') {
        const d = json.data as Partial<FakeComment> & { text: string; timestamp?: number | string }
        if (!d.text) return this.send(res, 422, { errors: [{ detail: 'text is required', source: { pointer: '/data/text' } }] })
        if (typeof d.timestamp === 'number' && d.timestamp < 0) return this.send(res, 422, { errors: [{ detail: 'timestamp must be at least 0' }] })
        const c = this.comment({ file_id: f.id, text: d.text, owner: this.me, ...(typeof d.timestamp === 'number' ? { timestamp: d.timestamp } : {}), ...(d.duration ? { duration: d.duration } : {}), ...(d.anchor ? { anchor: d.anchor } : {}), ...(d.annotation ? { annotation: d.annotation } : {}) })
        return data(this.commentOut(c, 'owner'))
      }
      if (sub === 'comments') return this.page(res, url, [...this.comments.values()].filter((c) => c.file_id === f.id && !c.parent).map((c) => this.commentOut(c, include)))
    }
    if (kind === 'comments') {
      const c = this.comments.get(id)
      return c ? data(this.commentOut(c, include)) : notFound()
    }
    notFound()
  }
}
