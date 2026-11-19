import { hostname } from 'node:os'
import type { AddonInput, AddonRow } from '@shared/contract-addons'
import type { LifeosStatus } from '@shared/contract-work-lifeos'
import type { WorkspaceMeta } from '@shared/domain'
import { shortHostName } from '@shared/hostNames'
import { WORK_HOME, type HostId, type SectorKey } from '@shared/work'
import { vaultGrantSource } from '../../addons/grants'
import type { CtxPart, WorkPartDeps } from '../ctx'
import type { WorkCtx } from '../modules'
import { WORK_OWNER_NAME_SETTING } from '../preamble'
import { vaultDeviceToken, type DeviceTokenStore } from './deviceToken'
import { SectorKeys, type WantedKey } from './keys'
import { Links } from './links'
import { LifeosSession, LifeosUnavailable } from './session'
import { convexTransport, faultWords, redact, type LifeosTransport } from './transport'

/**
 * `ctx.lifeos` and `ctx.links`: the host's side of LifeOS
 * (docs/agents/work-lifeos.md). One `LifeosHost` per host: the session
 * (sign-in, JWTs, the owner's live connection), the sector keys of the
 * linked scopes, and the thread links. Made at boot with Work on or off;
 * it connects only while Work is on.
 */

/** The host's device session against LifeOS's Convex, as a pillar calls it. Function names are Convex's, `module:function`. */
export interface LifeosClient {
  query<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>
  mutation<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>
  action<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>
}

/** A LifeOS `workLinks` row: the link between a thread and its task, mail or event. TempCode keeps no copy. */
export interface WorkLink {
  sector: SectorKey
  entity: { table: string; id: string }
  host: HostId
  threadId: string
  title: string
  state: 'open' | 'done'
  at: number
}

// The real LifeOS, and the rule for which one an isolated instance talks to, live with the page
// policy (src/shared/pagePolicy.ts): whatever serves the renderer writes the same address into it.
import { lifeosAddress } from '@shared/pagePolicy'
export { LIFEOS_MCP_URL, LIFEOS_URL, lifeosAddress } from '@shared/pagePolicy'

/** Seams a test passes in place of the real LifeOS and vault. */
export interface LifeosSeams {
  transport?: LifeosTransport
  tokens?: DeviceTokenStore
  hasGrant?: (addonId: string) => boolean
  address?: { url: string; mcpUrl: string }
  hostName?: string
  reconcileMs?: number
  session?: Partial<ConstructorParameters<typeof LifeosSession>[0]>
}

export interface LifeosHost {
  session: LifeosSession
  /** LifeOS's Convex address, which a screen's own client opens with the JWT it was given */
  url: string
  keys: SectorKeys
  links: Links
  /** What a screen draws; the pairing code only for a caller that may see it. */
  status(withCode: boolean): LifeosStatus
  onStatus(fn: () => void): () => void
  reconcile(): Promise<void>
  workspaces(): WorkspaceMeta[]
  validSector(sector: string): Promise<boolean>
  setSector(workspaceId: string, sector: string | null): void
  /** the host that holds a workspace's add-ons, or null for this one */
  homeOf(workspaceId: string): string | null
}

const hosts = new WeakMap<WorkCtx, LifeosHost>()
/** The host's LifeOS, for the module's own methods (work/lifeos/index.ts). */
export const lifeosHostOf = (ctx: WorkCtx): LifeosHost | undefined => hosts.get(ctx)

