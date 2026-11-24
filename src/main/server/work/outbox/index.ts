import { readFile } from 'node:fs/promises'
import type { AddonRow } from '@shared/contract-addons'
import type { FileAct } from '@shared/contract-work-files'
import type { OutboxItem, ToolRulesCard } from '@shared/contract-work-outbox'
import { handled, NOT_HANDLED } from '@shared/work'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { outboxHostOf, type OutboxHost } from './ctx'
import { OUTBOX_TELLS } from './tells'
import { ensureResults, resultsOf } from './results'
import { rulesCard, setRules } from './rules'
import { ensureEarnedTables } from './earned'
import { ensureOutboxTables } from './store'
import { PRIVATE_CHANGE, PRIVATE_CHANGE_KINDS, PRIVATE_ERROR, summaryFor } from './words'
import { pressesFor } from '../files/policy'
import { outboxMentions } from './mentions'

/**
 * The outbox pillar's server module (docs/agents/work-outbox.md): the
 * hold's tables and the `work.outbox.*` methods a screen calls. The hold
 * itself (the catch, the kinds, the press) is the context's part (ctx.ts).
 *
 * Every method that decides something is a person's: the socket's gate has
 * already checked `approve` or `admin` (contract-work-outbox.ts), and a
 * thread's own call (`kind: 'model'`) is refused here whatever it carries.
 * No tool of any thread reaches these methods.
 */

export const NOT_A_PERSON = "forbidden: only the owner decides a held act, a grant or a tool's rule; a thread cannot"

/** Who a decision is recorded as: the owner at this host, or the owner through a paired device. */
const person = (by: Caller): string => (by.kind === 'local' ? 'owner' : 'owner:remote')

function mustBePerson(by: Caller, cap: 'approve' | 'admin'): void {
  if (by.kind === 'model') throw new Error(NOT_A_PERSON)
  if (!by.caps.includes(cap)) throw new Error(NOT_A_PERSON)
}

/** The add-ons a Work thread can reach: a Work workspace's own, Work Chats', and the global ones (marked for Work or not, so he can mark one). */
function workAddons(host: OutboxHost, q: { addonId?: string; workspaceId?: string } = {}): AddonRow[] {
  const all = host.addons?.list() ?? []
  return all.filter((row) => {
    if (q.addonId && row.id !== q.addonId) return false
    if (q.workspaceId !== undefined && row.workspaceId !== q.workspaceId && row.workspaceId !== null) return false
    return row.workspaceId === null || host.isWorkScope(row.workspaceId)
  })
}

/** How many add-on tools a Work thread can reach have no rule that stands. */
export function unreviewedCount(host: OutboxHost): number {
  if (!host.addons) return 0
  let n = 0
  for (const row of workAddons(host)) {
    if (!row.enabled) continue
    const card = rulesCard(host.store, host.addons, row, host.mcpUrl())
    if (row.workspaceId === null && !card.forWork) continue
    n += card.unreviewed
  }
  return n
}

/**
 * An item as this caller may see it: a held change to a file others can open says only that it waits, with no
 * payload, to a caller that is not his press (a read or operate key), as the Outbox's own push goes only to `approve`.
 */
export function seenBy(by: Caller, item: OutboxItem): OutboxItem {
  if (pressesFor(by) || !PRIVATE_CHANGE_KINDS.has(item.kind)) return item
  const error = item.error ? PRIVATE_ERROR : null
  // A Files act keeps the things it names as they are (a reader draws its card from them), less the name it would give.
  if (item.kind === 'file.act') {
    const p = item.payload as FileAct
    const { name: _proposed, ...request } = p.request
    return { ...item, summary: summaryFor(item), error, payload: { ...p, request }, result: item.result ? { summary: item.state === 'sent' ? item.result.summary : PRIVATE_CHANGE } : null }
  }
  return { ...item, summary: summaryFor(item), error, payload: null, result: item.result ? { summary: item.result.summary } : null }
}

/** A computer act's picture, read for one item: the list never carries it. */
async function withPicture(host: OutboxHost, item: OutboxItem): Promise<OutboxItem> {
  if (item.kind !== 'computer.act' || item.ref.at !== 'host') return item
  const path = (host.store.get(item.ref.id)?.payload as { picture?: { path?: string } | null } | null)?.picture?.path
  if (!path) return item
  try {
    const data = (await readFile(path)).toString('base64')
    const payload = item.payload as { picture: object }
    return { ...item, payload: { ...payload, picture: { ...payload.picture, data } } }
  } catch {
    return item
  }
}

function mustResults(ctx: WorkCtx) {
  const results = resultsOf(ctx)
  if (!results) throw new Error('work: results did not start on this host')
  return results
}

function hostOf(ctx: WorkCtx): OutboxHost {
  const host = outboxHostOf(ctx)
  if (!host) throw new Error('work: outbox did not start on this host')
  return host
}

