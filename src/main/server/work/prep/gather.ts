import {
  emptyPrepDoc,
  PREP_PEOPLE_DRAWN,
  PREP_WORKING_MS,
  prepEndOf,
  prepStateOf,
  type PrepAddedPerson,
  type PrepDoc,
  type PrepDraft,
  type PrepFileRef,
  type PrepLast,
  type PrepPage,
  type PrepPerson,
  type PrepProblem,
  type PrepTask,
  type PrepUpcoming
} from '@shared/contract-work-prep'
import { errorText, type SectorKey } from '@shared/work'
import type { LifeosClient } from '../lifeos/ctx'
import { WORK_MODULES, type Caller, type WorkCtx } from '../modules'
import { aheadOf } from './ahead'
import { lastOf, linksIn, personKey, seriesOf, subjectWords, type SeriesPage } from './series'
import { PrepStore, type PageEvent, type PageRow } from './store'
import { linkedWorkspaces, sectorWord, workspaceSector } from './workspace'

/**
 * A meeting's facts, read from LifeOS with no model (docs/agents/work-prep.md
 * "The facts"). One gatherer serves the page, the tools and the first
 * message of a thread, so the three never disagree.
 *
 * It reads as the owner, whose session holds every sector, so the sector
 * fence is this file's own job: the event must be in the workspace's sector
 * or the read is refused, and every query that takes a sector gets the
 * workspace's. It is the only reader of LifeOS in the pillar.
 */

/** A LifeOS event as `events:get` and `events:range` answer it: the fields prep reads. */
export interface LifeEvent {
  _id: string
  sector: string
  title: string
  startsAt: number
  endsAt?: number
  allDay: boolean
  hidden?: boolean
  location?: string
  description?: string
  leaveAt?: number
  uid?: string
  attendees?: { address: string; name?: string; response?: string }[]
}

/** `people:page`'s answer, the fields prep reads. */
interface PersonPage {
  person: { _id: string; name: string }
  mail: { _id: string; subject: string; lastMessageAt: number; unread: boolean }[]
  tasks: { _id: string; title: string; status: string; dueAt?: number; relation: 'asked' | 'waiting' }[]
}

interface DraftRow {
  _id: string
  status: string
  sector?: string
  message: { subject: string; to: { name?: string; address: string }[] }
}

interface TaskDoc {
  _id: string
  sector: string
  title: string
  status: string
  dueAt?: number
}

const OPEN = new Set(['todo', 'doing', 'waiting'])
const TASKS_PER_PERSON = 4
const SUBJECT_TASKS = 5
const LAST_TASKS = 10

function owner(ctx: WorkCtx): LifeosClient {
  if (!ctx.lifeos.connected()) throw new Error('LifeOS is not connected on this computer.')
  return ctx.lifeos.owner()
}

/** The event, only when it is in the workspace's sector: the fence every prep read and write passes first. */
export async function eventOf(ctx: WorkCtx, sector: SectorKey, eventId: string): Promise<LifeEvent> {
  const event = await owner(ctx)
    .query<LifeEvent | null>('events:get', { id: eventId })
    .catch((err) => {
      // LifeOS answers a row it does not hold, or one outside the session's fence, as "not found".
      if (/not found/i.test(errorText(err))) return null
      throw err
    })
  if (!event) throw new Error('LifeOS has no such event.')
  if (event.sector !== sector) throw new Error(`That event is not in ${sectorWord(sector)}’s sector.`)
  return event
}

/** Everyone on a meeting, the event's attendees first, then the people added to its page, each once. */
export function peopleOf(event: Pick<LifeEvent, 'attendees'>, added: readonly PrepAddedPerson[]): PrepPerson[] {
  const seen = new Map<string, PrepPerson>()
  for (const a of event.attendees ?? []) {
    const address = a.address.trim().toLowerCase()
    if (!address || seen.has(address)) continue
    seen.set(address, { name: a.name?.trim() || address, address, ...(a.response === 'declined' ? { declined: true } : {}) })
  }
  for (const p of added) {
    const key = personKey(p)
    if (seen.has(key)) continue
    seen.set(key, { name: p.name, ...(p.address ? { address: p.address } : {}), ...(p.personId ? { personId: p.personId } : {}), added: true })
  }
  return [...seen.values()]
}

