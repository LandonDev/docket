import { join, relative } from 'node:path'
import { z } from 'zod'
import { TEAMS_FILE_KINDS, teamsAppOf, teamsCanvasOf, type TeamsEntry, type TeamsLibrary } from '@shared/contract-work-office'
import type { ClientRequest } from '@shared/contract'
import { workText, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { ToolCtx, WorkTool } from '../../modules'
import type { OfficeCarrier } from '../carrier'
import { copyIn, filesHandle } from './handle'
import { copyAllowed } from './library'

/**
 * The Teams files tools (docs/agents/work-files.md "The tools"). A thread reaches the libraries on
 * its own host and on each host its workspace may use ("Computer use on <Mac>"); a library's id
 * names its host, and every call runs there, inside that host's libraries. Reading is all they do:
 * a change to a workbook, document or deck goes through the `office_*` tools on the file `teams_open`
 * answers, under their rule for a file others can open.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
const json = (v: unknown): WorkToolResult => workText(JSON.stringify(v, null, 1))
const APP_NAME = { excel: 'Excel', word: 'Word', powerpoint: 'PowerPoint' } as const

/** The hosts a thread may reach Teams files on: its own, then its workspace's desktops. */
export const reachableHosts = (ctx: ToolCtx): string[] => [...new Set([ctx.host, ...(ctx.scope.workspaceId ? ctx.settings.workspace(ctx.scope.workspaceId).mayUseDesktop : [])])]

/** Runs one `work.office.files*` verb on a host: here directly, else over the host link. */
async function on(ctx: ToolCtx, carrier: () => OfficeCarrier | null, host: string, verb: string, params: Record<string, unknown>): Promise<unknown> {
  if (host !== ctx.host) return ctx.peer(host).call('office', verb, params)
  const req = { id: 'tool', method: `work.office.${verb}`, params } as unknown as ClientRequest
  const answer = await filesHandle(req, ctx, { kind: 'model', caps: [], sessionId: ctx.sessionId }, carrier, ctx.signal)
  return answer.handled ? answer.result : null
}

const hostOfLibrary = (id: string): string => id.slice(0, Math.max(0, id.lastIndexOf('~')))

async function libraryFor(ctx: ToolCtx, carrier: () => OfficeCarrier | null, id: string): Promise<TeamsLibrary> {
  const host = hostOfLibrary(id)
  if (!reachableHosts(ctx).includes(host)) throw new Error('This workspace may not use the host that library is on (Work settings → Computer use).')
  const { libraries } = (await on(ctx, carrier, host, 'filesLibraries', {})) as { libraries: TeamsLibrary[] }
  const library = libraries.find((l) => l.id === id)
  if (!library) throw new Error(`No library ${id}: list them with teams_libraries.`)
  return library
}

/** An entry as a thread reads it: its place in the library, not the host's path. */
const shown = (library: TeamsLibrary, e: TeamsEntry) => ({
  file: relative(library.path, e.path).split('\\').join('/'),
  kind: e.kind,
  ...(e.kind === 'folder' ? {} : { size: e.size, downloaded: e.local }),
  modified: new Date(e.modified).toISOString(),
  ...(e.by ? { by: e.by } : {})
})

const sourceIn = (library: TeamsLibrary, file = '') => ({ at: 'file' as const, host: library.host, path: file ? join(library.path, ...file.split('/')) : library.path })

const Library = z.string().max(200).describe('A library id from teams_libraries.')
const File = z.string().max(4096).describe("The file's place in its library, as teams_list and teams_search answer it (General/Budget.xlsx).")

export function teamsTools(carrier: () => OfficeCarrier | null): WorkTool[] {
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
        const out: unknown[] = []
        for (const host of reachableHosts(ctx)) {
          try {
            const { libraries } = (await on(ctx, carrier, host, 'filesLibraries', {})) as { libraries: TeamsLibrary[] }
            out.push(...libraries.map((l) => ({ id: l.id, team: l.team, ...(l.library ? { library: l.library } : {}), kind: l.kind, ...(l.channels.length ? { channels: l.channels } : {}), host })))
          } catch (err) {
            out.push({ host, error: errorText(err) })
          }
        }
        return out.length ? json(out) : workText('No Teams libraries are synced on the hosts this thread may use. The owner syncs a channel from Teams (Files → Sync) with OneDrive on his Mac.')
      }
    }),
    tool({
      name: 'teams_list',
      description: 'Lists one folder of a library: folders first, then files, each with its kind, size, when it changed, who last saved it (when the file says) and whether it is downloaded.',
      input: { library: Library, folder: File.optional().describe('A folder in the library; absent: its top.') },
      readOnly: true,
      async run(a, ctx) {
        const library = await libraryFor(ctx, carrier, a.library)
        const { entries } = (await on(ctx, carrier, library.host, 'filesList', { source: sourceIn(library, a.folder) })) as { entries: TeamsEntry[] }
        return json(entries.map((e) => shown(library, e)))
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
        for (const host of hosts) {
          if (!reachableHosts(ctx).includes(host)) return fail('This workspace may not use the host that library is on.')
          const { libraries } = (await on(ctx, carrier, host, 'filesLibraries', {})) as { libraries: TeamsLibrary[] }
          const { entries, more } = (await on(ctx, carrier, host, 'filesSearch', { query: a.query, ...(a.library ? { library: a.library } : {}), ...(a.kind ? { kind: a.kind } : {}) })) as { entries: TeamsEntry[]; more: boolean }
          for (const e of entries) {
            const library = libraries.find((l) => l.id === e.library)
            if (library) found.push({ library: library.id, ...shown(library, e) })
          }
          if (more) found.push({ host, more: 'There are more: name the library or add a word.' })
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
        const library = await libraryFor(ctx, carrier, a.library)
        const got = (await on(ctx, carrier, library.host, 'filesRead', { source: sourceIn(library, a.file), as: 'text' })) as { text: string; truncated: boolean }
        return workText(got.truncated ? `${got.text}\n\n(cut: the file goes on)` : got.text)
      }
    }),
    tool({
      name: 'teams_open',
      description:
        "Opens a file for the owner to see. On this thread's own host it opens in the canvas beside the thread (a workbook with Excel behind it, a Word file, a deck, a PDF, a picture or video) and an Office file in its app too; on another host it opens in its app there. Answers the `key` the office tools take: a change to the file goes through them, and since others can open a Teams file, only a change he asked for in so many words is written.",
      input: { library: Library, file: File },
      readOnly: false,
      async run(a, ctx) {
        const library = await libraryFor(ctx, carrier, a.library)
        const source = sourceIn(library, a.file)
        const { entry } = (await on(ctx, carrier, library.host, 'filesFetch', { source })) as { entry: TeamsEntry }
        const app = teamsAppOf(entry.kind, entry.name)
        const appLine = app ? `It is open in ${APP_NAME[app]}${library.host === ctx.host ? '' : ` on ${library.host}`}; its key for the office tools is ${JSON.stringify(entry.path)}.` : ''
        if (library.host === ctx.host || (ctx.scope.workspaceId && copyAllowed(ctx.db, ctx.scope.workspaceId))) {
          const copy = library.host === ctx.host ? null : await copyIn(ctx, ctx.sessionId, source, ctx.signal)
          const at = teamsCanvasOf(copy ? { ...copy.entry, kind: entry.kind } : entry, ctx.host, !!copy)
          if (app) await on(ctx, carrier, library.host, 'filesOpen', { source })
          if (at) {
            const item = ctx.canvas.open(ctx.canvas.paneOf(ctx.sessionId), at.kind, at.source, entry.name)
            return workText([`Opened ${entry.name} in the canvas (${item.id})${copy ? ', from a copy on this host' : ''}.`, appLine].filter(Boolean).join(' '))
          }
          if (!app) await on(ctx, carrier, library.host, 'filesOpen', { source })
          return workText(app ? appLine : `Opened ${entry.name} in its app.`)
        }
        await on(ctx, carrier, library.host, 'filesOpen', { source })
        return workText(`${app ? appLine : `Opened ${entry.name} in its app on ${library.host}.`} It stays on that host: this workspace does not copy Teams files, so it does not open in this thread's canvas.`)
      }
    })
  ]
}
