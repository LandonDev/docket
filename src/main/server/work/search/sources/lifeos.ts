import { mentionExcerpt, mentionMatches, type ContextChip } from '@shared/work'
import { refKey } from '@shared/work/files'
import { fileKey, lifeosKey, reachSectors, workspaceOfSector, type SearchHit, type SearchReach } from '@shared/work/search'
import type { WorkCtx } from '../../modules'
import { mirror } from '../mirror'
import type { SearchAsk, SearchSource } from '../source'
import { filesHoldLifeos } from './files'

/**
 * LifeOS's things for Work search (docs/agents/work-search.md "The
 * sources"): people, mail, tasks, events, documents and projects, on the
 * functions LifeOS already has. The host reads as the owner, so the reach
 * is the fence here: LifeOS is asked once for the whole reach where a
 * function allows it, and a row is kept only when a job in reach has its
 * sector. That job is the hit's.
 */

import { eventsWindow } from './window'

export { EVENTS_AHEAD_DAYS, EVENTS_BACK_DAYS, eventsWindow } from './window'

export type Person = { _id: string; name: string; notes?: string; sectors?: string[]; identities?: { kind?: string; value?: string; email?: string }[] }
export type MailThread = { _id: string; sector?: string; subject: string; snippet?: string; senders?: string[]; lastMessageAt?: number }
export type Task = { _id: string; sector?: string; title: string; description?: string; dueAt?: number; status?: string; key?: string }
export type Event = { _id: string; sector?: string; title: string; startsAt: number; location?: string; description?: string }
type Doc = { _id: string; sector?: string; title: string; editedAt?: number }
type Project = { _id: string; sector?: string; name: string; description?: string; status?: string }

const q = <T>(ctx: WorkCtx, fn: string, args: Record<string, unknown>): Promise<T> => ctx.lifeos.owner().query<T>(fn, args)
/** The one sector to ask LifeOS for, when the reach is one; otherwise ask for all and keep what is in reach. */
const asked = (sectors: readonly string[]): { sector?: string } => (sectors.length === 1 ? { sector: sectors[0] } : {})

/** One LifeOS kind: what to ask, the sectors a row is in, and the hit it becomes in its job. */
function source<T>(o: {
  kind: string
  label: string
  unranked?: boolean
  /** network unless said: a source the mirror feeds says so at each ask */
  tier?: SearchSource['tier']
  read(ctx: WorkCtx, ask: SearchAsk, sectors: string[]): Promise<T[]>
  sectors(row: T): readonly (string | undefined)[]
  hit(row: T, workspaceId: string, text: string): SearchHit
}): SearchSource {
  return {
    kind: o.kind,
    label: o.label,
    tier: o.tier ?? 'network',
    lifeos: true,
    ...(o.unranked ? { unranked: true } : {}),
    async search(ask, ctx) {
      const sectors = reachSectors(ask.reach)
      if (sectors.length === 0) return []
      const out: SearchHit[] = []
      const seen = new Set<string>()
      for (const row of (await o.read(ctx, ask, sectors)) ?? []) {
        if (out.length > ask.limit) break
        const workspaceId = jobOf(ask.reach, o.sectors(row))
        if (!workspaceId) continue
        const hit = o.hit(row, workspaceId, ask.text)
        if (seen.has(hit.key)) continue
        seen.add(hit.key)
        out.push(hit)
      }
      return out
    }
  }
}

/** The first job in reach that has one of a row's sectors. */
const jobOf = (reach: SearchReach, sectors: readonly (string | undefined)[]): string | undefined => {
  for (const sector of sectors) {
    const id = workspaceOfSector(reach, sector)
    if (id) return id
  }
  return undefined
}

const view = (name: string, w: Record<string, unknown>): SearchHit['open'] => ({ to: 'view', view: name, with: w })
const lifeosChip = (kind: ContextChip['kind'], table: 'tasks' | 'mailThreads' | 'events' | 'projects' | 'people', id: string, label: string, excerpt?: string): ContextChip => ({
  kind,
  label,
  ref: { at: 'lifeos', table, id },
  ...(excerpt ? { excerpt } : {})
})

