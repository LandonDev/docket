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

const day = (at: number): string => new Date(at).toISOString().slice(0, 10)

/** How the thread goes on from a hit: a LifeOS row as `table:id` for the LifeOS tools, a thread by its id, a file by its place in words. */
function handle(hit: SearchHit): string | null {
  const lifeos = /^lifeos:([A-Za-z]+):(.+)$/.exec(hit.key)
  if (lifeos) return `${lifeos[1]}:${lifeos[2]}`
  if (hit.open.to === 'thread') return `thread ${hit.open.sessionId}`
  if (hit.open.to === 'chip' && hit.open.chip.ref.at === 'item') return `canvas item ${hit.open.chip.ref.id}`
  return null
}

function line(hit: SearchHit, reach: SearchReach): string {
  const job = reach.workspaces.length + (reach.chats ? 1 : 0) > 1 ? (hit.workspaceId === null ? 'Work Chats' : (reach.workspaces.find((w) => w.id === hit.workspaceId)?.name ?? null)) : null
  const facts = [
    hit.kind === 'file' && hit.detail ? `in ${hit.detail}` : hit.detail,
    hit.cloud ? 'kept in the cloud' : null,
    hit.at !== undefined ? day(hit.at) : null,
    job,
    handle(hit)
  ].filter(Boolean)
  return `- ${hit.title}${hit.snippet ? `: "${hit.snippet}"` : ''}${facts.length ? ` (${facts.join('; ')})` : ''}`
}

/** The answer as a thread reads it: lines under kind headings, then one line a source that could not be searched. */
export function searchText(query: string, answer: SearchAnswer, reach: SearchReach): string {
  const out: string[] = []
  // Two sources of one kind (a thread by title, by its words) are one heading, and a thing is said once.
  const seen = new Set<string>()
  let heading = ''
  for (const group of answer.groups) {
    const fresh = group.hits.filter((hit) => !seen.has(hit.key))
    fresh.forEach((hit) => seen.add(hit.key))
    if (!fresh.length) continue
    if (group.label !== heading) out.push(...(out.length ? [''] : []), group.label)
    heading = group.label
    out.push(...fresh.map((hit) => line(hit, reach)))
    if (group.more) out.push(`- more ${group.label.toLowerCase()} match: ask again with kinds ["${group.kind}"] and a higher limit`)
  }
  if (!out.length) out.push(`Nothing found for "${query}".`)
  for (const quiet of answer.quiet) out.push('', `Not searched: ${quiet.line.replace(/\.$/, '')}.`)
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
        const answer = await runSearch(ctx, {
          modules,
          own: own(),
          reach,
          text: a.query,
          by: { kind: 'model', caps: [], sessionId: ctx.sessionId },
          ...(a.kinds?.length ? { kinds: a.kinds } : {}),
          limit: a.limit ?? LIMIT,
          signal: ctx.signal
        })
        return workText(searchText(a.query.trim(), answer, reach))
      }
    }
  ]
}

/** One line of the Work preamble. */
export const searchPreamble = (scope: WorkScope): string =>
  scope.workspaceId
    ? 'To find anything in this job (a person, a mail, a message, a task, an event, a file, a document, a thread), call `work_search` first.'
    : 'To find anything in any job (a person, a mail, a message, a task, an event, a file, a document, a thread), call `work_search` first.'
