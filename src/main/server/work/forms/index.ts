import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { FormPublishSchema, FormsRequestSchemas, type FormPublish } from '@shared/contract-work-forms'
import { handled, NOT_HANDLED } from '@shared/work'
import type { ActKindDef, WorkCtx, WorkModule } from '../modules'
import { announce, dropCopy, formItem, hold, publish, responses, review, rowOf, save, setOpen, settled, viewOf, writeCopy } from './forms'
import { ensureFormsTables, FormsStore, type FormRow } from './store'
import { formsTools } from './tools'

/** What a removed form leaves: its public page's copy and its own folder of answers. */
function dropForms(ctx: WorkCtx, rows: FormRow[]): void {
  for (const row of rows) {
    if (row.publicId) dropCopy(ctx, row.publicId)
    rmSync(join(ctx.dataDir, 'work-forms', row.itemId), { recursive: true, force: true })
  }
}

/**
 * The forms pillar's server module (docs/agents/work-forms.md): a form in
 * the canvas, its questions and its answers. Publishing shares a link, so
 * it is held (`form.publish`) for the owner's press; the Work service serves
 * the page at `/f/<publicId>` (service/routes/form.ts) and writes each
 * answer as a row of the form's sheet.
 */

export const formPublishKind: ActKindDef<FormPublish, never> = {
  kind: 'form.publish',
  store: 'host',
  payload: FormPublishSchema,
  // No matcher: a publish takes no grant, so every one waits for his press.
  words: (p) => ({ summary: `Publish ${p.title}`, verb: 'Publish' }),
  execute: (p, act) => publish(act, p),
  wayBack: () => null
}

const FORMS_METHODS: ReadonlySet<string> = new Set(FormsRequestSchemas.map((s) => s.shape.method.value))
const OWNER_ONLY = new Set(['work.forms.save', 'work.forms.review', 'work.forms.mode', 'work.forms.publish', 'work.forms.close'])

export const forms: WorkModule = {
  id: 'forms',
  ensure(db) {
    ensureFormsTables(db)
  },
  async handle(req, ctx, by) {
    // A method the contract does not list is the router's to call not built.
    if (!FORMS_METHODS.has(req.method)) return NOT_HANDLED
    // The canvas's methods are his: a thread's own call goes through the tools, where the hold and the mode apply.
    if (by.kind === 'model' && OWNER_ONLY.has(req.method)) throw new Error('Only the owner changes a form from the canvas.')
    const item = formItem(ctx, (req as { params: { itemId: string } }).params.itemId)
    switch (req.method) {
      case 'work.forms.open':
        return handled(viewOf(ctx, rowOf(ctx, item)))
      case 'work.forms.save':
        return handled(await save(ctx, item, req.params.rev, req.params.body))
      case 'work.forms.review':
        return handled(await review(ctx, item, req.params.which, req.params.verdict))
      case 'work.forms.mode':
        return handled(announce(ctx, new FormsStore(ctx.db).update(item.id, { mode: req.params.mode })))
      case 'work.forms.publish':
        return handled(hold(ctx, item).view)
      case 'work.forms.close':
        return handled(setOpen(ctx, item, req.params.open))
      case 'work.forms.responses':
        return handled(await responses(ctx, item, req.params.rev))
    }
    return NOT_HANDLED
  },
  tools: () => formsTools,
  acts: [formPublishKind as ActKindDef],
  preamble: () =>
    'A form in the canvas is made with `form_create` and changed with `form_edit` (questions by id, from `form_read`). Publishing shares a public link, so `form_publish` only holds it: the link goes live when the owner presses Publish. Each answer is a row of the form\'s sheet; read it with `form_read` or `sheet_read`. `form_close` stops answers and reopens them.',
  start(ctx) {
    // The service serves what main last wrote; write it again in case the folder was cleared while Work was off.
    for (const row of new FormsStore(ctx.db).published()) {
      try {
        writeCopy(ctx, row)
      } catch (err) {
        ctx.log(`forms: the page of ${row.itemId} was not written: ${String(err)}`)
      }
    }
    return ctx.held.onDecided((item) => settled(ctx, item))
  },
  sessionsRemoved(ids, ctx) {
    dropForms(ctx, new FormsStore(ctx.db).removeSessions(ids))
  },
  itemsRemoved(items, ctx) {
    dropForms(ctx, new FormsStore(ctx.db).removeItems(items.map((i) => i.id)))
  },
  // Nothing: a deleted workspace's threads are removed too, and `sessionsRemoved` clears their rows.
  workspaceRemoved() {}
}