export const addressesOf = (p: Person): string[] => [...new Set((p.identities ?? []).flatMap((i) => (i.kind === 'email' ? [i.value, i.email] : [i.email])).filter((v): v is string => !!v))]

export const personHit = (p: Person, workspaceId: string): SearchHit => ({
  key: lifeosKey('people', p._id),
  kind: 'person',
  title: p.name,
  ...(addressesOf(p)[0] ? { detail: addressesOf(p)[0] } : {}),
  workspaceId,
  open: view('people', { person: p._id }),
  chip: lifeosChip('person', 'people', p._id, p.name, mentionExcerpt(p.notes))
})
/** A person is found by a name or an address of theirs. */
export const personMatches = (p: Person, text: string): boolean => mentionMatches(text, p.name, ...addressesOf(p))

const TASK_WORDS: Record<string, string> = { done: 'Done', dropped: 'Dropped', waiting: 'Waiting' }
export const taskHit = (t: Task, workspaceId: string): SearchHit => ({
  key: lifeosKey('tasks', t._id),
  kind: 'task',
  title: t.title,
  ...(TASK_WORDS[t.status ?? ''] ? { detail: TASK_WORDS[t.status ?? ''] } : t.key ? { detail: t.key } : {}),
  ...(t.dueAt !== undefined ? { at: t.dueAt } : {}),
  workspaceId,
  open: view('tasks', { task: t._id }),
  chip: lifeosChip('task', 'tasks', t._id, t.title, mentionExcerpt(t.description))
})
/** A task's own key as he types one: PUR-41. */
const TASK_KEY = /^[A-Za-z]{2,6}-\d{1,7}$/
export const taskKeysIn = (text: string): string[] => text.split(/\s+/).filter((word) => TASK_KEY.test(word))

export const eventHit = (e: Event, workspaceId: string): SearchHit => ({
  key: lifeosKey('events', e._id),
  kind: 'event',
  title: e.title,
  ...(e.location ? { detail: e.location } : {}),
  at: e.startsAt,
  workspaceId,
  open: view('agenda', { event: e._id }),
  chip: lifeosChip('event', 'events', e._id, e.title, mentionExcerpt([e.location, e.description].filter(Boolean).join('. ')))
})
export const eventMatches = (e: Event, text: string): boolean => mentionMatches(text, e.title, e.location)
/** What is coming reads first, soonest first; then what has passed, latest first. */
export function eventsInOrder(rows: readonly Event[], now = Date.now()): Event[] {
  const today = new Date(now).setHours(0, 0, 0, 0)
  const coming = rows.filter((e) => e.startsAt >= today).sort((a, b) => a.startsAt - b.startsAt)
  const passed = rows.filter((e) => e.startsAt < today).sort((a, b) => b.startsAt - a.startsAt)
  return [...coming, ...passed]
}

export const person = source<Person>({
  kind: 'person',
  label: 'People',
  unranked: true,
  // Held in memory while Work is on (search/mirror.ts): then it answers at once, else LifeOS is asked.
  tier: () => (mirror()?.people() ? 'instant' : 'network'),
  read: async (ctx, ask) => (mirror()?.people() ?? (await q<Person[]>(ctx, 'people:list', { images: false }))).filter((p) => personMatches(p, ask.text)),
  sectors: (p) => p.sectors ?? [],
  hit: personHit
})

