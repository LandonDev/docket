import { z } from 'zod'
import { HeldRefSchema, type HeldRef } from './acts'
import type { HostId, SectorKey } from './ids'

/**
 * The one way Work tells him something (docs/agents/work-digest.md). A
 * pillar says what happened, which job it is about, where a press goes and,
 * only when it is true, the time after which it is too late (`by`). It
 * never says loud or quiet: the digest's rule decides whether the tell
 * interrupts or waits for the day's one notice.
 *
 * Wire-safe. A file the first paint loads takes these with `import type`.
 */

export const TELL_GROUPS = ['held', 'ending', 'meetings', 'clashes', 'results', 'people', 'review', 'system'] as const
export type TellGroup = (typeof TELL_GROUPS)[number]
export const TellGroupSchema = z.enum(TELL_GROUPS)

/** Listed once on a module's `tells`; `name` is what Settings and the list call it. */
export interface TellKind {
  kind: string
  group: TellGroup
  name: string
}

/** Where a press on a tell goes. */
export type TellOpen =
  | { thread: string }
  /** `openWorkView`'s own shape */
  | { view: string; workspaceId: string; at?: string }
  /** a page above the workspaces (`shell.openWorkPlace`) */
  | { place: string; at?: string }
  /** a held item in the Outbox; `thread`: the thread that made it, when one did */
  | { held: HeldRef; thread?: string }
  /** a Settings section: 'connections', 'work' */
  | { settings: string }
export const TellOpenSchema: z.ZodType<TellOpen> = z.union([
  z.object({ thread: z.string().min(1) }).strict(),
  z.object({ view: z.string().min(1), workspaceId: z.string().min(1), at: z.string().optional() }).strict(),
  z.object({ place: z.string().min(1), at: z.string().optional() }).strict(),
  z.object({ held: HeldRefSchema, thread: z.string().min(1).optional() }).strict(),
  z.object({ settings: z.string().min(1) }).strict()
])

export interface Tell {
  /** '<pillar>.<what>', one of the caller's `tells` */
  kind: string
  /** the job; null: no one job */
  workspaceId: string | null
  /** one plain line in his words; no path, command or URL */
  title: string
  /** one muted line */
  detail?: string
  open?: TellOpen
  /** ms. Only when he alone can unblock it and it is too late after this */
  by?: number
  /** the same key replaces the same row */
  key?: string
}

/** How a row stands: it waits for the next digest, it is in a day's digest, or he was told at once. */
export type TellHow = 'waiting' | 'digest' | 'now'

/** A tell as its host keeps it. */
export interface TellRow extends Tell {
  id: string
  host: HostId
  group: TellGroup
  sector: SectorKey | null
  at: number
  how: TellHow
  /** the digest it is in ('2026-11-23'); null: none yet */
  day: string | null
  /** when he was told at once; null: never */
  toldAt: number | null
}

export const TITLE_MAX = 200
export const DETAIL_MAX = 300

/** How loud a group is: only in the digest, at once when its clock cannot wait, or always at once. */
export const TELL_LEVELS = ['digest', 'clock', 'now'] as const
export type TellLevel = (typeof TELL_LEVELS)[number]
export const TellLevelSchema = z.enum(TELL_LEVELS)

/** One line, cut: what a tell's title and detail are held to. */
export const tellLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * What a notice with no thread is about (remote/notifier.ts `work`): the
 * day's digest, or a tell that cannot wait. `key` is what a newer notice of
 * the same thing replaces on the phone. `tell` is the row's key (its id
 * when it has none), the same on every host that tells the same thing.
 */
export type NoticeWork = { key: string; digest: string } | { key: string; tell: string; by?: number; open?: TellOpen }
export const NoticeWorkSchema: z.ZodType<NoticeWork> = z.union([
  z.object({ key: z.string().min(1).max(200), digest: z.string().min(1).max(40) }).strict(),
  z.object({ key: z.string().min(1).max(200), tell: z.string().min(1).max(400), by: z.number().optional(), open: TellOpenSchema.optional() }).strict()
])