/** The event as a row keeps it. */
export function pageEventOf(event: LifeEvent, people: readonly PrepPerson[]): PageEvent {
  return { id: event._id, series: seriesOf(event), title: event.title, startsAt: event.startsAt, endsAt: event.endsAt ?? null, peopleKeys: people.map(personKey) }
}

/** The meeting as last time is looked for it: with the people it has itself, since an inherited person cannot be what two meetings share. */
function ownPage(event: LifeEvent, row: PageRow | null): SeriesPage {
  const own = pageEventOf(event, peopleOf(event, row?.doc.people ?? []))
  return { eventId: own.id, series: own.series, title: own.title, startsAt: own.startsAt, peopleKeys: own.peopleKeys }
}

/**
 * The page before this one and the people a page of this meeting has: its
 * own once it has a row, else last time's, so a new page of a series starts
 * with the people he added before.
 */
export function standing(store: PrepStore, workspaceId: string, event: LifeEvent): { row: PageRow | null; last: PageRow | null; added: PrepAddedPerson[] } {
  const row = store.get(workspaceId, event._id)
  const last = lastOf(ownPage(event, row), store.earlier(workspaceId, event.startsAt))
  return { row, last, added: row ? row.doc.people : (last?.doc.people ?? []) }
}

/** The doc a page's first write begins with: last time's added people, nothing else. */
export const startDoc = (last: PageRow | null): PrepDoc => ({ ...emptyPrepDoc(), people: last?.doc.people ?? [] })

function sameFile(a: PrepFileRef, b: PrepFileRef): boolean {
  if (a.url || b.url) return a.url === b.url
  return JSON.stringify(a.chip?.ref) === JSON.stringify(b.chip?.ref)
}

/** The files in play: the event's own links, then last time's, then the brief's, each once. */
export function filesOf(event: Pick<LifeEvent, 'description' | 'location'>, last: PageRow | null, doc: PrepDoc | null): PrepFileRef[] {
  const files: PrepFileRef[] = []
  for (const file of [...linksIn(event.description, event.location), ...(last?.doc.brief?.files ?? []), ...(doc?.brief?.files ?? [])]) {
    if (!files.some((f) => sameFile(f, file))) files.push(file)
  }
  return files
}

async function personFacts(client: LifeosClient, sector: SectorKey, person: PrepPerson): Promise<{ person: PrepPerson; tasks: PrepTask[] }> {
  let id = person.personId
  if (!id && person.address) id = (await client.query<{ _id: string } | null>('people:find', { email: person.address }))?._id
  // `people:page` answers only one of this sector's people: a person of another job stays a name and an address.
  const page = id ? await client.query<PersonPage | null>('people:page', { id, sector }) : null
  const { personId: _asked, ...bare } = person
  if (!page) return { person: bare, tasks: [] }
  const mail = page.mail[0]
  const name = person.added ? person.name : page.person.name || person.name
  return {
    person: { ...bare, name, personId: page.person._id, ...(mail ? { mail: { id: mail._id, subject: mail.subject, at: mail.lastMessageAt, unread: mail.unread } } : {}) },
    tasks: page.tasks
      .filter((t) => OPEN.has(t.status))
      .slice(0, TASKS_PER_PERSON)
      .map((t) => ({ id: t._id, title: t.title, ...(t.dueAt !== undefined ? { dueAt: t.dueAt } : {}), why: t.relation, who: name }))
  }
}

/**
 * What last time's page left: its decisions, what it left open, and the tasks it filed that are still open. A task
 * LifeOS no longer holds is simply not there; one whose read failed is `missed`, so the page can say that part did
 * not load and offer to read again, and what did load still shows.
 */
