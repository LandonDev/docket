import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { teamsAppOf, teamsKindOf, type TeamsEntry, type TeamsLibrary } from '@shared/contract-work-office'
import { handled, NOT_HANDLED, type CanvasSource, type Handled } from '@shared/work'
import type { ClientRequest } from '@shared/contract'
import { FenceError } from '../../../remote/fence'
import { macBridgeLandingRoot } from '../../../macBridgeLanding'
import type { Caller, WorkCtx } from '../../modules'
import type { OfficeCarrier } from '../carrier'
import { BYTES_MAX, copyAllowed, entryOf, fetchFile, foldersPlace, librariesOf, libraryOf, listFolder, offFolders, readText, rootsOf, searchLibraries, SEARCH_MAX, setCopyAllowed, setRoots } from './library'
import { NOT_SET_UP } from '../../winvm/keeper'
import { isGuestPath, missingLibraries, refreshVm, setWantedLibraries, storedStatus, vmBytes, vmFetch, vmLibraries, vmLibraryOf, vmList, vmOfficeStatus, vmOpen, vmPlace, vmSearch, vmStat, vmText, wantedLibraries } from '../vm/files'
import { vmAllowed, vmKey, vmState } from '../vm/office'
import { vmCall } from '../vm/link'
import { followSignIn, OFFICE_SIGN_IN_LINES, SIGN_IN_LINES, walkOfficeSignIn, walkSignIn } from '../vm/signin'
import type { TeamsLibrariesAnswer, TeamsPlace, VmSignInAnswer, VmSyncLibrary } from '@shared/contract-work-office'

/**
 * The Teams files' wire (`work.office.files*`, docs/agents/work-files.md). Every method that names a
 * file takes it as a `{at: 'file'}` source on this host, and every one passes the same fence: the
 * file's real path lies in a library this host lists (`libraryOf`). A remote key must also be able to
 * name it itself (the listener's fence); a call from another host of his, over the host link, is held
 * to the libraries alone, under this host's bridge policy for it.
 */

const NOT_TEAMS = 'That is not in a Teams folder on this host (Settings → Work → Teams files).'
const NOT_VM = 'This workspace may not use the Windows VM (its Work settings: Computer use on the Windows VM).'
const ONLY_OWNER = 'Only the owner signs in on the Windows VM or chooses what it syncs.'

/** What `filesHandle` needs of the pillar besides the files: the carrier of this host, the VM's Office, and his address where Outlook here knows it. */
export interface FilesDeps {
  carrier(): OfficeCarrier | null
  /** opens an Office file in its app in the Windows VM; absent where the pillar has no VM carrier (a test) */
  vmOpenOffice?: (app: 'excel' | 'word' | 'powerpoint', path: string) => Promise<void>
  ownAccount?: () => string | null
}

/** A test's short waits for the sign-in walk; with them set the walk sleeps no time and nothing follows it. */
let pace: { first: number; page: number; list: number } | null = null
export const setSignInPace = (waits: { first: number; page: number; list: number } | null): void => void (pace = waits)