export const mail = source<MailThread>({
  kind: 'mail',
  label: 'Mail',
  // Mail takes no sector: LifeOS searches every account once, and a thread is kept by the sector it sits in.
  read: (ctx, ask) => q<MailThread[]>(ctx, 'mail:search', { text: ask.text }),
  sectors: (m) => [m.sector],
  hit: (m, workspaceId, text) => ({
    key: lifeosKey('mailThreads', m._id),
    kind: 'mail',
    title: m.subject || '(no subject)',
    ...(m.senders?.[0] ? { detail: m.senders[0] } : {}),
    // The words are in the mail's own lines and not its subject or sender: the line says why it was found.
    ...(m.snippet && !mentionMatches(text, m.subject, ...(m.senders ?? [])) && mentionMatches(text, m.snippet) ? { snippet: m.snippet } : {}),
    ...(m.lastMessageAt !== undefined ? { at: m.lastMessageAt } : {}),
    workspaceId,
    open: view('mail', { mail: m._id }),
    chip: lifeosChip('mail', 'mailThreads', m._id, m.subject || '(no subject)', mentionExcerpt(m.snippet))
  })
})

export const task = source<Task>({
  kind: 'task',
  label: 'Tasks',
  // A key he typed is the task he means: it reads first, then LifeOS's own ranking of the titles.
  async read(ctx, ask, sectors) {
    const keys = taskKeysIn(ask.text)
    const [byKey, found] = await Promise.all([keys.length ? q<Task[]>(ctx, 'tasks:byKeys', { keys: keys.slice(0, 10) }) : Promise.resolve([]), q<Task[]>(ctx, 'tasks:search', { text: ask.text, ...asked(sectors) })])
    return [...(byKey ?? []), ...(found ?? [])]
  },
  sectors: (t) => [t.sector],
  hit: taskHit
})

/** The open tasks the mirror holds, at once: by title or key. Nothing while it is cold; `task` above still asks LifeOS for every task, done ones among them. */
export const openTask = source<Task>({
  kind: 'task',
  label: 'Tasks',
  tier: 'instant',
  read: async (_ctx, ask) => {
    const keys = taskKeysIn(ask.text).map((key) => key.toUpperCase())
    const open = mirror()?.tasks() ?? []
    return [...open.filter((t) => t.key && keys.includes(t.key.toUpperCase())), ...open.filter((t) => mentionMatches(ask.text, t.title, t.key))]
  },
  sectors: (t) => [t.sector],
  hit: taskHit
})

export const event = source<Event>({
  kind: 'event',
  label: 'Agenda',
  unranked: true,
  tier: () => (mirror()?.events() ? 'instant' : 'network'),
  read: async (ctx, ask, sectors) => eventsInOrder((mirror()?.events() ?? (await q<Event[]>(ctx, 'events:range', { ...eventsWindow(), ...asked(sectors) }))).filter((e) => eventMatches(e, ask.text))),
  sectors: (e) => [e.sector],
  hit: eventHit
})

/** How many documents' titles a sector is asked for: LifeOS's own page. */
const DOCS_PAGE = 25

type FoundDoc = Doc & { snippet?: string }

/**
 * The documents of the sectors in reach that hold the words, a sector at a
 * time, as LifeOS's catalog asks: a title that holds them first, then the
 * documents whose text does. `asFiles` picks the jobs: those where Files
 * lists LifeOS's documents (a document is a file there), or the rest.
 */
