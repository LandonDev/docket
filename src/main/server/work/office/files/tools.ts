import { join, relative } from 'node:path'
import { z } from 'zod'
import { TEAMS_FILE_KINDS, teamsAppOf, teamsCanvasOf, teamsKindOf, teamsPlaceKey, type TeamsEntry, type TeamsLibrariesAnswer, type TeamsLibrary } from '@shared/contract-work-office'
import type { ClientRequest } from '@shared/contract'
import { workText, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { ToolCtx, WorkTool } from '../../modules'
import type { OfficeCarrier } from '../carrier'
import { copyIn, filesHandle, type FilesDeps } from './handle'
import { copyAllowed } from './library'

/**
 * The Teams files tools (docs/agents/work-teams-files.md "The tools"). A thread reaches the libraries on
 * its own host and on each host its workspace may use ("Computer use on <Mac>"); a library's id
 * names its host, and every call runs there, inside that host's libraries. A library in the Windows
 * VM this host keeps is this host's (`vm`), read through the guest. Where a desktop and the VM hold
 * the same place, a thread is shown it once, and a call the one machine cannot answer goes to the
 * other (`twinOf`). Reading is all they do:
 * a change to a workbook, document or deck goes through the `office_*` tools on the file `teams_open`
 * answers, under their rule for a file others can open.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
const json = (v: unknown): WorkToolResult => workText(JSON.stringify(v, null, 1))
const APP_NAME = { excel: 'Excel', word: 'Word', powerpoint: 'PowerPoint' } as const

/** The hosts a thread may reach Teams files on: its own, then its workspace's desktops. */
export const reachableHosts = (ctx: ToolCtx): string[] => [...new Set([ctx.host, ...(ctx.scope.workspaceId ? ctx.settings.workspace(ctx.scope.workspaceId).mayUseDesktop : [])])]

/** Runs one `work.office.files*` verb on a host: here directly, else over the host link. */
type Deps = FilesDeps | (() => OfficeCarrier | null)

async function on(ctx: ToolCtx, carrier: Deps, host: string, verb: string, params: Record<string, unknown>): Promise<unknown> {
  if (host !== ctx.host) return ctx.peer(host).call('office', verb, params)
  const req = { id: 'tool', method: `work.office.${verb}`, params } as unknown as ClientRequest
  const answer = await filesHandle(req, ctx, { kind: 'model', caps: [], sessionId: ctx.sessionId }, carrier, ctx.signal)
  return answer.handled ? answer.result : null
}

const hostOfLibrary = (id: string): string => id.slice(0, Math.max(0, id.lastIndexOf('~')))

/** Every library on the hosts this thread may use; a host that does not answer is left out, and named in `failed`. */
async function allLibraries(ctx: ToolCtx, carrier: Deps): Promise<{ libraries: TeamsLibrary[]; failed: { host: string; error: string }[] }> {
  const libraries: TeamsLibrary[] = []
  const failed: { host: string; error: string }[] = []
  await Promise.all(
    reachableHosts(ctx).map(async (host) => {
      try {
        const got = ((await on(ctx, carrier, host, 'filesLibraries', {})) as TeamsLibrariesAnswer).libraries
        keep(got)
        libraries.push(...got)
      } catch (err) {
        failed.push({ host, error: errorText(err) })
      }
    })
  )
  return { libraries, failed }
}

async function libraryFor(ctx: ToolCtx, carrier: Deps, id: string): Promise<TeamsLibrary> {
  const host = hostOfLibrary(id)
  if (!reachableHosts(ctx).includes(host)) throw new Error('This workspace may not use the host that library is on (Work settings → Computer use).')
  const { libraries } = (await on(ctx, carrier, host, 'filesLibraries', {})) as TeamsLibrariesAnswer
  keep(libraries)
  const library = libraries.find((l) => l.id === id)
  if (!library) throw new Error(`No library ${id}: list them with teams_libraries.`)
  return library
}

/** A file's place in its library with forward slashes, whichever host's separator its path has. */
const placeIn = (library: TeamsLibrary, path: string): string =>
  library.vm ? path.slice(library.path.length).split('\\').filter(Boolean).join('/') : relative(library.path, path).split('\\').join('/')

/** An entry as a thread reads it: its place in the library, not the host's path. */
const shown = (library: TeamsLibrary, e: TeamsEntry) => ({
  file: placeIn(library, e.path),
  kind: e.kind,
  ...(e.kind === 'folder' ? {} : { size: e.size, downloaded: e.local }),
  modified: new Date(e.modified).toISOString(),
  ...(e.by ? { by: e.by } : {})
})

const pathIn = (library: TeamsLibrary, file = ''): string => {
  const parts = file.split('/').filter(Boolean)
  return library.vm ? [library.path, ...parts].join('\\') : parts.length ? join(library.path, ...parts) : library.path
}
const sourceIn = (library: TeamsLibrary, file = '') => ({ at: 'file' as const, host: library.host, path: pathIn(library, file) })
const nameOf = (file: string): string => file.split('/').filter(Boolean).pop() ?? file

/** The places a library holds, each by its key (`teamsPlaceKey`) and the folder in the library that is its top ('' for the library itself). */
function placesOf(l: TeamsLibrary): { key: string; top: string }[] {
  if (l.kind === 'folder') return []
  if (l.kind === 'mine') return [{ key: 'mine', top: '' }]
  if (l.kind === 'channels' && l.channels.length) return l.channels.map((c) => ({ key: teamsPlaceKey(l.team, c), top: c }))
  return [{ key: teamsPlaceKey(l.team, l.library ?? ''), top: '' }]
}

/**
 * The same file on another machine: a Mac syncs one folder of a site's library as a library of its own
 * (`RecWell-TeamRecWell`), the VM the whole library with that folder at its top (`RecWell - Documents\Team
 * RecWell`). Null when no other library holds the place `file` lies in.
 */
export function twinOf(all: readonly TeamsLibrary[], library: TeamsLibrary, file: string): { library: TeamsLibrary; file: string } | null {
  const parts = file.split('/').filter(Boolean)
  for (const place of placesOf(library)) {
    const top = place.top ? [place.top] : []
    if (top.length && parts[0]?.toLowerCase() !== top[0]!.toLowerCase()) continue
    const rest = parts.slice(top.length)
    for (const other of all) {
      if (other.id === library.id) continue
      const there = placesOf(other).find((p) => p.key === place.key)
      if (there) return { library: other, file: [...(there.top ? [there.top] : []), ...rest].join('/') }
    }
  }
  return null
}

/** Whether a failure says the machine could not be asked at all (asleep and not waking, link down, OneDrive not running), not that the file is wrong. */
const unreachable = (err: unknown): boolean =>
  /not answer|not reachable|unreachable|offline|not connected|link (to|dropped)|no links|bridge is off|in time|could not start|is asleep|not set up|OneDrive is not running|server closing/i.test(errorText(err))

/** Each library last listed, by id: a host that stops answering gives no list, and its library must still be known to find its twin. */
const known = new Map<string, TeamsLibrary>()
const keep = (libraries: readonly TeamsLibrary[]): void => {
  if (known.size > 2000) known.clear()
  for (const l of libraries) known.set(l.id, l)
}

/** Runs `fn` on the library named; if its machine cannot be asked and another holds the same place, there instead. */
async function withTwin<T>(ctx: ToolCtx, carrier: Deps, id: string, file: string, fn: (library: TeamsLibrary, file: string) => Promise<T>): Promise<T> {
  let library: TeamsLibrary | null = null
  try {
    library = await libraryFor(ctx, carrier, id)
    return await fn(library, file)
  } catch (err) {
    if (!unreachable(err)) throw err
    const { libraries } = await allLibraries(ctx, carrier).catch(() => ({ libraries: [] as TeamsLibrary[] }))
    // A host that did not answer gave no list now: its library is as it was last listed.
    library ??= known.get(id) ?? null
    const twin = library ? twinOf(libraries, library, file) : null
    if (!twin) throw err
    return fn(twin.library, twin.file)
  }
}

const Library = z.string().max(200).describe('A library id from teams_libraries.')
const File = z.string().max(4096).describe("The file's place in its library, as teams_list and teams_search answer it (General/Budget.xlsx).")

export function teamsTools(carrier: Deps): WorkTool[] {
  const tool = <S extends z.ZodRawShape>(t: { name: string; description: string; input: S; readOnly: boolean; run(a: z.infer<z.ZodObject<S>>, ctx: ToolCtx): Promise<WorkToolResult> }): WorkTool => ({
    name: t.name,
    description: t.description,
    input: z.object(t.input),
    readOnly: t.readOnly,
    async run(args, ctx) {
      const parsed = z.object(t.input).safeParse(args ?? {})
      if (!parsed.success) return fail(`The arguments do not fit ${t.name}: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
      try {
        return await t.run(parsed.data, ctx as ToolCtx)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  })
  return [
    tool({
      name: 'teams_libraries',
      description:
        "Lists the Teams and SharePoint libraries synced on the hosts this thread may use: each library's id, its team (or site), the library's own name when it is not the team's Documents, and the channels (a team's top folders).",
      input: {},
      readOnly: true,
      async run(_a, ctx) {
        const { libraries, failed } = await allLibraries(ctx, carrier)
        // The VM lists a site's whole library; a desktop's library that is one folder of it is that same place, shown once.
        const inVm = new Set(libraries.filter((l) => l.vm).flatMap((l) => placesOf(l).map((p) => p.key)))
        const once = libraries.filter((l) => l.vm || !placesOf(l).some((p) => inVm.has(p.key)))
        const out: unknown[] = [
          ...once.map((l) => ({ id: l.id, team: l.team, ...(l.library ? { library: l.library } : {}), kind: l.kind, ...(l.channels.length ? { channels: l.channels } : {}), host: l.host, ...(l.vm ? { in: 'the Windows VM' } : {}) })),
          ...failed
        ]
        return out.length ? json(out) : workText('No Teams libraries are synced on the computers this thread may use. The owner syncs a channel from Teams (Files → Sync) with OneDrive on his Mac, or signs in to OneDrive on the Windows VM.')
      }
    }),
    tool({
      name: 'teams_list',
      description: 'Lists one folder of a library: folders first, then files, each with its kind, size, when it changed, who last saved it (when the file says) and whether it is downloaded.',
      input: { library: Library, folder: File.optional().describe('A folder in the library; absent: its top.') },
      readOnly: true,
      async run(a, ctx) {
        return withTwin(ctx, carrier, a.library, a.folder ?? '', async (library, folder) => {
          const { entries } = (await on(ctx, carrier, library.host, 'filesList', { source: sourceIn(library, folder) })) as { entries: TeamsEntry[] }
          // Named as the thread named the folder's library: a twin's entries keep their place below the folder asked for.
          const base = (a.folder ?? '').split('/').filter(Boolean)
          const under = folder.split('/').filter(Boolean).length
          return json(entries.map((e) => ({ ...shown(library, e), file: [...base, ...placeIn(library, e.path).split('/').slice(under)].join('/') })))
        })
      }
    }),
    tool({
      name: 'teams_search',
      description: 'Finds files and folders whose names hold every word of `query`, newest first, in one library or all of them.',
      input: { query: z.string().min(1).max(200), library: Library.optional(), kind: z.enum(TEAMS_FILE_KINDS).optional() },
      readOnly: true,
      async run(a, ctx) {
        const hosts = a.library ? [hostOfLibrary(a.library)] : reachableHosts(ctx)
        const found: unknown[] = []
        const seen = new Set<string>()
        for (const host of hosts) {
          if (!reachableHosts(ctx).includes(host)) return fail('This workspace may not use the host that library is on.')
          let libraries: TeamsLibrary[]
          let got: { entries: TeamsEntry[]; more: boolean }
          try {
            libraries = ((await on(ctx, carrier, host, 'filesLibraries', {})) as TeamsLibrariesAnswer).libraries
            got = (await on(ctx, carrier, host, 'filesSearch', { query: a.query, ...(a.library ? { library: a.library } : {}), ...(a.kind ? { kind: a.kind } : {}) })) as { entries: TeamsEntry[]; more: boolean }
          } catch (err) {
            // One machine not answering does not hide what the others found.
            if (a.library || hosts.length === 1) throw err
            found.push({ host, error: errorText(err) })
            continue
          }
          for (const e of got.entries) {
            const library = libraries.find((l) => l.id === e.library)
            if (!library) continue
            // The same file on two machines is one hit: the first to answer names it.
            const place = placesOf(library).find((p) => !p.top || placeIn(library, e.path).toLowerCase().startsWith(`${p.top.toLowerCase()}/`) || placeIn(library, e.path).toLowerCase() === p.top.toLowerCase())
            const key = place ? `${place.key}\u0000${placeIn(library, e.path).split('/').slice(place.top ? 1 : 0).join('/').toLowerCase()}` : null
            if (key && seen.has(key)) continue
            if (key) seen.add(key)
            found.push({ library: library.id, ...shown(library, e) })
          }
          if (got.more) found.push({ host, more: 'There are more: name the library or add a word.' })
        }
        return json(found)
      }
    }),
    tool({
      name: 'teams_read',
      description: "Reads a file's text: a Word file's paragraphs, a deck's slides in order, a text or CSV file as it is. A workbook is read through Excel (teams_open, then office_range_read). Reading downloads a file OneDrive keeps in the cloud.",
      input: { library: Library, file: File },
      readOnly: true,
      async run(a, ctx) {
        return withTwin(ctx, carrier, a.library, a.file, async (library, file) => {
          const got = (await on(ctx, carrier, library.host, 'filesRead', { source: sourceIn(library, file), as: 'text' })) as { text: string; truncated: boolean }
          return workText(got.truncated ? `${got.text}\n\n(cut: the file goes on)` : got.text)
        })
      }
    }),
    tool({
      name: 'teams_open',
      description:
        "Opens a file for the owner to see. On this thread's own host it opens in the canvas beside the thread (a workbook with Excel behind it, a Word file, a deck, a PDF, a picture or video) and an Office file in its app too; on another host it opens in its app there. Answers the `key` the office tools take: a change to the file goes through them, and since others can open a Teams file, only a change he asked for in so many words is written.",
      input: { library: Library, file: File },
      readOnly: false,
      async run(a, ctx) {
        return withTwin(ctx, carrier, a.library, a.file, async (library, file) => {
          const source = sourceIn(library, file)
          const name = nameOf(file)
          const app = teamsAppOf(teamsKindOf(name), name)
          const where = library.vm ? ' in the Windows VM' : library.host === ctx.host ? '' : ` on ${library.host}`
          const appLine = app ? `It is open in ${APP_NAME[app]}${where}; its key for the office tools is ${JSON.stringify(source.path)}.` : ''
          // A file on this host's own disk opens as it lies; one in the VM or on another host only from a copy he allowed.
          const here = library.host === ctx.host && !library.vm
          if (here || (ctx.scope.workspaceId && copyAllowed(ctx.db, ctx.scope.workspaceId))) {
            // The canvas reads the file's bytes: here OneDrive downloads it first; a copy is made of the downloaded file.
            const entry = here ? ((await on(ctx, carrier, library.host, 'filesFetch', { source })) as { entry: TeamsEntry }).entry : (await copyIn(ctx, ctx.sessionId, source, ctx.signal)).entry
            const at = teamsCanvasOf({ ...entry, kind: teamsKindOf(name) }, ctx.host, !here)
            if (app || !at) await on(ctx, carrier, library.host, 'filesOpen', { source })
            if (at) {
              const item = ctx.canvas.open(ctx.canvas.paneOf(ctx.sessionId), at.kind, at.source, name)
              return workText([`Opened ${name} in the canvas (${item.id})${here ? '' : ', from a copy on this host: a change goes to the original through the office tools'}.`, appLine].filter(Boolean).join(' '))
            }
            return workText(app ? appLine : `Opened ${name} in its app${where}.`)
          }
          // Its app downloads the file itself: nothing is fetched for it here.
          await on(ctx, carrier, library.host, 'filesOpen', { source })
          return workText(`${app ? appLine : `Opened ${name} in its app${where}.`} It stays ${library.vm ? 'in the VM' : 'on that host'}: this workspace does not copy Teams files, so it does not open in this thread's canvas.`)
        })
      }
    })
  ]
}
