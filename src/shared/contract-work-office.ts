import { z } from 'zod'
import { CanvasSourceSchema, type CanvasKind, type CanvasSource } from './work/canvas'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The office pillar's wire (docs/agents/work-office.md). Its methods are
 * `work.office.<verb>` and its push `work.office.sheet`; src/shared/work/wire.ts
 * has the helpers and the rules.
 *
 * Agents reach Office through tools (`office_*`), carried out on the host
 * that has the app. A thread on another host reaches them through
 * `ctx.peer(host).call('office', 'read' | 'write', {tool, args})`, which
 * runs the same tool here: `read` only for a tool that changes nothing,
 * `write` for the rest. A tool that sends mail or books a meeting answers a
 * held act on this host whichever way it is called: nothing reaches anyone
 * without the owner's press.
 */

export const OFFICE_APPS = ['excel', 'word', 'powerpoint', 'outlook'] as const
export type OfficeApp = (typeof OFFICE_APPS)[number]

/** Whether this host may drive an app: `yes`, `no` (refused in System Settings), `ask` (needs his one click), `unknown` (not running, so macOS will not say). */
export type OfficeAllowed = 'yes' | 'no' | 'ask' | 'unknown'

export interface OfficeAppState {
  app: OfficeApp
  installed: boolean
  running: boolean
  allowed: OfficeAllowed
}

/** What this host can carry out: `mac` by osascript, `owa` by Outlook on the web in the box's browser (mail and calendar only), `com` by COM on Windows (tc-office.exe), `addin` by our Office add-in alone (milestone 29), null where no carrier runs. */
export interface OfficeStatus {
  carrier: 'mac' | 'owa' | 'com' | 'fake' | 'addin' | null
  apps: OfficeAppState[]
  /** the Outlook addresses this host reports to LifeOS's local route, and when it last did */
  route: { accounts: string[]; beatAt: number | null; error: string | null }
}

/** One cell in a range as the Office tools pass it: a formula is a string that starts with `=`. */
export type OfficeCell = string | number | boolean | null
export const OfficeCellSchema = z.union([z.string().max(32_000), z.number(), z.boolean(), z.null()])

/** What a file is, as the Files view and the tools say it. */
export const TEAMS_FILE_KINDS = ['folder', 'workbook', 'document', 'deck', 'pdf', 'picture', 'video', 'audio', 'text', 'other'] as const
export type TeamsFileKind = (typeof TEAMS_FILE_KINDS)[number]

/** His edit to one folder of the list: one he added, a found one turned off, or its web address (a channel's Files → Copy link). */
export interface TeamsRoot {
  folder: string
  off?: boolean
  web?: string
}
export const TeamsRootSchema = z.object({
  folder: z.string().min(1).max(4096),
  off: z.boolean().optional(),
  web: z.string().max(4096).regex(/^https:\/\/[^\s]+$/i, 'an https address').optional()
})

/**
 * One synced library. `team` is the site or team, `library` the library's own name when it is not the
 * team's Documents (whose top folders are its channels), `channels` those folder names.
 */
export interface TeamsLibrary {
  /** `<host>~<hash of the path>`: unique across hosts */
  id: string
  host: string
  path: string
  team: string
  library: string | null
  /** the tenant OneDrive names (Purdue University), when the folder says it */
  tenant: string | null
  /** `mine`: his own OneDrive; `channels`: a team's Documents; `library`: another library; `folder`: one he added */
  kind: 'mine' | 'channels' | 'library' | 'folder'
  channels: string[]
  web: string | null
  /** found under ~/Library/CloudStorage, not added by him */
  found: boolean
}

/** One file or folder. `local`: its bytes are on this disk (false: OneDrive keeps it in the cloud until it is opened). `by`: who last saved it, when the file says. */
export interface TeamsEntry {
  name: string
  path: string
  library: string
  kind: TeamsFileKind
  size: number
  modified: number
  local: boolean
  by: string | null
}

const EXT_KIND: Record<string, TeamsFileKind> = {}
for (const [kind, exts] of [
  ['workbook', 'xlsx xlsm xlsb xls csv'],
  ['document', 'docx docm doc rtf odt'],
  ['deck', 'pptx pptm ppt odp'],
  ['pdf', 'pdf'],
  ['picture', 'png jpg jpeg gif webp avif heic heif tif tiff bmp svg'],
  ['video', 'mp4 m4v mov webm mkv avi'],
  ['audio', 'mp3 m4a wav aac flac ogg'],
  ['text', 'txt md markdown json xml html htm log tsv yaml yml']
] as const)
  for (const ext of exts.split(' ')) EXT_KIND[ext] = kind

/** A file's kind from its name. */
export function teamsKindOf(name: string): TeamsFileKind {
  const dot = name.lastIndexOf('.')
  return (dot > 0 && EXT_KIND[name.slice(dot + 1).toLowerCase()]) || 'other'
}

/** The Office app behind a kind, if one is. */
export const teamsAppOf = (kind: TeamsFileKind, name = ''): 'excel' | 'word' | 'powerpoint' | null =>
  kind === 'workbook' && !/\.csv$/i.test(name) ? 'excel' : kind === 'document' ? 'word' : kind === 'deck' ? 'powerpoint' : null

/**
 * The canvas item a file opens as on `host`: a workbook with real Excel behind it, a Word file or deck
 * through its app, a PDF, a picture or video; null for a kind no canvas shows. `copy`: the file is a
 * copy in a thread's attachments, so it opens as the file it is.
 */
