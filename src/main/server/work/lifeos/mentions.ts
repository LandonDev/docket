import { MENTION_PER_KIND, mentionExcerpt, mentionMatches, type MentionHit, type MentionReach, type SectorKey } from '@shared/work'
import type { MentionSource, WorkCtx } from '../modules'

/**
 * LifeOS's things for the composer's `@` (docs/agents/work-canvas.md
 * "Mentions"): tasks, mail threads, events, projects, people and documents.
 * The host reads them as the owner, so the reach's sectors are the fence
 * here: every row is kept only when its sector is one the thread may read,
 * whatever LifeOS answered, and a reach with no sector reads nothing.
 */

const DAY = 86_400_000

type Row = { _id: string; sector?: string }
type Task = Row & { title: string; description?: string; dueAt?: number }
type MailThread = Row & { subject: string; snippet?: string; senders?: string[]; lastMessageAt?: number }
type Event = Row & { title: string; startsAt: number; location?: string; description?: string }
type Project = Row & { name: string; description?: string; status?: string }
type Person = { _id: string; name: string; notes?: string; sectors?: string[] }
type Doc = Row & { title: string; editedAt?: number; _creationTime?: number }

const reads = (reach: MentionReach, sector: string | undefined): boolean => reach.sectors === 'all' || (!!sector && reach.sectors.includes(sector))
/** The one sector to ask LifeOS for, when the reach is one; otherwise ask for all and keep what is in reach. */
const asked = (reach: MentionReach): { sector?: SectorKey } => (reach.sectors !== 'all' && reach.sectors.length === 1 ? { sector: reach.sectors[0] } : {})
const none = (reach: MentionReach): boolean => reach.sectors !== 'all' && reach.sectors.length === 0

/** One LifeOS kind: what to ask, which rows are in reach, and the hit each becomes. */
function source<T>(kind: MentionSource['kind'], read: (ctx: WorkCtx, text: string, reach: MentionReach) => Promise<T[]>, keep: (row: T, reach: MentionReach, text: string) => boolean, hit: (row: T) => MentionHit): MentionSource {
  return {
    kind,
    lifeos: true,
    async search(text, reach, ctx) {
      if (none(reach)) return []
      const rows = await read(ctx, text, reach)
      const out: MentionHit[] = []
      for (const row of rows ?? []) {
        if (out.length >= MENTION_PER_KIND) break
        if (keep(row, reach, text)) out.push(hit(row))
      }
      return out
    }
  }
}

const q = <T>(ctx: WorkCtx, fn: string, args: Record<string, unknown>): Promise<T> => ctx.lifeos.owner().query<T>(fn, args)

export const lifeosMentions: MentionSource[] = [
  source<Task>(
    'task',
    (ctx, text, reach) => (text ? q(ctx, 'tasks:search', { text, ...asked(reach) }) : q(ctx, 'tasks:list', asked(reach))),
    (t, reach, text) => reads(reach, t.sector) && mentionMatches(text, t.title, t.description),
    (t) => ({ chip: { kind: 'task', label: t.title, ref: { at: 'lifeos', table: 'tasks', id: t._id }, excerpt: mentionExcerpt(t.description) }, at: t.dueAt })
  ),
  source<MailThread>(
    'mail',
    // Mail takes no sector here: a page wide enough that a sector's own newest threads are in it, kept to the reach below.
    async (ctx, text) => (text ? q(ctx, 'mail:search', { text }) : (await q<{ page: MailThread[] }>(ctx, 'mail:threads', { paginationOpts: { numItems: 100, cursor: null } })).page),
    // LifeOS's search reads bodies too, so a thread it found is kept whatever its subject says.
    (m, reach) => reads(reach, m.sector),
    (m) => ({
      chip: { kind: 'mail', label: m.subject || '(no subject)', ref: { at: 'lifeos', table: 'mailThreads', id: m._id }, excerpt: mentionExcerpt(m.snippet) },
      detail: m.senders?.[0],
      at: m.lastMessageAt
    })
  ),
  source<Event>(
    'event',
    async (ctx, _text, reach) => {
      const now = Date.now()
      const rows = await q<Event[]>(ctx, 'events:range', { from: now - 14 * DAY, to: now + 90 * DAY, ...asked(reach) })
      // What is coming reads first, soonest first; then what has passed, latest first.
      const today = new Date(now).setHours(0, 0, 0, 0)
      const coming = rows.filter((e) => e.startsAt >= today).sort((a, b) => a.startsAt - b.startsAt)
      const passed = rows.filter((e) => e.startsAt < today).sort((a, b) => b.startsAt - a.startsAt)
      return [...coming, ...passed]
    },
    (e, reach, text) => reads(reach, e.sector) && mentionMatches(text, e.title, e.location),
    (e) => ({ chip: { kind: 'event', label: e.title, ref: { at: 'lifeos', table: 'events', id: e._id }, excerpt: mentionExcerpt([e.location, e.description].filter(Boolean).join('. ')) }, detail: e.location, at: e.startsAt })
  ),
  source<Project>(
    'project',
    (ctx, _text, reach) => q(ctx, 'projects:list', asked(reach)),
    (p, reach, text) => reads(reach, p.sector) && mentionMatches(text, p.name, p.description),
    (p) => ({ chip: { kind: 'project', label: p.name, ref: { at: 'lifeos', table: 'projects', id: p._id }, excerpt: mentionExcerpt(p.description) } })
  ),
  source<Person>(
    'person',
    (ctx) => q(ctx, 'people:list', { images: false }),
    // A person is in reach when any of their sectors is.
    (p, reach, text) => (reach.sectors === 'all' || (p.sectors ?? []).some((s) => reach.sectors.includes(s))) && mentionMatches(text, p.name),
    (p) => ({ chip: { kind: 'person', label: p.name, ref: { at: 'lifeos', table: 'people', id: p._id }, excerpt: mentionExcerpt(p.notes) } })
  ),
  source<Doc>(
    'doc',
    async (ctx, _text, reach) => (await q<{ page: Doc[] }>(ctx, 'docs:list', { ...asked(reach), paginationOpts: { numItems: 25, cursor: null } })).page,
    (d, reach, text) => reads(reach, d.sector) && mentionMatches(text, d.title),
    (d) => ({ chip: { kind: 'doc', label: d.title || 'Untitled', ref: { at: 'lifeos', table: 'docs', id: d._id } }, at: d.editedAt })
  )
]
