import type { ClientRequest } from '@shared/contract'
import type { OfficeLiveApp, OfficeLiveDesktop, OfficeLiveLibraryDefault, OfficeLiveMode, OfficeLiveOf, OfficeStatus, TeamsLibrariesAnswer, TeamsLibrary, VmOfficeStatus } from '@shared/contract-work-office'
import { canvasSourcePath, filesPaneOf, handled, NOT_HANDLED, type Handled } from '@shared/work'
import { FenceError } from '../../../remote/fence'
import { filesState, ownRows } from '../../files/handle'
import { reachesPath } from '../../files/names'
import { librariesHere } from '../../files/places/libraries'
import { locate } from '../../files/policy'
import type { Caller, WorkCtx } from '../../modules'
import type { OfficeCarrier } from '../carrier'
import { cachedVmLibraries } from '../files/handle'
import { libraryOf } from '../files/library'
import { vmLibraryOf, vmOfficeStatus } from '../vm/files'
import { vmState } from '../vm/office'
import { appOf, liveAddress, liveTwin, pathRules, relativeLivePath, tenantOf } from './address'
import { libraryDefault, modeOf, setLibraryDefault } from './memory'

const OF = 'work.office.live.of'
const PEER_READ_MS = 4_000
const NO_FILE = 'That Files tab is closed.'
const EMPTY: OfficeLiveOf = { mode: 'here', address: null, app: null, tenant: null, desktops: [] }
type FileAt = { library: TeamsLibrary; path: string }
type PeerRead = (host: string, verb: string, params: Record<string, unknown>) => Promise<unknown>

const localLibraries = (ctx: WorkCtx): TeamsLibrary[] => [...librariesHere(ctx), ...cachedVmLibraries(ctx)]

async function readLibraries(read: PeerRead, host: string): Promise<TeamsLibrary[]> {
  try {
    const { libraries, roots } = (await read(host, 'filesLibraries', { cached: true })) as TeamsLibrariesAnswer
    // Older hosts did not say where web came from. On those hosts every non-VM web matching a saved link is from Settings.
    return libraries.filter((l) => l.host === host).map((l) => !l.vm && !l.webSource && l.web && roots.some((r) => r.web === l.web) ? { ...l, webSource: 'settings' } : l)
  } catch {
    return []
  }
}

function farFile(libraries: readonly TeamsLibrary[], ref: { host: string; path: string }): FileAt | null {
  const library = libraries
    .filter((l) => l.host === ref.host && (l.vm ? vmLibraryOf([l], ref.path) : relativeLivePath(l, ref.path) !== null))
    .sort((a, b) => b.path.length - a.path.length)[0]
  return library ? { library, path: ref.path } : null
}

async function remoteDefault(read: PeerRead, library: TeamsLibrary): Promise<OfficeLiveMode> {
  try {
    const { mode } = (await read(library.host, 'live.libraryDefault', { libraryId: library.id })) as OfficeLiveLibraryDefault
    return mode === 'live' ? 'live' : 'here'
  } catch {
    return 'here'
  }
}

/** A desktop target names a file on its own host, as work.office.filesOpen expects it. */
async function desktopOf(ctx: WorkCtx, app: OfficeLiveApp, at: FileAt, read: PeerRead, carrier: () => OfficeCarrier | null): Promise<OfficeLiveDesktop | null> {
  const { host, vm } = at.library
  try {
    if (vm) {
      const { office } = host === ctx.host ? vmOfficeStatus(ctx.db, vmState()) : (await read(host, 'vmStatus', {})) as VmOfficeStatus
      if (!office?.installed || !office.apps.includes(app)) return null
    } else {
      const own = host === ctx.host ? carrier() : null
      const status = host === ctx.host ? { carrier: own?.kind, apps: await own?.apps() } : (await read(host, 'status', {})) as OfficeStatus
      if (!status.carrier || status.carrier === 'owa' || status.carrier === 'addin' || !status.apps?.some((a) => a.app === app && a.installed)) return null
    }
    return { source: { at: 'file', host, path: at.path }, ...(vm ? { vm } : {}) }
  } catch {
    return null
  }
}

function twinFiles(ctx: WorkCtx, by: Caller, at: FileAt, file: string, libraries: readonly TeamsLibrary[]): FileAt[] {
  const targets = [at]
  for (const library of libraries) {
    if (targets.some((t) => t.library.host === library.host && !!t.library.vm === !!library.vm)) continue
    const twin = liveTwin(at.library, file, library)
    if (!twin) continue
    const rules = pathRules(library)
    const parts = twin.file.split('/')
    if (rules.sep === '\\' && parts.some((part) => part.includes('\\'))) continue
    const path = rules.join(library.path, ...parts)
    if (!reachesPath(ctx, by, path)) continue
    const found = library.host !== ctx.host ? { library, path } : library.vm ? vmLibraryOf([library], path) : libraryOf([library], path)
    if (found && reachesPath(ctx, by, found.path)) targets.push(found)
  }
  return targets
}

