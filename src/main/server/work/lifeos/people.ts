import { z } from 'zod'
import { workText, type SectorKey, type WorkToolResult } from '@shared/work'
import type { WorkCtx, WorkTool } from '../modules'
import { GUEST_LINKS_TABLE } from '../guests/store'

/**
 * A person's page for a thread (docs/agents/work-people.md "For agents"): the
 * same page the People view draws, read as the owner and bounded to the
 * thread's one sector, which is its fence (work-scope.md). Read-only: it
 * writes nothing, in LifeOS or here.
 */

type Person = { _id: string; name: string; emails: string[]; lastAt?: number }
type Row = { _id: string }
type Page = {
  person: { _id: string; name: string; notes: string; emails: string[]; phones: string[] }
  lastAt?: number
  mail: (Row & { subject: string; snippet: string; lastMessageAt: number; unread: boolean })[]
  coming: (Row & { title: string; startsAt: number; allDay?: boolean; location?: string })[]
  recent: (Row & { title: string; startsAt: number; allDay?: boolean; location?: string })[]
  tasks: (Row & { title: string; status: string; dueAt?: number; relation: 'asked' | 'waiting' })[]
  shared: { table: 'docs' | 'sheets' | 'projects'; id: string; title: string }[]
}
/** A guest link as this host keeps it: the part a page shows. */
export type HeldLink = { name: string; table: 'docs' | 'sheets' | 'projects'; id: string; role: string; expiresAt: number; createdAt: number }

const fold = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()

/** Who the ask names among the sector's people: an id, an address, a whole name, else the one name that holds every word asked. */
export function resolvePerson(rows: readonly Person[], ask: string): { person: Person } | { none: true } | { several: Person[] } {
  const raw = ask.trim()
  const byId = rows.find((p) => p._id === raw)
  if (byId) return { person: byId }
  const lower = raw.toLowerCase()
  if (lower.includes('@')) {
    const byMail = rows.find((p) => p.emails.some((e) => e.toLowerCase() === lower))
    return byMail ? { person: byMail } : { none: true }
  }
  const want = fold(raw)
  const whole = rows.filter((p) => fold(p.name) === want)
  if (whole.length === 1) return { person: whole[0]! }
  const words = want.split(' ').filter(Boolean)
  const some = whole.length ? whole : rows.filter((p) => words.every((w) => fold(p.name).includes(w)))
  if (some.length === 1) return { person: some[0]! }
  return some.length ? { several: some.slice(0, 10) } : { none: true }
}

