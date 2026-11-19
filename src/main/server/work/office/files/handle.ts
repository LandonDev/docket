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
import { BYTES_MAX, copyAllowed, entryOf, fetchFile, librariesOf, libraryOf, listFolder, offFolders, readText, rootsOf, searchLibraries, setCopyAllowed, setRoots } from './library'

/**
 * The Teams files' wire (`work.office.files*`, docs/agents/work-files.md). Every method that names a
 * file takes it as a `{at: 'file'}` source on this host, and every one passes the same fence: the
 * file's real path lies in a library this host lists (`libraryOf`). A remote key must also be able to
 * name it itself (the listener's fence); a call from another host of his, over the host link, is held
 * to the libraries alone, under this host's bridge policy for it.
 */

const NOT_TEAMS = 'That is not in a Teams folder on this host (Settings → Work → Teams files).'

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
  if (source.at !== 'file' || source.host === ctx.host) throw new Error('A copy comes from a file on another host.')
  const got = (await ctx.peer.call({ scope, signal }, source.host).call('office', 'filesRead', { source, as: 'bytes' })) as { name: string; data: string }
  // One folder per source file, so two files of one name in a thread never share a copy.
  const dir = join(copyDirOf(ctx.dataDir, sessionId), createHash('sha1').update(`${source.host}\u0000${source.path}`).digest('hex').slice(0, 12))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, basename(got.name))
  writeFileSync(path, Buffer.from(got.data, 'base64'), { mode: 0o600 })
  return { source: { at: 'file', host: ctx.host, path }, entry: entryOf('', path) }
}

export async function filesHandle(req: ClientRequest, ctx: WorkCtx, by: Caller, carrier: () => OfficeCarrier | null, signal?: AbortSignal): Promise<Handled> {
  const m = req.method
  const p = (req as { params?: Record<string, unknown> }).params ?? {}
  switch (m) {
    case 'work.office.filesLibraries':
      return handled({ host: ctx.host, libraries: librariesOf(ctx.db, ctx.host), roots: rootsOf(ctx.db), off: offFolders(ctx.db) })
    case 'work.office.filesList': {
      const { library, path } = admitted(ctx, by, m, p.source as CanvasSource)
      if (!statSync(path).isDirectory()) throw new Error('That is a file, not a folder.')
      return handled({ entries: listFolder(library, path) })
    }
    case 'work.office.filesSearch': {
      const all = librariesOf(ctx.db, ctx.host)
      const libs = p.library ? all.filter((l) => l.id === p.library) : all
      if (p.library && !libs.length) throw new Error('No such library on this host.')
      // A remote key searches only what it could name itself.
      const fenced = by.kind === 'remote' && !by.peer ? libs.filter((l) => ctx.reaches(by, l.path)) : libs
      return handled(await searchLibraries(fenced, p.query as string, p.kind as never))
    }
    case 'work.office.filesFetch': {
      const { library, path } = admitted(ctx, by, m, p.source as CanvasSource)
      return handled({ entry: await fetchFile(library.id, path, signal) })
    }
    case 'work.office.filesRead': {
      const { path } = admitted(ctx, by, m, p.source as CanvasSource)
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
      await openInApp(carrier(), entryOf(library.id, path))
      return handled({ opened: true as const })
    }
    case 'work.office.filesSetRoots':
      setRoots(ctx.db, p.roots as never)
      return handled({ host: ctx.host, libraries: librariesOf(ctx.db, ctx.host), roots: rootsOf(ctx.db), off: offFolders(ctx.db) })
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