async function liveOf(ctx: WorkCtx, by: Caller, workspaceId: string, tabId: string, carrier: () => OfficeCarrier | null, signal?: AbortSignal): Promise<OfficeLiveOf> {
  ownRows(ctx, by, workspaceId)
  const state = filesState(ctx)
  const tab = state.tabs.list(workspaceId).tabs.find((t) => t.id === tabId)
  if (!tab) throw new Error(NO_FILE)
  if (tab.kind !== 'file') return EMPTY
  const item = tab.itemId ? ctx.canvas.get(tab.itemId) : null
  if (!item || item.sessionId !== filesPaneOf(workspaceId)) throw new Error(NO_FILE)
  const path = canvasSourcePath(item.source)
  if (path !== null && !reachesPath(ctx, by, path)) throw new FenceError(OF)
  // A Word import replaces the item, but the tab key and the marked original stay.
  const refKey = tab.key ?? ''
  const marked = refKey ? state.marks.of(workspaceId, [refKey]).get(refKey)?.at : undefined
  const original = marked && 'file' in marked && marked.file.at === 'file' ? marked.file : null
  const ref = tab.copyOf ?? original ?? (path !== null && 'host' in item.source ? { host: item.source.host, path } : null)
  if (!ref) return EMPTY
  const app = appOf(ref.path)
  if (!app) return EMPTY

  const here = ref.host === ctx.host ? locate(ctx, by, workspaceId, { at: 'file', host: ref.host, path: ref.path }, OF) : null
  if (here && here.in !== 'library') return EMPTY
  const own = localLibraries(ctx)
  const deadline = AbortSignal.timeout(PEER_READ_MS)
  const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  const read: PeerRead = (host, verb, args) => ctx.peer.call({ scope: { sessionId: filesPaneOf(workspaceId), workspaceId }, signal: readSignal }, host).call('office', verb, args)
  const peers = ctx.settings.workspace(workspaceId).mayUseDesktop
  // A remote key can see the origin of a copy it can reach, and only the mounts it could name on this host.
  const hosts = [...new Set(peers)].filter((host) => host !== ctx.host && (by.kind === 'local' || host === ref.host))
  const far = (await Promise.all(hosts.map((host) => readLibraries(read, host)))).flat()
  const at = here?.in === 'library' ? here : farFile(far, ref)
  if (!at) return { ...EMPTY, mode: modeOf(ctx.db, workspaceId, refKey, null), app, why: 'The file’s library did not answer.' }

  const libraries = [...own.filter((l) => reachesPath(ctx, by, l.path)), ...far]
  const result = liveAddress(at.library, at.path, { libraries })
  const file = relativeLivePath(at.library, at.path)
  const targets = file === null ? [] : twinFiles(ctx, by, at, file, libraries)
  const [desktops, fallback] = await Promise.all([
    Promise.all(targets.map((target) => desktopOf(ctx, app, target, read, carrier))),
    at.library.host === ctx.host ? undefined : remoteDefault(read, at.library)
  ])
  return {
    mode: modeOf(ctx.db, workspaceId, refKey, at.library.id, fallback),
    address: result.ok ? result.url : null,
    ...(!result.ok ? { why: result.why } : {}),
    app,
    tenant: result.ok ? tenantOf(result.url) : null,
    desktops: desktops.filter((target) => target !== null)
  }
}

export async function liveHandle(req: ClientRequest, ctx: WorkCtx, by: Caller, carrier: () => OfficeCarrier | null, signal?: AbortSignal): Promise<Handled> {
  switch (req.method) {
    case OF:
      return handled(await liveOf(ctx, by, req.params.workspaceId, req.params.tabId, carrier, signal))
    case 'work.office.live.libraryDefault':
    case 'work.office.live.setLibraryDefault': {
      if (by.kind === 'model' || (by.peer && req.method === 'work.office.live.setLibraryDefault')) throw new Error('Library defaults are set from a window on this host.')
      const { libraryId } = req.params
      const library = localLibraries(ctx).find((l) => l.id === libraryId)
      if (!library) throw new Error('That library is no longer listed on this host.')
      if (!reachesPath(ctx, by, library.path)) throw new FenceError(req.method)
      if (req.method === 'work.office.live.setLibraryDefault') setLibraryDefault(ctx.db, libraryId, req.params.mode)
      return handled({ mode: libraryDefault(ctx.db, libraryId) } satisfies OfficeLiveLibraryDefault)
    }
    default:
      return NOT_HANDLED
  }
}
