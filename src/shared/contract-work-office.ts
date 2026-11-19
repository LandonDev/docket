import { z } from 'zod'
import { CanvasSourceSchema } from './work/canvas'
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

/** What this host can carry out: `mac` by osascript, `addin` by our Office add-in alone (milestone 29), null where no carrier runs (Linux, Windows until milestone 44). */
export interface OfficeStatus {
  carrier: 'mac' | 'fake' | 'addin' | null
  apps: OfficeAppState[]
  /** the Outlook addresses this host reports to LifeOS's local route, and when it last did */
  route: { accounts: string[]; beatAt: number | null; error: string | null }
}

/** One cell in a range as the Office tools pass it: a formula is a string that starts with `=`. */
export type OfficeCell = string | number | boolean | null
export const OfficeCellSchema = z.union([z.string().max(32_000), z.number(), z.boolean(), z.null()])

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
  request('work.office.addin.remove', z.object({ id: z.string().max(64) }))
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
  'work.office.addin.remove': 'operate'
} satisfies CapsOf<typeof OfficeRequestSchemas>
export const OFFICE_RELAY = {} satisfies RelayOf<typeof OfficeRequestSchemas>
