import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import type { FormListRow } from '@shared/contract-work-msforms'
import type { FilesTabs } from '@shared/contract-work-files'
import { admitCaller } from '../files/policy'
import { join } from 'node:path'
import { FormPublishSchema, FormsRequestSchemas, type FormPublish } from '@shared/contract-work-forms'
import { handled, NOT_HANDLED } from '@shared/work'
import type { ActKindDef, Caller, WorkCtx, WorkModule } from '../modules'
import { mustBePerson } from '../outbox/person'
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
const OWNER_ONLY = new Set(['work.forms.save', 'work.forms.review', 'work.forms.mode', 'work.forms.publish', 'work.forms.close', 'work.forms.make'])

/** The job's forms, ours, newest change first: the Forms view's half of its list. A thread lists its own job's alone. */
function listForms(ctx: WorkCtx, by: Caller, workspaceId: string): FormListRow[] {
  admitCaller(ctx, by, workspaceId)
  const store = new FormsStore(ctx.db)
  return ctx.canvas
    .forWorkspace(workspaceId, { panes: true })
    .filter((i) => i.kind === 'form')
    .flatMap((i): FormListRow[] => {
      const row = store.get(i.id)
      return row ? [{ kind: 'ours', id: i.id, title: row.body.title, state: row.state, count: null, lastAnswerAt: null, updatedAt: i.updatedAt, sessionId: i.sessionId }] : []
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** His New → TempCode form: an empty draft in the workspace's Files pane, opened in a tab of its own. */
async function makeInFiles(ctx: WorkCtx, by: Caller, workspaceId: string, title = 'Untitled form'): Promise<FilesTabs & { tabId: string; itemId: string }> {
  admitCaller(ctx, by, workspaceId)
  const { openInTab, tabsAnswer } = await import('../files/handle')
  const { tabId, item } = openInTab(ctx, workspaceId, { key: `form:${randomBytes(9).toString('base64url')}`, name: title, kind: 'form', source: { at: 'thread' } })
  new FormsStore(ctx.db).create(item.id, item.sessionId, { title, description: '', questions: [] })
  return { ...tabsAnswer(ctx, workspaceId), tabId, itemId: item.id }
}

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
    if (req.method === 'work.forms.list') return handled(listForms(ctx, by, req.params.workspaceId))
    if (req.method === 'work.forms.make') return handled(await makeInFiles(ctx, by, req.params.workspaceId, req.params.title))
    // Reopening starts a public page taking answers again: his press with approve, as a publish is. Closing stays operate.
    if (req.method === 'work.forms.close' && req.params.open) mustBePerson(by, 'approve')
    const item = formItem(ctx, (req as { params: { itemId: string } }).params.itemId)
    switch (req.method) {
      case 'work.forms.open':
        return handled(viewOf(ctx, rowOf(ctx, item)))
      case 'work.forms.save':
        return handled(await save(ctx, item, req.params.rev, req.params.body))
      case 'work.forms.review':
        // Accepting a thread's change to a published form changes a public page: his press, as the Outbox's.
        if (req.params.verdict === 'accept' && rowOf(ctx, item).publicId) mustBePerson(by, 'approve')
        return handled(await review(ctx, item, req.params.which, req.params.verdict))
      case 'work.forms.mode':
        return handled(announce(ctx, new FormsStore(ctx.db).update(item.id, { mode: req.params.mode })))
      case 'work.forms.publish':
        return handled(hold(ctx, item, req.params.rev).view)
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
