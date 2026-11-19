import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, copyFileSync, createReadStream, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, dirname, extname, join } from 'node:path'
import { Docservice, dsGet, groupRss, type DocserviceOpts } from './docservice'
import { FULL_TOKEN, lookupSocketOf, type FullLookup } from './wire'

/**
 * The full editor (docs/agents/work-sheets.md, "The full editor"): opens of
 * a workbook in ONLYOFFICE, and the two small servers it needs. Main runs
 * them, since main owns the files:
 *
 * - the storage server, on 127.0.0.1, which only the docservice calls: it
 *   fetches the file as it was when the switch was pressed, and posts its
 *   callbacks (signed with the docservice's secret), whose saves land in
 *   the file as a change from outside;
 * - the lookup socket, beside the Work service's internal one, which only
 *   the service's `/w/full` route calls, to learn what a token opens.
 *
 * The docservice starts on the first open, and stops when Work turns off,
 * when nothing has been open for `idleMs`, or when its process group holds
 * more memory than the cap.
 */

/** 32 random bytes, hex: a token (FULL_TOKEN), the docservice's secret. */
export const newToken = (): string => randomBytes(32).toString('hex')

/** An open's id, which is its document's key: hex, since the converter takes a key starting with `-` for a flag. */
export const newDocId = (): string => randomBytes(24).toString('hex')

/** What tells a change made outside the full editor (the same stamp the package store keeps). */
export function stampOf(path: string): string {
  const st = statSync(path)
  return `${st.size}:${Math.round(st.mtimeMs)}`
}

export function signHs256(payload: object, secret: string): string {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

/** The claims of a token this secret signed with HS256 and that has not run out; null otherwise. */
export function verifyHs256(token: string, secret: string, now = Date.now()): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [head, body, sig] = parts as [string, string, string]
  const want = createHmac('sha256', secret).update(`${head}.${body}`).digest()
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  try {
    if ((JSON.parse(Buffer.from(head, 'base64url').toString()) as { alg?: string }).alg !== 'HS256') return null
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>
    if (typeof claims.exp === 'number' && claims.exp * 1000 < now) return null
    return claims
  } catch {
    return null
  }
}

/** One workbook open in the full editor. */
export interface FullOpen {
  token: string
  /** the document's key and the storage server's name for it */
  id: string
  path: string
  itemId: string
  title: string
  fileType: string
  /** the file as the docservice fetched it */
  snapshot: string
  /** the file's stamp when it was last ours: a save over a file changed since goes beside it */
  stamp: string
  at: number
  /** someone has had it open in the editor */
  seen: boolean
  users: number
}

/** Where a save from the editor went. */
export interface SavedTo {
  path: string
  /** the file had changed outside the editor meanwhile: the save is a copy beside it */
  beside: boolean
}

export interface FullEditorDeps {
  dataDir: string
  /** the Work service's internal socket: the lookup socket sits beside it */
  serviceSocket: string
  /** the toolchain's onlyoffice folder, when it is installed */
  toolDir(): string | null
  enabled(): boolean
  log(line: string): void
  /** a save landed */
  saved(open: FullOpen, to: SavedTo): void
  /** what the owner must hear about a save that did not land in the file */
  failed(open: FullOpen, words: string): void
  now?: () => number
  spawn?: DocserviceOpts['spawn']
  rss?: (pgid: number) => Promise<number>
  memoryCapBytes?: number
  idleMs?: number
  tickMs?: number
}

/** The cap on the docservice's process group, 2 GiB unless `TEMP_CODE_FULL_EDITOR_MEMORY_MB` says otherwise. */
export function memoryCapOf(env: NodeJS.ProcessEnv = process.env): number {
  const mb = Number(env.TEMP_CODE_FULL_EDITOR_MEMORY_MB)
  return (Number.isInteger(mb) && mb >= 512 ? mb : 2048) * 1024 * 1024
}

