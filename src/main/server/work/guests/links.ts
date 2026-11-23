import { createHash, randomBytes } from 'node:crypto'
import { guestRefusal, type GuestCreated, type GuestLinkRow, type GuestRole, type GuestSource, type TicketSource } from '@shared/contract-work-guests'
import { guestProjectionOf, projectionItems, type GuestProjection } from '@shared/work/guestProjection'
import { fileDocName, type CollabClaims as KitClaims } from 'work-kit/collab-server'
import { FenceError } from '../../remote/fence'
import { sharedOf } from '../files/policy'
import type { Caller, WorkCtx } from '../modules'
import { ActNotSent } from '../outbox/kinds'
import { WORK_OWNER_NAME_SETTING } from '../preamble'
import { isIsolatedInstance } from '../service/config'
import { canonicalPath, serviceOf, ServedElsewhere } from '../service/ctx'
import type { ServiceSupervisor } from '../service/supervisor'
import type { ServiceProject } from '../service/wire'
import { GuestStore, hashSecret, isLive, sourceKey, type StoredLink } from './store'
import { PASS_PREFIX, type GuestServiceLink } from './wire'

/**
 * Guest links on the host that serves LifeOS's documents (architecture §8.6,
 * docs/agents/work-guests.md): made, revoked, listed, and told to the Work
 * service. Main signs every token (the service holds no key); each live link
 * and each open ticket carries one, re-signed before it runs out, and the
 * service hands it out only after the secret checks. A link is told to the
 * service only once LifeOS has marked its item shared, which every write
 * guard reads: a link whose item LifeOS did not mark is not made, and one
 * found so after a restart waits out of the list. Revoking sends the list
 * at once without the link: its document sockets close then, its sheet
 * sockets at the next second's check.
 *
 * A project's link (view only) shows what LifeOS's `projects:guestView`
 * answers, read live here for each project with a live link and sent to the
 * service in a message of its own, with a view token for each sheet it
 * lists (a document is handed as its text and has no token). Every document
 * and sheet it lists is marked shared in LifeOS before the service hears of
 * it, and unmarked once no link shows it: the service told first when
 * something leaves, LifeOS first when something joins. While LifeOS cannot
 * be reached the read may be old, so after a minute a project's link shows
 * nothing until it answers again.
 */

/** A guest's token lasts ten minutes and is signed again with five left. */
export const GUEST_TOKEN_SECONDS = 10 * 60
const RESIGN_MS = 5 * 60_000
/** How often the list is looked over: tokens near their end, links that ended. */
export const TICK_MS = 30_000
/** A ticket opens within two minutes; the session it opens lasts eight hours. */
export const TICKET_MS = 2 * 60_000
export const PASS_MS = 8 * 60 * 60_000
/** How long a new project link waits for LifeOS's first answer of what the project shows. */
export const FIRST_VIEW_MS = 10_000
/** How long a project's link goes on showing its last read while LifeOS cannot be reached. */
export const STALE_VIEW_MS = 60_000

export const DEFAULT_ORIGIN = 'https://tempcode.landonhale.com'

/** Where a guest reaches this host: the tunnel's hostname on the box's installed host; a proof's origin when one is named. */
export function publicOrigin(ctx: Pick<WorkCtx, 'service'>, env: NodeJS.ProcessEnv = process.env): string {
  if (env.TEMP_CODE_WORK_PUBLIC_ORIGIN) return env.TEMP_CODE_WORK_PUBLIC_ORIGIN.replace(/\/$/, '')
  if (process.platform === 'linux' && !isIsolatedInstance(env)) return DEFAULT_ORIGIN
  try {
    return ctx.service.url('/').replace(/\/$/, '')
  } catch {
    return DEFAULT_ORIGIN
  }
}

/**
 * Whether a phone can reach this host's hosted pages at all: the box behind its tunnel, or a proof that
 * names its origin. Any other host's service answers on loopback alone, which no phone opens.
 */
