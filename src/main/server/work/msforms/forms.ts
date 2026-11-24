import { randomBytes } from 'node:crypto'
import type { FormListRow, MsFormHistoryRow, MsFormMake, MsFormPublish, MsFormView, MsSuggestion } from '@shared/contract-work-msforms'
import type { HeldItem } from '@shared/work/acts'
import type { Principal } from '@shared/work/ids'
import { applyChange, changeWords, diffQuestions, isOther, questionWords, respondOf, settingsWords, type MsAnyQuestion, type MsChange, type MsFormCheck, type MsFormSettings } from '@shared/work/msforms'
import type { Caller, WorkCtx } from '../modules'
import { authorize, CarrierRefused, CarrierStop, msCarrier, NO_CARRIER, type CarrierBy, type CarrierOp, type FormRead, type MsCarrier } from './carrier/types'
import { folderOf, folderPageOf, libraryAt } from './place'
import { formReach, formsReached, jobOf, librariesFor, MsformsError, type Reached } from './reach'
import { MsformsStore, type MsFormRow } from './store'

/**
 * The Microsoft Forms pillar's logic (docs/agents/work-msforms.md): a form's
 * row and view, his own presses (make, close, reopen, the mode, the check
 * schedule, accepting a change), the hold of Collect responses, and every
 * carrier run, each under an authorization bound to exactly what it does.
 */

export type MsCtx = Pick<WorkCtx, 'db' | 'host' | 'scopeOf' | 'settings' | 'reaches' | 'push' | 'log' | 'held'>

export function carrierOrRefuse(): MsCarrier {
  const c = msCarrier()
  if (!c) throw new MsformsError(NO_CARRIER)
  return c
}

/** Whether this host makes Microsoft forms: it has the box browser's carrier and a SharePoint library. */
export function offeredHere(ctx: Pick<WorkCtx, 'db' | 'host' | 'scopeOf' | 'settings'>, by: Caller): boolean {
  return msCarrier() !== null && librariesFor(ctx as MsCtx, by).some((l) => folderOf(l, '') !== null)
}

export function viewOf(row: MsFormRow): MsFormView {
  return {
    workspaceId: row.workspaceId,
    formId: row.formId,
    tenant: row.tenant,
    title: row.title,
    folder: row.folder,
    workbook: row.workbook,
    state: row.state,
    mode: row.mode,
    settings: row.settings,
    questions: row.questions,
    rev: row.rev,
    readAt: row.readAt,
    answersReadAt: row.answersReadAt,
    count: row.count,
    lastAnswerAt: row.lastAnswerAt,
    check: row.check,
    suggestions: row.suggestions,
    held: row.held,
    link: row.state === 'draft' ? null : respondOf(row.formId),
    madeBy: row.madeBy,
    signedInAs: row.signedInAs,
    updatedAt: row.updatedAt,
    unseen: Math.max(0, row.count - row.seenCount),
    stopped: row.stopped,
    closedAt: row.closedAt
  }
}

/** Says the form to his windows. A push carries no answer: the view holds counts alone. */
export function announce(ctx: Pick<WorkCtx, 'push'>, row: MsFormRow): MsFormView {
  const view = viewOf(row)
  ctx.push({ push: 'work.msforms', workspaceId: row.workspaceId, formId: row.formId, view })
  return view
}

export function listRows(rows: readonly MsFormRow[]): FormListRow[] {
  return rows.map((r) => ({ kind: 'ms', id: r.formId, title: r.title, state: r.state, count: r.count, lastAnswerAt: r.lastAnswerAt, updatedAt: r.updatedAt }))
}

/** One carrier authorization for a reached form, from its grantor. */
export function authFor(ctx: Pick<WorkCtx, 'host'>, at: { workspaceId: string; formId: string; rev: number }, op: CarrierOp, by: CarrierBy, payload: unknown) {
  return authorize({ host: ctx.host, workspaceId: at.workspaceId, target: { formId: at.formId }, op, rev: at.rev, by, payload })
}

/** What a fresh read changes on the row: the page is the truth for title, questions and settings. */
export function readPatch(read: FormRead): Partial<MsFormRow> {
  return {
    title: read.title || 'Untitled form',
    questions: read.questions,
    settings: read.settings,
    readAt: Date.now(),
    ...(read.signedInAs ? { signedInAs: read.signedInAs } : {}),
    ...(read.count !== null ? { count: read.count } : {})
  }
}

