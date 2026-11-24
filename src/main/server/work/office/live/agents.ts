import type { TeamsLibrariesAnswer, TeamsLibrary } from '@shared/contract-work-office'
import type { ToolCtx } from '../../modules'
import { isMicrosoftUrl } from '../addin/web'
import { OfficeError, type OfficeCarrier } from '../carrier'
import { on, reachableHosts, type Deps } from '../files/tools'
import { cloudKey, openAddress, sameCloudFile, syncedFilesOf } from './address'

/**
 * An agent's office tools on a live file (docs/agents/work-office.md "A file named by its address"). The thread names
 * the file by its address, the live tab's; the Office that has it open keys it by its own form of that address (the
 * add-in's `Office.context.document.url`, Word's `FullName`). These find the one from the other by `cloudKey`, open
 * the file by its address in Word in the Windows VM where nothing has it open, and read OneDrive's synced copy where
 * no Office can. A change is judged and held by the tools as before (tools.ts, held.ts): nothing here writes.
 */

export type FileApp = 'excel' | 'word' | 'powerpoint'
export interface NamedFile {
  app: FileApp
  key: string
}

const FIELD = { excel: 'workbook', word: 'document', powerpoint: 'deck' } as const
const APP = { excel: 'Excel', word: 'Word', powerpoint: 'PowerPoint' } as const

/** The file a tool's arguments name, if any. */
export function fileOf(args: unknown): NamedFile | null {
  const a = (args ?? {}) as Record<string, unknown>
  if (typeof a.workbook === 'string') return { app: 'excel', key: a.workbook }
  if (typeof a.document === 'string') return { app: 'word', key: a.document }
  if (typeof a.deck === 'string') return { app: 'powerpoint', key: a.deck }
  return null
}

/** Whether a tool names its file by a cloud address `cloudKey` can match. */
export const byAddress = (f: NamedFile | null): f is NamedFile => !!f && cloudKey(f.key) !== null

const openFiles = (c: OfficeCarrier, app: FileApp) => (app === 'excel' ? c.workbooks() : app === 'word' ? c.documents() : c.presentations())

/** The key the carrier has this file open under: the same key first, else any form of its address. Null when none, or the app cannot be asked. */
export async function openKeyOf(c: OfficeCarrier, f: NamedFile): Promise<string | null> {
  if (!byAddress(f)) return null
  let open: { key: string }[]
  try {
    open = await openFiles(c, f.app)
  } catch {
    return null
  }
  return (open.find((o) => o.key === f.key) ?? open.find((o) => sameCloudFile(o.key, f.key)))?.key ?? null
}

/** The same arguments with the file named by another key. */
export const withKey = (args: unknown, f: NamedFile, key: string): unknown => (key === f.key ? args : { ...(args as object), [FIELD[f.app]]: key })

/** The arguments naming the file as this carrier keys it, so a hold keeps the key its press finds again; else as they were. */
export async function keyedArgs(c: OfficeCarrier, args: unknown): Promise<unknown> {
  const f = fileOf(args)
  const key = byAddress(f) ? await openKeyOf(c, f) : null
  return f && key ? withKey(args, f, key) : args
}

export interface OpenWait {
  /** how long the app may take to list the file */
  ms?: number
  every?: number
  sleep?: (ms: number) => Promise<void>
}
/** Word started cold in the VM and the file fetched from SharePoint take tens of seconds. */
export const OPEN_MS = 90_000
const EVERY_MS = 2_000

/**
 * The file opened by its address in its app on this carrier, where no form of the address is open there yet:
 * `Office.Open`'s URL route (`ms-word:ofe|u|<address>`), so Word co-authors the live file rather than a copy. An address
 * off Microsoft's own sites is refused. Waits
 * until the app lists it, and answers its key there (Word's `FullName`).
 */
export async function openByAddress(c: OfficeCarrier, f: NamedFile, o: OpenWait = {}): Promise<string> {
  const had = await openKeyOf(c, f)
  if (had) return had
  // Only Microsoft's own sites: an agent's address never sends Word elsewhere.
  if (!isMicrosoftUrl(f.key)) throw new OfficeError(`${APP[f.app]} opens a file by its address only on Microsoft's own sites (SharePoint, OneDrive).`, 'not-allowed')
  await c.open(f.app, { kind: 'url', url: openAddress(f.key) })
  const ms = o.ms ?? OPEN_MS
  const every = o.every ?? EVERY_MS
  const sleep = o.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)))
  for (let waited = 0; waited < ms; waited += every) {
    await sleep(every)
    const key = await openKeyOf(c, f)
    if (key) return key
  }
  throw new OfficeError(`${APP[f.app]} did not open the file by its address within ${Math.round(ms / 1000)} s.`, 'not-running')
}

/** What a read of the synced copy says first: it is not the live file. */
export const BEHIND = "Read from OneDrive's synced copy, not the live file: it may be behind what is open in Word on the web now."

/** Where a file named by its address may be read on disk: its synced copies, the VM's only where the thread may use it. */
export function syncedCopies(libraries: readonly TeamsLibrary[], url: string, vm: boolean): { library: TeamsLibrary; path: string }[] {
  return syncedFilesOf(libraries, url).filter((s) => vm || !s.library.vm)
}

/** The Teams libraries on the hosts the thread may reach, as each lists them now. */
async function reachableLibraries(ctx: ToolCtx, carrier: Deps): Promise<TeamsLibrary[]> {
  const libraries: TeamsLibrary[] = []
  await Promise.all(
    reachableHosts(ctx).map(async (host) => {
      try {
        libraries.push(...((await on(ctx, carrier, host, 'filesLibraries', { cached: true })) as TeamsLibrariesAnswer).libraries)
      } catch {
        // a host that does not answer holds no library we can name
      }
    })
  )
  return libraries
}

/**
 * Whether the thread may have Word in the VM open a file by its address: only a file in a library it may reach (any
 * host's, the VM's included), never any address the VM's Office account could open.
 */
export async function mayOpenAddress(ctx: ToolCtx, carrier: Deps, url: string): Promise<boolean> {
  return syncedFilesOf(await reachableLibraries(ctx, carrier), url).length > 0
}

/**
 * A file named by its address read from a synced copy on a host the thread may reach (`teams_read`'s own verb), for a
 * read no Office could answer. Null when no library there holds it, or none of its copies could be read.
 */
export async function readSynced(ctx: ToolCtx, carrier: Deps, url: string, vm: boolean): Promise<{ text: string; truncated: boolean } | null> {
  for (const copy of syncedCopies(await reachableLibraries(ctx, carrier), url, vm)) {
    try {
      const host = copy.library.host
      return (await on(ctx, carrier, host, 'filesRead', { source: { at: 'file', host, path: copy.path }, as: 'text' })) as { text: string; truncated: boolean }
    } catch {
      // the next copy
    }
  }
  return null
}
