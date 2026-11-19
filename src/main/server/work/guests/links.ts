import { randomBytes } from 'node:crypto'
import { guestRefusal, type GuestCreated, type GuestLinkRow, type GuestRole, type GuestSource } from '@shared/contract-work-guests'
import type { CollabClaims as KitClaims } from 'work-kit/collab-server'
import type { WorkCtx } from '../modules'
import { ActNotSent } from '../outbox/kinds'
import { WORK_OWNER_NAME_SETTING } from '../preamble'
import { isIsolatedInstance } from '../service/config'
import { serviceOf, ServedElsewhere } from '../service/ctx'
import type { ServiceSupervisor } from '../service/supervisor'
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
 */

/** A guest's token lasts ten minutes and is signed again with five left. */
export const GUEST_TOKEN_SECONDS = 10 * 60
const RESIGN_MS = 5 * 60_000
/** How often the list is looked over: tokens near their end, links that ended. */
export const TICK_MS = 30_000
/** A ticket opens within two minutes; the session it opens lasts eight hours. */
export const TICKET_MS = 2 * 60_000
export const PASS_MS = 8 * 60 * 60_000

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

export const guestUrl = (origin: string, id: string, secret: string): string => `${origin}/g/${id}#k=${secret}`

type Seen = Record<string, { at: number; open: number }>

interface Pass {
  id: string
  issuedAt: number
  ticketHash: string
  ticketUntil: number
  until: number
  source: GuestSource
  title: string
}

/** What a guests module keeps while Work is on: tickets, and the tokens it has signed. */
export class GuestRuntime {
  private readonly passes = new Map<string, Pass>()
  private readonly tokens = new Map<string, { token: string; exp: number; signer: unknown }>()
  /** what LifeOS was last told of each item's `shared` */
  private readonly told = new Map<string, boolean>()
  readonly store: GuestStore

