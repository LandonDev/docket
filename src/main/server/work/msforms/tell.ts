import type { TellKind } from '@shared/work/tell'
import type { WorkCtx } from '../modules'
import type { NewAnswers } from './events'
import { MsformsStore } from './store'

/**
 * New answers as a tell (docs/agents/work-digest.md): one row a form, keyed
 * `msforms:<formId>`, its count the answers he has not seen, updated in place
 * as more come and done when he opens the form's Responses. Counts and the
 * form's title only: never an answer, a name or an address.
 */

export const RESPONSES_TELL: TellKind = { kind: 'msforms.responses', group: 'results', name: 'Form responses' }

export const tellKey = (formId: string): string => `msforms:${formId}`

export function tellNewAnswers(ctx: Pick<WorkCtx, 'db' | 'tell'>, e: NewAnswers): void {
  const row = new MsformsStore(ctx.db).get(e.workspaceId, e.formId)
  if (!row) return
  const unseen = Math.max(0, row.count - row.seenCount)
  if (!unseen) return ctx.tell.done(tellKey(row.formId))
  ctx.tell({
    kind: RESPONSES_TELL.kind,
    workspaceId: row.workspaceId,
    title: `${unseen} new ${unseen === 1 ? 'response' : 'responses'} to ${row.title}`,
    open: { view: 'forms', workspaceId: row.workspaceId, at: row.formId },
    key: tellKey(row.formId)
  })
}