async function lastFacts(client: LifeosClient, sector: SectorKey, last: PageRow): Promise<{ last: PrepLast | null; missed: boolean }> {
  const filed = (last.doc.after?.tasks ?? []).filter((t) => t.state === 'filed' && t.lifeosTaskId).slice(0, LAST_TASKS)
  let missed = false
  const got = await Promise.all(
    filed.map((t) =>
      client.query<{ task: TaskDoc } | null>('tasks:get', { id: t.lifeosTaskId }).catch((err) => {
        if (!/not found/i.test(errorText(err))) missed = true
        return null
      })
    )
  )
  const tasks = got.flatMap((g): PrepTask[] => (g && g.task.sector === sector && OPEN.has(g.task.status) ? [{ id: g.task._id, title: g.task.title, ...(g.task.dueAt !== undefined ? { dueAt: g.task.dueAt } : {}) }] : []))
  const decided = last.doc.after?.decisions ?? []
  const open = last.doc.after?.questions ?? []
  if (!decided.length && !open.length && !tasks.length) return { last: null, missed }
  return { last: { eventId: last.eventId, title: last.title, startsAt: last.startsAt, decided, open, tasks }, missed }
}

async function draftsOf(client: LifeosClient, sector: SectorKey, threadId: string): Promise<PrepDraft[]> {
  const rows = await client.query<DraftRow[]>('compose:byOrigin', { threadId })
  return rows
    .filter((r) => r.status === 'draft' && (r.sector === undefined || r.sector === sector))
    .map((r) => ({ outboxId: r._id, subject: r.message.subject, to: r.message.to.map((p) => p.name?.trim() || p.address) }))
}

/** How a meeting item stands, asked of the meetings pillar's own `get`; null when it has no meeting or does not answer. */
export async function meetingOf(ctx: WorkCtx, itemId: string): Promise<{ status: string; error: string | null } | null> {
  try {
    const meetings = WORK_MODULES.find((m) => m.id === 'meetings')
    const answer = await meetings?.handle?.({ id: 'prep', method: 'work.meetings.get', params: { itemId } }, ctx, HOST)
    const meeting = answer?.handled ? (answer.result as { meeting?: { status?: string; error?: string | null } | null }).meeting : null
    return meeting?.status ? { status: meeting.status, error: meeting.error ?? null } : null
  } catch {
    return null
  }
}

/** The name a file path shows by. */
export const fileTitle = (path: string): string => path.split(/[\\/]/).pop() || path

/**
 * The file that holds the notes: the meeting beside the follow-up thread
 * while its item still exists, else the document made for the notes, with
 * its item beside that thread once the follow-up has opened it there.
 */
export async function notesFileOf(ctx: WorkCtx, notes: PrepDoc['notes'], followSessionId: string | null | undefined): Promise<PrepPage['notesFile']> {
  if (!notes) return null
  try {
    const item = notes.meetingItemId ? ctx.canvas.get(notes.meetingItemId) : null
    if (item?.kind === 'meeting') {
      // A recording this host could not read says so on the page: its transcription may fail long after the dialog closed.
      const meeting = await meetingOf(ctx, item.id)
      return { kind: 'meeting', itemId: item.id, title: item.title, ...(meeting?.status === 'failed' ? { error: meeting.error?.trim() || 'This host could not read it.' } : {}) }
    }
    const file = notes.file
    if (file?.at !== 'file') return null
    const held = followSessionId ? ctx.canvas.forSession(ctx.canvas.paneOf(followSessionId)).find((i) => i.kind === 'document' && i.source.at === 'file' && i.source.path === file.path) : undefined
    return { kind: 'document', title: fileTitle(file.path), source: file, ...(held ? { itemId: held.id } : {}) }
  } catch {
    // A host whose canvas is not running names no file; the notes' words still show.
    return null
  }
}