export function servesPublic(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.TEMP_CODE_WORK_PUBLIC_ORIGIN || (process.platform === 'linux' && !isIsolatedInstance(env))
}

export const guestUrl = (origin: string, id: string, secret: string): string => `${origin}/g/${id}#k=${secret}`

/**
 * What a ticket opens: a LifeOS row, or a document or sheet kept as a file on this host. A `.tcdoc` is named
 * by its resolved path, as the docs pillar names its room; a `.tcsheet` by its item's own spelling of the path,
 * as the sheets pillar names its workbook (sheets/held.ts), so the phone and the desktop are on one workbook.
 */
type Opens = { at: 'lifeos'; source: GuestSource } | { at: 'tcdoc'; path: string } | { at: 'tcsheet'; path: string }

/** A file sheet's name on the live socket: no path is ever in an address, and main alone says which file a name is (the pass's `sheetFile`). */
export const fileSheetId = (path: string): string => `tc${createHash('sha256').update(path).digest('hex').slice(0, 40)}`

/** The item the service is told a ticket opens, and the claims main signs for it. */
const opensItem = (o: Opens): { doc: string } | { sheet: string } => (o.at === 'lifeos' ? itemOf(o.source) : o.at === 'tcdoc' ? { doc: fileDocName(o.path) } : { sheet: fileSheetId(o.path) })
const opensClaims = (o: Opens): Pick<KitClaims, 'doc' | 'sheet' | 'file'> => (o.at === 'tcdoc' ? { doc: fileDocName(o.path), file: { path: o.path } } : opensItem(o))

/** Why the hosted editor does not open an item on the phone, in the words its screen shows. */
export const TICKET_REFUSALS = {
  gone: 'That item is no longer open.',
  kind: 'The hosted editor opens a document or a sheet.',
  shared: 'This file is in a place others can open, so it stays on the computer that has it.',
  word: 'This document is a Word file. Edit it on your computer.',
  excel: 'This sheet is an Excel file. Edit it on your computer.',
  elsewhere: 'This file opens on the computer that has it.',
  noPage: 'This computer serves no page a phone can open. Edit it on your computer.'
} as const

type Seen = Record<string, { at: number; open: number }>

interface Pass {
  id: string
  issuedAt: number
  ticketHash: string
  ticketUntil: number
  until: number
  opens: Opens
  title: string
  /** the canvas item a file was opened by: while the pass stands, the item must still be open, on that file, in a place of his own */
  itemId?: string
}

/** What a guests module keeps while Work is on: tickets, and the tokens it has signed. */
export class GuestRuntime {
  private readonly passes = new Map<string, Pass>()
  private readonly tokens = new Map<string, { token: string; exp: number; signer: unknown }>()
  /** When each link last took a new address; its tokens from before then are refused by the service. */
  private readonly keyedAt = new Map<string, number>()
  /** what LifeOS was last told of each row's `shared`, by `docs:<id>`, `sheets:<id>` or `projects:<id>` */
  private readonly told = new Map<string, boolean>()
  /** the live read of what each project with a live link shows; `undefined` until LifeOS first answers */
  private readonly watched = new Map<string, { stop(): void; since: number; projection: GuestProjection | null | undefined }>()
  /** what the service was last sent for each project link, to send it again only when it changed, and the documents and sheets it named */
  private readonly sent = new Map<string, { json: string; items: Set<string> }>()
  /** since when LifeOS has not been reachable; null while it is */
  private lifeosDownSince: number | null = null
  private viewWaiters: (() => void)[] = []
  readonly store: GuestStore

  constructor(
    private readonly ctx: WorkCtx,
    /** the host's Work service; a test hands in its own */
    private readonly service: () => Pick<ServiceSupervisor, 'tokenSigner' | 'setLinks' | 'setProject'> | undefined = () => serviceOf(ctx)
  ) {
    this.store = new GuestStore(ctx.db)
  }

