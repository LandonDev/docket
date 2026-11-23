import { z } from 'zod'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The clashes pillar's wire (docs/agents/work-clashes.md): clashes across
 * every job, read from LifeOS as the owner, when to leave for an event, the
 * miles between two stops, and his own answer to a clash. The shapes the
 * answers take are in `src/shared/work/clashes.ts`.
 */

const at = z.number().int().nonnegative()
const id = z.string().min(1).max(200)

export const ClashStopSchema = z.union([z.object({ event: id }), z.object({ place: z.string().min(1).max(500) }), z.object({ start: z.literal(true) })])

export const ClashesRequestSchemas = [
  /** → ClashList: every job's clashes over the span, and when to leave for each event in it */
  request('work.clashes.list', z.object({ from: at, to: at })),
  /** → ClashLeave | null: when to leave for one event, from where he will be */
  request('work.clashes.leave', z.object({ eventId: id })),
  /** → ClashMiles | null: the drive between two stops, for the workspace's job; null when a stop has no point on the map */
  request('work.clashes.miles', z.object({ workspaceId: z.string().min(1), from: ClashStopSchema, to: ClashStopSchema })),
  /** → null: on, the clash is fine and goes quiet until either event's time or place changes; off takes that back */
  request('work.clashes.waive', z.object({ id, on: z.boolean() })),
  /**
   * → ClashAnswered (`{queued}`): his own answer to one event of a clash, sent at once as his press: a decline, a proposed time, or a move.
   * `queued` says a calendar's act is with LifeOS's sender and not yet on the calendar; a move of an event that lives in LifeOS is written and done.
   * Never a thread's: an agent drafts the same act with its held tools and it waits in the Outbox.
   */
  request(
    'work.clashes.answer',
    z.object({ eventId: id, way: z.enum(['decline', 'propose', 'move']), comment: z.string().max(2000).optional(), start: at.optional(), end: at.optional() })
  )
] as const

/** `work.clashes.leave`'s answer. */
export interface ClashLeave {
  leaveAt: number
  minutes?: number
  miles?: number
  from: 'start' | 'event'
  fromTitle?: string
  measured: boolean
}

/** `work.clashes.miles`'s answer: `measured` false is the straight-line floor, not a mile driven. */
export interface ClashMiles {
  miles: number
  minutes: number
  measured: boolean
}

/** The clash list changed: ask `work.clashes.list` again. */
export type ClashesPush = { push: 'work.clashes' }

export const CLASHES_CAPS = {
  'work.clashes.list': 'read',
  'work.clashes.leave': 'read',
  'work.clashes.miles': 'read',
  'work.clashes.waive': 'operate',
  'work.clashes.answer': 'approve'
} satisfies CapsOf<typeof ClashesRequestSchemas>
export const CLASHES_RELAY = {} satisfies RelayOf<typeof ClashesRequestSchemas>