export const outbox: WorkModule = {
  id: 'outbox',
  mentions: outboxMentions,
  tells: OUTBOX_TELLS,
  ensure(db) {
    ensureOutboxTables(db)
    // Offers are a shortcut: a fault in their tables never takes the Outbox down with it.
    try {
      ensureEarnedTables(db)
    } catch {
      // the Outbox runs without offers (outbox.ts reads them under try)
    }
    ensureResults(db)
  },
  async handle(req, ctx, by, signal) {
    if (!req.method.startsWith('work.outbox.')) return NOT_HANDLED
    const host = hostOf(ctx)
    const box = host.outbox
    switch (req.method) {
      case 'work.outbox.list': {
        const listed = box.list(req.params ?? {})
        return handled({ ...listed, items: listed.items.map((item) => seenBy(by, item)) })
      }
      case 'work.outbox.get':
        return handled(seenBy(by, await withPicture(host, await box.get(req.params.ref))))
      case 'work.outbox.send':
        mustBePerson(by, 'approve')
        return handled(await box.send(req.params.ref, { ...(req.params.rev !== undefined ? { rev: req.params.rev } : {}), ...(req.params.again ? { again: true } : {}), ...(req.params.many ? { many: true } : {}), by: person(by) }))
      case 'work.outbox.discard':
        mustBePerson(by, 'approve')
        return handled(await box.discard(req.params.ref, person(by)))
      case 'work.outbox.edit':
        mustBePerson(by, 'approve')
        return handled(await box.edit(req.params.ref, req.params.payload))
      case 'work.outbox.grant':
        mustBePerson(by, 'admin')
        return handled(await box.grant(req.params.from, req.params.matcher, { ...(req.params.label ? { label: req.params.label } : {}), ...(req.params.routine ? { routine: true } : {}) }))
      case 'work.outbox.grants':
        return handled({ grants: host.store.grants({ ...(req.params?.workspaceId ? { workspaceId: req.params.workspaceId } : {}), ...(req.params?.all ? { all: true } : {}) }) })
      case 'work.outbox.ungrant':
        mustBePerson(by, 'admin')
        return handled(box.ungrant(req.params.id))
      // Grants he has earned (earned.ts): read, taken and dismissed only by a person, like the grant itself.
      case 'work.outbox.offers':
        mustBePerson(by, 'approve')
        return handled({ offers: box.offers(req.params ?? {}) })
      case 'work.outbox.takeOffer':
        mustBePerson(by, 'admin')
        return handled(await box.takeOffer(req.params.id))
      case 'work.outbox.dismissOffer':
        mustBePerson(by, 'admin')
        return handled(box.dismissOffer(req.params.id))
      case 'work.outbox.rules': {
        if (!host.addons) return handled({ addons: [] })
        const cards: ToolRulesCard[] = workAddons(host, req.params ?? {}).map((row) => rulesCard(host.store, host.addons!, row, host.mcpUrl()))
        return handled({ addons: cards })
      }
      case 'work.outbox.setRules': {
        mustBePerson(by, 'admin')
        const row = host.addons?.get(req.params.addonId)
        if (!row || !host.addons) throw new Error(`no add-on ${req.params.addonId} on this host`)
        const card = rulesCard(host.store, host.addons, row, host.mcpUrl())
        if (card.lifeos) throw new Error("refused: LifeOS's tools are not set here; its key cannot send and LifeOS holds its own drafts")
        setRules(host.store, host.addons, row, req.params.rules, person(by))
        box.changed(null)
        return handled(rulesCard(host.store, host.addons, row, host.mcpUrl()))
      }
      case 'work.outbox.setForWork': {
        mustBePerson(by, 'admin')
        const row = host.addons?.get(req.params.addonId)
        if (!row || !host.addons) throw new Error(`no add-on ${req.params.addonId} on this host`)
        if (row.workspaceId !== null) throw new Error('refused: only a global add-on is marked for Work; a workspace add-on is already its workspace\'s')
        host.setForWork(row.id, req.params.forWork)
        box.changed(null)
        return handled(rulesCard(host.store, host.addons, row, host.mcpUrl()))
      }
      // Results (milestone 14, work/outbox/results.ts)
      case 'work.outbox.results':
        return handled({ results: mustResults(ctx).list(req.params) })
      case 'work.outbox.undo':
        mustBePerson(by, 'approve')
        return handled(await mustResults(ctx).undo(req.params.id, signal ?? new AbortController().signal))
    }
    return NOT_HANDLED
  },
  start(ctx) {
    const host = outboxHostOf(ctx)
    if (!host) return () => {}
    // One push per change, to the keys that may decide: a held item names recipients and text a read-only key should not get unasked.
    let last = ''
    return host.outbox.onChange((item) => {
      const waiting = host.outbox.waiting()
      const unreviewed = unreviewedCount(host)
      const failed = host.outbox.failed()
      const key = JSON.stringify([waiting, unreviewed, failed, item?.ref ?? null, item?.state ?? null, item?.updatedAt ?? null])
      if (key === last) return
      last = key
      ctx.push({ push: 'work.outbox', waiting, unreviewed, failed, ...(item ? { item: light(item) } : {}) }, { need: 'approve' })
    })
  },
  preamble(scope) {
    // What a held answer means, said once where every Work thread reads it.
    return scope ? 'A tool that answers "Held as item N" has put the act in the owner\'s Outbox. An add-on whose tools the owner has not reviewed yet holds every call: name that add-on in your report and do not retry.' : null
  },
  sessionsRemoved(ids, ctx) {
    const host = outboxHostOf(ctx)
    if (!host) return
    host.forget(ids)
    host.store.closeSessions(ids, 'The thread that made this was deleted.')
  },
  workspaceRemoved(id, ctx) {
    const host = outboxHostOf(ctx)
    if (!host) return
    host.store.closeWorkspace(id, 'The workspace this belonged to was deleted.')
    host.store.removeWorkspaceGrants(id)
    host.earned.dropWorkspace(id)
  }
}

/** An item as a push carries it: a computer act without its picture's bytes, a mail without its HTML body. */
function light(item: OutboxItem): OutboxItem {
  const payload = item.payload as { message?: { html?: string } } | null
  if (item.kind === 'mail.send' && payload?.message && typeof payload.message === 'object') return { ...item, payload: { ...payload, message: { ...payload.message, html: '' } } }
  return item
}
