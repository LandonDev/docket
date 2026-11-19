import { randomBytes } from 'node:crypto'
import type { LifeosTransport, OwnerConnection } from './transport'

/**
 * A LifeOS in memory for milestone 7's tests: the functions the host calls,
 * answering as the real ones do (milestone 2's auth and bots, milestone 4's
 * links). `reachable = false` makes every call fail as a dead socket does.
 */

const SECTORS = ['cosmic', 'hypixel', 'purdue', 'ref', 'unify', 'life']
const secret = (prefix: string): string => `${prefix}${randomBytes(18).toString('base64url')}`
const refusal = (code: string): Error => Object.assign(new Error(`ConvexError: ${code}`), { data: { code } })

export interface FakeBot {
  _id: string
  name: string
  token: string
  sectors: string[]
  client?: string
  draftOnly: boolean
  revokedAt?: number
}

export class FakeLifeos implements LifeosTransport {
  reachable = true
  /** only the open HTTP calls fail (auth:token and the pairing), the socket stays */
  openDown = false
  /** each open call waits this long first */
  delayMs = 0
  /** bots:mint makes the key and then the answer is lost */
  loseMintAnswer = false
  /** every call made, by function name */
  calls: { fn: string; args: Record<string, unknown> }[] = []
  readonly sessions = new Map<string, { id: string; revoked: boolean }>()
  readonly bots: FakeBot[] = []
  readonly jwts: { jwt: string; sectors?: string[] }[] = []
  readonly links: { entity: { table: string; id: string }; host: string; threadId: string; title: string; state: 'open' | 'done'; sector: string; at: number }[] = []
  readonly tasks = new Map<string, { sector: string; done?: { reason?: string; threadLink?: unknown } }>([['task1', { sector: 'purdue' }]])
  private pairing: { code: string; poll: string; approved: boolean; claimed: boolean } | null = null
  private conns = new Set<{ live: boolean }>()
  identities = [{ name: 'Landon Hale', isDefault: true }]
  /** a mutation of this name fails as if the function did not exist (a LifeOS from before milestone 4) */
  missing = new Set<string>()
  /** LifeOS's projects as `projects:list` answers them, a sector at a time */
  projects: { _id: string; name: string; status: string; sector: string }[] = []
  /** the live queries open now, each run again when what it reads changes */
  private readonly watchers = new Set<{ fn: string; rerun: () => void }>()

  /** Changes LifeOS's projects and tells every live `projects:list`, as Convex does. */
  setProjects(next: { _id: string; name: string; status: string; sector: string }[]): void {
    this.projects = next
    for (const w of [...this.watchers]) if (w.fn === 'projects:list') w.rerun()
  }

  /** A device token LifeOS knows, as `auth:mint` makes one. */
  device(): string {
    const token = secret('lo_')
    this.sessions.set(token, { id: `sess_${this.sessions.size + 1}`, revoked: false })
    return token
  }

  approvePairing(): void {
    if (this.pairing) this.pairing.approved = true
  }

  liveBots(): FakeBot[] {
    return this.bots.filter((b) => b.revokedAt === undefined)
  }

  private reach(fn: string, args: Record<string, unknown>): void {
    this.calls.push({ fn, args })
    if (!this.reachable) throw new TypeError('fetch failed')
  }

