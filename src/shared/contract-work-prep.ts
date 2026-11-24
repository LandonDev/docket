import { z } from 'zod'
import { CanvasSourceSchema, ContextChipSchema, type CanvasSource, type ContextChip } from './work/canvas'
import type { SectorKey } from './work/ids'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The prep pillar's wire (docs/agents/work-prep.md): a page for one meeting.
 * Before it, who is coming, the last mail with each, the open tasks that
 * touch them or the subject, the files in play and what was agreed last
 * time; after it, his notes turned into tasks he ticks and a follow-up mail
 * that waits for his press.
 *
 * A page belongs to one LifeOS event in one Work workspace, on the
 * workspace's host. Its facts are read from LifeOS with no model; a Work
 * thread writes the part that needs judgement through the pillar's tools.
 * Nothing here sends: the follow-up mail is LifeOS's own held draft.
 */

export const PREP_LINE_MAX = 200
export const PREP_MATTERS_MAX = 5
export const PREP_LINES_MAX = 12
export const PREP_PEOPLE_MAX = 40
/** How many people a page draws; the rest are counted. */
export const PREP_PEOPLE_DRAWN = 12
export const PREP_NOTES_MAX = 60_000
export const PREP_TASKS_MAX = 20
/** How many of an outcome's writing threads a page remembers, for their follow-up mail. */
export const PREP_WRITERS_MAX = 6
/** How many dismissed suggestions an outcome remembers past the ones it still lists. */
export const PREP_DISMISSED_MAX = 100
/** The longest span `work.prep.upcoming` reads in one call. */
export const PREP_UPCOMING_MAX_MS = 31 * 86_400_000

/** One thing said on a page, and the LifeOS row it is about when there is one: a press opens it. */
export const PrepLineSchema = z.object({
  text: z.string().trim().min(1).max(PREP_LINE_MAX),
  ref: z.object({ table: z.enum(['mailThreads', 'tasks', 'events', 'docs', 'people']), id: z.string().min(1).max(200) }).optional()
})
export type PrepLine = z.infer<typeof PrepLineSchema>

/** A file in play: a chip opens where a sent chip opens, a url opens outside. */
export const PrepFileRefSchema = z.object({
  title: z.string().trim().min(1).max(200),
  chip: ContextChipSchema.optional(),
  url: z.string().url().max(2000).optional()
})
export interface PrepFileRef {
  title: string
  chip?: ContextChip
  url?: string
}

/** Someone he or the thread added beside the event's own attendees; kept for the series. */
export const PrepAddedPersonSchema = z.object({
  address: z.string().trim().toLowerCase().email().max(320).optional(),
  name: z.string().trim().min(1).max(200),
  /** the LifeOS person, when they are one of the sector's people */
  personId: z.string().min(1).max(200).optional()
})
export type PrepAddedPerson = z.infer<typeof PrepAddedPersonSchema>

/** A task the follow-up yielded: a suggestion until he ticks it, then a LifeOS task. */
export const PrepSuggestionSchema = z.object({
  id: z.string().min(1).max(32),
  title: z.string().trim().min(1).max(300),
  /** who it falls to, as the notes said */
  who: z.string().trim().max(120).optional(),
  due: z.number().optional(),
  quote: z.string().trim().max(400).optional(),
  state: z.enum(['proposed', 'filed', 'rejected']),
  lifeosTaskId: z.string().optional(),
  /** a filing was asked and LifeOS did not answer it: it may have made the task, under this suggestion's key */
  tried: z.boolean().optional()
})
export type PrepSuggestion = z.infer<typeof PrepSuggestionSchema>

