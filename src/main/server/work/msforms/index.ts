import type { ClientRequest } from '@shared/contract'
import { MSFORMS_OWNER_ONLY, MsformsRequestSchemas } from '@shared/contract-work-msforms'
import { handled, NOT_HANDLED, type Handled } from '@shared/work'
import type { ActKindDef, Caller, WorkCtx, WorkModule } from '../modules'
import { msformMakeKind, msformPublishKind, settled } from './acts'
import { authFor, carrierOrRefuse, get, history, holdPublish, list, make, markSeen, page, review, setCheck, setMode, setOpen } from './forms'
import { forgetWorkspaceAnswers } from './answers/cache'
import { refreshAnswers, responsesOf, signInNeeded, startAnswersPoller } from './answers/read'
import { formReach, MsformsError } from './reach'
import { ensureMsformJobs, msformTasksJob, msformTrigger, removeMsformJobs, setTriggerDb } from './routine'
import { ensureMsformsTables, MsformsStore } from './store'
import { registerRefSeat } from '../files/hooks'
import { refKey } from '@shared/work/files'
import { ensureWorkbookIndex, workbookFile } from './workbook'
// (registers its rows in Files' library folders when it loads)
import './folder'
import { formsRows } from './health'
import { msCarrier } from './carrier/types'
import { refuseWithheld } from './withhold'
import { MSFORMS_PREAMBLE, msformsTools } from './tools'
import { msformMentions, msformSearch } from './search'
import { onNewAnswers } from './events'
import { byPerson } from './people'
import { RESPONSES_TELL, tellKey, tellNewAnswers } from './tell'

// A form opens in a Files tab by its own source, after the one reach check (files/hooks.ts `registerRefSeat`).
registerRefSeat('msform', async (ctx, by, ask) => {
  const ref = ask.ref as Extract<typeof ask.ref, { at: 'msform' }>
  const { row } = formReach(ctx, by, { workspaceId: ask.workspaceId, formId: ref.formId })
  const source = { at: 'msform' as const, host: ctx.host, workspaceId: row.workspaceId, formId: row.formId, tenant: row.tenant }
  return { key: refKey(source), name: row.title, kind: 'msform', source }
})

/**
 * The Microsoft Forms pillar's server module (docs/agents/work-msforms.md):
 * real Microsoft forms made, opened, collected and read from Work. The form,
 * its sign-in and its answers workbook stay Microsoft's; the box browser's
 * carrier is the only hands on Forms, and every outward step is held for the
 * owner's press (`msform.make`, `msform.publish`).
 */

type Params<M extends string> = Extract<(typeof MsformsRequestSchemas)[number]['_output'], { method: M }>['params']
const METHODS: ReadonlySet<string> = new Set(MsformsRequestSchemas.map((s) => s.shape.method.value))

const paramsOf = <M extends string>(method: M, req: ClientRequest): Params<M> => {
  const schema = MsformsRequestSchemas.find((s) => s.shape.method.value === method)!
  return schema.shape.params.parse((req as { params?: unknown }).params) as Params<M>
}

const OWNER_ONLY = 'refused: only the owner changes a Microsoft form from his window. A thread uses the msform tools, where the hold and the mode apply; nothing was changed.'

