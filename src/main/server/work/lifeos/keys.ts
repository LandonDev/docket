import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AddonInput, AddonRow } from '@shared/contract-addons'
import type { LifeosKeyState } from '@shared/contract-work-lifeos'
import { WORK_HOME } from '@shared/work'
import type { LifeosClient } from './ctx'
import { faultWords, redact } from './transport'

/**
 * The sector keys (architecture §5, §19): one LifeOS bot key per linked
 * scope on the host that holds the scope's add-ons, minted as the owner
 * with `bots:mint` and kept only as the grant of that scope's LifeOS add-on
 * row (`role: 'lifeos'`). A Work or code workspace linked to a sector gets a
 * key of that sector; the Work Chats (`"~work"`) get one of every sector.
 * LifeOS makes every key a TempCode one minted from this host's session:
 * `client: 'tempcode'`, draft-only. A linked workspace whose add-ons live
 * on another host (the box, for a workspace both hosts have) gets its key
 * there, and this host reads that row and a copy of its grant.
 *
 * The key goes from `bots:mint` straight into the grant; it is never kept
 * in a row, a log or a push. A scope that loses its link loses its row and
 * its key is revoked in LifeOS.
 */

export const LIFEOS_ADDON_NAME = 'lifeos'
export const KEYS_TABLE = 'work_lifeos_keys'