  private ownerName(): string {
    try {
      return (this.ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(WORK_OWNER_NAME_SETTING) as { value?: string } | undefined)?.value?.trim() || 'The owner'
    } catch {
      return 'The owner'
    }
  }

  /** Throws `served elsewhere: <env>` on a host that does not serve LifeOS's documents, as every docs method does. */
  async servedHere(source: GuestSource): Promise<void> {
    try {
      // Asked as for a document: a project and its documents are served where LifeOS's documents are.
      await this.ctx.service.token({ item: source.table === 'sheets' ? { sheet: source.id } : { doc: source.id }, role: 'view', principal: 'owner' })
    } catch (err) {
      if (err instanceof ServedElsewhere) throw new Error(`served elsewhere: ${err.host}`)
      throw err
    }
  }

  /** The item exists in LifeOS, and its sector and title. */
  async itemRow(source: GuestSource): Promise<{ sector: string; title: string }> {
    if (source.table === 'projects') {
      const got = await this.ctx.lifeos
        .owner()
        .query<{ project?: { sector?: string; name?: string } } | null>('projects:get', { id: source.id })
        .catch(() => null)
      if (typeof got?.project?.sector !== 'string') throw new Error('LifeOS has no such project')
      return { sector: got.project.sector, title: got.project.name?.trim() || 'Untitled' }
    }
    const row = await this.ctx.lifeos
      .owner()
      .query<{ sector?: string; title?: string } | null>(source.table === 'docs' ? 'docs:get' : 'sheets:get', { id: source.id })
      .catch(() => null)
    if (!row || typeof row.sector !== 'string') throw new Error(`LifeOS has no such ${source.table === 'docs' ? 'document' : 'sheet'}`)
    return { sector: row.sector, title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : 'Untitled' }
  }

  async create(o: { source: GuestSource; title: string; name: string; role: GuestRole; expiresAt: number; bySession: string | null }): Promise<GuestCreated> {
    const refused = guestRefusal(o)
    if (refused) throw new Error(refused)
    await this.servedHere(o.source)
    const row = await this.itemRow(o.source)
    // A project's link is named as LifeOS names the project now, never as a client said.
    const { link, secret } = this.store.create(o.source.table === 'projects' ? { ...o, title: row.title.slice(0, 200) } : o)
    // The item reads shared to every write guard before a guest can reach it: if LifeOS does not take it, no link is made.
    // In the passes' own turn, so this mark and a pass's unmark of the same row never reach LifeOS out of order.
    if (!(await this.inTurn(() => this.tell(sourceKey(o.source), true)))) {
      this.store.forget(link.id)
      throw new ActNotSent(`LifeOS did not mark ${o.title} as shared, so no guest link was made. Nothing was made.`)
    }
    // A project's link shows what LifeOS answers for it: with no answer there is nothing to show, and no link.
    if (o.source.table === 'projects' && !(await this.firstView(o.source.id))) {
      this.store.forget(link.id)
      await this.settle()
      throw new ActNotSent(`LifeOS did not answer what ${o.title} shows a guest, so no guest link was made. Nothing was made.`)
    }
    await this.settle()
    this.ctx.push({ push: 'work.guests' })
    return { link: this.rowOf(link, {}), url: guestUrl(publicOrigin(this.ctx), link.id, secret) }
  }

  /** A new address for a live link (the one before stops opening); null when it is not live. */
  async rekey(id: string): Promise<string | null> {
    const secret = this.store.rekey(id)
    if (!secret) return null
    // Every token handed out before now stops opening anything: the service refuses a token of this link
    // issued before the next second's edge (tokens carry whole seconds), and main signs new ones from then.
    const at = (Math.floor(Date.now() / 1000) + 1) * 1000
    this.keyedAt.set(id, at)
    for (const key of [...this.tokens.keys()]) if (key === id || key.startsWith(`${id}|`)) this.tokens.delete(key)
    // On the wall clock the tokens carry: a timer may fire a moment early.
    while (Date.now() < at) await new Promise((r) => setTimeout(r, at - Date.now() + 5))
    await this.sync()
    this.ctx.push({ push: 'work.guests' })
    return guestUrl(publicOrigin(this.ctx), id, secret)
  }

