import { z } from 'zod'
import { TELL_GROUPS, TellLevelSchema, type TellGroup, type TellLevel, type TellRow } from './work/tell'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The digest pillar's wire (docs/agents/work-digest.md): the ledger of what
 * Work told him on this host, the days it made a digest of, and the three
 * things he sets (the time, the zone his desktop is in, a level a group).
 * No method here tells: every source of news is on a host and calls
 * `ctx.tell`.
 */

/** "08:00": the wall time of the day's digest. */
export const DigestAtSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
/** '2026-11-23': a digest's day, on the wall clock of its zone. */
export const DigestDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const DigestLevelsSchema = z.partialRecord(z.enum(TELL_GROUPS), TellLevelSchema)

/** What he sets, a field each: the time, and each group's level. */
export type DigestField = 'at' | TellGroup
export const DIGEST_FIELDS: readonly DigestField[] = ['at', ...TELL_GROUPS]
/** When each field was last set (ms): fields never set are absent. */
export const DigestSetAtSchema = z.partialRecord(z.enum(['at', ...TELL_GROUPS]), z.number())

export const DigestRequestSchemas = [
  /** → DigestList: the days kept and their rows, newest first; `day`: that day's rows alone; `since`: rows told at or after it */
  request('work.digest.list', z.object({ day: DigestDaySchema.optional(), since: z.number().optional() })),
  /** → DigestSettings */
  request('work.digest.get', z.object({})),
  /**
   * → DigestSettings: the time and a level a group, on this host alone; a client writes it to every Work host it is linked to.
   * `setAt`: when each field in the write was set, for a write that brings a host to what another already holds: the host
   * stamps the field with that time, and leaves alone a field it holds a newer setting of. Absent: set now.
   */
  request('work.digest.set', z.object({ at: DigestAtSchema.optional(), levels: DigestLevelsSchema.optional(), setAt: DigestSetAtSchema.optional() })),
  /** → null: the zone of the desktop he is at; the host keeps the newest, so the digest follows the desktop he last used */
  request('work.digest.here', z.object({ zone: z.string().min(1).max(64) })),
  /** → null: he opened that day's digest; every window's notice of it goes */
  request('work.digest.seen', z.object({ day: DigestDaySchema }))
] as const

/** One day's digest on a host. */
export interface DigestDay {
  day: string
  madeAt: number
  /** when he opened it, anywhere; null: not yet */
  seenAt: number | null
  /** how many rows it was made of */
  count: number
}

export interface DigestList {
  days: DigestDay[]
  rows: TellRow[]
  /** rows that wait for the next digest */
  waiting: number
  /** the groups some module on this host lists a kind for */
  groups: TellGroup[]
}

export interface DigestSettings {
  at: string
  zone: string
  /** only the groups he changed; every other is 'clock' */
  levels: Partial<Record<TellGroup, TellLevel>>
  /** when the next digest is due */
  nextAt: number
  /**
   * When each field was last set on this host: `at` and a group each; a field never set is absent. Hosts are written
   * alike, and a field one of them missed is brought to the newest setting of it, field by field.
   */
  setAt?: Partial<Record<DigestField, number>>
}

/** A day was made or seen, a row was told or replaced, a row went (its id), or the settings changed. */
export type DigestPush = { push: 'work.digest'; day?: DigestDay; row?: TellRow; gone?: string; settings?: DigestSettings }

export const DIGEST_CAPS = {
  'work.digest.list': 'read',
  'work.digest.get': 'read',
  'work.digest.set': 'admin',
  'work.digest.here': 'operate',
  'work.digest.seen': 'operate'
} satisfies CapsOf<typeof DigestRequestSchemas>
export const DIGEST_RELAY = {} satisfies RelayOf<typeof DigestRequestSchemas>