  constructor(
    private readonly ctx: WorkCtx,
    /** the host's Work service; a test hands in its own */
    private readonly service: () => Pick<ServiceSupervisor, 'tokenSigner' | 'setLinks'> | undefined = () => serviceOf(ctx)
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
      await this.ctx.service.token({ item: itemOf(source), role: 'view', principal: 'owner' })
    } catch (err) {
      if (err instanceof ServedElsewhere) throw new Error(`served elsewhere: ${err.host}`)
      throw err
    }
  }

  /** The item exists in LifeOS, and its sector and title. */
  async itemRow(source: GuestSource): Promise<{ sector: string; title: string }> {
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
    await this.itemRow(o.source)
    const { link, secret } = this.store.create(o)
    // The item reads shared to every write guard before a guest can reach it: if LifeOS does not take it, no link is made.
    if (!(await this.setShared(o.source))) {
      this.store.forget(link.id)
      throw new ActNotSent(`LifeOS did not mark ${o.title} as shared, so no guest link was made. Nothing was made.`)
    }
    await this.sync()
    this.ctx.push({ push: 'work.guests' })
    return { link: this.rowOf(link, {}), url: guestUrl(publicOrigin(this.ctx), link.id, secret) }
  }

  /** A new address for a live link (the one before stops opening); null when it is not live. */
  async rekey(id: string): Promise<string | null> {
    const secret = this.store.rekey(id)
    if (!secret) return null
    await this.sync()
    this.ctx.push({ push: 'work.guests' })
    return guestUrl(publicOrigin(this.ctx), id, secret)
  }

  async revoke(id: string): Promise<void> {
    const link = this.store.get(id)
    if (!link) throw new Error('no such guest link on this host')
    if (!this.store.revoke(id)) return
    // The service first: the link's sockets close now, whatever LifeOS does next.
    await this.sync()
    await this.setShared(link.source)
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

  /** A ticket for the owner's hosted editor: the address holds it, once. */
  async ticket(source: GuestSource, title: string): Promise<{ url: string; expiresAt: number }> {
    await this.servedHere(source)
    const ticket = randomBytes(32).toString('base64url')
    const now = Date.now()
    const pass: Pass = { id: randomBytes(12).toString('base64url'), issuedAt: now, ticketHash: hashSecret(ticket), ticketUntil: now + TICKET_MS, until: now + PASS_MS, source, title }
    this.passes.set(pass.id, pass)
    await this.sync()
    return { url: `${publicOrigin(this.ctx)}/w/open#t=${ticket}`, expiresAt: pass.ticketUntil }
  }

  /** LifeOS's `shared` on the item: on while any link to it is live. Answers whether LifeOS took it. */
  async setShared(source: GuestSource): Promise<boolean> {
    const shared = this.store.live().some((l) => sourceKey(l.source) === sourceKey(source))
    try {
      await this.ctx.lifeos.owner().mutation(source.table === 'docs' ? 'docs:setShared' : 'sheets:setShared', { id: source.id, shared })
      this.told.set(sourceKey(source), shared)
      return true
    } catch (err) {
      this.ctx.log(`guests: ${sourceKey(source)} shared=${shared} was not set: ${String(err)}`)
      return false
    }
  }

  private async sign(key: string, claims: KitClaims): Promise<{ token: string; exp: number } | null> {
    const signer = this.service()?.tokenSigner()
    if (!signer) return null
    const held = this.tokens.get(key)
    if (held && held.signer === signer && held.exp - Date.now() > RESIGN_MS) return held
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
    const out: GuestServiceLink[] = []
    const keep = new Set<string>()
    for (const l of this.store.live(now)) {
      // Not before LifeOS reads its item shared: until then every write guard takes the item for private.
      if (this.told.get(sourceKey(l.source)) !== true) continue
      const principal = `guest:${l.id}` as const
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
        guest: { secretHash: l.secretHash, name: l.name, title: l.title, owner, token: t.token, tokenExp: t.exp }
      })
    }
    for (const p of this.passes.values()) {
      if (p.until <= now) {
        this.passes.delete(p.id)
        continue
      }
      const key = PASS_PREFIX + p.id
      const t = await this.sign(key, { ...kitItem(p.source), role: 'edit', principal: 'owner' }).catch(() => null)
      if (!t) continue
      keep.add(key)
      out.push({
        linkId: key,
        item: itemOf(p.source),
        role: 'edit',
        expiresAt: p.until,
        revokedAt: null,
        pass: { ticketHash: p.ticketHash, ticketUntil: p.ticketUntil, issuedAt: p.issuedAt, title: p.title, token: t.token, tokenExp: t.exp }
      })
    }
    for (const key of this.tokens.keys()) if (!keep.has(key)) this.tokens.delete(key)
    // Read again now that the signing is done: a link revoked, rekeyed or ended meanwhile goes as it now stands.
    const fresh = new Map(this.store.live().map((l) => [l.id, l]))
    supervisor.setLinks(
      out.flatMap((x): GuestServiceLink[] => {
        if (x.pass) return [x]
        const l = fresh.get(x.linkId)
        return l && x.guest ? [{ ...x, guest: { ...x.guest, secretHash: l.secretHash } }] : []
      })
    )
  }

  /**
   * Every 30 s: LifeOS told each item's `shared` where it differs from what was last told (every item once after a
   * start, and again until it takes it), then tokens signed again: a link goes to the service only once its item reads shared.
   */
  async tick(): Promise<void> {
    const now = Date.now()
    const live = new Set(this.store.live(now).map((l) => sourceKey(l.source)))
    let changed = false
    for (const l of this.store.listed(now)) {
      const key = sourceKey(l.source)
      if (this.told.get(key) === live.has(key)) continue
      changed ||= this.told.has(key)
      await this.setShared(l.source)
    }
    await this.sync()
    if (changed) this.ctx.push({ push: 'work.guests' })
  }
}

export const itemOf = (s: GuestSource): { doc: string } | { sheet: string } => (s.table === 'docs' ? { doc: s.id } : { sheet: s.id })
const kitItem = (s: GuestSource): { doc: string } | { sheet: string } => itemOf(s)