/** Writes a read to the row; a change made in the page (not ours) is kept as a version by the page. */
export function storeRead(ctx: MsCtx, row: MsFormRow, read: FormRead, o: { by?: Principal | 'page'; bump?: boolean; state?: MsFormRow['state']; stopped?: string | null } = {}): MsFormRow {
  const state = o.state ?? (row.state === 'draft' ? 'draft' : read.settings.accepting ? 'collecting' : 'closed')
  const closedAt = state === 'closed' ? (row.state === 'closed' ? row.closedAt : Date.now()) : null
  return new MsformsStore(ctx.db).update(row.workspaceId, row.formId, { ...readPatch(read), state, closedAt, stopped: o.stopped ?? null }, { by: o.by ?? 'page', bump: o.bump })
}

/** A carrier stop said on the row, with the page as it then stood when the stop read it. */
function stopped(ctx: MsCtx, row: MsFormRow, err: CarrierStop, by: Principal): MsFormRow {
  return err.read ? storeRead(ctx, row, err.read, { by, bump: true, stopped: err.message }) : new MsformsStore(ctx.db).update(row.workspaceId, row.formId, { stopped: err.message })
}

// ── reading ──────────────────────────────────────────────────────────

export function list(ctx: MsCtx, by: Caller, workspaceId: string): { forms: MsFormView[]; offered: boolean } {
  const { rows } = formsReached(ctx, by, workspaceId)
  return { forms: rows.map(viewOf), offered: offeredHere(ctx, by) }
}

export function get(ctx: MsCtx, by: Caller, ask: { workspaceId: string; formId: string }): MsFormView {
  return viewOf(formReach(ctx, by, ask).row)
}

/** What a Forms ticket is asked with: the tenant and the id; main builds the address. */
export function page(ctx: MsCtx, by: Caller, ask: { workspaceId: string; formId: string }): { tenant: string; formId: string } {
  const { row } = formReach(ctx, by, ask)
  return { tenant: row.tenant, formId: row.formId }
}

export function history(ctx: MsCtx, by: Caller, ask: { workspaceId: string; formId: string }): MsFormHistoryRow[] {
  const { row } = formReach(ctx, by, ask)
  const versions = new MsformsStore(ctx.db).versions(row.workspaceId, row.formId)
  const out: MsFormHistoryRow[] = []
  versions.forEach((v, i) => {
    const words = i === 0 ? (v.questions.length ? v.questions.map((q) => `Made with a ${questionWords(q)}`) : ['Made']) : diffQuestions(versions[i - 1].questions, v.questions)
    if (words.length) out.push({ rev: v.rev, at: v.at, by: v.by, words })
  })
  return out.reverse()
}

// ── making ───────────────────────────────────────────────────────────

/** The settings a form is made with, his tenant's rule kept unless he chose otherwise. */
const makeSettings = (s?: Partial<MsFormSettings>): MsFormSettings => ({ accepting: false, orgOnly: s?.orgOnly ?? true, recordName: s?.recordName ?? true, onePerPerson: s?.onePerPerson ?? true, ...(s?.startDate ? { startDate: s.startDate } : {}), ...(s?.endDate ? { endDate: s.endDate } : {}) })

/** The sentence when a made form may still take answers. */
export const MAY_TAKE_ANSWERS = 'The form was made but may take answers: no one has its link. Open it and turn off Accept responses, or delete it.'

/**
 * His New → Microsoft form, or the execute of a claimed `msform.make`: the
 * carrier makes the form in the folder, turns Accept responses off first, then
 * names it and adds what was asked. The row is stored as soon as the id is
 * known, so a stop part way still leaves the form findable.
 */
