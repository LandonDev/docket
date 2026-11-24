import { z } from 'zod'
import { workText, type WorkScope, type WorkToolResult } from '@shared/work'
import { SEARCH_ORDER, type SearchAnswer, type SearchHit, type SearchReach } from '@shared/work/search'
import { WORK_MODULES, type WorkModule, type WorkTool } from '../modules'
import { threadReach } from './reach'
import { runSearch } from './run'
import type { SearchSource } from './source'

/**
 * What a Work thread finds things with (docs/agents/work-search.md "For
 * agents"): one read-only tool over the thread's own reach, the reach its
 * `@` has. It takes no argument that names a job, a workspace or a sector,
 * so it cannot be pointed at another job: a thread in a job reads that job,
 * a Work Chat every job, and a thread with no reach is told so.
 */

const LIMIT = 5
const LIMIT_MAX = 20

/**
 * A hit's time as a thread reads it, on this host's clock (his own, not UTC: an evening event is not the next
 * day): the day, and for an event its time with the zone's name.
 */
export function whenWords(hit: Pick<SearchHit, 'kind' | 'at'>, timeZone?: string): string | null {
  if (hit.at === undefined) return null
  const at = new Date(hit.at)
  const part = (o: Intl.DateTimeFormatOptions): Record<string, string> => Object.fromEntries(new Intl.DateTimeFormat('en-US', { ...o, timeZone }).formatToParts(at).map((p) => [p.type, p.value]))
  const d = part({ year: 'numeric', month: '2-digit', day: '2-digit' })
  const day = `${d.year}-${d.month}-${d.day}`
  if (hit.kind !== 'event') return day
  return `${day} ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone }).format(at)}`
}

/** How the thread goes on from a hit: a LifeOS row as `table:id` for the LifeOS tools, a thread by its id, a file by its place in words. */
function handle(hit: SearchHit): string | null {
  const lifeos = /^lifeos:([A-Za-z]+):(.+)$/.exec(hit.key)
  if (lifeos) return `${lifeos[1]}:${lifeos[2]}`
  // A LifeOS document listed under Files (the job's Files holds LifeOS): still named for the LifeOS tools.
  const doc = docOf(hit)
  if (doc) return `docs:${doc}`
  if (hit.open.to === 'thread') return `thread ${hit.open.sessionId}`
  if (hit.open.to === 'chip' && hit.open.chip.ref.at === 'item') return `canvas item ${hit.open.chip.ref.id}`
  return null
}

/** The id of the LifeOS document a hit opens as a file, or null. */
function docOf(hit: SearchHit): string | null {
  const ref = hit.open.to === 'file' ? (hit.open.ref as { at?: unknown; table?: unknown; id?: unknown }) : null
  return ref && ref.at === 'lifeos' && ref.table === 'docs' && typeof ref.id === 'string' ? ref.id : null
}

function line(hit: SearchHit, reach: SearchReach): string {
  const job = reach.workspaces.length + (reach.chats ? 1 : 0) > 1 ? (hit.workspaceId === null ? 'Work Chats' : (reach.workspaces.find((w) => w.id === hit.workspaceId)?.name ?? null)) : null
  const facts = [
    hit.kind === 'file' && hit.detail ? `in ${hit.detail}` : hit.detail,
    hit.cloud ? 'kept in the cloud' : null,
    whenWords(hit),
    job,
    handle(hit)
  ].filter(Boolean)
  return `- ${hit.title}${hit.snippet ? `: "${hit.snippet}"` : ''}${facts.length ? ` (${facts.join('; ')})` : ''}`
}

/**
 * The answer as a thread reads it: lines under kind headings, then one line a source that could not be searched.
 * `limit` is the most rows a kind: two sources of one kind (a thread by title, by its words) are one heading, a
 * thing is said once, and the kind as a whole is cut to the limit, with a line that says more matched.
 */