  async revoke(id: string): Promise<void> {
    const link = this.store.get(id)
    if (!link) throw new Error('no such guest link on this host')
    if (!this.store.revoke(id)) return
    // The service first, ahead of any pass that is waiting on LifeOS: the link's sockets close now, whatever LifeOS does next.
    await this.sync()
    await this.settle()
    this.ctx.push({ push: 'work.guests' })
  }

  async list(source?: GuestSource): Promise<GuestLinkRow[]> {
    const rows = source ? this.store.forSource(source) : this.store.listed()
    const seen = await this.seen()
    const now = Date.now()
    return rows.map((l) => this.rowOf(l, seen)).sort((a, b) => Number(isLive(b, now)) - Number(isLive(a, now)) || b.createdAt - a.createdAt)
  }

  private rowOf(l: StoredLink, seen: Seen | null): GuestLinkRow {
    const { secretHash: _h, bySession: _s, ...row } = l
    return { ...row, lastOpenedAt: seen ? (seen[l.id]?.at ?? null) : null, open: seen?.[l.id]?.open ?? 0 }
  }

  /** When each link was last opened and how many sockets it holds, as the service counts them; null when it does not answer. */
  private async seen(): Promise<Seen | null> {
    try {
      return ((await this.ctx.service.internal('/internal/guests/seen', {})) as { seen?: Seen }).seen ?? {}
    } catch {
      return null
    }
  }

  /**
   * What a canvas item opens in the hosted editor, or why not. A LifeOS row is asked as its row. A file must
   * be a `.tcdoc` or a `.tcsheet` on this host, within the caller's reach, in a place only he can open: a
   * file others can open never goes to a phone, and a Word or Excel file is saved by the desktop's own editor.
   */
  private opensOf(itemId: string, by: Caller, method: string): Opens {
    const item = this.ctx.canvas.get(itemId)
    if (!item) throw new Error(TICKET_REFUSALS.gone)
    if (item.kind !== 'document' && item.kind !== 'sheet') throw new Error(TICKET_REFUSALS.kind)
    const s = item.source
    if (s.at === 'lifeos' && (s.table === 'docs' || s.table === 'sheets')) return { at: 'lifeos', source: { at: 'lifeos', table: s.table, id: s.id } }
    if (s.at !== 'file') throw new Error(TICKET_REFUSALS.elsewhere)
    // A file is served by the host it is on (§19): the phone asks that one.
    if (s.host !== this.ctx.host) throw new Error(`served elsewhere: ${s.host}`)
    if (!this.ctx.reaches(by, s.path)) throw new FenceError(method)
    if (sharedOf(this.ctx, s)) throw new Error(TICKET_REFUSALS.shared)
    if (!servesPublic()) throw new Error(TICKET_REFUSALS.noPage)
    const path = canonicalPath(s.path)
    const name = path.toLowerCase()
    if (item.kind === 'document') {
      if (name.endsWith('.tcdoc')) return { at: 'tcdoc', path }
      throw new Error(/\.(docx?|odt|rtf)$/.test(name) ? TICKET_REFUSALS.word : TICKET_REFUSALS.elsewhere)
    }
    if (name.endsWith('.tcsheet')) return { at: 'tcsheet', path: s.path }
    throw new Error(/\.(xlsx?|xlsm|ods|csv)$/.test(name) ? TICKET_REFUSALS.excel : TICKET_REFUSALS.elsewhere)
  }