/** An open nobody loaded in this long is let go. */
export const UNSEEN_MS = 15 * 60_000
/** No open lives longer than this. */
export const MAX_OPEN_MS = 24 * 60 * 60_000

export class FullEditor {
  private readonly home: string
  private readonly secret = newToken()
  private readonly opens = new Map<string, FullOpen>()
  private readonly byId = new Map<string, FullOpen>()
  private ds: Docservice | null = null
  private starting: Promise<Docservice> | null = null
  private storage: Server | null = null
  private storagePort = 0
  private lookup: Server | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private quietSince = 0
  private readonly now: () => number

  constructor(private readonly deps: FullEditorDeps) {
    this.home = join(deps.dataDir, 'full-editor')
    this.now = deps.now ?? Date.now
  }

  /** Offered on a Linux host (the box) with the tool installed. */
  available(): boolean {
    return process.platform === 'linux' && this.deps.toolDir() !== null
  }

  /** Whether the docservice runs now. */
  running(): boolean {
    return this.ds?.running() ?? false
  }

  /**
   * Opens a workbook: starts what is not running and answers the open's
   * token. A file already open answers the same token, so two presses never
   * make two sessions that would save over each other.
   */
  async open(o: { path: string; itemId: string; title: string }): Promise<string> {
    if (!this.deps.enabled()) throw new Error('Work is off on this host.')
    const toolDir = this.deps.toolDir()
    if (process.platform !== 'linux' || !toolDir) throw new Error('The full editor is not installed on this host.')
    for (const open of this.opens.values()) if (open.path === o.path) return open.token
    await this.listen()
    await this.docservice(toolDir)
    const id = newDocId()
    const fileType = extname(o.path).slice(1).toLowerCase()
    const files = join(this.home, 'files')
    mkdirSync(files, { recursive: true, mode: 0o700 })
    const snapshot = join(files, `${id}.${fileType}`)
    const stamp = stampOf(o.path)
    copyFileSync(o.path, snapshot)
    const open: FullOpen = { token: newToken(), id, path: o.path, itemId: o.itemId, title: o.title, fileType, snapshot, stamp, at: this.now(), seen: false, users: 0 }
    this.opens.set(open.token, open)
    this.byId.set(open.id, open)
    this.deps.log(`[full-editor] opened ${basename(o.path)}`)
    return open.token
  }

  /** The editor's config for an open, signed for the docservice. */
  configOf(open: FullOpen): Record<string, unknown> {
    const store = `http://127.0.0.1:${this.storagePort}`
    const config: Record<string, unknown> = {
      document: {
        fileType: open.fileType,
        key: open.id,
        title: open.title,
        url: `${store}/file/${open.id}`,
        permissions: { edit: true, comment: true, download: true, print: true, review: false }
      },
      documentType: 'cell',
      editorConfig: {
        callbackUrl: `${store}/callback/${open.id}`,
        mode: 'edit',
        lang: 'en',
        user: { id: 'owner', name: 'Owner' },
        customization: { forcesave: true, autosave: true, compactHeader: true, uiTheme: 'theme-system' }
      },
      type: 'desktop',
      width: '100%',
      height: '100%'
    }
    return { ...config, token: signHs256(config, this.secret) }
  }