export async function make(
  ctx: MsCtx,
  by: Caller,
  ask: { workspaceId: string; folder: { libraryId: string; path: string } | { at: 'file'; host: string; path: string }; title: string; description?: string; questions?: MsFormMake['questions']; settings?: Partial<MsFormSettings> },
  grant: { by: 'owner' | 'act'; madeBy: Principal }
): Promise<MsFormView> {
  const carrier = carrierOrRefuse()
  const workspace = jobOf(ctx, by, ask.workspaceId)
  const libraries = librariesFor(ctx, by)
  const asked = ask.folder
  const found = 'at' in asked ? (asked.host === ctx.host ? libraryAt(libraries, asked.path) : null) : ((l) => (l ? { library: l, inside: asked.path } : null))(libraries.find((l) => l.id === asked.libraryId))
  const library = found?.library
  const folder = found ? folderOf(found.library, found.inside) : null
  if (!library || !folder) throw new MsformsError('Microsoft forms are made in a Teams or OneDrive folder this computer reaches.')
  const folderUrl = folderPageOf(folder, library.web)
  if (!folderUrl) throw new MsformsError('Microsoft forms are made in a Teams or OneDrive folder this computer reaches.')
  const settings = makeSettings(ask.settings)
  const payload = { title: ask.title, description: ask.description ?? '', questions: ask.questions ?? [], settings, folder: { libraryId: folder.libraryId, path: folder.path } }
  const auth = authorize({ host: ctx.host, workspaceId: workspace.id, target: { folder: { libraryId: folder.libraryId, path: folder.path } }, op: 'make', rev: 0, by: grant.by, payload })
  const store = new MsformsStore(ctx.db)
  const keep = (formId: string): MsFormRow =>
    store.get(workspace.id, formId) ??
    store.create({ workspaceId: workspace.id, formId, tenant: folder.tenant, sector: workspace.sector, title: ask.title, folder: { libraryId: folder.libraryId, path: folder.path, siteUrl: folder.siteUrl, label: folder.label }, madeBy: grant.madeBy })
  try {
    const { read } = await carrier.make(auth, { workspaceId: workspace.id, folderUrl, title: ask.title, description: ask.description ?? '', questions: ask.questions ?? [], settings })
    const row = keep(read.formId)
    // A draft only once a fresh read shows Accept responses off.
    return announce(ctx, storeRead(ctx, row, read, { by: grant.madeBy, state: 'draft', stopped: read.settings.accepting ? MAY_TAKE_ANSWERS : null }))
  } catch (err) {
    if (err instanceof CarrierStop && err.formId) {
      const row = keep(err.formId)
      const after = err.read ? storeRead(ctx, row, err.read, { by: grant.madeBy, state: 'draft', stopped: err.message }) : store.update(workspace.id, err.formId, { stopped: err.message, settings: { ...row.settings, accepting: true } })
      announce(ctx, after)
      throw Object.assign(new MsformsError(err.message), { formId: err.formId })
    }
    throw err
  }
}

// ── collecting ───────────────────────────────────────────────────────

/** The form in words as people will see it: the held card's body. */
export function formWords(title: string, questions: readonly MsAnyQuestion[], settings: MsFormSettings, description = ''): string {
  const lines = [title]
  if (description.trim()) lines.push(description.trim())
  lines.push('')
  let n = 0
  for (const q of questions) lines.push(q.type === 'section' ? `— ${q.title}` : `${++n}. ${questionWords(q)}`)
  lines.push('', settingsWords(settings))
  return lines.join('\n').trim()
}

/** Holds Collect responses (or a change of who can answer, or a reopen) for his press. One held at this rev is the one. */
export function holdPublish(ctx: MsCtx, at: Reached, act: MsFormPublish['act'], settings: MsFormSettings, sessionId: string | null): { view: MsFormView; held: HeldItem | null } {
  const { row } = at
  if (act === 'collect' && row.state === 'collecting') throw new MsformsError(`${row.title} is collecting responses already.`)
  if (act === 'reopen' && row.state !== 'closed') throw new MsformsError(`${row.title} is not closed.`)
  if (!row.questions.some((q) => q.type !== 'section')) throw new MsformsError('A form needs a question before it collects responses.')
  if (row.held && row.held.rev === row.rev) return { view: viewOf(row), held: null }
  const payload: MsFormPublish = { workspaceId: row.workspaceId, formId: row.formId, rev: row.rev, title: row.title, act, settings, content: formWords(row.title, row.questions, settings) }
  const held = ctx.held.create({ kind: 'msform.publish', sessionId, payload })
  const store = new MsformsStore(ctx.db)
  const next = held.state === 'held' ? store.update(row.workspaceId, row.formId, { held: { ref: held.ref, rev: row.rev } }) : (store.get(row.workspaceId, row.formId) ?? row)
  return { view: announce(ctx, next), held }
}

