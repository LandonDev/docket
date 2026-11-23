import { z } from 'zod'
import { CanvasSourceSchema, type CanvasKind, type CanvasSource } from './work/canvas'
import { ENTRY_KINDS, extsOfKind, kindOfEntry, placeKey, type EntryKind } from './work/files'
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
  /** what the app waits on him for, in words, when it is known to answer nothing until he answers a prompt of the system's (macOS asking whether it may open OneDrive's files) */
  waiting?: string
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
  /** it lies in the Windows VM this host keeps (docs/agents/work-teams-files.md "The Windows VM"): its path is the guest's, and a read wakes the VM */
  vm?: true
}

/**
 * One place a host's Teams files come from, and what stands between it and him: OneDrive's folders on
 * the host itself (`folders`, a Mac or a PC), or OneDrive in the Windows VM the host keeps (`vm`).
 * The Files view's empty state and Connections say each one's `state`:
 *  - `ok`: signed in, its libraries listed (a sleeping VM's from the last time it was awake);
 *  - `no-onedrive`: no OneDrive folder on this host (not installed, or never signed in);
 *  - `signed-out`: OneDrive in the VM is not signed in: `work.office.vmSignIn`, then his approval;
 *  - `no-libraries`: signed in, his own files only: no Teams library is synced there yet;
 *  - `not-set-up`: the Windows VM is not set up on this host (Settings → Work);
 *  - `error`: it could not be asked; `detail` says why (for the VM, also an awake machine whose helper did not answer its last read);
 *  - `reading`: the VM has never been read and its first read is under way: `work.office.files` is pushed when it ends.
 */
export const TEAMS_PLACE_STATES = ['ok', 'no-onedrive', 'signed-out', 'no-libraries', 'not-set-up', 'error', 'reading'] as const
export type TeamsPlaceState = (typeof TEAMS_PLACE_STATES)[number]
export interface TeamsPlace {
  kind: 'folders' | 'vm'
  state: TeamsPlaceState
  /** who OneDrive is signed in as, where the place says */
  account: string | null
  detail?: string
}

/** What `work.office.filesLibraries` answers. `places` is absent from a host on an older build. */
export interface TeamsLibrariesAnswer {
  host: string
  libraries: TeamsLibrary[]
  roots: TeamsRoot[]
  off: string[]
  places?: TeamsPlace[]
}

/** What `work.office.vmSignIn` answers: the computer whose Take over shows the sign-in, and the address it was opened for. */
export interface VmSignInAnswer {
  computer: 'vm:windows'
  account: string | null
  /** what is on the VM's screen now, in words for the row */
  line: string
  /** the number for his phone, when the walk reached it and the page names it (the line says it too) */
  number?: string
}

/**
 * Office and OneDrive in the Windows VM this host keeps, as last read while it was awake (`at`; null: never
 * read, and then `office` is null too). Reading it never wakes the VM. `account`: who Office is signed in as;
 * `licensed`: whether that sign-in gave it a licence (null: Office did not say).
 */
export interface VmOfficeStatus {
  office: { installed: boolean; version: string | null; apps: OfficeApp[]; account: string | null; licensed: boolean | null } | null
  onedrive: TeamsPlace
  at: number | null
}

/** One place two machines may both hold: a team or site and a folder or library of it, as either OneDrive layout names it ("RecWell-TeamRecWell" on a Mac is "RecWell" + "Team RecWell" under Windows). */
export const teamsPlaceKey = placeKey

/** A library the Windows VM should sync, by the ids its own Sync button would send (OneDrive's `odopen://sync` link). */
export const VmSyncLibrarySchema = z.object({
  siteId: z.string().uuid(),
  webId: z.string().uuid(),
  listId: z.string().uuid(),
  webUrl: z.string().max(2048).regex(/^https:\/\/[^\s]+$/i),
  webTitle: z.string().min(1).max(200),
  listTitle: z.string().min(1).max(200)
})
export type VmSyncLibrary = z.infer<typeof VmSyncLibrarySchema>

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

/** The Files grammar's kinds (src/shared/work/files.ts, the one table of file types) in the words the Teams tools have always used. */
const TEAMS_KIND: Record<EntryKind, TeamsFileKind> = { folder: 'folder', document: 'document', sheet: 'workbook', deck: 'deck', pdf: 'pdf', picture: 'picture', video: 'video', audio: 'audio', text: 'text', archive: 'other', other: 'other' }

/** The extensions of a kind, and every extension that has one: the guest's search filters by them. */
export const teamsExtsOf = (kind: TeamsFileKind): string[] => ENTRY_KINDS.filter((k) => TEAMS_KIND[k] === kind && k !== 'archive').flatMap((k) => extsOfKind(k))
export const teamsKnownExts = (): string[] => ENTRY_KINDS.filter((k) => TEAMS_KIND[k] !== 'other').flatMap((k) => extsOfKind(k))