  /**
   * Whether a file's pass may go on: its item is still open on the same file, and the file is still his alone.
   * Checked at every pass over the list (`TICK_MS`); a pass dropped here opens nothing more: its sheet socket
   * closes at the next second's check, and its document's token is not renewed.
   */
  private stillOpens(p: Pass): boolean {
    if (!p.itemId || p.opens.at === 'lifeos') return true
    const s = this.ctx.canvas.get(p.itemId)?.source
    if (!s || s.at !== 'file' || s.host !== this.ctx.host) return false
    if ((p.opens.at === 'tcdoc' ? canonicalPath(s.path) : s.path) !== p.opens.path) return false
    return !sharedOf(this.ctx, s)
  }

  /** A ticket for the owner's hosted editor: the address holds it, once. */
  async ticket(source: TicketSource, title: string, by: Caller, method = 'work.guests.ticket'): Promise<{ url: string; expiresAt: number }> {
    const opens: Opens = source.at === 'item' ? this.opensOf(source.itemId, by, method) : { at: 'lifeos', source }
    if (opens.at === 'lifeos') {
      if (opens.source.table === 'projects') throw new Error(TICKET_REFUSALS.kind)
      await this.servedHere(opens.source)
    }
    const ticket = randomBytes(32).toString('base64url')
    const now = Date.now()
    const pass: Pass = { id: randomBytes(12).toString('base64url'), issuedAt: now, ticketHash: hashSecret(ticket), ticketUntil: now + TICKET_MS, until: now + PASS_MS, opens, title, ...(source.at === 'item' && opens.at !== 'lifeos' ? { itemId: source.itemId } : {}) }
    this.passes.set(pass.id, pass)
    await this.sync()
    return { url: `${publicOrigin(this.ctx)}/w/open#t=${ticket}`, expiresAt: pass.ticketUntil }
  }

  /** LifeOS told one row's `shared`. Answers whether LifeOS took it. */
  private async tell(key: string, shared: boolean): Promise<boolean> {
    const [table, id] = key.split(':') as [GuestSource['table'], string]
    try {
      await this.ctx.lifeos.owner().mutation(`${table}:setShared`, { id, shared })
      this.told.set(key, shared)
      this.store.setMark(key, shared)
      return true
    } catch (err) {
      this.ctx.log(`guests: ${key} shared=${shared} was not set: ${String(err)}`)
      return false
    }
  }

  /** Every LifeOS row a live link shows: each link's own item, and for a project every document and sheet its projection lists, the description's among them. */
  private wanted(now = Date.now()): Set<string> {
    const out = new Set<string>()
    for (const l of this.store.live(now)) {
      out.add(sourceKey(l.source))
      const shown = l.source.table === 'projects' ? this.watched.get(l.source.id)?.projection : null
      if (shown) for (const key of projectionItems(shown)) out.add(key)
    }
    return out
  }

  /**
   * LifeOS told each row's `shared` where it differs from what the live links show: every row once
   * after a start, a row a project's link gained, a row no link shows any more (those this host
   * marked before a restart among them). Answers how many were told, and whether a known one changed.
   */
  private async reconcile(now = Date.now()): Promise<{ told: number; changed: boolean }> {
    const wanted = this.wanted(now)
    // A project whose first read has not landed yet: its documents are not known, so nothing is unmarked on a guess. Not for good: a read that never comes stops holding the rest back.
    const unsure = this.store.live(now).some((l) => {
      const held = l.source.table === 'projects' ? this.watched.get(l.source.id) : undefined
      return !!held && held.projection === undefined && now - held.since < FIRST_VIEW_MS
    })
    // What the service was last sent: a document or sheet it still shows keeps its mark until the service has been told it left.
    const shown = new Set([...this.sent.values()].flatMap((s) => [...s.items]))
    const all = [...new Set([...wanted, ...this.told.keys(), ...this.store.listed(now).map((l) => sourceKey(l.source)), ...this.store.marks()])]
    let told = 0
    let changed = false
    const pass = async (keys: string[]): Promise<void> => {
      for (const key of keys) {
        const want = wanted.has(key)
        if (this.told.get(key) === want || (!want && (unsure || shown.has(key)))) continue
        changed ||= this.told.has(key)
        if (await this.tell(key, want)) told++
        else if (want && key.startsWith('projects:')) await this.endIfGone(key.slice('projects:'.length))
      }
    }
    // Projects first. LifeOS marks a project's description with the project, both ways, so a project told
    // anything leaves what was told of the documents in doubt: every document a live link shows is told again.
    const before = told
    await pass(all.filter((key) => key.startsWith('projects:')))
    if (told > before) for (const key of wanted) if (key.startsWith('docs:')) this.told.delete(key)
    await pass(all.filter((key) => !key.startsWith('projects:')))
    return { told, changed }
  }