async function route(req: ClientRequest, ctx: WorkCtx, by: Caller): Promise<Handled> {
  const method = req.method
  if (by.kind === 'model' && MSFORMS_OWNER_ONLY.has(method)) throw new MsformsError(OWNER_ONLY)
  switch (method) {
    case 'work.msforms.list': {
      const p = paramsOf('work.msforms.list', req)
      return handled(list(ctx, by, p.workspaceId))
    }
    case 'work.msforms.get':
      return handled(get(ctx, by, paramsOf('work.msforms.get', req)))
    case 'work.msforms.page':
      return handled(page(ctx, by, paramsOf('work.msforms.page', req)))
    case 'work.msforms.workbook':
      return handled(await workbookFile(ctx, by, paramsOf('work.msforms.workbook', req)))
    case 'work.msforms.history':
      return handled(history(ctx, by, paramsOf('work.msforms.history', req)))
    case 'work.msforms.make': {
      const p = paramsOf('work.msforms.make', req)
      return handled(await make(ctx, by, p, { by: 'owner', madeBy: 'owner' }))
    }
    case 'work.msforms.publish': {
      const p = paramsOf('work.msforms.publish', req)
      const at = formReach(ctx, by, p)
      const { view, held } = holdPublish(ctx, at, at.row.state === 'closed' ? 'reopen' : 'collect', { ...at.row.settings, accepting: true }, null)
      const ref = held?.ref ?? view.held?.ref
      if (!ref) throw new MsformsError('Collect responses could not be held for your press.')
      return handled({ ref, rev: view.rev })
    }
    case 'work.msforms.close': {
      const p = paramsOf('work.msforms.close', req)
      return handled(await setOpen(ctx, formReach(ctx, by, p), p.open, 'owner', 'owner'))
    }
    case 'work.msforms.mode': {
      const p = paramsOf('work.msforms.mode', req)
      return handled(setMode(ctx, formReach(ctx, by, p), p.mode))
    }
    case 'work.msforms.check': {
      const p = paramsOf('work.msforms.check', req)
      return handled(setCheck(ctx, formReach(ctx, by, p), p.every))
    }
    case 'work.msforms.review': {
      const p = paramsOf('work.msforms.review', req)
      return handled(await review(ctx, formReach(ctx, by, p), p.accept, p.reject))
    }
    case 'work.msforms.responses': {
      const at = formReach(ctx, by, paramsOf('work.msforms.responses', req))
      refuseWithheld(ctx, by, at.row.sector)
      return handled(await responsesOf(ctx, at, by))
    }
    case 'work.msforms.refresh':
      return handled(await refreshAnswers(ctx, formReach(ctx, by, paramsOf('work.msforms.refresh', req))))
    case 'work.msforms.survey': {
      const p = paramsOf('work.msforms.survey', req)
      const { startSurvey } = await import('./makers/survey')
      return handled(await startSurvey(ctx, by, p.workspaceId, p.event))
    }
    case 'work.msforms.prefill': {
      const p = paramsOf('work.msforms.prefill', req)
      const at = formReach(ctx, by, p)
      const carrier = carrierOrRefuse()
      return handled(await carrier.prefill(authFor(ctx, at.row, 'prefill', 'owner', p.values), at.row.formId, p.values))
    }
    case 'work.msforms.seen': {
      const view = markSeen(ctx, formReach(ctx, by, paramsOf('work.msforms.seen', req)))
      // he opened its Responses: what was new is seen, and the tell of it is done
      ctx.tell.done(tellKey(view.formId))
      return handled(view)
    }
    case 'work.msforms.byPerson':
      return handled(await byPerson(ctx, by, paramsOf('work.msforms.byPerson', req)))
  }
  return NOT_HANDLED
}

export const msforms: WorkModule = {
  id: 'msforms',
  ensure(db) {
    ensureMsformsTables(db)
    ensureWorkbookIndex(db)
    ensureMsformJobs(db)
    // the trigger's words read a form's title here, Work on or off
    setTriggerDb(db)
  },
  async handle(req, ctx, by) {
    // A method the contract does not list is the router's to call not built.
    if (!METHODS.has(req.method)) return NOT_HANDLED
    return route(req, ctx, by)
  },
  acts: [msformPublishKind as ActKindDef, msformMakeKind as ActKindDef],
  // Connections: one row on the host whose box browser carries Forms, signed in as the last read saw, or Needs you.
  health: {
    check: async (ctx) => formsRows(ctx.db, { carrier: msCarrier() !== null, signIn: signInNeeded() })
  },
  tools: () => msformsTools,
  search: [msformSearch],
  mentions: [msformMentions],
  preamble: () => MSFORMS_PREAMBLE,
  // "When someone answers <form>" (routine.ts): armed by the routines engine on the answers read's event
  triggers: [msformTrigger],
  tells: [RESPONSES_TELL],
  jobs: [msformTasksJob],
  start(ctx) {
    const off = ctx.held.onDecided((item) => settled(ctx, item))
    const poller = startAnswersPoller(ctx)
    const told = onNewAnswers((e) => tellNewAnswers(ctx, e))
    return () => {
      off()
      poller()
      told()
    }
  },
  workspaceRemoved(workspaceId, ctx) {
    for (const row of new MsformsStore(ctx.db).removeWorkspace(workspaceId)) ctx.tell.done(tellKey(row.formId))
    forgetWorkspaceAnswers(workspaceId)
    removeMsformJobs(ctx.db, workspaceId)
  }
}
