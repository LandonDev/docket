import { PREP_UPCOMING_MAX_MS, type PrepAddedPerson, type PrepPage } from '@shared/contract-work-prep'
import { handled, NOT_HANDLED } from '@shared/work'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { eventOf, gather, pageEventOf, peopleOf, standing, startDoc, upcoming, workspaceSector } from './gather'
import { personKey } from './series'
import { ensurePrepTables, PrepStore, type PageRow } from './store'

/**
 * The prep pillar's server module (docs/agents/work-prep.md): a page for one
 * meeting, kept with its event on the workspace's host. It reads its facts
 * from LifeOS with no model and declares no act kind: nothing here sends,
 * books or shares.
 */

/** What a write answers a thread's own call with: the page is his to change, a thread writes through its tools. */
const NOT_A_PERSON = 'only the owner changes a meeting’s page; a thread writes its brief with prep_write'

export function mustBePerson(by: Caller): void {
  if (by.kind === 'model') throw new Error(NOT_A_PERSON)
}

/** Says a page changed: a screen reads it again when `rev` moves. Carries ids alone. */
export function pagePushed(ctx: WorkCtx, row: Pick<PageRow, 'workspaceId' | 'eventId' | 'rev'>): void {
  ctx.push({ push: 'work.prep', workspaceId: row.workspaceId, eventId: row.eventId, rev: row.rev })
}

/** His change to the people added to a page: each once, kept for the series. */
async function setPeople(ctx: WorkCtx, workspaceId: string, eventId: string, people: PrepAddedPerson[], now = Date.now()): Promise<PrepPage> {
  const sector = workspaceSector(ctx, workspaceId)
  const event = await eventOf(ctx, sector, eventId)
  const store = new PrepStore(ctx.db)
  const { last } = standing(store, workspaceId, event)
  const seen = new Set<string>()
  const added = people.filter((p) => {
    const key = personKey(p)
    return !seen.has(key) && Boolean(seen.add(key))
  })
  const row = store.write(workspaceId, pageEventOf(event, peopleOf(event, added)), () => startDoc(last), (doc) => ({ ...doc, people: added }), now)
  pagePushed(ctx, row)
  return (await gather(ctx, workspaceId, eventId, now)).page
}

export const prep: WorkModule = {
  id: 'prep',
  ensure: ensurePrepTables,
  async handle(req, ctx, by) {
    switch (req.method) {
      case 'work.prep.page':
        return handled({ page: (await gather(ctx, req.params.workspaceId, req.params.eventId)).page })
      case 'work.prep.upcoming': {
        const { from } = req.params
        return handled({ meetings: await upcoming(ctx, from, Math.min(req.params.to, from + PREP_UPCOMING_MAX_MS)) })
      }
      case 'work.prep.people':
        mustBePerson(by)
        return handled({ page: await setPeople(ctx, req.params.workspaceId, req.params.eventId, req.params.people) })
    }
    return NOT_HANDLED
  },
  sessionsRemoved(ids, ctx) {
    // A page belongs to its event: it stays, without the thread.
    for (const row of new PrepStore(ctx.db).clearSessions(ids, Date.now())) pagePushed(ctx, row)
  },
  workspaceRemoved(workspaceId, ctx) {
    new PrepStore(ctx.db).removeWorkspace(workspaceId)
  }
}