export function searchText(query: string, answer: SearchAnswer, reach: SearchReach, limit = Number.POSITIVE_INFINITY): string {
  const out: string[] = []
  const seen = new Set<string>()
  const kinds: { kind: string; label: string; hits: SearchHit[]; more: boolean }[] = []
  for (const group of answer.groups) {
    const fresh = group.hits.filter((hit) => !seen.has(hit.key))
    fresh.forEach((hit) => seen.add(hit.key))
    const last = kinds[kinds.length - 1]
    if (last && last.label === group.label) {
      last.hits.push(...fresh)
      last.more ||= group.more
    } else kinds.push({ kind: group.kind, label: group.label, hits: fresh, more: group.more })
  }
  for (const { kind, label, hits, more } of kinds) {
    if (!hits.length) continue
    out.push(...(out.length ? [''] : []), label, ...hits.slice(0, limit).map((hit) => line(hit, reach)))
    if (more || hits.length > limit) out.push(`- more ${label.toLowerCase()} match: ask again with kinds ["${kind}"] and a higher limit`)
  }
  // "Nothing found" is true only of a search that ran: with no source answering, only why is said.
  if (!out.length && (answer.searched !== 0 || !answer.quiet.length)) out.push(`Nothing found for "${query}".`)
  for (const quiet of answer.quiet) out.push(...(out.length ? [''] : []), `Not searched: ${quiet.line.replace(/\.$/, '')}.`)
  return out.join('\n')
}

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })

export function searchTools(own: () => readonly SearchSource[], modules: readonly WorkModule[] = WORK_MODULES): WorkTool[] {
  return [
    {
      name: 'work_search',
      description:
        "Find anything in this thread's job by words: people, mail, chat messages, tasks, events, files (by name), documents, projects and Work threads. In a Work Chat it reads every job. Read-only. A LifeOS row is named as table:id for the LifeOS tools; a thread by its id.",
      input: z.object({
        query: z.string().min(1).max(200).describe('The words to look for.'),
        kinds: z.array(z.string().max(40)).max(20).optional().describe(`Only these kinds: ${SEARCH_ORDER.join(', ')}.`),
        limit: z.number().int().min(1).max(LIMIT_MAX).optional().describe(`Rows a kind (${LIMIT} by default).`)
      }),
      readOnly: true,
      run: async (args, ctx) => {
        const a = args as { query: string; kinds?: string[]; limit?: number }
        const reach = threadReach(ctx, ctx.sessionId)
        if (!reach) return fail('This thread has nothing to search: it belongs to no Work workspace on this host.')
        if (!a.query.trim()) return fail('Give the words to look for.')
        const limit = a.limit ?? LIMIT
        // Documents asked for and not files: where a job's Files holds LifeOS, a document is listed as a file, so
        // the file sources are asked too and only their LifeOS documents are kept.
        const docsOnly = !!a.kinds?.includes('doc') && !a.kinds.includes('file')
        const answer = await runSearch(ctx, {
          modules,
          own: own(),
          reach,
          text: a.query,
          by: { kind: 'model', caps: [], sessionId: ctx.sessionId },
          ...(a.kinds?.length ? { kinds: docsOnly ? [...a.kinds, 'file'] : a.kinds } : {}),
          limit,
          signal: ctx.signal
        })
        const groups = docsOnly ? answer.groups.map((g) => (g.kind === 'file' ? { ...g, hits: g.hits.filter((hit) => docOf(hit) !== null), more: false } : g)) : answer.groups
        return workText(searchText(a.query.trim(), { ...answer, groups }, reach, limit))
      }
    }
  ]
}

/** One line of the Work preamble. */
export const searchPreamble = (scope: WorkScope): string =>
  scope.workspaceId
    ? 'To find anything in this job (a person, a mail, a message, a task, an event, a file, a document, a thread), call `work_search` first.'
    : 'To find anything in any job (a person, a mail, a message, a task, an event, a file, a document, a thread), call `work_search` first.'