export function makeLifeosHost(ctx: WorkCtx, deps: WorkPartDeps, seams: LifeosSeams = {}): LifeosHost {
  const log = (line: string): void => ctx.log(redact(line))
  const address = seams.address ?? lifeosAddress()
  const hostName = (): string => seams.hostName ?? shortHostName(hostname())
  const session = new LifeosSession({
    transport: seams.transport ?? convexTransport(address.url, log),
    tokens: seams.tokens ?? vaultDeviceToken,
    url: address.url,
    host: deps.environmentId,
    hostName,
    log,
    ...seams.session
  })
  const owner = () => (session.connected() ? session.owner() : null)
  const wanted = (): WantedKey[] => {
    if (!ctx.enabled()) return []
    const out: WantedKey[] = deps.registry
      .listWorkspaces()
      .filter((w) => !!w.sector)
      .map((w) => ({ scope: w.id, sectors: [w.sector!], label: w.name }))
    out.push({ scope: WORK_HOME, sectors: 'all', label: 'Work Chats' })
    return out
  }
  const local = { kind: 'local' } as const
  const keys = new SectorKeys({
    db: deps.db,
    host: deps.environmentId,
    hostName,
    owner,
    mcpUrl: address.mcpUrl,
    wanted,
    homeOf: (scope) => deps.storeSync?.homeFor(scope)?.name ?? null,
    addons: {
      get: (id) => deps.addons?.get(id) ?? null,
      byName: (scope, name) => deps.addons?.byName(scope, name) ?? null,
      async set(input: AddonInput): Promise<AddonRow> {
        if (!deps.addonRpc) throw new Error('the add-on registry is not running on this host')
        return ((await deps.addonRpc.handle({ method: 'addons.set', params: { addon: input } }, local)) as { addon: AddonRow }).addon
      },
      async remove(id) {
        await deps.addonRpc?.handle({ method: 'addons.remove', params: { id } }, local)
      },
      role: (id) => deps.addons?.workMarks(id)?.role ?? null,
      setRole: (id) => void deps.addons?.setWorkMarks(id, { role: 'lifeos' })
    },
    grants: deps.addonGrants
      ? {
          has: seams.hasGrant ?? ((id) => !!vaultGrantSource.readSync(id)?.fields.Authorization),
          set: async (id, authorization) => void (await deps.addonGrants!.setFields(id, { Authorization: authorization }))
        }
      : null,
    log
  })
  const links = new Links({ db: deps.db, host: deps.environmentId, owner, sectorOf: (id) => ctx.scopeOf(id)?.sector ?? null, log })
  const listeners = new Set<() => void>()
  const changed = (): void => {
    for (const fn of [...listeners]) fn()
  }
  session.onChange(changed)
  keys.onChange(changed)

  const reconcile = (): Promise<void> => keys.reconcile()
  let soon: NodeJS.Timeout | null = null
  const reconcileSoon = (): void => {
    if (soon) return
    soon = setTimeout(() => {
      soon = null
      void reconcile()
    }, 500)
    soon.unref?.()
  }

  /** The owner's name for the preamble, from his default mail identity, when the host has none yet. */
  const learnOwnerName = async (): Promise<void> => {
    if (deps.store.getSetting(WORK_OWNER_NAME_SETTING)) return
    try {
      const accounts = await session.owner().query<{ identities?: { name?: string; isDefault: boolean }[] }[]>('mail:accounts', {})
      const name = accounts?.flatMap((a) => a.identities ?? []).find((i) => i.isDefault && i.name?.trim())?.name?.trim()
      if (name) deps.store.setSetting(WORK_OWNER_NAME_SETTING, name.slice(0, 80))
    } catch (err) {
      log(`lifeos: the owner's name was not read: ${faultWords(err)}`)
    }
  }

  deps.whileOn(() => {
    session.start()
    const offConnected = session.onConnected(() => {
      void reconcile()
      void links.flush()
      void learnOwnerName()
    })
    const offCatalog = deps.registry.onCatalog?.((kind) => kind === 'workspaces' && reconcileSoon())
    // A build before Work resets a row's marks when it rewrites it; the next pass puts the mark back.
    const offAddons = deps.addons?.onChange(reconcileSoon)
    const every = setInterval(() => void reconcile(), seams.reconcileMs ?? 5 * 60_000)
    every.unref?.()
    void reconcile()
    return () => {
      offConnected()
      offCatalog?.()
      offAddons?.()
      clearInterval(every)
      if (soon) clearTimeout(soon)
      soon = null
      session.stop()
    }
  })

  const host: LifeosHost = {
    session,
    keys,
    links,
    url: address.url,
    status(withCode) {
      const state = session.state()
      const lifeos = state.state === 'pairing' && !withCode ? { state: 'pairing' as const, expiresAt: state.expiresAt } : state
      return { lifeos, keys: keys.list() }
    },
    onStatus(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    reconcile,
    workspaces: () => deps.registry.listWorkspaces(),
    async validSector(sector) {
      const list = await session.owner().query<{ key: string }[]>('sectors:list', {})
      return (list ?? []).some((s) => s.key === sector)
    },
    setSector: (workspaceId, sector) => deps.registry.setWorkspaceSector(workspaceId, sector),
    homeOf: (workspaceId) => deps.storeSync?.homeFor(workspaceId)?.name ?? null
  }
  return host
}

export const lifeosPart: CtxPart<'lifeos' | 'links'> = (ctx, deps) => {
  const host = makeLifeosHost(ctx, deps, lifeosSeamsFor.current ?? {})
  hosts.set(ctx, host)
  const { session, links } = host
  return {
    lifeos: {
      connected: () => session.connected(),
      owner: () => session.owner(),
      jwt: async (sector) => (await session.jwt(sector ? [sector] : undefined)).jwt,
      subscribe: (fn, args, on) => session.subscribe(fn, args, on)
    },
    links: {
      link: (about, sessionId, title) => links.link(about, sessionId, title),
      forThread: async (sessionId) => links.forThread(sessionId, liveOwner(session)),
      completeFor: async (sessionId, reason) => links.completeFor(sessionId, reason, liveOwner(session))
    }
  }
}

/** The owner's client, or the typed reason there is none. */
function liveOwner(session: LifeosSession) {
  if (!session.connected()) {
    const state = session.state().state
    throw new LifeosUnavailable(state === 'connected' ? 'connecting' : state)
  }
  return session.owner()
}

/** Test seams for the part as `buildWorkCtx` makes it: set before `startWork`, cleared after. */
export const lifeosSeamsFor: { current: LifeosSeams | null } = { current: null }