export function teamsCanvasOf(entry: Pick<TeamsEntry, 'name' | 'path' | 'kind'>, host: string, copy = false): { kind: CanvasKind; source: CanvasSource } | null {
  const file: CanvasSource = { at: 'file', host, path: entry.path }
  const app = teamsAppOf(entry.kind, entry.name)
  const of = { workbook: 'sheet', document: 'document', deck: 'slides', pdf: 'pdf', picture: 'media', video: 'media' } as const
  const kind = (of as Record<string, CanvasKind | undefined>)[entry.kind]
  if (!kind || (entry.kind === 'workbook' && !app)) return null
  if (app && !copy) return { kind, source: { at: 'microsoft', host, app, name: entry.name, ref: { kind: 'path', path: entry.path } } }
  return { kind, source: file }
}

/** A file's address on the web: the library's address (his paste) and the file's place in it. */
export function teamsWebOf(library: Pick<TeamsLibrary, 'path' | 'web'>, path: string): string | null {
  if (!library.web) return null
  const rel = path.slice(library.path.length).split(/[\\/]/).filter(Boolean)
  return [library.web.replace(/\/+$/, ''), ...rel.map(encodeURIComponent)].join('/')
}

const ToolCall = z.object({ tool: z.string().regex(/^office_[a-z_]+$/), args: z.unknown() })

export const OfficeRequestSchemas = [
  request('work.office.status', z.object({})),
  /** a tool that changes nothing, run on this host for a thread elsewhere */
  request('work.office.read', ToolCall),
  /** any other tool; `asked`: the calling host found the owner's words for this change; `by`: the calling thread, as a principal */
  request('work.office.write', ToolCall.extend({ asked: z.boolean().default(false), by: z.string().regex(/^agent:[^:]+:.+$/).optional() })),
  /** brings the app forward with the file: the switch for a Microsoft file */
  request('work.office.switch', z.object({ source: CanvasSourceSchema })),
  /** a short code for pairing our Office add-in with this host, good for five minutes (the owner's, never an agent's) */
  request('work.office.addin.pair', z.object({})),
  /** the add-ins paired with this host, and which are connected now */
  request('work.office.addin.list', z.object({})),
  /** forgets an add-in's key and closes it */
  request('work.office.addin.remove', z.object({ id: z.string().max(64) })),
  /** the Teams and SharePoint libraries synced on this host, and his edits to that list (Teams files, docs/agents/work-files.md) */
  request('work.office.filesLibraries', z.object({})),
  /** one folder of a library: `source` is `{at: 'file'}` on this host */
  request('work.office.filesList', z.object({ source: CanvasSourceSchema })),
  /** files and folders whose names hold every word of `query`, in one library or all */
  request('work.office.filesSearch', z.object({ query: z.string().min(1).max(200), library: z.string().max(200).optional(), kind: z.enum(TEAMS_FILE_KINDS).optional() })),
  /** downloads a file OneDrive keeps in the cloud only, and answers it as it is now */
  request('work.office.filesFetch', z.object({ source: CanvasSourceSchema })),
  /** a file's text (`text`), or its bytes as base64 (`bytes`, for a copy he allowed) */
  request('work.office.filesRead', z.object({ source: CanvasSourceSchema, as: z.enum(['text', 'bytes']).default('text') })),
  /** opens a file in its own app on this host (Excel, Word, PowerPoint, Preview) */
  request('work.office.filesOpen', z.object({ source: CanvasSourceSchema })),
  /** his edits to the list, from this computer's own window only: a folder added, a found one turned off, a folder's web address */
  request('work.office.filesSetRoots', z.object({ roots: z.array(TeamsRootSchema).max(100) })),
  /** whether a Work workspace on this host may copy Teams files from another host to here (off by default) */
  request('work.office.filesCopyGet', z.object({ workspaceId: z.string().max(200) })),
  request('work.office.filesCopySet', z.object({ workspaceId: z.string().max(200), on: z.boolean() })),
  /** copies a file from the host `source` names into this thread's attachments here, when its workspace allows it; answers the copy's source */
  request('work.office.filesCopy', z.object({ sessionId: z.string().max(200), source: CanvasSourceSchema }))
] as const

/** A pairing code as TempCode shows it. */
export interface OfficeAddinCode {
  code: string
  expiresAt: number
}

/** A paired add-in: `app` is excel, word or powerpoint; `live` while it is connected. */
export interface OfficeAddinKey {
  id: string
  name: string
  app: string
  createdAt: number
  seenAt: number | null
  live: boolean
}

export type OfficePush = never

export const OFFICE_CAPS = {
  'work.office.status': 'read',
  'work.office.read': 'read',
  'work.office.write': 'operate',
  'work.office.switch': 'operate',
  'work.office.addin.pair': 'operate',
  'work.office.addin.list': 'read',
  'work.office.addin.remove': 'operate',
  'work.office.filesLibraries': 'read',
  'work.office.filesList': 'read',
  'work.office.filesSearch': 'read',
  'work.office.filesFetch': 'read',
  'work.office.filesRead': 'read',
  'work.office.filesOpen': 'operate',
  'work.office.filesSetRoots': 'local',
  'work.office.filesCopyGet': 'read',
  'work.office.filesCopySet': 'admin',
  'work.office.filesCopy': 'operate'
} satisfies CapsOf<typeof OfficeRequestSchemas>
export const OFFICE_RELAY = {} satisfies RelayOf<typeof OfficeRequestSchemas>