/** This host's own caller, for a read prep makes of another pillar. */
const HOST: Caller = { kind: 'local', caps: ['read'] }

/**
 * When to leave, as the clashes pillar works it out (from where he will be:
 * the event before, or the job's start place), once that pillar is on this
 * host; undefined when it is not, has nothing to say or does not answer, and
 * the event's own leave time stands. Asked only for an event that passed
 * prep's own sector fence.
 */
async function clashLeave(ctx: WorkCtx, eventId: string): Promise<number | undefined> {
  try {
    const clashes = WORK_MODULES.find((m) => m.id === 'clashes')
    if (!clashes?.handle) return undefined
    const answer = await clashes.handle({ id: 'prep', method: 'work.clashes.leave', params: { eventId } }, ctx, HOST)
    const leave = answer.handled ? (answer.result as { leaveAt?: unknown } | null) : null
    return typeof leave?.leaveAt === 'number' ? leave.leaveAt : undefined
  } catch {
    return undefined
  }
}

/** Until when a thread still counts as at work for a reader that cannot see it: started, nothing written since, the bound not yet up. */
function workingUntil(sessionId: string | null | undefined, startedAt: number | null | undefined, writtenAt: number | undefined, now: number): number | null {
  if (!sessionId || startedAt === null || startedAt === undefined) return null
  if (writtenAt !== undefined && writtenAt >= startedAt) return null
  const until = startedAt + PREP_WORKING_MS
  return until > now ? until : null
}

export interface Gathered {
  page: PrepPage
  event: LifeEvent
  row: PageRow | null
  last: PageRow | null
}

/**
 * Everything a page shows. A part that fails is left out and named in
 * `problems`; only the event itself, and the fence on it, fail the whole
 * read. Writes nothing.
 */