/** His close or reopen: Accept responses off, or on again. A reopen by an agent is held elsewhere; this is his press. */
export async function setOpen(ctx: MsCtx, at: Reached, open: boolean, by: CarrierBy, madeBy: Principal): Promise<MsFormView> {
  const { row } = at
  if (row.state === 'draft') throw new MsformsError(open ? 'A draft collects responses with Collect responses.' : `${row.title} is not collecting responses.`)
  const carrier = carrierOrRefuse()
  try {
    const { read } = await carrier.close(authFor(ctx, row, 'close', by, { open }), row.formId, open)
    return announce(ctx, storeRead(ctx, row, read, { by: madeBy, state: read.settings.accepting ? 'collecting' : 'closed' }))
  } catch (err) {
    if (err instanceof CarrierStop) {
      announce(ctx, stopped(ctx, row, err, madeBy))
      throw new MsformsError(err.message)
    }
    throw err
  }
}

// ── his other presses ────────────────────────────────────────────────

export function setMode(ctx: MsCtx, at: Reached, mode: MsFormRow['mode']): MsFormView {
  return announce(ctx, new MsformsStore(ctx.db).update(at.row.workspaceId, at.row.formId, { mode }))
}

export function setCheck(ctx: MsCtx, at: Reached, every: MsFormCheck): MsFormView {
  return announce(ctx, new MsformsStore(ctx.db).update(at.row.workspaceId, at.row.formId, { check: every }))
}

export function markSeen(ctx: MsCtx, at: Reached): MsFormView {
  return announce(ctx, new MsformsStore(ctx.db).update(at.row.workspaceId, at.row.formId, { seenCount: at.row.count }))
}

/** An agent's change waiting for his Accept, in words against the form as it stands. */
export function suggestionOf(change: MsChange, list: readonly MsAnyQuestion[], by: Principal, reason?: string): MsSuggestion {
  return { id: randomBytes(6).toString('base64url'), change, words: changeWords(change, list), ...(reason ? { reason } : {}), by, at: Date.now() }
}

/**
 * Runs changes through the carrier's `write`, then stores the page as read.
 * A stop says what was done; the row keeps the page as the stop read it.
 */
export async function writeChanges(ctx: MsCtx, row: MsFormRow, changes: readonly MsChange[], grant: CarrierBy, madeBy: Principal): Promise<MsFormRow> {
  if (!changes.length) return row
  for (const c of changes) if (c.op !== 'add' && row.questions[c.at] && isOther(row.questions[c.at])) throw new MsformsError(`"${row.questions[c.at].title}" is a kind of question only the Forms page changes.`)
  // The list as it will stand, so a change that names no question is refused before the page is touched.
  changes.reduce<MsAnyQuestion[]>((list, c) => applyChange(list, c), [...row.questions])
  const carrier = carrierOrRefuse()
  try {
    const { read } = await carrier.write(authFor(ctx, row, 'write', grant, { changes, before: row.questions }), row.formId, changes, row.questions)
    return storeRead(ctx, row, read, { by: madeBy, bump: true })
  } catch (err) {
    if (err instanceof CarrierStop) throw Object.assign(new MsformsError(err.message), { row: stopped(ctx, row, err, madeBy) })
    if (err instanceof CarrierRefused) throw new MsformsError(err.message)
    throw err
  }
}

/** His Accept and Reject of waiting changes: Accept runs the carrier's `write` with exactly those changes. */
export async function review(ctx: MsCtx, at: Reached, accept: readonly string[], reject: readonly string[]): Promise<MsFormView> {
  const store = new MsformsStore(ctx.db)
  const { row } = at
  const ids = new Set([...accept, ...reject])
  const chosen = row.suggestions.filter((s) => accept.includes(s.id))
  const left = row.suggestions.filter((s) => !ids.has(s.id))
  if (!chosen.length) return announce(ctx, store.update(row.workspaceId, row.formId, { suggestions: left }))
  // Each change was worded against the list as it stood when suggested; they run in order on the page as it stands.
  try {
    await writeChanges(ctx, { ...row, suggestions: left }, chosen.map((s) => s.change), 'owner', 'owner')
    return announce(ctx, store.update(row.workspaceId, row.formId, { suggestions: left }))
  } catch (err) {
    const kept = (err as { row?: MsFormRow }).row
    if (kept) announce(ctx, store.update(row.workspaceId, row.formId, { suggestions: left }))
    throw err
  }
}