  async open<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    this.reach(fn, args)
    if (this.openDown) throw new TypeError('fetch failed')
    switch (fn) {
      case 'auth:token': {
        const row = this.sessions.get(String(args.token))
        if (!row || row.revoked) throw refusal('invalid-token')
        const jwt = `eyJ${secret('')}.${secret('')}.${secret('')}`
        this.jwts.push({ jwt, ...(args.sectors ? { sectors: args.sectors as string[] } : {}) })
        return { jwt, expiresAt: Date.now() + 3_600_000 } as T
      }
      case 'auth:pairStart':
        this.pairing = { code: 'ABCD-EFGH', poll: secret('lop_'), approved: false, claimed: false }
        return { code: this.pairing.code, poll: this.pairing.poll, expiresAt: Date.now() + 600_000 } as T
      case 'auth:pairClaim': {
        const p = this.pairing
        if (!p || p.poll !== args.poll || p.claimed) throw refusal('pairing-unknown')
        if (!p.approved) return { status: 'pending' } as T
        p.claimed = true
        return { status: 'approved', token: this.device() } as T
      }
    }
    throw new Error(`no open function ${fn}`)
  }

  /** What the last connection is told when its identity lapses, as Convex's setAuth onChange(false). */
  authLost: (() => void) | null = null

  connect(fetchToken: (force: boolean) => Promise<string | null>, onAuthLost: () => void): OwnerConnection {
    this.authLost = onAuthLost
    const conn = { live: true }
    this.conns.add(conn)
    const sessionOf = async (): Promise<{ id: string }> => {
      const jwt = await fetchToken(false)
      if (!jwt || !this.jwts.some((j) => j.jwt === jwt)) throw refusal('not-signed-in')
      const token = [...this.sessions.entries()].find(([, s]) => !s.revoked)
      return { id: token?.[1].id ?? 'sess_?' }
    }
    const run = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
      this.reach(fn, args)
      if (this.missing.has(fn)) throw new Error(`Could not find public function for '${fn}'`)
      const me = await sessionOf()
      switch (fn) {
        case 'auth:caller':
          return { ownerId: 'landon', sessionId: me.id, sectors: 'all', client: 'tempcode', draftOnly: false } as T
        case 'sectors:list':
          return SECTORS.map((key, order) => ({ _id: key, key, label: key, order })) as T
        case 'mail:accounts':
          return [{ address: 'l@example.com', identities: this.identities }] as T
        case 'bots:list':
          return this.bots.map(({ token: _t, ...view }) => view) as T
        case 'bots:mint': {
          if (this.liveBots().some((b) => b.name === args.name)) throw new Error(`a bot named ${String(args.name)} already has a token`)
          if (String(args.name).length > 40) throw new Error('a bot needs a name of 1 to 40 characters')
          const token = secret('lob_')
          this.bots.push({ _id: `bot_${this.bots.length + 1}`, name: String(args.name), token, sectors: args.sectors as string[], client: 'tempcode', draftOnly: true })
          if (this.loseMintAnswer) throw new TypeError('fetch failed')
          return token as T
        }
        case 'bots:revoke': {
          const bot = this.bots.find((b) => b._id === args.id)
          if (bot) bot.revokedAt ??= Date.now()
          return null as T
        }
        case 'auth:revoke':
          for (const s of this.sessions.values()) if (s.id === args.id) s.revoked = true
          return null as T
        case 'projects:list':
          return this.projects.filter((p) => !args.sector || p.sector === args.sector) as T
        case 'workLinks:link': {
          const entity = args.entity as { table: string; id: string }
          const task = this.tasks.get(entity.id)
          this.links.push({ entity, host: String(args.host), threadId: String(args.threadId), title: String(args.title), state: 'open', sector: task?.sector ?? 'life', at: Date.now() })
          return `link_${this.links.length}` as T
        }
        case 'workLinks:byThread':
          return this.links.filter((l) => l.threadId === args.threadId) as T
        case 'tasks:complete': {
          const task = this.tasks.get(String(args.id))
          if (!task) throw new Error('no such task')
          task.done = { reason: args.reason as string, threadLink: args.threadLink }
          for (const l of this.links) if (l.entity.id === args.id) l.state = 'done'
          return {} as T
        }
      }
      throw new Error(`no function ${fn}`)
    }
    return {
      query: (fn, args = {}) => run(fn, args),
      mutation: (fn, args = {}) => run(fn, args),
      action: (fn, args = {}) => run(fn, args),
      watch: (fn, args, on, onError) => {
        let stopped = false
        const rerun = (): void =>
          void run(fn, args)
            .then((v) => !stopped && on(v as never))
            .catch((err) => !stopped && onError(err as Error))
        const watcher = { fn, rerun }
        this.watchers.add(watcher)
        rerun()
        return () => {
          stopped = true
          this.watchers.delete(watcher)
        }
      },
      live: () => conn.live && this.reachable,
      close: () => {
        conn.live = false
        this.conns.delete(conn)
      }
    }
  }

  /** Open connections now. */
  open_(): number {
    return this.conns.size
  }
}