/** The live guest links named for this person, newest first, one an item: the People view's own rule (people/model.ts `linksFor`). */
export function linksNamed(links: readonly HeldLink[], name: string, now: number): HeldLink[] {
  const who = fold(name)
  const seen = new Set<string>()
  return links
    .filter((l) => l.expiresAt > now && fold(l.name) === who)
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((l) => {
      const key = `${l.table}:${l.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** This host's live guest links. Another host keeps none of the box's, and a host without the table lists none. */
function heldLinks(ctx: WorkCtx): HeldLink[] {
  try {
    const rows = ctx.db.prepare(`SELECT name, source, role, expires_at, created_at FROM ${GUEST_LINKS_TABLE} WHERE revoked_at IS NULL`).all() as { name: string; source: string; role: string; expires_at: number; created_at: number }[]
    return rows.flatMap((r) => {
      const source = JSON.parse(r.source) as { table?: string; id?: string }
      if ((source.table !== 'docs' && source.table !== 'sheets' && source.table !== 'projects') || typeof source.id !== 'string') return []
      return [{ name: r.name, table: source.table, id: source.id, role: r.role, expiresAt: r.expires_at, createdAt: r.created_at }]
    })
  } catch {
    return []
  }
}

const when = (ms: number, allDay?: boolean): string => {
  const iso = new Date(ms).toISOString()
  return allDay ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ') + 'Z'
}
const NOUN = { docs: 'document', sheets: 'sheet', projects: 'project' } as const

/** The page as words, each thing with the id LifeOS's own tools take. */
export function pageText(page: Page, links: readonly HeldLink[], sector: string): string {
  const { person } = page
  const out: string[] = [`# ${person.name} (person ${person._id}, ${sector})`]
  if (person.emails.length) out.push(`Addresses: ${person.emails.join(', ')}`)
  if (person.phones.length) out.push(`Numbers: ${person.phones.join(', ')}`)
  if (person.notes.trim()) out.push('', 'Notes:', person.notes.trim())
  const section = (title: string, lines: string[]) => {
    if (lines.length) out.push('', `## ${title}`, ...lines)
  }
  section('Mail, newest first', page.mail.map((m) => `- ${m.subject || '(no subject)'}, ${when(m.lastMessageAt)}${m.unread ? ', unread' : ''} (mail thread ${m._id})`))
  section('Coming up', page.coming.map((e) => `- ${e.title}, ${when(e.startsAt, e.allDay)}${e.location ? `, ${e.location}` : ''} (event ${e._id})`))
  section('Asked for by them', page.tasks.filter((t) => t.relation === 'asked').map((t) => `- ${t.title}${t.dueAt !== undefined ? `, due ${when(t.dueAt)}` : ''} (task ${t._id}, ${t.status})`))
  section('Waiting on them', page.tasks.filter((t) => t.relation === 'waiting').map((t) => `- ${t.title}${t.dueAt !== undefined ? `, due ${when(t.dueAt)}` : ''} (task ${t._id}, ${t.status})`))
  const linkOf = new Map(links.map((l) => [`${l.table}:${l.id}`, l]))
  section(
    'Shared with them by guest link',
    page.shared.map((s) => {
      const l = linkOf.get(`${s.table}:${s.id}`)
      return `- ${s.title || 'Untitled'} (${NOUN[s.table]} ${s.id})${l ? `, can ${l.role} until ${when(l.expiresAt).slice(0, 10)}` : ''}`
    })
  )
  section('Earlier events', page.recent.map((e) => `- ${e.title}, ${when(e.startsAt, e.allDay)} (event ${e._id})`))
  // No "last heard from": read as the owner, its time may be a message of another sector.
  if (!page.mail.length && !page.coming.length && !page.recent.length && !page.tasks.length && !page.shared.length) out.push('', `Nothing live with them in ${sector}.`)
  return out.join('\n')
}

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })

export const personPageTool: WorkTool = {
  name: 'person_page',
  description:
    "One person's page in this workspace's LifeOS sector: who they are (addresses, numbers, notes), then what is live with them here: recent mail threads, coming and recent events they attend, open tasks they asked for or that wait on them, and the owner's documents, sheets and projects shared with them by guest link. Name them by their person id (from list_people), an address, or their name. Read-only.",
  input: z.object({
    person: z.string().min(1).max(200).describe('Their LifeOS person id, one of their addresses, or their name.'),
    sector: z.string().min(1).max(40).optional().describe("Only in a Work Chat, which reads every sector: the sector to read. A workspace's thread reads its own.")
  }),
  readOnly: true,
  run: async (args, ctx) => {
    const a = args as { person: string; sector?: string }
    const own = ctx.scope.sector
    // A workspace's thread reads its own sector and no other; a Work Chat names the one it wants.
    if (own && a.sector && a.sector !== own) return fail(`This thread reads only the ${own} sector.`)
    if (!own && ctx.scope.workspaceId) return fail('This workspace is linked to no LifeOS sector.')
    const sector = (own ?? a.sector) as SectorKey | undefined
    if (!sector) return fail('Name the sector: a Work Chat reads every one.')
    try {
      const owner = ctx.lifeos.owner()
      const rows = (await owner.query<Person[]>('people:directory', { sector })) ?? []
      const found = resolvePerson(rows, a.person)
      if ('none' in found) return fail(`No one in ${sector}'s people is ${a.person}.`)
      if ('several' in found) return fail(`Several of ${sector}'s people match ${a.person}: ${found.several.map((p) => `${p.name} (${p._id})`).join(', ')}. Ask again by id.`)
      const links = linksNamed(heldLinks(ctx), found.person.name, Date.now())
      const page = await owner.query<Page | null>('people:page', { id: found.person._id, sector, shared: links.slice(0, 50).map((l) => ({ table: l.table, id: l.id })) })
      if (!page) return fail(`No one in ${sector}'s people is ${a.person}.`)
      return workText(pageText(page, links, sector))
    } catch (err) {
      return fail(`LifeOS did not answer: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
