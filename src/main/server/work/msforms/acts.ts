import { MsFormMakeSchema, MsFormPublishSchema, type MsFormMake, type MsFormPublish } from '@shared/contract-work-msforms'
import type { Principal } from '@shared/work/ids'
import type { ActCtx, ActKindDef, Caller } from '../modules'
import { ActStale } from '../outbox/kinds'
import { CarrierRefused, CarrierStop, msCarrier, readPayload, settingsPayload, type FormRead } from './carrier/types'
import { announce, authFor, basisOf, formWords, make, storeRead } from './forms'
import { formReach, MsformsError } from './reach'
import { MsformsStore } from './store'

/**
 * The pillar's two held kinds (docs/agents/work-msforms.md "The hold"). Both
 * have no matcher, so no grant carries either and Away releases none: only
 * his press. `msform.publish` collects responses, changes who can answer or
 * reopens; `msform.make` makes an agent's form (and with `collect`, also
 * collects it, so "make it and send it out" is one press).
 */

/** Who an act runs as: the host itself on his press, for the job the held item names. */
const HOST: Caller = { kind: 'local', caps: [] }

const GONE = 'The form is not in this job any more. No one can answer yet.'
const MOVED = 'The form changed after this was held. No one can answer yet; collect responses again.'
const DIFFERS = 'The form in Forms is not what was held: its questions or settings were changed there. No one can answer yet; collect responses again.'

const principalOf = (act: ActCtx): Principal => (act.item.sessionId ? `agent:${act.host}:${act.item.sessionId}` : 'owner')

/** Runs collect (or audience, or reopen) for a reached form after a fresh read matches what was held. */
async function carryPublish(act: ActCtx, p: MsFormPublish): Promise<{ summary: string; ref: unknown }> {
  const carrier = msCarrier()
  if (!carrier) throw new ActStale('This computer can no longer reach Microsoft Forms. No one can answer yet.')
  let reached
  try {
    reached = formReach(act, HOST, { workspaceId: p.workspaceId, formId: p.formId })
  } catch {
    throw new ActStale(GONE)
  }
  const { row } = reached
  if (row.rev !== p.rev) throw new ActStale(MOVED)
  if (p.act === 'collect' && row.state === 'collecting') throw new ActStale(`${row.title} is collecting responses already.`)
  if (p.act === 'reopen' && row.state !== 'closed') throw new ActStale(`${row.title} is not closed.`)
  let fresh: FormRead
  try {
    // a read grant of its own: the press's collect or audience grant is made for exactly what runs, after it
    fresh = await carrier.read(authFor(act, row, 'read', 'act', readPayload(row.formId)), row.formId)
  } catch (err) {
    if (err instanceof CarrierRefused || err instanceof CarrierStop) throw new ActStale(`${err.message} No one can answer yet.`)
    throw err
  }
  // The page is checked against the form as it stood when held, its own settings included: a change made since, in the
  // page or by anyone, is not collected on this press.
  if (basisOf(fresh) !== p.basis) throw new ActStale(DIFFERS)
  const store = new MsformsStore(act.db)
  try {
    if (p.act === 'audience') {
      // Who can answer alone: Accept responses stays as it is.
      const settings = { ...p.settings, accepting: fresh.settings.accepting }
      const { read } = await carrier.audience(authFor(act, row, 'audience', 'act', settingsPayload(settings)), row.formId, settings)
      const next = storeRead(act, store.update(row.workspaceId, row.formId, { held: null }), read, { by: principalOf(act), bump: true })
      announce(act, next)
      return { summary: `Changed who can answer ${row.title}`, ref: { workspaceId: row.workspaceId, formId: row.formId } }
    }
    const { read, link } = await carrier.collect(authFor(act, row, 'collect', 'act', settingsPayload(p.settings)), row.formId, p.settings)
    const next = storeRead(act, store.update(row.workspaceId, row.formId, { held: null }), read, { by: principalOf(act), bump: true, state: 'collecting' })
    announce(act, next)
    return { summary: `${p.act === 'reopen' ? 'Reopened' : 'Collecting responses to'} ${row.title}`, ref: { workspaceId: row.workspaceId, formId: row.formId, link } }
  } catch (err) {
    if (err instanceof CarrierRefused) throw new ActStale(`${err.message} No one can answer yet.`)
    if (err instanceof CarrierStop) {
      if (err.read) announce(act, storeRead(act, row, err.read, { by: principalOf(act), bump: true, stopped: err.message }))
      throw new Error(err.message)
    }
    throw err
  }
}

