import { z } from 'zod'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The google pillar's wire (docs/agents/work-google.md). Its methods are
 * `work.google.<verb>` and its push `work.google`; src/shared/work/wire.ts has
 * the helpers and the rules.
 *
 * Google Docs, Sheets and Slides through LifeOS's own Google client: the
 * Picker gives a file to TempCode (`drive.file`), and every call goes with a
 * short-lived token LifeOS's worker mints. A Doc opens in the document canvas
 * on a mirror read when it is opened; his edits there are written to Google
 * with `write`, an agent's wait on his host until he approves them (tools). A Sheet opens in
 * the sheet canvas through `work.sheets.*`.
 */

export const GOOGLE_KINDS = ['doc', 'sheet', 'slides'] as const
export type GoogleKind = (typeof GOOGLE_KINDS)[number]

const Account = z.string().trim().min(3).max(320)
const FileId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/, 'a Drive file id')

/** One of his Google accounts as LifeOS knows it: `files` once it allowed Drive files (M24's consent). */
export interface GoogleAccount {
  account: string
  files: boolean
}

export interface GoogleAccounts {
  accounts: GoogleAccount[]
  /** whether this host can show the Picker: it knows LifeOS's Google client id */
  picker: boolean
}

/** A file he picked. */
export interface GooglePicked {
  fileId: string
  name: string
  mime: string
  kind: GoogleKind | null
}

/** A Google file's state as an open item draws it. */
export interface GoogleFileState {
  /** Google moved since the item read it: Read again brings it in */
  behind: boolean
  /** his edits in a Doc's mirror not yet written to Google */
  unsent: number
  /** the file in Google's own editor */
  url: string | null
}

/** What `write` did. `refused`: one line per block it left, and why. */
export interface GoogleWritten {
  changed: number
  added: number
  removed: number
  refused: string[]
}

export const GoogleRequestSchemas = [
  /** his Google accounts, and whether this host can show the Picker (→ GoogleAccounts) */
  request('work.google.accounts', z.object({})),
  /** the desktop Picker in the system browser, as `account` (→ { files: GooglePicked[] }); only this machine's own window */
  request('work.google.pick', z.object({ account: Account, kinds: z.array(z.enum(GOOGLE_KINDS)).max(3).optional() })),
  /** opens a picked file as an item of the thread's canvas (→ { itemId }) */
  request('work.google.open', z.object({ sessionId: z.string().max(200), account: Account, fileId: FileId })),
  /** a Google item's state; an open window asks it each minute, which keeps the file's version poll running (→ GoogleFileState) */
  request('work.google.watch', z.object({ itemId: z.string().max(200) })),
  /** his edits in a Doc's mirror, written to Google in one batchUpdate (→ GoogleWritten) */
  request('work.google.write', z.object({ itemId: z.string().max(200) })),
  /** reads a Doc from Google again; `discard` drops edits not yet written (→ GoogleFileState) */
  request('work.google.reload', z.object({ itemId: z.string().max(200), discard: z.boolean().default(false) })),
  /** a document of ours as a new Google Doc in `account`'s Drive, its suggestions as Google's (→ { fileId, url }) */
  request('work.google.upload', z.object({ itemId: z.string().max(200), account: Account })),
  /** LifeOS's Google client id, which the Picker needs; the owner's, on this machine */
  request('work.google.setup', z.object({ clientId: z.string().trim().regex(/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/, "a Google client id (…apps.googleusercontent.com)") }))
] as const

/** A Google file an open item shows moved, or was written. */
export type GooglePush = { push: 'work.google'; sessionId: string; itemId: string; state: GoogleFileState }

export const GOOGLE_CAPS = {
  'work.google.accounts': 'read',
  'work.google.pick': 'local',
  'work.google.open': 'operate',
  'work.google.watch': 'read',
  'work.google.write': 'operate',
  'work.google.reload': 'operate',
  'work.google.upload': 'operate',
  'work.google.setup': 'local'
} satisfies CapsOf<typeof GoogleRequestSchemas>
export const GOOGLE_RELAY = {} satisfies RelayOf<typeof GoogleRequestSchemas>