  /** A project LifeOS no longer has shows nothing: its links end here, so they are not retried and not listed as live. */
  private async endIfGone(projectId: string): Promise<void> {
    const gone = await this.ctx.lifeos
      .owner()
      .query<unknown>('projects:get', { id: projectId })
      .then(
        (row) => row === null,
        // LifeOS says "not found" of a row that is gone; any other failure (out of reach) is not that.
        (err: unknown) => /not found/i.test(err instanceof Error ? err.message : String(err))
      )
    if (!gone) return
    for (const l of this.store.live()) if (l.source.table === 'projects' && l.source.id === projectId) this.store.revoke(l.id)
    this.ctx.log(`guests: project ${projectId} is no longer in LifeOS; its guest links have ended`)
    this.ctx.push({ push: 'work.guests' })
  }

  /** One live read of `projects:guestView` for each project a live link shows; a project with none is let go. */
  private watch(now = Date.now()): void {
    const live = new Set(this.store.live(now).flatMap((l) => (l.source.table === 'projects' ? [l.source.id] : [])))
    for (const [id, held] of this.watched) {
      if (live.has(id)) continue
      held.stop()
      this.watched.delete(id)
    }
    for (const id of live) {
      if (this.watched.has(id)) continue
      const held: { stop(): void; since: number; projection: GuestProjection | null | undefined } = { stop: () => {}, since: now, projection: undefined }
      this.watched.set(id, held)
      held.stop = this.ctx.lifeos.subscribe<unknown>('projects:guestView', { id }, (raw) => {
        if (this.watched.get(id) !== held) return
        held.projection = guestProjectionOf(raw)
        // LifeOS answers nothing for a project it does not read as shared: it is told again at the next pass.
        if (!held.projection) this.told.delete(`projects:${id}`)
        for (const w of this.viewWaiters.splice(0)) w()
        void this.settle().catch((err: Error) => this.ctx.log(`guests: ${err.message}`))
      })
    }
  }

