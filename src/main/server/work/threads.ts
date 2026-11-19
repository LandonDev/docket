import { CATALOG, resolveModel, type ProviderId } from '@shared/catalog'
import { writtenByOwner, type SessionMeta, type UserTextBy } from '@shared/events'
import { sessionScopeOf, WORK_HOME } from '@shared/work'
import { OWNER_PREFIX } from '../remote/crossHostThreads'
import type { CtxPart } from './ctx'
import { WORK_MODULES } from './modules'
import { modulePreambles } from './preamble'

/**
 * `ctx.threads`: what a Work module asks of the session registry. A routine
 * or a watch starts a thread (`start`), a decided act wakes one (`resume`),
 * and a write that claims the owner asked for it is checked against what the
 * owner typed (`ownerSaid`, architecture §6.7).
 *
 * This part also hands the registry the modules' preamble parts, since the
 * registry may not import the module list itself (work/preamble.ts).
 */

/** A quote shorter than this, once spaces are collapsed, proves nothing. */
export const OWNER_QUOTE_MIN = 12

const plain = (text: string): string =>
  text
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

export interface OwnerWords {
  get(id: string): SessionMeta | null | undefined
  /** A thread's `user-text` rows, oldest first, with who wrote each (absent on a row from before F1). */
  userTexts(id: string): { text: string; by?: UserTextBy }[]
  /** The host that started the thread from another host, if one did. */
  farOwner(id: string): string | null
}

/**
 * The messages of a thread that are the owner's own typing: the rows the
 * owner wrote (events.ts `writtenByOwner`) in the thread and in every thread
 * above it, since a subagent works from its parent's words. A row says who
 * wrote it: the owner at a window of this host, a client key that could
 * approve (the owner's own device, a host's desktop), or not the owner (a
 * thread, a host, a key of the MCP facade, the app). So the owner's own
 * messages count in a thread another thread or a routine started, and a
 * message a facade key sent never does.
 *
 * Rows from before F1 carry no `by`, and are read as M6 read every row: one
 * counts only in a thread at the top of its tree into which no model could
 * have written (not a routine's, not a batch thread, not one another thread
 * started here or from another host). Where this cannot tell, it says no: a
 * write that fails the check becomes a suggestion, which is the safe side.
 */
export function ownerMessages(words: OwnerWords, sessionId: string): string[] {
  const chain: SessionMeta[] = []
  for (let at = words.get(sessionId), hops = 0; at && hops < 32; at = at.parentId ? words.get(at.parentId) : null, hops++) chain.push(at)
  const top = chain.at(-1)
  const legacyCounts = !!top && !top.parentId && !(top.routineRunId || top.masterId || top.startedBy || words.farOwner(top.id))
  return chain.flatMap((thread) =>
    words.userTexts(thread.id).flatMap((row) => {
      if (row.by) return writtenByOwner(row.by) ? [row.text] : []
      return legacyCounts && thread === top ? [row.text] : []
    })
  )
}

/** Whether the owner typed `quote` in the thread: found whole in one of the owner's messages, letter case and spacing aside. */
export function ownerSaid(words: OwnerWords, sessionId: string, quote: string): boolean {
  const want = plain(quote)
  if (want.length < OWNER_QUOTE_MIN) return false
  return ownerMessages(words, sessionId).some((text) => plain(text).includes(want))
}

export const threadsPart: CtxPart<'threads'> = (ctx, deps) => {
  const { registry, store } = deps
  // The registry asks here for what the modules add to a Work thread's preamble.
  registry.workPreambleParts = (session) => {
    const scope = ctx.scopeOf(session.id)
    return scope ? modulePreambles(scope, WORK_MODULES, ctx.log) : []
  }
  const words: OwnerWords = {
    get: (id) => registry.get(id),
    userTexts: (id) => registry.eventsAfter(id, 0).flatMap((row) => (row.event.type === 'user-text' ? [{ text: row.event.text, ...(row.event.by ? { by: row.event.by } : {}) }] : [])),
    farOwner: (id) => store.getSetting(`${OWNER_PREFIX}${id}`)
  }
  return {
    threads: {
      async start(o) {
        if (!ctx.enabled()) throw new Error('Work is off on this host')
        // A workspace's own model and reasoning, unless the caller names a model.
        const chat = o.workspaceId === WORK_HOME
        const settings = chat ? null : ctx.settings.workspace(o.workspaceId)
        const asked = o.model ?? settings?.model
        const provider: ProviderId | undefined = asked ? resolveModel('claude', asked).provider : undefined
        const reasoning = !o.model && settings?.reasoning ? (settings.reasoning as SessionMeta['reasoning']) : undefined
        const thread = await registry.startWith(
          {
            scope: 'work',
            threadType: 'chat',
            ...(o.projectId ? { projectId: o.projectId } : { workspaceId: chat ? null : o.workspaceId }),
            ...(asked && provider ? { provider, model: asked } : {}),
            ...(reasoning && (!provider || CATALOG[provider]) ? { reasoning } : {}),
            // Nobody is there to answer a card: a Work thread has full access, and what leaves is held by the Outbox.
            permission: 'auto',
            ...(o.about ? { about: o.about } : {})
          },
          o.text,
          o.routineRunId ? { routineRunId: o.routineRunId } : {}
        )
        if (sessionScopeOf(thread) !== 'work') throw new Error(`thread ${thread.id} was not made a Work thread`)
        return thread.id
      },
      async resume(sessionId, notice) {
        const thread = registry.get(sessionId)
        if (!thread) throw new Error(`unknown thread: ${sessionId}`)
        if (sessionScopeOf(thread) !== 'work') throw new Error(`thread ${sessionId} is not a Work thread`)
        // The app's own line, delivered as a report is: never a row that reads as the owner's message.
        registry.deliverAgentReport(sessionId, { agentId: 'work', title: 'Work', status: 'notice', text: notice })
      },
      ownerSaid: (sessionId, quote) => ownerSaid(words, sessionId, quote)
    }
  }
}