export async function gather(ctx: WorkCtx, workspaceId: string, eventId: string, now = Date.now()): Promise<Gathered> {
  const sector = workspaceSector(ctx, workspaceId)
  const client = owner(ctx)
  const event = await eventOf(ctx, sector, eventId)
  const store = new PrepStore(ctx.db)
  const { row, last, added } = standing(store, workspaceId, event)
  const doc = row?.doc ?? startDoc(last)
  const everyone = peopleOf(event, added)
  const drawn = everyone.slice(0, PREP_PEOPLE_DRAWN)
  const problems: PrepProblem[] = []
  const words = subjectWords(event.title)

  const [people, subject, before, drafts, ahead, leaveAt, notesFile] = await Promise.all([
    Promise.all(
      drawn.map((p) =>
        personFacts(client, sector, p).catch(() => {
          if (!problems.includes('people')) problems.push('people')
          const { personId: _asked, ...bare } = p
          return { person: bare, tasks: [] as PrepTask[] }
        })
      )
    ),
    words
      ? client.query<TaskDoc[]>('tasks:search', { text: words, sector }).catch(() => {
          problems.push('tasks')
          return [] as TaskDoc[]
        })
      : Promise.resolve([] as TaskDoc[]),
    last
      ? lastFacts(client, sector, last).then(
          (facts) => {
            if (facts.missed) problems.push('last')
            return facts.last
          },
          () => {
            problems.push('last')
            return null
          }
        )
      : Promise.resolve(null),
    row?.followSessionId
      ? draftsOf(client, sector, row.followSessionId).catch(() => {
          problems.push('drafts')
          return []
        })
      : Promise.resolve([]),
    aheadOf(ctx, workspaceId),
    clashLeave(ctx, event._id),
    notesFileOf(ctx, row?.doc.notes ?? null, row?.followSessionId)
  ])

  // A task this page filed shows under To do, and one last time's page filed shows under Last time: never a second row under Tasks.
  const filedHere = new Set([...(row?.doc.after?.tasks ?? []).flatMap((t) => (t.lifeosTaskId ? [t.lifeosTaskId] : [])), ...(before?.tasks ?? []).map((t) => t.id)])
  const tasks: PrepTask[] = []
  for (const task of people.flatMap((p) => p.tasks)) if (!filedHere.has(task.id) && !tasks.some((t) => t.id === task.id)) tasks.push(task)
  const bySubject = subject.filter((t) => t.sector === sector && OPEN.has(t.status) && !filedHere.has(t._id) && !tasks.some((x) => x.id === t._id)).slice(0, SUBJECT_TASKS)
  for (const t of bySubject) tasks.push({ id: t._id, title: t.title, ...(t.dueAt !== undefined ? { dueAt: t.dueAt } : {}) })

  const page: PrepPage = {
    workspaceId,
    sector,
    event: {
      id: event._id,
      title: event.title,
      startsAt: event.startsAt,
      ...(event.endsAt !== undefined ? { endsAt: event.endsAt } : {}),
      allDay: event.allDay,
      ...(event.location ? { location: event.location } : {}),
      // One leave time: the clashes pillar's when it has one, else LifeOS's own for the event.
      ...((leaveAt ?? event.leaveAt) !== undefined ? { leaveAt: leaveAt ?? event.leaveAt } : {})
    },
    people: people.map((p) => p.person),
    morePeople: everyone.length - drawn.length,
    invited: everyone.flatMap((p) => (!p.added && p.address ? [p.address] : [])),
    tasks,
    files: filesOf(event, last, row?.doc ?? null),
    last: before,
    doc,
    rev: row?.rev ?? 0,
    state: row ? prepStateOf(row, now) : 'none',
    briefSessionId: row?.briefSessionId ?? null,
    followSessionId: row?.followSessionId ?? null,
    drafts,
    notesFile,
    briefUntil: workingUntil(row?.briefSessionId, row?.briefAt, row?.doc.brief?.at, now),
    followUntil: workingUntil(row?.followSessionId, row?.followAt, row?.doc.after?.at, now),
    briefStartedAt: row?.briefSessionId ? row.briefAt : null,
    followStartedAt: row?.followSessionId ? row.followAt : null,
    aheadOn: ahead.on,
    aheadOffered: ahead.offered,
    problems
  }
  return { page, event, row, last }
}

/**
 * The timed meetings with someone else on them in this host's linked Work
 * workspaces, soonest first, each with how ready its page is. One read of
 * LifeOS and one of the pages: no query per person, so Today and the digest
 * may ask often.
 */
export async function upcoming(ctx: WorkCtx, from: number, to: number, now = Date.now(), scope?: { workspaceId: string; sector: SectorKey }): Promise<PrepUpcoming[]> {
  const workspaces = scope ? new Map([[scope.sector, scope.workspaceId]]) : linkedWorkspaces(ctx)
  if (!workspaces.size || to <= from) return []
  const events = await owner(ctx).query<LifeEvent[]>('events:range', { from, to, ...(scope ? { sector: scope.sector } : {}) })
  const store = new PrepStore(ctx.db)
  const pages = store.until([...workspaces.values()], to)
  const meetings: PrepUpcoming[] = []
  for (const event of events) {
    const workspaceId = workspaces.get(event.sector)
    if (!workspaceId || event.allDay || event.hidden) continue
    const mine = pages.filter((p) => p.workspaceId === workspaceId)
    const row = mine.find((p) => p.eventId === event._id) ?? null
    const added = row ? row.doc.people : (lastOf(ownPage(event, row), mine)?.doc.people ?? [])
    const people = peopleOf(event, added)
    if (!people.length) continue
    meetings.push({
      workspaceId,
      sector: event.sector,
      eventId: event._id,
      title: event.title,
      startsAt: event.startsAt,
      endsAt: prepEndOf(event),
      with: people.slice(0, 3).map((p) => p.name),
      state: row ? prepStateOf(row, now) : 'none'
    })
  }
  return meetings.sort((a, b) => a.startsAt - b.startsAt)
}