  /** Waits for LifeOS's first answer of what a project shows; false when none came in time, or it answered nothing. */
  private async firstView(projectId: string): Promise<boolean> {
    this.watch()
    const end = Date.now() + FIRST_VIEW_MS
    while (!this.watched.get(projectId)?.projection && Date.now() < end) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(0, end - Date.now()))
        this.viewWaiters.push(() => (clearTimeout(t), resolve()))
      })
    }
    return !!this.watched.get(projectId)?.projection
  }

  private settling: Promise<void> = Promise.resolve()

  /**
   * Brings the service and LifeOS's marks in step with the links and what their projects show, one
   * run at a time. The service first, so what left (a revoked link, a document moved out of a
   * project) closes before its mark comes off; then the marks; then the service again, so what
   * joined is sent only once LifeOS reads it shared.
   */
  settle(): Promise<{ changed: boolean }> {
    return this.inTurn(async () => {
      this.watch()
      await this.sync()
      const { told, changed } = await this.reconcile()
      if (told) await this.sync()
      return { changed }
    })
  }

  /** One thing at a time that tells LifeOS a mark: a pass, or a new link's own mark. */
  private inTurn<T>(run: () => Promise<T>): Promise<T> {
    const turn = this.settling.then(run)
    this.settling = turn.then(
      () => {},
      () => {}
    )
    return turn
  }

  /** Work went off: the live reads stop. */
  stop(): void {
    for (const held of this.watched.values()) held.stop()
    this.watched.clear()
  }

  private async sign(key: string, claims: KitClaims): Promise<{ token: string; exp: number } | null> {
    const signer = this.service()?.tokenSigner()
    if (!signer) return null
    const held = this.tokens.get(key)
    // A token signed before its link took a new address is never handed out again.
    const keyed = claims.link ? (this.keyedAt.get(claims.link) ?? 0) : 0
    const issued = held ? held.exp - GUEST_TOKEN_SECONDS * 1000 : 0
    if (held && held.signer === signer && held.exp - Date.now() > RESIGN_MS && issued >= keyed) return held
    const got = await signer.sign(claims, GUEST_TOKEN_SECONDS)
    const next = { token: got.token, exp: got.expiresAt, signer }
    this.tokens.set(key, next)
    return next
  }

  private syncing: Promise<void> = Promise.resolve()

  /**
   * Tells the service every live link and open ticket, each with a token it may hand out. One at a
   * time: a tick's sync that was signing when a revoke came must not send its older list after the
   * revoke's, and what is sent is read again after the signing, so a link revoked meanwhile is out.
   */
  sync(): Promise<void> {
    const run = this.syncing.then(() => this.syncOnce())
    this.syncing = run.catch(() => {})
    return run
  }

  private async syncOnce(): Promise<void> {
    const supervisor = this.service()
    if (!supervisor) return
    const now = Date.now()
    const owner = this.ownerName()
    const up = this.ctx.lifeos.connected?.() !== false
    this.lifeosDownSince = up ? null : (this.lifeosDownSince ?? now)
    const stale = this.lifeosDownSince !== null && now - this.lifeosDownSince >= STALE_VIEW_MS
    const out: GuestServiceLink[] = []
    const projects = new Map<string, ServiceProject>()
    const keep = new Set<string>()
    for (const l of this.store.live(now)) {
      // Not before LifeOS reads its item shared: until then every write guard takes the item for private.
      if (this.told.get(sourceKey(l.source)) !== true) continue
      const principal = `guest:${l.id}` as const
      if (l.source.table === 'projects') {
        // A project's link goes only with what it shows; until LifeOS has answered, the service does not know it.
        const shown = this.watched.get(l.source.id)?.projection
        if (!shown) continue
        // LifeOS out of reach for a minute: the read may be old (a document moved out, a task changed), so the link shows nothing until it answers.
        if (!stale) projects.set(l.id, await this.projectFacts(l.id, shown, keep))
        out.push({ linkId: l.id, item: { project: l.source.id }, role: 'view', expiresAt: l.expiresAt, revokedAt: null, guest: { secretHash: l.secretHash, name: l.name, title: l.title, owner, token: '', tokenExp: 0, keyedAt: this.keyedAt.get(l.id) ?? 0 } })
        continue
      }
      // A link that cannot be signed is left out, never left as it was: the service then refuses it.
      const t = await this.sign(l.id, { ...kitItem(l.source), role: l.role, principal, link: l.id }).catch((err: Error) => (this.ctx.log(`guests: ${l.id} was not signed: ${err.message}`), null))
      if (!t) continue
      keep.add(l.id)
      out.push({
        linkId: l.id,
        item: itemOf(l.source),
        role: l.role,
        expiresAt: l.expiresAt,
        revokedAt: null,
        guest: { secretHash: l.secretHash, name: l.name, title: l.title, owner, token: t.token, tokenExp: t.exp, keyedAt: this.keyedAt.get(l.id) ?? 0 }
      })
    }
    for (const p of this.passes.values()) {
      // A file's pass ends with what let it be made: the item closed, the file moved, or its place now one others can open.
      if (p.until <= now || !this.stillOpens(p)) {
        this.passes.delete(p.id)
        continue
      }
      const key = PASS_PREFIX + p.id
      const t = await this.sign(key, { ...opensClaims(p.opens), role: 'edit', principal: 'owner' }).catch(() => null)
      if (!t) continue
      keep.add(key)
      out.push({
        linkId: key,
        item: opensItem(p.opens),
        role: 'edit',
        expiresAt: p.until,
        revokedAt: null,
        pass: { ticketHash: p.ticketHash, ticketUntil: p.ticketUntil, issuedAt: p.issuedAt, title: p.title, token: t.token, tokenExp: t.exp, ...(p.opens.at === 'tcsheet' ? { sheetFile: p.opens.path } : {}) }
      })
    }
    for (const key of this.tokens.keys()) if (!keep.has(key)) this.tokens.delete(key)
    // Read again now that the signing is done: a link revoked, rekeyed or ended meanwhile goes as it now stands.
    const fresh = new Map(this.store.live().map((l) => [l.id, l]))
    // A projection goes before the list that names its link, and is taken away after the list that drops it.
    for (const [linkId, project] of projects) {
      if (!fresh.has(linkId)) continue
      const json = JSON.stringify(project)
      if (this.sent.get(linkId)?.json === json) continue
      supervisor.setProject(linkId, project)
      this.sent.set(linkId, { json, items: new Set(projectionItems(project.projection)) })
    }
    supervisor.setLinks(
      out.flatMap((x): GuestServiceLink[] => {
        if (x.pass) return [x]
        const l = fresh.get(x.linkId)
        return l && x.guest ? [{ ...x, guest: { ...x.guest, secretHash: l.secretHash } }] : []
      })
    )
    for (const linkId of [...this.sent.keys()]) {
      if (projects.has(linkId) && fresh.has(linkId)) continue
      supervisor.setProject(linkId, null)
      this.sent.delete(linkId)
    }
  }

  /**
   * What the service is told a project link shows: LifeOS's projection with only the documents and
   * sheets LifeOS already reads as shared (one that just joined waits for its mark), and a view token
   * for each sheet, signed for this link and that sheet. A document has no token: the service hands
   * its text as it stands, never its live room.
   */
  private async projectFacts(linkId: string, shown: GuestProjection, keep: Set<string>): Promise<ServiceProject> {
    const marked = (key: string): boolean => this.told.get(key) === true
    const docId = shown.project.docId && marked(`docs:${shown.project.docId}`) ? shown.project.docId : null
    const projection: GuestProjection = { ...shown, project: { ...shown.project, docId }, docs: shown.docs.filter((d) => marked(`docs:${d.id}`)), sheets: shown.sheets.filter((sh) => marked(`sheets:${sh.id}`)) }
    const tokens: ServiceProject['tokens'] = {}
    for (const { id } of projection.sheets) {
      const key = `sheets:${id}`
      const claims = { sheet: id, role: 'view', principal: `guest:${linkId}`, link: linkId } as KitClaims
      // A sheet that cannot be signed stays listed and opens nothing: the service answers it as gone.
      const t = await this.sign(`${linkId}|${key}`, claims).catch((err: Error) => (this.ctx.log(`guests: ${linkId} ${key} was not signed: ${err.message}`), null))
      if (!t) continue
      keep.add(`${linkId}|${key}`)
      tokens[key] = { token: t.token, exp: t.exp }
    }
    return { projection, tokens }
  }

  /** Every 30 s: links that ended, rows LifeOS has not marked yet, tokens near their end (`settle`). */
  async tick(): Promise<void> {
    const { changed } = await this.settle()
    if (changed) this.ctx.push({ push: 'work.guests' })
  }
}

/** A document's or a sheet's link as the service names its item; a project's link is built where its projection is. */
export const itemOf = (s: GuestSource): { doc: string } | { sheet: string } => (s.table === 'sheets' ? { sheet: s.id } : { doc: s.id })
const kitItem = itemOf