async function readDocs(ctx: WorkCtx, ask: SearchAsk, all: string[], asFiles: boolean): Promise<FoundDoc[]> {
  const held = await Promise.all(all.map((sector) => filesHoldLifeos(ctx, workspaceOfSector(ask.reach, sector)!, ask.by)))
  const sectors = all.filter((_, i) => held[i] === asFiles)
  const each = await Promise.all(
    sectors.map(async (sector) => {
      const [listed, found] = await Promise.all([
        q<{ page: Doc[] }>(ctx, 'docs:list', { sector, paginationOpts: { numItems: DOCS_PAGE, cursor: null } }),
        q<{ table: string; id: string; snippet: string }[]>(ctx, 'catalog:search', { sector, text: ask.text })
      ])
      const byId = new Map((listed?.page ?? []).map((d) => [d._id, d]))
      const titled = (listed?.page ?? []).filter((d) => mentionMatches(ask.text, d.title)).map((d) => ({ ...d, sector }))
      const inText = (found ?? []).filter((f) => f.table === 'docs' && !titled.some((d) => d._id === f.id)).map((f) => ({ _id: f.id, sector, title: byId.get(f.id)?.title ?? '', editedAt: byId.get(f.id)?.editedAt, snippet: f.snippet }))
      return { titled, inText }
    })
  )
  const rows: FoundDoc[] = [...each.flatMap((s) => s.titled), ...each.flatMap((s) => s.inText)].slice(0, ask.limit + 1)
  // A document found by its text alone, outside the newest page: its title is read, for the few rows shown.
  await Promise.all(
    rows.map(async (row) => {
      if (row.title) return
      row.title = (await q<{ title?: string } | null>(ctx, 'docs:get', { id: row._id }).catch(() => null))?.title || 'Untitled'
    })
  )
  return rows
}

const docRef = (d: FoundDoc) => ({ at: 'lifeos' as const, table: 'docs' as const, id: d._id })
const docHit = (d: FoundDoc, workspaceId: string): Omit<SearchHit, 'key' | 'kind'> => ({
  title: d.title || 'Untitled',
  ...(d.snippet ? { snippet: d.snippet } : {}),
  ...(d.editedAt !== undefined ? { at: d.editedAt } : {}),
  workspaceId,
  // A document opens as a Files tab of its job (the Docs view folded into Files).
  open: { to: 'file', ref: docRef(d), name: d.title || 'Untitled' },
  chip: { kind: 'doc', label: d.title || 'Untitled', ref: docRef(d) }
})

/** Documents, under their own heading: in the jobs where Files does not list LifeOS's (a host a release behind, a job Files is off for). */
export const doc = source<FoundDoc>({
  kind: 'doc',
  label: 'Documents',
  read: (ctx, ask, all) => readDocs(ctx, ask, all, false),
  sectors: (d) => [d.sector],
  hit: (d, workspaceId) => ({ key: lifeosKey('docs', d._id), kind: 'doc', ...docHit(d, workspaceId) })
})

/**
 * The same documents as files, in the jobs where Files lists LifeOS's: a
 * document is a file there, so it stands under Files and nowhere else. Files'
 * own list as he types holds only the names it has seen; this finds the
 * rest, and the ones whose text holds the words. The key is the one Files
 * gives the document, so a document both find is listed once.
 */
export const docAsFile = source<FoundDoc>({
  kind: 'file',
  label: 'Files',
  read: (ctx, ask, all) => readDocs(ctx, ask, all, true),
  sectors: (d) => [d.sector],
  hit: (d, workspaceId) => ({ key: fileKey(refKey(docRef(d))), kind: 'file', ...docHit(d, workspaceId) })
})

export const project = source<Project>({
  kind: 'project',
  label: 'Projects',
  unranked: true,
  read: async (ctx, ask, sectors) => (await q<Project[]>(ctx, 'projects:list', asked(sectors))).filter((p) => mentionMatches(ask.text, p.name, p.description)),
  sectors: (p) => [p.sector],
  hit: (p, workspaceId, text) => ({
    key: lifeosKey('projects', p._id),
    kind: 'project',
    title: p.name,
    // Found by what it is about and not by its name: the line says why.
    ...(p.description && !mentionMatches(text, p.name) ? { snippet: mentionExcerpt(p.description, 160) } : {}),
    workspaceId,
    open: view('projects', { project: p._id }),
    chip: lifeosChip('project', 'projects', p._id, p.name, mentionExcerpt(p.description))
  })
})

export const lifeosSources: SearchSource[] = [person, mail, openTask, task, event, doc, project]
/** With the Files sources: a document where it is a file (search/index.ts orders the three of the kind). */
export const lifeosFileSources: SearchSource[] = [docAsFile]