/** One watch of a sign-in at a time (vm/signin.ts `followSignIn`); none under a test's pace. */
let following = false
function follow(ctx: WorkCtx, account: () => Promise<string | null>, what: string): void {
  if (following || pace) return
  following = true
  void followSignIn({ call: vmCall, account })
    .then((end) => ctx.log(`office: the Windows VM's ${what} sign-in ${end === 'signed-in' ? 'went through' : 'was not finished in six minutes'}`))
    .catch((err) => ctx.log(`office: following the sign-in failed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => (following = false))
}

/** How fresh the VM's kept status must be for a list to use it without asking an awake machine again. */
const VM_FRESH_MS = 15_000

/**
 * The VM's libraries and its place, for a list. An awake machine is asked again (it costs one short
 * call); a sleeping one answers from what was kept, and is woken only if it has never been read.
 */
async function vmListing(ctx: WorkCtx, signal?: AbortSignal): Promise<{ libraries: TeamsLibrary[]; place: TeamsPlace | null }> {
  const state = vmState()
  if (!state || state.cannot || state.state === 'none' || state.state === 'setting-up') return { libraries: [], place: vmPlace(ctx.db, state) }
  const stored = storedStatus(ctx.db)
  try {
    if (!stored) await refreshVm(ctx.db, { wake: true, signal })
    else if (state.state === 'awake' && Date.now() - stored.at > VM_FRESH_MS) await refreshVm(ctx.db, { wake: false, signal })
  } catch (err) {
    ctx.log(`office: the Windows VM's OneDrive could not be read: ${err instanceof Error ? err.message : String(err)}`)
    if (!storedStatus(ctx.db)) return { libraries: [], place: { kind: 'vm', state: 'error', account: null, detail: err instanceof Error ? err.message : String(err) } }
  }
  return { libraries: vmLibraries(ctx.db, ctx.host), place: vmPlace(ctx.db, state) }
}

/** Whether the caller may use what is in the VM: a thread only where its workspace turns the VM on; his own windows always. */
const vmFor = (ctx: WorkCtx, by: Caller): boolean => {
  if (by.kind !== 'model') return true
  // a host that keeps no VM has nothing to ask a thread's workspace about
  if (!vmState()) return false
  const scope = by.sessionId ? ctx.scopeOf(by.sessionId) : null
  return !!scope && vmAllowed(ctx, scope)
}

async function librariesAnswer(ctx: WorkCtx, by: Caller, signal?: AbortSignal): Promise<TeamsLibrariesAnswer> {
  const own = librariesOf(ctx.db, ctx.host)
  const vm = vmFor(ctx, by) ? await vmListing(ctx, signal) : { libraries: [], place: null }
  const folders = foldersPlace(ctx.host)
  // A folder he added himself is a library too: the place then has something to show.
  const places = [...(folders ? [own.some((l) => l.kind !== 'mine') && folders.state !== 'ok' ? { ...folders, state: 'ok' as const } : folders] : []), ...(vm.place ? [vm.place] : [])]
  return { host: ctx.host, libraries: [...own, ...vm.libraries], roots: rootsOf(ctx.db), off: offFolders(ctx.db), places }
}

/** Opens a file in its own app here: the Office carrier for an Office file, else the system's opener. A test hands its own. */
let opener = (path: string): Promise<void> =>
  new Promise((done, fail) => {
    const [cmd, args] = process.platform === 'darwin' ? ['/usr/bin/open', [path]] : process.platform === 'win32' ? ['explorer.exe', [path]] : [null, []]
    if (!cmd) return fail(new Error('A file opens in its app on a Mac or a Windows PC.'))
    execFile(cmd, args as string[], (err) => (err && process.platform !== 'win32' ? fail(err) : done()))
  })
export const setFilesOpener = (fn: (path: string) => Promise<void>): void => void (opener = fn)

/** The file a source names here, inside a library, or a refusal. */
export function admitted(ctx: WorkCtx, by: Caller, method: string, source: CanvasSource): { library: TeamsLibrary; path: string } {
  const path = source.at === 'file' ? source.path : source.at === 'microsoft' && source.ref.kind === 'path' ? source.ref.path : null
  if (path === null) throw new Error('A Teams file is named by its path on its host.')
  if (source.at !== 'thread' && 'host' in source && source.host !== ctx.host) throw new Error('That file is on another host: ask that host.')
  if (isGuestPath(path) && process.platform !== 'win32') {
    // A file in the Windows VM this host keeps: no path of this host's disk, so the listener's fence has nothing to
    // say of it. It must lie in a library OneDrive syncs there, and a thread needs its workspace's switch.
    if (!vmFor(ctx, by)) throw new Error(NOT_VM)
    const inVm = vmLibraryOf(vmLibraries(ctx.db, ctx.host), path)
    if (!inVm) throw new Error(NOT_TEAMS)
    return inVm
  }
  const found = libraryOf(librariesOf(ctx.db, ctx.host), path)
  if (!found) throw new Error(NOT_TEAMS)
  if (by.kind === 'remote' && !by.peer && !ctx.reaches(by, found.path)) throw new FenceError(method)
  return found
}

/** Opens an entry in its app on this host. */
export async function openInApp(carrier: OfficeCarrier | null, entry: Pick<TeamsEntry, 'name' | 'path'>): Promise<void> {
  const app = teamsAppOf(teamsKindOf(entry.name), entry.name)
  // Outlook on the web and the add-in alone open no file on this disk.
  if (app && carrier && carrier.kind !== 'owa' && carrier.kind !== 'addin') return carrier.open(app, { kind: 'path', path: entry.path })
  return opener(entry.path)
}

/** Where a copy he allowed lands: the thread's own corner of this host's attachments (a root a remote key reaches). */
const copiesRoot = (dataDir: string): string => join(macBridgeLandingRoot(dataDir), 'teams-files')
const safe = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_')
export const copyDirOf = (dataDir: string, sessionId: string): string => join(copiesRoot(dataDir), safe(sessionId))

/** Drops the copies of the threads given, or of every thread whose workspace `inWorkspace` names. */
export function dropCopies(ctx: Pick<WorkCtx, 'dataDir' | 'scopeOf'>, which: { sessions: string[] } | { workspaceId: string }): void {
  const root = copiesRoot(ctx.dataDir)
  if (!existsSync(root)) return
  const dirs = 'sessions' in which ? which.sessions.map(safe) : readdirSync(root).filter((dir) => ctx.scopeOf(dir)?.workspaceId === which.workspaceId)
  for (const dir of dirs) rmSync(join(root, dir), { recursive: true, force: true })
}

/** Copies a file from another host into the thread's attachments here, when its workspace allows it. */
export async function copyIn(ctx: WorkCtx, sessionId: string, source: CanvasSource, signal?: AbortSignal): Promise<{ source: CanvasSource; entry: TeamsEntry }> {
  const scope = ctx.scopeOf(sessionId)
  if (!scope) throw new Error(`thread ${sessionId} is not a Work thread here`)
  if (!scope.workspaceId || !copyAllowed(ctx.db, scope.workspaceId)) throw new Error('This workspace keeps Teams files where they are: turn on Copy Teams files in its settings to open one here.')
  if (source.at !== 'file') throw new Error('A copy comes from a file on another host.')
  let got: { name: string; bytes: Buffer }
  if (source.host === ctx.host) {
    // A file in this host's Windows VM comes out of the guest the same way: a snapshot in the thread's own folder.
    if (!isGuestPath(source.path)) throw new Error('A copy comes from a file on another host.')
    if (!vmAllowed(ctx, scope)) throw new Error(NOT_VM)
    const inVm = vmLibraryOf(vmLibraries(ctx.db, ctx.host), source.path)
    if (!inVm) throw new Error(NOT_TEAMS)
    got = { name: inVm.path.slice(inVm.path.lastIndexOf('\\') + 1), bytes: await vmBytes(inVm.path, BYTES_MAX, signal) }
  } else {
    const far = (await ctx.peer.call({ scope, signal }, source.host).call('office', 'filesRead', { source, as: 'bytes' })) as { name: string; data: string }
    got = { name: far.name, bytes: Buffer.from(far.data, 'base64') }
  }
  // One folder per source file, so two files of one name in a thread never share a copy.
  const dir = join(copyDirOf(ctx.dataDir, sessionId), createHash('sha1').update(`${source.host}\u0000${source.path}`).digest('hex').slice(0, 12))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, basename(got.name))
  writeFileSync(path, got.bytes, { mode: 0o600 })
  return { source: { at: 'file', host: ctx.host, path }, entry: entryOf('', path) }
}