/** A file's kind from its name. */
export const teamsKindOf = (name: string): TeamsFileKind => TEAMS_KIND[kindOfEntry(name).kind]

/** The Office app behind a kind, if one is. */
export const teamsAppOf = (kind: TeamsFileKind, name = ''): 'excel' | 'word' | 'powerpoint' | null =>
  kind === 'workbook' && !/\.(csv|tsv)$/i.test(name) ? 'excel' : kind === 'document' ? 'word' : kind === 'deck' ? 'powerpoint' : null

/**
 * The canvas item a file opens as on `host`: a workbook with real Excel behind it, a Word file or deck
 * through its app, a PDF, a picture or video; null for a kind no canvas shows. `copy`: the file is a
 * copy in a thread's attachments, so it opens as the file it is.
 */
export function teamsCanvasOf(entry: Pick<TeamsEntry, 'name' | 'path' | 'kind'>, host: string, copy = false): { kind: CanvasKind; source: CanvasSource } | null {
  if (entry.kind === 'folder') return null
  // An Office file in place has its app behind it, whatever its form (an old `.xls` as much as an `.xlsx`).
  const app = teamsAppOf(entry.kind, entry.name)
  if (app && !copy) return { kind: APP_CANVAS[app], source: { at: 'microsoft', host, app, name: entry.name, ref: { kind: 'path', path: entry.path } } }
  // Else the one table says which canvas kind opens the name (`kindOfEntry`). Two of its answers are not for a thread
  // here: the `file` kind's items are the Files pane's alone until a thread has their tools, and a library's sound is
  // played, not transcribed as a meeting; both open in their own app.
  const { kind: what, canvas } = kindOfEntry(entry.name)
  if (!canvas || canvas === 'file' || what === 'audio') return null
  return { kind: canvas, source: { at: 'file', host, path: entry.path } }
}
const APP_CANVAS = { excel: 'sheet', word: 'document', powerpoint: 'slides' } as const

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
  /**
   * A deck in desktop PowerPoint on the computer its file is on, and PowerPoint's own slideshow from the first slide:
   * the Present menu's "In PowerPoint". → { presented: true }. With `check`, opens nothing and answers { can }: whether
   * it can here (PowerPoint there, and the place proven). His press alone: a thread is refused.
   */
  request('work.office.present', z.object({ source: CanvasSourceSchema, check: z.boolean().optional() })),
  /** a short code for pairing our Office add-in with this host, good for five minutes (the owner's, never an agent's) */
  request('work.office.addin.pair', z.object({})),
  /** the add-ins paired with this host, and which are connected now */
  request('work.office.addin.list', z.object({})),
  /** forgets an add-in's key and closes it */
  request('work.office.addin.remove', z.object({ id: z.string().max(64) })),
  /** the Teams and SharePoint libraries synced on this host, and his edits to that list (Teams files, docs/agents/work-teams-files.md) */
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
  request('work.office.filesCopy', z.object({ sessionId: z.string().max(200), source: CanvasSourceSchema })),
  /** → { threads: {sessionId, itemId, source}[] }: the threads of a Work workspace here whose open items show this file, newest first */
  request('work.office.filesThreads', z.object({ workspaceId: z.string().max(200), source: CanvasSourceSchema })),
  /**
   * Brings OneDrive's sign-in up on the Windows VM's screen with his address filled in, so that only his
   * approval is missing; answers `VmSignInAnswer`. He finishes it in a Take over of `vm:windows`. No agent
   * may call it (a model caller is refused), and nothing here types a password or a code.
   */
  request('work.office.vmSignIn', z.object({ account: z.string().max(320).optional() })),
  /** → VmOfficeStatus: Office and OneDrive in the Windows VM as last read; never wakes it */
  request('work.office.vmStatus', z.object({})),
  /**
   * The libraries OneDrive in the VM should sync, kept on this host and asked of OneDrive whenever it is signed
   * in and lacks one (files on demand: names only until a file is opened). → { wanted, mounted }. A person's alone.
   */
  request('work.office.vmSync', z.object({ libraries: z.array(VmSyncLibrarySchema).max(50) }))
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

/** A host's Teams files changed behind an answer it gave (the Windows VM read again): a Files view on screen asks that host again. */
export type OfficePush = { push: 'work.office.files' }

export const OFFICE_CAPS = {
  'work.office.status': 'read',
  'work.office.read': 'read',
  'work.office.write': 'operate',
  'work.office.switch': 'operate',
  'work.office.present': 'operate',
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
  'work.office.filesCopy': 'operate',
  'work.office.filesThreads': 'read',
  'work.office.vmSignIn': 'operate',
  'work.office.vmStatus': 'read',
  'work.office.vmSync': 'admin'
} satisfies CapsOf<typeof OfficeRequestSchemas>
export const OFFICE_RELAY = {} satisfies RelayOf<typeof OfficeRequestSchemas>
