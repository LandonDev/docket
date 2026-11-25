import { mentionMatches } from '@shared/work'
import { inReach, threadKey, type SearchHit } from '@shared/work/search'
import { searchHost, type WorkThread } from '../host'
import type { SearchSource } from '../source'

/**
 * Work threads (docs/agents/work-search.md "Threads"): by title at once,
 * from the rows the host holds in memory, and by the words said in them
 * through the FTS5 index every host keeps, held to Work threads on the
 * host (`scope: 'work'`). A code thread is never answered, whatever it
 * says. The app's Search on ⌘K stays the app's: threads, code and notes of
 * every place.
 */

/**
 * Threads read for one search, each by its best row: the store's own cap. The index knows no job, so the host
 * is handed the threads in reach and asks for one row of each: neither another job's long thread nor its many
 * threads (their rows or their notes) can crowd a job's own out of the read.
 */
const WORDS_THREADS = 200

/** An archived thread's hit says so in its fact, and opening it puts the thread back (`open.archived`). */
const hitOf = (t: WorkThread, over: Partial<SearchHit> = {}): SearchHit => {
  const hit: SearchHit = { key: threadKey(t.id), kind: 'thread', title: t.title || 'Untitled', at: t.updatedAt, workspaceId: t.workspaceId, open: { to: 'thread', sessionId: t.id }, ...over }
  return t.archived && hit.open.to === 'thread' ? { ...hit, detail: 'Archived', snippet: hit.snippet, open: { ...hit.open, archived: true } } : hit
}

/** Titles, from memory: newest first, live threads before archived ones. A subagent's row is not listed. */
export const threadTitles: SearchSource = {
  kind: 'thread',
  label: 'Threads',
  tier: 'instant',
  async search(ask) {
    const found = (searchHost()?.threads() ?? []).filter((t) => !t.child && inReach(ask.reach, t.workspaceId) && mentionMatches(ask.text, t.title))
    return [...found.filter((t) => !t.archived), ...found.filter((t) => t.archived)].slice(0, ask.limit + 1).map((t) => hitOf(t))
  }
}

/** The words said in a thread, with the line they are in: one row a thread, the index's best first. */
export const threadWords: SearchSource = {
  kind: 'thread',
  label: 'Threads',
  tier: 'network',
  async search(ask) {
    const host = searchHost()
    if (!host) return []
    const out: SearchHit[] = []
    const seen = new Set<string>()
    // A subagent's thread is found by its words, so it is in the list; an archived one too, marked.
    const within = host.threads().filter((t) => inReach(ask.reach, t.workspaceId)).map((t) => t.id)
    for (const row of await host.words(ask.text, WORDS_THREADS, within)) {
      if (out.length > ask.limit) break
      // A thread's notes and its best row both answer: the first of them is the thread's hit.
      if (seen.has(row.sessionId)) continue
      seen.add(row.sessionId)
      const t = host.thread(row.sessionId)
      // The host's query is held to Work threads; the row's own stamp is read again here all the same.
      if (!t || !inReach(ask.reach, t.workspaceId)) continue
      out.push(hitOf(t, { snippet: row.snippet, at: row.ts, open: { to: 'thread', sessionId: t.id, ...(row.seq > 0 ? { seq: row.seq } : {}) } }))
    }
    return out
  }
}

export const threadSources: SearchSource[] = [threadTitles, threadWords]