/** What a page keeps: the people added, the brief a thread wrote, his notes and what came of them. */
export const PrepDocSchema = z.object({
  people: z.array(PrepAddedPersonSchema).max(PREP_PEOPLE_MAX),
  brief: z
    .object({
      matters: z.array(PrepLineSchema).max(PREP_MATTERS_MAX),
      agreed: z.array(PrepLineSchema).max(PREP_LINES_MAX),
      files: z.array(PrepFileRefSchema).max(PREP_LINES_MAX),
      at: z.number(),
      /** the thread that wrote it */
      by: z.string()
    })
    .nullable(),
  notes: z
    .object({
      text: z.string().max(PREP_NOTES_MAX),
      at: z.number(),
      /** a recording, a transcript or a document that holds the notes */
      file: CanvasSourceSchema.optional(),
      meetingItemId: z.string().optional()
    })
    .nullable(),
  after: z
    .object({
      summary: z.array(PrepLineSchema).max(PREP_LINES_MAX),
      decisions: z.array(PrepLineSchema).max(PREP_LINES_MAX),
      questions: z.array(PrepLineSchema).max(PREP_LINES_MAX),
      tasks: z.array(PrepSuggestionSchema).max(PREP_TASKS_MAX),
      at: z.number(),
      /**
       * The threads that wrote it, oldest first, the newest six: a follow-up mail any of them drafted stays on the
       * page when a later follow-up rewrites the outcome. (One id alone in a page written before the list.)
       */
      by: z.preprocess((v) => (typeof v === 'string' ? [v] : v), z.array(z.string()).max(PREP_WRITERS_MAX)).optional(),
      /** the folded titles of suggestions he dismissed that a rewrite left out: suggested again, they stay dismissed */
      dismissed: z.array(z.string().max(300)).max(PREP_DISMISSED_MAX).optional(),
      /**
       * Suggestions a filing was asked for with no answer (`tried`) that a rewrite left out: suggested again
       * unchanged, each comes back with its id, so its filing key, and a second filing finds the task LifeOS made.
       */
      unanswered: z.array(PrepSuggestionSchema).max(PREP_TASKS_MAX).optional()
    })
    .nullable()
})
export interface PrepDoc {
  people: PrepAddedPerson[]
  brief: { matters: PrepLine[]; agreed: PrepLine[]; files: PrepFileRef[]; at: number; by: string } | null
  notes: { text: string; at: number; file?: CanvasSource; meetingItemId?: string } | null
  after: { summary: PrepLine[]; decisions: PrepLine[]; questions: PrepLine[]; tasks: PrepSuggestion[]; at: number; by?: string[]; dismissed?: string[]; unanswered?: PrepSuggestion[] } | null
}
export const emptyPrepDoc = (): PrepDoc => ({ people: [], brief: null, notes: null, after: null })

/**
 * How ready a page is. `after`: notes or an outcome stand. `briefed`: a
 * brief stands. `working`: a brief thread was started a short while ago and
 * has not written yet (the host bounds it by time; the window knows the
 * thread's own status). `none`: facts only.
 */
export type PrepState = 'none' | 'working' | 'briefed' | 'after'

/** How long after its start a brief thread that has not written still counts as working. */
export const PREP_WORKING_MS = 20 * 60_000

/**
 * When a meeting is over: its end; when the calendar gave none, an hour after its start, or the next midnight for
 * one that lasts the day. The one rule for the page's verb and Agenda's row verb, so the two never disagree.
 */