export function ensureKeysTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${KEYS_TABLE} (
    scope TEXT PRIMARY KEY,
    addon_id TEXT NOT NULL,
    bot_name TEXT NOT NULL,
    sectors TEXT NOT NULL,
    minted_at INTEGER NOT NULL
  )`)
}

interface KeyRow {
  scope: string
  addonId: string
  botName: string
  sectors: string[]
  mintedAt: number
}

/** One scope that should hold a key. */
export interface WantedKey {
  scope: string
  /** 'all': every sector LifeOS lists, read at mint */
  sectors: string[] | 'all'
  label: string
}

export interface KeysDeps {
  db: DatabaseSync
  host: string
  hostName: () => string
  /** the owner's client, or null while LifeOS is not connected */
  owner: () => LifeosClient | null
  /** the LifeOS MCP server's address */
  mcpUrl: string
  /** the scopes that should hold a key now */
  wanted: () => WantedKey[]
  /** where a scope's add-ons live: null for this host */
  homeOf: (scope: string) => string | null
  addons: {
    get(id: string): AddonRow | null
    byName(scope: string, name: string): AddonRow | null
    /** written as this host's own caller, through the store's RPC */
    set(input: AddonInput): Promise<AddonRow>
    remove(id: string): Promise<void>
    role(id: string): string | null
    setRole(id: string): void
  }
  grants: {
    /** whether the row's grant holds a key */
    has(addonId: string): boolean
    set(addonId: string, authorization: string): Promise<void>
  } | null
  log: (line: string) => void
  now?: () => number
}

/** A bot name LifeOS will take: at most 40 characters, unique among live keys (this host and scope in a short hash). */
export function botNameOf(host: string, hostName: string, scope: string, label: string): string {
  const tag = createHash('sha256').update(`${host}\0${scope}`).digest('hex').slice(0, 6)
  const head = `TempCode ${hostName}: ${label}`.replace(/\s+/g, ' ').trim()
  return `${head.length > 32 ? `${head.slice(0, 31).trimEnd()}…` : head} ${tag}`
}

const sameSectors = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')

export class SectorKeys {
  private states = new Map<string, LifeosKeyState>()
  private running: Promise<void> | null = null
  private again = false
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: KeysDeps) {}

  private log(line: string): void {
    this.deps.log(redact(`lifeos keys: ${line}`))
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  list(): LifeosKeyState[] {
    return [...this.states.values()]
  }

  private record(scope: string): KeyRow | null {
    const row = this.deps.db.prepare(`SELECT scope, addon_id, bot_name, sectors, minted_at FROM ${KEYS_TABLE} WHERE scope = ?`).get(scope) as
      | { scope: string; addon_id: string; bot_name: string; sectors: string; minted_at: number }
      | undefined
    return row ? { scope: row.scope, addonId: row.addon_id, botName: row.bot_name, sectors: JSON.parse(row.sectors) as string[], mintedAt: row.minted_at } : null
  }

  private records(): KeyRow[] {
    const rows = this.deps.db.prepare(`SELECT scope FROM ${KEYS_TABLE}`).all() as { scope: string }[]
    return rows.map((r) => this.record(r.scope)).filter((r): r is KeyRow => !!r)
  }

  private save(row: KeyRow): void {
    this.deps.db
      .prepare(`INSERT INTO ${KEYS_TABLE} (scope, addon_id, bot_name, sectors, minted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET addon_id = excluded.addon_id, bot_name = excluded.bot_name, sectors = excluded.sectors, minted_at = excluded.minted_at`)
      .run(row.scope, row.addonId, row.botName, JSON.stringify(row.sectors), row.mintedAt)
  }

  private forget(scope: string): void {
    this.deps.db.prepare(`DELETE FROM ${KEYS_TABLE} WHERE scope = ?`).run(scope)
  }

  /** One pass over every scope; a pass asked for while one runs runs once more after it. */
  reconcile(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        try {
          await this.pass()
        } catch (err) {
          this.log(`a pass failed: ${faultWords(err)}`)
        }
      } while (this.again)
    })().finally(() => {
      this.running = null
      for (const fn of [...this.listeners]) fn()
    })
    return this.running
  }

  private async pass(): Promise<void> {
    const wanted = this.deps.wanted()
    const next = new Map<string, LifeosKeyState>()
    const owner = this.deps.owner()
    let everySector: string[] | null = null
    for (const want of wanted) {
      const known = this.record(want.scope)
      const shown = (sectors: string[], state: LifeosKeyState['state'], extra: Partial<LifeosKeyState> = {}): void =>
        void next.set(want.scope, { workspaceId: want.scope, sectors, state, ...extra })
      const fixed = want.sectors === 'all' ? (known?.sectors ?? []) : want.sectors
      if (want.scope !== WORK_HOME && this.deps.homeOf(want.scope) !== null) {
        // The home mints this scope's key. One minted here before the scope was shared is revoked and forgotten; the row is the home's now, and its own pass mints into it.
        if (known && owner) {
          try {
            await this.retire(known, owner)
            this.forget(known.scope)
            this.log(`${known.botName}: retired, the scope's add-ons live on ${this.deps.homeOf(want.scope)}`)
          } catch (err) {
            shown(fixed, 'failed', { error: faultWords(err) })
            continue
          }
        }
        shown(fixed, 'elsewhere')
        continue
      }
      const row = known ? this.deps.addons.get(known.addonId) : null
      // A row a build before Work rewrote lost its mark: put it back whenever it is missing.
      if (row && this.deps.addons.role(row.id) !== 'lifeos') this.deps.addons.setRole(row.id)
      if (!owner) {
        shown(fixed, row && known ? 'ready' : 'waiting', row ? { addonId: row.id } : {})
        continue
      }
      try {
        if (want.sectors === 'all') everySector ??= ((await owner.query<{ key: string }[]>('sectors:list', {})) ?? []).map((s) => s.key)
        const sectors = want.sectors === 'all' ? everySector! : want.sectors
        // A row someone pointed elsewhere (another address, another header) would carry the key there: it is minted again into a sound row.
        if (known && row && sameSectors(known.sectors, sectors) && this.sound(row) && this.deps.grants?.has(row.id)) {
          shown(sectors, 'ready', { addonId: row.id })
          continue
        }
        const id = await this.mint(want, sectors, known, owner)
        shown(sectors, 'ready', { addonId: id })
      } catch (err) {
        this.log(`${want.label}: ${faultWords(err)}`)
        shown(fixed, 'failed', { error: faultWords(err), ...(row ? { addonId: row.id } : {}) })
      }
    }
    // A scope that no longer wants a key: its row goes and its key is revoked.
    const keep = new Set(wanted.map((w) => w.scope))
    for (const old of this.records()) {
      if (keep.has(old.scope)) continue
      if (!owner) {
        next.set(old.scope, { workspaceId: old.scope, sectors: old.sectors, state: 'waiting', addonId: old.addonId })
        continue
      }
      try {
        await this.drop(old, owner)
      } catch (err) {
        next.set(old.scope, { workspaceId: old.scope, sectors: old.sectors, state: 'failed', error: faultWords(err) })
      }
    }
    this.states = next
  }

  /** The row as this host wrote it: LifeOS's MCP address, the one header, typed values, on. */
  private sound(row: AddonRow): boolean {
    const spec = row.spec
    return row.enabled && spec.transport === 'http' && spec.url === this.deps.mcpUrl && spec.auth === 'fields' && spec.headers.length === 1 && spec.headers[0] === 'Authorization'
  }

  /** Revokes a scope's key, removes its row if this host still has it, and forgets it. */
  private async drop(old: KeyRow, owner: LifeosClient): Promise<void> {
    await this.retire(old, owner)
    if (old.addonId && this.deps.addons.get(old.addonId)) await this.deps.addons.remove(old.addonId)
    this.forget(old.scope)
    this.log(`${old.botName}: retired`)
  }

  private async mint(want: WantedKey, sectors: string[], known: KeyRow | null, owner: LifeosClient): Promise<string> {
    if (!sectors.length) throw new Error('LifeOS listed no sectors')
    const grants = this.deps.grants
    if (!grants) throw new Error('the add-on grants are not running on this host')
    // A row named lifeos that is not this host's LifeOS row is the person's own: never written over.
    const named = this.deps.addons.byName(want.scope, LIFEOS_ADDON_NAME)
    if (named && named.id !== known?.addonId && this.deps.addons.role(named.id) !== 'lifeos') {
      throw new Error(`an add-on named ${LIFEOS_ADDON_NAME} is already in this workspace; remove or rename it`)
    }
    if (known) await this.retire(known, owner)
    const botName = botNameOf(this.deps.host, this.deps.hostName(), want.scope, want.label)
    // A key of this name left live by a pass that stopped half way is retired before a new one is made.
    await this.retire({ botName }, owner)
    // The intent is kept before the mint: if LifeOS makes the key and the answer is lost, a later pass still knows its name and retires it.
    this.save({ scope: want.scope, addonId: named?.id ?? known?.addonId ?? '', botName, sectors, mintedAt: 0 })
    try {
      const key = await owner.action<string>('bots:mint', { name: botName, sectors, client: 'tempcode', draftOnly: true })
      const row = await this.deps.addons.set({
        ...(named ? { id: named.id } : {}),
        name: LIFEOS_ADDON_NAME,
        workspaceId: want.scope,
        description: want.sectors === 'all' ? 'LifeOS for the Work Chats: every sector, drafts only.' : `LifeOS, held to ${sectors.join(', ')}: reads and drafts only.`,
        spec: { transport: 'http', url: this.deps.mcpUrl, headers: ['Authorization'], auth: 'fields' },
        enabled: true
      })
      this.deps.addons.setRole(row.id)
      await grants.set(row.id, `Bearer ${key}`)
      this.save({ scope: want.scope, addonId: row.id, botName, sectors, mintedAt: this.deps.now?.() ?? Date.now() })
      this.log(`${botName}: minted for ${sectors.join(', ')}`)
      return row.id
    } catch (err) {
      await this.retire({ botName }, owner).catch(() => {})
      throw err
    }
  }

  /** Revokes the live key of this name in LifeOS, if there is one. */
  private async retire(row: Pick<KeyRow, 'botName'>, owner: LifeosClient): Promise<void> {
    const bots = await owner.query<{ _id: string; name: string; revokedAt?: number }[]>('bots:list', {})
    for (const bot of bots ?? []) if (bot.name === row.botName && bot.revokedAt === undefined) await owner.mutation('bots:revoke', { id: bot._id })
  }

  /** The scope's add-on row id, if this host holds one. */
  addonOf(scope: string): string | null {
    return this.record(scope)?.addonId ?? null
  }
}
