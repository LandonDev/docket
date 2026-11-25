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

/** A sign-in prepared for a computer (`auth:enrollCreate`), as the backend keeps it. */
export interface FakeEnrollment {
  id: string
  name: string
  expiresAt: number
  codes: Partial<Record<'desktop' | 'tempcode', string>>
  used: Set<string>
  cancelled: boolean
  /** the device tokens its codes were traded for */
  tokens: string[]
}

export class FakeLifeos implements LifeosTransport {
  reachable = true
  /** this host's own session came from a setup link: LifeOS lets it mint no bot key and prepare no sign-in */
  enrolled = false
  readonly enrollments: FakeEnrollment[] = []
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
  readonly tasks = new Map<string, { sector: string; projectId?: string; done?: { reason?: string; threadLink?: unknown } }>([['task1', { sector: 'purdue' }]])
  private pairing: { code: string; poll: string; approved: boolean; claimed: boolean } | null = null
  private conns = new Set<{ live: boolean }>()
  private timezone: string | null = null
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

  setTimezone(zone: string | null): void {
    this.timezone = zone
    for (const w of [...this.watchers]) if (w.fn === 'settings:get') w.rerun()
  }

  /** A device token LifeOS knows, as `auth:mint` makes one. */
  device(): string {
    const token = `lo_${randomBytes(32).toString('base64url')}`
    this.sessions.set(token, { id: `sess_${this.sessions.size + 1}`, revoked: false })
    return token
  }

  approvePairing(): void {
    if (this.pairing) this.pairing.approved = true
  }

  liveBots(): FakeBot[] {
    return this.bots.filter((b) => b.revokedAt === undefined)
  }

  /** LifeOS's rule for a TempCode session minting anything lasting: it holds its own device token, not a JWT alone. */
  private ownProof(args: Record<string, unknown>, sessionId: string): boolean {
    const row = typeof args.token === 'string' ? this.sessions.get(args.token) : undefined
    return !!row && !row.revoked && row.id === sessionId
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
      case 'auth:enrollRedeem': {
        const code = String(args.code)
        const row = this.enrollments.find((e) => Object.values(e.codes).includes(code))
        if (!row) throw refusal('enroll-unknown')
        if (args.owner !== undefined && args.owner !== 'landon') throw refusal('enroll-wrong-owner')
        if (row.cancelled) throw refusal('enroll-cancelled')
        if (row.used.has(code)) throw refusal('enroll-used')
        if (Date.now() > row.expiresAt) throw refusal('enroll-expired')
        row.used.add(code)
        const token = this.device()
        row.tokens.push(token)
        return { token, owner: 'landon' } as T
      }
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
        case 'settings:get':
          return { timezone: this.timezone } as T
        case 'sectors:list':
          return SECTORS.map((key, order) => ({ _id: key, key, label: key, order })) as T
        case 'mail:accounts':
          return [{ address: 'l@example.com', identities: this.identities }] as T
        case 'bots:list':
          return this.bots.map(({ token: _t, ...view }) => view) as T
        case 'auth:enrollCreate': {
          if (this.enrolled || !this.ownProof(args, me.id)) throw refusal('forbidden')
          const uses = [...new Set(args.uses as ('desktop' | 'tempcode')[])]
          if (!uses.length) throw new Error('a sign-in needs at least one use')
          const codes: FakeEnrollment['codes'] = {}
          for (const use of uses) codes[use] = `loe_${randomBytes(32).toString('base64url')}`
          const row: FakeEnrollment = { id: `enr_${this.enrollments.length + 1}`, name: String(args.name), expiresAt: Date.now() + Math.min(Number(args.ttlMs ?? 900_000), 900_000), codes, used: new Set(), cancelled: false, tokens: [] }
          this.enrollments.push(row)
          return { enrollment: row.id, expiresAt: row.expiresAt, codes: { ...codes } } as T
        }
        case 'auth:enrollRevoke': {
          const row = this.enrollments.find((e) => e.id === args.enrollment)
          if (!row) throw refusal('not-found')
          row.cancelled = true
          for (const token of row.tokens) this.sessions.get(token)!.revoked = true
          return null as T
        }
        case 'bots:mint': {
          if (this.enrolled || !this.ownProof(args, me.id)) throw refusal('forbidden')
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
        case 'tasks:get': {
          const task = this.tasks.get(String(args.id))
          if (!task) throw new Error('no such task')
          const project = this.projects.find((p) => p._id === task.projectId) ?? null
          return { task: { _id: String(args.id), sector: task.sector, ...(task.projectId ? { projectId: task.projectId } : {}) }, project } as T
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