export function prepEndOf(event: { startsAt: number; endsAt?: number | null; allDay?: boolean }): number {
  if (event.endsAt !== undefined && event.endsAt !== null) return event.endsAt
  if (!event.allDay) return event.startsAt + 3_600_000
  // The next local midnight, as Agenda ends an all-day event: a day is 23 or 25 hours when the clocks change.
  const d = new Date(event.startsAt)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

/**
 * A name or a title as two pages share it: case, Latin accents and punctuation aside. Letters, digits and the marks
 * of any script are kept (a Devanagari vowel sign is a mark, and tells two names apart). The one fold for the host's
 * keys and the window's, so the two never disagree on who is who.
 */
export const prepFold = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()

export function prepStateOf(page: { doc: PrepDoc; briefSessionId: string | null; briefAt: number | null }, now: number): PrepState {
  if (page.doc.notes || page.doc.after) return 'after'
  if (page.doc.brief) return 'briefed'
  if (page.briefSessionId && page.briefAt !== null && now - page.briefAt < PREP_WORKING_MS) return 'working'
  return 'none'
}

export interface PrepEvent {
  id: string
  title: string
  startsAt: number
  endsAt?: number
  allDay: boolean
  location?: string
  /** when to leave for it, as LifeOS (or, once it is built, the clashes pillar) worked out */
  leaveAt?: number
}

/** Someone on the meeting: an attendee of the event or a person added to the page. */
export interface PrepPerson {
  name: string
  address?: string
  /** the LifeOS person, only when they are one of this sector's people */
  personId?: string
  /** added to the page, not on the event itself */
  added?: boolean
  /** true only for an attendee who declined the invite */
  declined?: boolean
  /** their newest mail thread in this sector */
  mail?: { id: string; subject: string; at: number; unread: boolean }
}

/** An open task that touches the meeting: one a person on it asked for or is waited on for, or one that names its subject. */
export interface PrepTask {
  id: string
  title: string
  dueAt?: number
  /** why it is here; absent: its title matches the meeting's subject */
  why?: 'asked' | 'waiting'
  /** the person `why` is about */
  who?: string
}

/** The page before this one: the same series, or the same title with a shared person. */
export interface PrepLast {
  eventId: string
  title: string
  startsAt: number
  decided: PrepLine[]
  open: PrepLine[]
  /** tasks it filed that are still open */
  tasks: PrepTask[]
}

/** The follow-up mail a page's thread drafted and LifeOS holds: shown, never sent, from here. */
export interface PrepDraft {
  outboxId: string
  subject: string
  to: string[]
}

export interface PrepNotesFile {
  kind: 'meeting' | 'document'
  title: string
  itemId?: string
  /**
   * A recording this host could not read (no transcriber, a file it cannot parse): why, in the meeting's own words.
   * On a document, the recording kept beside it could not be read; the document is still the notes.
   */
  error?: string
  /** a document's own file, so the window can open it before any thread holds it */
  source?: CanvasSource
}

/** A part of the page that did not load; the rest still shows. */
export type PrepProblem = 'people' | 'tasks' | 'last' | 'drafts'

export interface PrepPage {
  workspaceId: string
  sector: SectorKey
  event: PrepEvent
  people: PrepPerson[]
  /** people past the ones drawn */
  morePeople: number
  /** the address of everyone the calendar itself lists, drawn or not: none of them is his to add */
  invited: string[]
  tasks: PrepTask[]
  files: PrepFileRef[]
  last: PrepLast | null
  doc: PrepDoc
  /** 0 until something is kept */
  rev: number
  state: PrepState
  briefSessionId: string | null
  followSessionId: string | null
  /**
   * Until when the brief thread, and the follow-up thread, still count as at work for a reader that cannot see the
   * thread itself: started, nothing written since, and `PREP_WORKING_MS` not yet up. Null: not at work.
   */
  briefUntil: number | null
  followUntil: number | null
  /** When each thread was started; a brief or an outcome written since is that run's, so the run no longer counts as at work. */
  briefStartedAt: number | null
  followStartedAt: number | null
  drafts: PrepDraft[]
  /**
   * The file that holds the notes, when one does: a recording or transcript (a meeting open beside the
   * follow-up thread) or a document made from the job's Meeting notes template. `itemId` is its item
   * beside the follow-up thread, once there is one.
   */
  notesFile: PrepNotesFile | null
  /** Prepare ahead is on for this workspace */
  aheadOn: boolean
  /** false for a sector Prepare ahead is withheld from */
  aheadOffered: boolean
  problems: PrepProblem[]
}

/** A meeting that is coming, and how ready its page is: Today's mark and the digest's notice read this. */
export interface PrepUpcoming {
  workspaceId: string
  sector: SectorKey
  eventId: string
  title: string
  startsAt: number
  endsAt: number
  /** up to three names of the others on it */
  with: string[]
  state: PrepState
}

export interface PrepAhead {
  on: boolean
  offered: boolean
  routineId?: string
}

const workspaceId = z.string().min(1).max(64)
const eventId = z.string().min(1).max(200)
const page = { workspaceId, eventId }

export const PrepRequestSchemas = [
  /** → { page: PrepPage }: the meeting's facts, read from LifeOS now, and what the page keeps. Writes nothing. */
  request('work.prep.page', z.object(page)),
  /**
   * → { meetings: PrepUpcoming[] }: the timed events with someone else on them in this host's
   * linked Work workspaces, soonest first; at most 31 days a call.
   */
  request('work.prep.upcoming', z.object({ from: z.number(), to: z.number() })),
  /** Sets the people added to the page, kept for the series. → { page } */
  request('work.prep.people', z.object({ ...page, people: z.array(PrepAddedPersonSchema).max(PREP_PEOPLE_MAX) })),
  /**
   * Starts the brief thread, or answers the one still working. `restart`: the window knows that thread has
   * stopped (the host cannot read a thread's status), so a new one starts whatever the clock says. → { sessionId }
   */
  request('work.prep.brief', z.object({ ...page, restart: z.boolean().optional() })),
  /**
   * Keeps his notes (empty text takes them back). A file that holds the notes stays beside the words, unless
   * `dropFile`: the window says a recording never arrived or could not be read, so it is no notes. With `itemId`
   * (the meeting its upload went to) only that meeting is let go, and only while the page still names it; the words
   * the host holds stay, since another window may have kept newer ones; and while the meetings pillar has the file
   * after all, nothing is let go. `base`: the words the dialog opened on; when the host holds other words by now (another
   * window kept them), nothing is written and the answer says `conflict`. → { page, conflict? }
   */
  request('work.prep.notes', z.object({ ...page, text: z.string().max(PREP_NOTES_MAX), dropFile: z.boolean().optional(), itemId: z.string().min(1).max(200).optional(), base: z.string().max(PREP_NOTES_MAX).optional() })),
  /**
   * Starts the follow-up thread from the notes, or answers the one still working. With `recording`
   * (a recording or a transcript he picked) the host opens an empty meeting beside the new thread and
   * answers its item: the window then puts the file there through the meetings pillar's own start, so
   * nothing of it leaves the thread's host. → { sessionId, itemId? }
   */
  request('work.prep.followUp', z.object({ ...page, restart: z.boolean().optional(), recording: z.object({ name: z.string().trim().min(1).max(300) }).optional() })),
  /**
   * Write in a document: makes the meeting's notes file from the job's Meeting notes template, in the
   * workspace's own folder, and keeps it as the page's notes; a second ask answers the same file. → { page, source, title }
   */
  request('work.prep.notesDoc', z.object({ ...page, today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })),
  /** Accept files suggested tasks in the workspace’s sector. Reject drops them. → { page, failed: { id, error }[] } */
  request('work.prep.decide', z.object({ ...page, taskIds: z.array(z.string().max(32)).min(1).max(PREP_TASKS_MAX), decision: z.enum(['accept', 'reject']) })),
  /** The workspace’s Prepare-ahead routine. A person with admin may set it. → PrepAhead */
  request('work.prep.ahead', z.object({ workspaceId, on: z.boolean().optional(), tz: z.string().min(1).max(64).optional() }))
] as const

/** A page changed: a screen reads it again when `rev` is past what it holds. */
export type PrepPush = { push: 'work.prep'; workspaceId: string; eventId: string; rev: number }

export const PREP_CAPS = {
  'work.prep.page': 'read',
  'work.prep.upcoming': 'read',
  'work.prep.people': 'operate',
  'work.prep.brief': 'operate',
  'work.prep.notes': 'operate',
  'work.prep.followUp': 'operate',
  'work.prep.notesDoc': 'operate',
  'work.prep.decide': 'approve',
  'work.prep.ahead': 'read'
} satisfies CapsOf<typeof PrepRequestSchemas>
/** Every method is carried to the workspace's host, so the phone and a Mac window reach a page on the box. */
export const PREP_RELAY = {} satisfies RelayOf<typeof PrepRequestSchemas>