export const msformPublishKind: ActKindDef<MsFormPublish, never> = {
  kind: 'msform.publish',
  store: 'host',
  payload: MsFormPublishSchema,
  // No matcher: no grant collects responses, changes who can answer or reopens; every one waits for his press.
  words: (p) =>
    p.act === 'audience' ? { summary: `Change who can answer ${p.title}`, verb: 'Change who can answer' } : p.act === 'reopen' ? { summary: `Reopen ${p.title}`, verb: 'Reopen' } : { summary: `Collect responses to ${p.title}`, verb: 'Collect responses' },
  execute: (p, act) => carryPublish(act, p),
  wayBack: () => null
}

/** What his press on a held make runs: the form made in the folder, then collected when the item said so. */
async function carryMake(act: ActCtx, p: MsFormMake): Promise<{ summary: string; ref: unknown }> {
  if (!msCarrier()) throw new ActStale('This computer can no longer reach Microsoft Forms. Nothing was made in Forms.')
  let view
  try {
    view = await make(act, HOST, { workspaceId: p.workspaceId, folder: p.folder, title: p.title, description: p.description, questions: p.questions, settings: p.settings }, { by: 'act', madeBy: principalOf(act) })
  } catch (err) {
    // A stop after the form was made is a failure he must see (the form is there); before, nothing was made.
    if ((err as { formId?: string }).formId) throw new Error((err as Error).message)
    if (err instanceof MsformsError || err instanceof CarrierRefused) throw new ActStale(`${err.message} Nothing was made in Forms.`)
    throw err
  }
  if (!p.collect) return { summary: `Made ${view.title} in Forms`, ref: { workspaceId: view.workspaceId, formId: view.formId } }
  const row = new MsformsStore(act.db).get(view.workspaceId, view.formId)!
  // Collect only what he approved: the form Forms saved must be the one held, word for word.
  const saved = basisOf({ title: row.title, description: row.description, questions: row.questions, settings: p.settings })
  const approved = basisOf({ title: p.title, description: p.description, questions: p.questions, settings: p.settings })
  if (saved !== approved) return { summary: `Made ${row.title} in Forms, but not collecting responses: what Forms saved is not exactly what was held. Look at it, then Collect responses.`, ref: { workspaceId: row.workspaceId, formId: row.formId } }
  const content = formWords(row.title, row.questions, p.settings, row.description)
  return carryPublish(act, { workspaceId: row.workspaceId, formId: row.formId, rev: row.rev, title: row.title, act: 'collect', settings: p.settings, content, basis: basisOf(row) })
}

export const msformMakeKind: ActKindDef<MsFormMake, never> = {
  kind: 'msform.make',
  store: 'host',
  payload: MsFormMakeSchema,
  // No matcher: a form made in a Team shows to its members at once, so every make waits for his press.
  words: (p) => ({ summary: `${p.collect ? 'Make and collect responses to' : 'Make'} the Microsoft form ${p.title}`, verb: p.collect ? 'Make and collect' : 'Make form' }),
  execute: (p, act) => carryMake(act, p),
  wayBack: () => null
}

/** A held publish decided another way (discarded, stale, failed) stops waiting on the form. */
export function settled(ctx: Pick<ActCtx, 'db' | 'push'>, item: { kind: string; ref: { at: string; id?: string }; state: string }): void {
  if (item.kind !== 'msform.publish' || item.state === 'held' || item.ref.at !== 'host' || !item.ref.id) return
  const store = new MsformsStore(ctx.db)
  const row = store.byHeld(item.ref.id)
  if (row) announce(ctx, store.update(row.workspaceId, row.formId, { held: null }))
}
