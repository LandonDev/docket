import type { ReviewEvent } from '@shared/work/review'
import type { LifeosClient } from '../../lifeos/ctx'
import { personName, text, type Asked } from './common'

/**
 * The calendar, from LifeOS `events:range`: every sector's events that touch the span. LifeOS lists by when an event
 * starts, so the read begins a day early and keeps what still ran into the span. Whether an event counts is the
 * shared rule's (`countedSpan`); this only says what LifeOS holds.
 */

type EventDoc = {
  _id: string
  sector: string
  title?: string
  startsAt: number
  endsAt?: number
  allDay?: boolean
  hidden?: boolean
  attendees?: { address: string; name?: string; response?: string }[]
  myResponse?: string
}

const DAY = 24 * 60 * 60_000
const NAMED = 8
const ADDRESSES = 20

/** His own addresses, lower case: an event's other people are the attendees that are not one of these. */
export async function ownAddresses(owner: LifeosClient): Promise<Set<string>> {
  const accounts = await owner.query<{ address?: string; identities?: { address?: string }[] }[]>('mail:accounts', {})
  const out = new Set<string>()
  for (const a of accounts ?? []) {
    if (a.address) out.add(a.address.toLowerCase())
    for (const i of a.identities ?? []) if (i.address) out.add(i.address.toLowerCase())
  }
  return out
}

export function toEvent(doc: EventDoc, self: ReadonlySet<string>): ReviewEvent {
  const others = (doc.attendees ?? []).filter((a) => a.address && !self.has(a.address.toLowerCase()))
  return {
    id: doc._id,
    sector: doc.sector,
    title: text(doc.title) || 'An event',
    startsAt: doc.startsAt,
    endsAt: doc.endsAt ?? null,
    allDay: !!doc.allDay,
    declined: doc.myResponse === 'declined',
    hidden: !!doc.hidden,
    people: others.slice(0, NAMED).map(personName),
    others: others.length,
    addresses: others.slice(0, ADDRESSES).map((a) => a.address.toLowerCase().slice(0, 320))
  }
}

/** One event by id; null when LifeOS no longer has it. */
export async function eventById(owner: LifeosClient, id: string, self: ReadonlySet<string>, asked: Pick<Asked, 'only'>): Promise<ReviewEvent | null> {
  const doc = await owner.query<EventDoc | null>('events:get', { id }).catch(() => null)
  if (!doc || (asked.only !== undefined && doc.sector !== asked.only)) return null
  return toEvent(doc, self)
}

/** The events that touch `[from, to)`, soonest first. */
export async function eventsBetween(owner: LifeosClient, from: number, to: number, self: ReadonlySet<string>, asked: Pick<Asked, 'only'>): Promise<ReviewEvent[]> {
  const docs = await owner.query<EventDoc[]>('events:range', { from: from - DAY, to })
  return (docs ?? [])
    .filter((d) => (d.endsAt ?? d.startsAt) > from && (asked.only === undefined || d.sector === asked.only))
    .map((d) => toEvent(d, self))
}