export async function filesHandle(req: ClientRequest, ctx: WorkCtx, by: Caller, deps: FilesDeps | (() => OfficeCarrier | null), signal?: AbortSignal): Promise<Handled> {
  const d: FilesDeps = typeof deps === 'function' ? { carrier: deps } : deps
  const carrier = d.carrier
  const m = req.method
  const p = (req as { params?: Record<string, unknown> }).params ?? {}
  switch (m) {
    case 'work.office.filesLibraries':
      return handled(await librariesAnswer(ctx, by, signal))
    case 'work.office.filesList': {
      const { library, path } = admitted(ctx, by, m, p.source as CanvasSource)
      if (library.vm) return handled({ entries: await vmList(library, path, signal) })
      if (!statSync(path).isDirectory()) throw new Error('That is a file, not a folder.')
      return handled({ entries: listFolder(library, path) })
    }
    case 'work.office.filesSearch': {
      const vm = vmFor(ctx, by) ? vmLibraries(ctx.db, ctx.host) : []
      const all = [...librariesOf(ctx.db, ctx.host), ...vm]
      const libs = p.library ? all.filter((l) => l.id === p.library) : all
      if (p.library && !libs.length) throw new Error('No such library on this host.')
      // A remote key searches only what it could name itself; the VM's libraries are no path of this host and are its to search.
      const own = libs.filter((l) => !l.vm)
      const fenced = by.kind === 'remote' && !by.peer ? own.filter((l) => ctx.reaches(by, l.path)) : own
      const inVm = libs.filter((l) => l.vm)
      const [a, b] = await Promise.all([searchLibraries(fenced, p.query as string, p.kind as never), vmSearch(inVm, p.query as string, p.kind as never, signal)])
      const entries = [...a.entries, ...b.entries].sort((x, y) => y.modified - x.modified)
      return handled({ entries: entries.slice(0, SEARCH_MAX), more: a.more || b.more || entries.length > SEARCH_MAX })
    }
    case 'work.office.filesFetch': {
      const { library, path } = admitted(ctx, by, m, p.source as CanvasSource)
      return handled({ entry: library.vm ? await vmFetch(library.id, path, signal) : await fetchFile(library.id, path, signal) })
    }
    case 'work.office.filesRead': {
      const { library, path } = admitted(ctx, by, m, p.source as CanvasSource)
      if (library.vm) {
        // The guest's bytes never leave this host: a copy he allowed is made here (`filesCopy`), not sent to a caller.
        if (p.as === 'bytes') throw new Error("A file in the Windows VM is copied on this host (filesCopy): its bytes go to no caller.")
        return handled({ name: path.slice(path.lastIndexOf('\\') + 1), ...(await vmText(path, signal)) })
      }
      if (p.as === 'bytes') {
        // Bytes leave this host only for another host of his making a copy its workspace allows (it checks its own switch).
        if (!by.peer) throw new Error('A file\'s bytes go only to another host of his, for a copy he allowed.')
        // The size is known before the download: a file too big to copy is never fetched for it.
        if (statSync(path).size > BYTES_MAX) throw new Error(`${basename(path)} is over ${BYTES_MAX / 1024 / 1024} MB: open it in its app.`)
        await fetchFile('', path, signal)
        return handled({ name: basename(path), data: readFileSync(path).toString('base64') })
      }
      return handled({ name: basename(path), ...(await readText(path)) })
    }
    case 'work.office.filesOpen': {
      const { library, path } = admitted(ctx, by, m, p.source as CanvasSource)
      if (library.vm) {
        if ((await vmStat(library.id, path, signal)).kind === 'folder') throw new Error('That is a folder.')
        await vmOpen(path, d.vmOpenOffice ?? null, signal)
        return handled({ opened: true as const })
      }
      await openInApp(carrier(), entryOf(library.id, path))
      return handled({ opened: true as const })
    }
    case 'work.office.filesSetRoots':
      setRoots(ctx.db, p.roots as never)
      return handled(await librariesAnswer(ctx, by, signal))
    case 'work.office.vmStatus':
      return handled(vmOfficeStatus(ctx.db, vmState()))
    case 'work.office.vmSignIn': {
      if (by.kind === 'model') throw new Error(ONLY_OWNER)
      const state = vmState()
      if (!state || state.cannot || state.state === 'none') throw new Error(state?.cannot ?? NOT_SET_UP)
      const stored = await refreshVm(ctx.db, { wake: true, signal })
      const signedIn = stored?.status.onedrive.account ?? null
      if (signedIn) {
        // OneDrive is done; a fresh Office asks for its own sign-in in the first app he opens, so Word is opened for it.
        const office = stored!.status.office
        if (office.installed && office.licensed !== true) {
          const reached = await walkOfficeSignIn({ call: vmCall, ...(pace ? { waits: pace, sleep: async () => {} } : {}) })
          follow(ctx, async () => (await refreshVm(ctx.db, { wake: false }))?.status.office.account ?? null, 'Office')
          return handled({ computer: 'vm:windows', account: signedIn, line: OFFICE_SIGN_IN_LINES[reached] } satisfies VmSignInAnswer)
        }
        return handled({ computer: 'vm:windows', account: signedIn, line: `The Windows VM is signed in as ${signedIn}.` } satisfies VmSignInAnswer)
      }
      const account = (p.account as string | undefined) ?? d.ownAccount?.() ?? stored?.status.office.account ?? null
      // Walked to the one step that is his: the number for his phone. Nothing here types a password or a code.
      const reached = await walkSignIn(account, { call: vmCall, key: vmKey, ...(pace ? { waits: pace, sleep: async () => {} } : {}) })
      // While he answers on his phone the host answers what Microsoft asks next, so his one approval is enough.
      if (reached === 'number' || reached === 'pending') follow(ctx, async () => (await refreshVm(ctx.db, { wake: false }))?.status.onedrive.account ?? null, 'OneDrive')
      return handled({ computer: 'vm:windows', account, line: SIGN_IN_LINES[reached] } satisfies VmSignInAnswer)
    }
    case 'work.office.vmSync': {
      if (by.kind === 'model') throw new Error(ONLY_OWNER)
      setWantedLibraries(ctx.db, p.libraries as VmSyncLibrary[])
      // An awake, signed-in OneDrive is asked now; otherwise at its next read.
      await refreshVm(ctx.db, { wake: false, signal }).catch(() => null)
      return handled({ wanted: wantedLibraries(ctx.db).length, missing: missingLibraries(ctx.db).length })
    }
    case 'work.office.filesCopyGet':
      return handled({ on: copyAllowed(ctx.db, p.workspaceId as string) })
    case 'work.office.filesCopySet':
      setCopyAllowed(ctx.db, p.workspaceId as string, p.on as boolean)
      // Turned off, the copies its threads hold go too.
      if (!p.on) dropCopies(ctx, { workspaceId: p.workspaceId as string })
      return handled({ on: copyAllowed(ctx.db, p.workspaceId as string) })
    case 'work.office.filesCopy': {
      const scope = ctx.scopeOf(p.sessionId as string)
      if (!scope || (by.kind === 'model' && by.sessionId !== scope.sessionId)) throw new Error('No such Work thread here.')
      return handled(await copyIn(ctx, scope.sessionId, p.source as CanvasSource, signal))
    }
  }
  return NOT_HANDLED
}