  /** Every open ends, the docservice and both servers stop. */
  async stop(why: string): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const open of [...this.opens.values()]) this.end(open)
    const ds = this.ds
    this.ds = null
    this.starting = null
    if (ds?.running()) this.deps.log(`[full-editor] stopped: ${why}`)
    await ds?.stop()
    await Promise.all([this.storage, this.lookup].map((s) => (s ? new Promise<void>((r) => s.close(() => r())) : null)))
    this.storage = null
    this.lookup = null
    rmSync(lookupSocketOf(this.deps.serviceSocket), { force: true })
  }

  /** One pass of the watchdog: Work off, the memory cap, opens nobody uses, and idle. */
  async tick(): Promise<void> {
    if (!this.deps.enabled()) return this.stop('Work is off')
    const ds = this.ds
    if (ds?.pid) {
      const cap = this.deps.memoryCapBytes ?? memoryCapOf()
      const rss = await (this.deps.rss ?? groupRss)(ds.pid)
      if (rss > cap) return this.stop(`its processes held ${Math.round(rss / 1048576)} MB, over the ${Math.round(cap / 1048576)} MB cap; edits not yet saved there are lost`)
    }
    const now = this.now()
    for (const open of [...this.opens.values()]) {
      if (!open.seen && now - open.at > UNSEEN_MS) this.end(open)
      else if (open.users === 0 && now - open.at > MAX_OPEN_MS) this.end(open)
    }
    if (this.opens.size === 0 && now - this.quietSince > (this.deps.idleMs ?? 10 * 60_000)) await this.stop('nothing open for ten minutes')
  }

  // ── what it starts ─────────────────────────────────────────────────

  private docservice(toolDir: string): Promise<Docservice> {
    if (this.ds?.running()) return Promise.resolve(this.ds)
    this.starting ??= (async () => {
      const ds = new Docservice({ toolDir, home: this.home, secret: this.secret, log: this.deps.log, ...(this.deps.spawn ? { spawn: this.deps.spawn } : {}) })
      this.deps.log('[full-editor] starting the docservice')
      await ds.start(() => {
        if (this.ds !== ds) return
        this.ds = null
        for (const open of [...this.opens.values()]) this.end(open)
      })
      this.ds = ds
      this.quietSince = this.now()
      this.timer ??= setInterval(() => void this.tick().catch((err: Error) => this.deps.log(`[full-editor] ${err.message}`)), this.deps.tickMs ?? 10_000)
      this.timer.unref?.()
      return ds
    })().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async listen(): Promise<void> {
    if (!this.storage) {
      const storage = createServer((req, res) => void this.serveStorage(req, res))
      await new Promise<void>((resolve, reject) => storage.once('error', reject).listen(0, '127.0.0.1', () => resolve()))
      this.storage = storage
      this.storagePort = (storage.address() as AddressInfo).port
    }
    if (!this.lookup) {
      const socket = lookupSocketOf(this.deps.serviceSocket)
      rmSync(socket, { force: true })
      const lookup = createServer((req, res) => this.serveLookup(req, res))
      await new Promise<void>((resolve, reject) => lookup.once('error', reject).listen(socket, () => resolve()))
      chmodSync(socket, 0o600)
      this.lookup = lookup
    }
  }

  private end(open: FullOpen): void {
    if (!this.opens.delete(open.token)) return
    this.byId.delete(open.id)
    rmSync(open.snapshot, { force: true })
    this.quietSince = this.now()
  }

  // ── the lookup socket: the service's route asks what a token opens ──

  private serveLookup(req: IncomingMessage, res: ServerResponse): void {
    const m = /^\/lookup\/([0-9a-f]+)$/.exec(req.url ?? '')
    const open = m && FULL_TOKEN.test(m[1]!) ? this.opens.get(m[1]!) : undefined
    if (req.method !== 'GET' || !open || !this.ds?.running()) {
      res.writeHead(404).end()
      return
    }
    const answer: FullLookup = { socket: this.ds.socket, title: open.title, config: this.configOf(open) }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer))
  }

  // ── the storage server: only the docservice calls it ───────────────

  private async serveStorage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = /^\/(file|callback)\/([0-9a-f]{48})$/.exec(req.url ?? '')
    const open = m ? this.byId.get(m[2]!) : undefined
    if (!m || !open) return void res.writeHead(404).end()
    if (m[1] === 'file' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': statSync(open.snapshot).size })
      createReadStream(open.snapshot).pipe(res)
      return
    }
    if (m[1] !== 'callback' || req.method !== 'POST') return void res.writeHead(405).end()
    const answer = (error: number): void => void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error }))
    let body: Record<string, unknown>
    try {
      body = JSON.parse(await readAll(req, 1024 * 1024)) as Record<string, unknown>
    } catch {
      return answer(1)
    }
    const header = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const claims = verifyHs256(header ?? (typeof body.token === 'string' ? body.token : ''), this.secret, this.now())
    if (!claims) {
      this.deps.log('[full-editor] refused a callback that was not signed by the docservice')
      return answer(1)
    }
    // The header's token carries the body under `payload`; a token in the body is the body.
    const said = (header ? claims.payload : claims) as CallbackBody | undefined
    if (!said || said.key !== open.id) return answer(1)
    try {
      await this.callback(open, said)
      answer(0)
    } catch (err) {
      this.deps.log(`[full-editor] ${basename(open.path)}: ${(err as Error).message}`)
      answer(1)
    }
  }

  /** What the docservice says about a document: who is in it, and its saves. */
  async callback(open: FullOpen, said: CallbackBody): Promise<void> {
    switch (said.status) {
      case 1:
        open.users = said.users?.length ?? 0
        if (open.users > 0) open.seen = true
        return
      case 2:
      case 6: {
        if (typeof said.url !== 'string') throw new Error('a save came with no file')
        const bytes = await this.fetchSaved(said.url)
        const to = this.writeBack(open, bytes)
        this.deps.log(`[full-editor] saved ${basename(open.path)}${to.beside ? ` beside it as ${basename(to.path)}: the file changed outside the editor meanwhile` : ''}`)
        if (to.beside) this.deps.failed(open, `The full editor saved its changes beside this file, as ${basename(to.path)}: this file changed while it was open there.`)
        else this.deps.saved(open, to)
        if (said.status === 2) this.end(open)
        return
      }
      case 3:
      case 7:
        this.deps.log(`[full-editor] ${basename(open.path)}: the editor could not save it (status ${said.status})`)
        this.deps.failed(open, 'The full editor could not save the changes made there: this file does not have them.')
        if (said.status === 3) this.end(open)
        return
      case 4:
        this.end(open)
        return
    }
  }

  /** The saved file, from the docservice's own socket whatever origin its URL names. */
  private async fetchSaved(url: string): Promise<Buffer> {
    if (!this.ds?.running()) throw new Error('the docservice stopped before the save was fetched')
    const u = new URL(url)
    const path = u.pathname.replace(/^\/w\/full\/[0-9a-f]{64}/, '')
    if (!path.startsWith('/cache/files/')) throw new Error('a save named a file outside the editor\'s cache')
    const got = await dsGet(this.ds.socket, path + u.search, 60_000)
    if (got.status !== 200) throw new Error(`the saved file did not come (${got.status})`)
    return got.body
  }

  /**
   * Puts the editor's save in the file as one change from outside (the
   * package store makes it a revision of its own, and the grids reload).
   * A file changed outside the editor since it was opened is not
   * overwritten: the save goes beside it.
   */
  writeBack(open: FullOpen, bytes: Buffer): SavedTo {
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('the editor saved something that is not a workbook')
    const real = realpathSync(open.path)
    if (stampOf(real) !== open.stamp) {
      const ext = extname(real)
      const at = new Date(this.now()).toISOString().slice(0, 16).replace('T', ' ').replace(':', '')
      const beside = join(dirname(real), `${basename(real, ext)} (full editor ${at})${ext}`)
      writeFileSync(beside, bytes, { flag: 'wx', mode: statSync(real).mode & 0o777 })
      return { path: beside, beside: true }
    }
    const tmp = join(dirname(real), `.${basename(real)}.full-${randomBytes(4).toString('hex')}`)
    writeFileSync(tmp, bytes, { mode: statSync(real).mode & 0o777 })
    renameSync(tmp, real)
    open.stamp = stampOf(real)
    return { path: open.path, beside: false }
  }
}

/** The callback's body, as the docservice signs it. */
export interface CallbackBody {
  key?: string
  status?: number
  url?: string
  users?: string[]
}

function readAll(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) req.destroy(new Error('too large'))
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}
