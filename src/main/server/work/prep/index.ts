import { PREP_UPCOMING_MAX_MS, PREP_WORKING_MS, type PrepAddedPerson, type PrepPage } from '@shared/contract-work-prep'
import { handled, NOT_HANDLED } from '@shared/work'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { aheadOf, setAhead } from './ahead'
import { decideTasks } from './after'
import { eventOf, gather, standing, startDoc, upcoming } from './gather'
import { pagePushed, writePage } from './page'
import { briefMessage, briefTitle, followMessage, followTitle } from './prompts'
import { changeInOrder } from './serial'
import { personKey } from './series'
import { ensurePrepTables, PrepStore } from './store'
import { prepPreamble, prepTools } from './tools'
import { workspaceSector } from './workspace'

/**
 * The prep pillar’s server module. A page stays with its event on the
 * workspace’s host. A Work thread writes the brief or outcome with tools.
 * The pillar declares no act kind.
 */

/** Refuse a thread’s own call to a person’s method. */
export function mustBePerson(by: Caller): void {
  if (by.kind === 'model') throw new Error('only the owner changes a meeting’s page; a thread writes its brief with prep_write')
}

/** His change to the people added to a page: each once, kept for the series. */
async function setPeople(ctx: WorkCtx, workspaceId: string, eventId: string, people: PrepAddedPerson[]): Promise<PrepPage> {
  const event = await eventOf(ctx, workspaceSector(ctx, workspaceId), eventId)
  const { row, last } = standing(new PrepStore(ctx.db), workspaceId, event)
  const seen = new Set<string>()
  const added = people.filter((p) => {
    const key = personKey(p)
    return !seen.has(key) && Boolean(seen.add(key))
  })
  const now = Date.now()
  writePage(ctx, workspaceId, event, last, { ...(row?.doc ?? startDoc(last)), people: added }, now)
  return (await gather(ctx, workspaceId, eventId, now)).page
}

async function setNotes(ctx: WorkCtx, workspaceId: string, eventId: string, text: string): Promise<PrepPage> {
  const event = await eventOf(ctx, workspaceSector(ctx, workspaceId), eventId)
  const { row, last } = standing(new PrepStore(ctx.db), workspaceId, event)
  const at = Date.now()
  const notes = text.trim() ? { text: text.trim(), at } : null
  writePage(ctx, workspaceId, event, last, { ...(row?.doc ?? startDoc(last)), notes }, at)
  return (await gather(ctx, workspaceId, eventId, at)).page
}

async function startThread(ctx: WorkCtx, workspaceId: string, eventId: string, kind: 'brief' | 'follow'): Promise<{ sessionId: string }> {
  const { page, event, row, last } = await gather(ctx, workspaceId, eventId)
  const follow = kind === 'follow'
  if (follow && !page.doc.notes) throw new Error('Add notes first.')
  const existing = follow ? row?.followSessionId : row?.briefSessionId
  const startedAt = follow ? row?.followAt : row?.briefAt
  const writtenAt = follow ? page.doc.after?.at : page.doc.brief?.at
  const now = Date.now()
  if (existing && startedAt != null && now - startedAt < PREP_WORKING_MS && (writtenAt === undefined || writtenAt < startedAt)) {
    return { sessionId: existing }
  }
  const title = page.event.title
  const sessionId = await ctx.threads.start({
    workspaceId,
    title: follow ? followTitle(title) : briefTitle(title),
    about: { kind: 'event', label: title, ref: { at: 'lifeos', table: 'events', id: eventId } },
    text: follow ? followMessage(page) : briefMessage(page)
  })
  writePage(ctx, workspaceId, event, last, page.doc, now, { [kind]: sessionId })
  return { sessionId }
}

export const prep: WorkModule = {
  id: 'prep',
  ensure: ensurePrepTables,
  tools: prepTools,
  preamble: prepPreamble,
  async handle(req, ctx, by) {
    switch (req.method) {
      case 'work.prep.page':
        return handled({ page: (await gather(ctx, req.params.workspaceId, req.params.eventId)).page })
      case 'work.prep.upcoming': {
        const { from } = req.params
        return handled({ meetings: await upcoming(ctx, from, Math.min(req.params.to, from + PREP_UPCOMING_MAX_MS)) })
      }
      case 'work.prep.people': {
        mustBePerson(by)
        const { workspaceId, eventId, people } = req.params
        return handled({ page: await changeInOrder(ctx, [workspaceId, eventId], () => setPeople(ctx, workspaceId, eventId, people)) })
      }
      case 'work.prep.brief':
      case 'work.prep.followUp': {
        mustBePerson(by)
        const { workspaceId, eventId } = req.params
        const kind = req.method === 'work.prep.brief' ? 'brief' : 'follow'
        return handled(await changeInOrder(ctx, [workspaceId, eventId], () => startThread(ctx, workspaceId, eventId, kind)))
      }
      case 'work.prep.notes': {
        mustBePerson(by)
        const { workspaceId, eventId, text } = req.params
        return handled({ page: await changeInOrder(ctx, [workspaceId, eventId], () => setNotes(ctx, workspaceId, eventId, text)) })
      }
      case 'work.prep.decide': {
        mustBePerson(by)
        const { workspaceId, eventId, taskIds, decision } = req.params
        return handled(await changeInOrder(ctx, [workspaceId, eventId], () => decideTasks(ctx, workspaceId, eventId, taskIds, decision)))
      }
      case 'work.prep.ahead': {
        const { workspaceId, on, tz } = req.params
        if (on === undefined) return handled(await aheadOf(ctx, workspaceId))
        mustBePerson(by)
        return handled(await setAhead(ctx, by, workspaceId, on, tz))
      }
    }
    return NOT_HANDLED
  },
  sessionsRemoved(ids, ctx) {
    // A page belongs to its event, so it stays when its thread goes.
    for (const row of new PrepStore(ctx.db).clearSessions(ids, Date.now())) pagePushed(ctx, row)
  },
  workspaceRemoved(workspaceId, ctx) {
    new PrepStore(ctx.db).removeWorkspace(workspaceId)
  }
}
