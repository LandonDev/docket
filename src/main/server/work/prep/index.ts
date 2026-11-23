import { PREP_UPCOMING_MAX_MS, PREP_WORKING_MS, type PrepAddedPerson, type PrepPage } from '@shared/contract-work-prep'
import { errorText, handled, NOT_HANDLED, type CanvasSource } from '@shared/work'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { aheadOf, setAhead } from './ahead'
import { decideTasks } from './after'
import { eventOf, fileTitle, gather, meetingOf, standing, startDoc, upcoming } from './gather'
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

/** The starter the notes document is made from; his own template saved as "Meeting notes" takes its place (work-templates.md). */
export const NOTES_TEMPLATE = 'any/meeting-notes'

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

async function setNotes(ctx: WorkCtx, workspaceId: string, eventId: string, text: string, dropFile = false): Promise<PrepPage> {
  const event = await eventOf(ctx, workspaceSector(ctx, workspaceId), eventId)
  const { row, last } = standing(new PrepStore(ctx.db), workspaceId, event)
  const at = Date.now()
  const doc = row?.doc ?? startDoc(last)
  const words = text.trim()
  // A file that holds the notes stays when the words beside it change or go, unless the window says it never arrived.
  const { file, meetingItemId } = dropFile ? ({} as { file?: undefined; meetingItemId?: undefined }) : (doc.notes ?? {})
  const notes = words || file || meetingItemId ? { text: words, at, ...(file ? { file } : {}), ...(meetingItemId ? { meetingItemId } : {}) } : null
  writePage(ctx, workspaceId, event, last, { ...doc, notes }, at)
  return (await gather(ctx, workspaceId, eventId, at)).page
}

/**
 * Write in a document: the meeting's notes file, made from the job's Meeting
 * notes template in the workspace's own folder and kept as the page's notes.
 * Made once: a second ask answers the same file. His press, so Files' door
 * judges it as his.
 */
async function makeNotesDoc(ctx: WorkCtx, by: Caller, workspaceId: string, eventId: string, today?: string): Promise<{ page: PrepPage; source: CanvasSource; title: string }> {
  const event = await eventOf(ctx, workspaceSector(ctx, workspaceId), eventId)
  const { row, last } = standing(new PrepStore(ctx.db), workspaceId, event)
  const kept = row?.doc.notes?.file
  if (kept?.at === 'file') return { page: (await gather(ctx, workspaceId, eventId)).page, source: kept, title: fileTitle(kept.path) }
  // The templates pillar's own door for other pillars; loaded on the press, so prep loads without it.
  const { makeFromTemplate } = await import('../templates/api')
  const made = await makeFromTemplate(ctx, { workspaceId, template: NOTES_TEMPLATE, fields: { Meeting: event.title }, title: `${event.title} notes`, ...(today ? { today } : {}) }, by)
  const now = Date.now()
  const doc = row?.doc ?? startDoc(last)
  writePage(ctx, workspaceId, event, last, { ...doc, notes: { text: doc.notes?.text ?? '', at: now, file: made.source } }, now)
  return { page: (await gather(ctx, workspaceId, eventId, now)).page, source: made.source, title: made.source.at === 'file' ? fileTitle(made.source.path) : made.title }
}

/** Whether a meeting item holds a file to read; any doubt is no. */
const meetingHasFile = async (ctx: WorkCtx, itemId: string): Promise<boolean> => {
  const meeting = await meetingOf(ctx, itemId)
  return !!meeting && meeting.status !== 'empty'
}

async function startThread(ctx: WorkCtx, workspaceId: string, eventId: string, kind: 'brief' | 'follow', opts: { recording?: { name: string }; restart?: boolean } = {}): Promise<{ sessionId: string; itemId?: string }> {
  const gathered = await gather(ctx, workspaceId, eventId)
  const { event, row, last } = gathered
  let { page } = gathered
  const { recording } = opts
  const follow = kind === 'follow'
  // A recording that never arrived (its upload failed) is no notes: a follow-up from typed words leaves its empty meeting behind.
  const stale = follow && !recording && page.doc.notes?.meetingItemId && !(await meetingHasFile(ctx, page.doc.notes.meetingItemId)) ? page.doc.notes : null
  if (stale) {
    const { meetingItemId: _gone, ...kept } = stale
    page = { ...page, notesFile: null, doc: { ...page.doc, notes: kept.text || kept.file ? kept : null } }
  }
  if (follow && !page.doc.notes && !recording) throw new Error('Add notes first.')
  const existing = follow ? row?.followSessionId : row?.briefSessionId
  const startedAt = follow ? row?.followAt : row?.briefAt
  const writtenAt = follow ? page.doc.after?.at : page.doc.brief?.at
  const now = Date.now()
  // A thread the window knows has stopped, or one whose recording never arrived, is not waited on.
  if (!opts.restart && !stale && existing && startedAt != null && now - startedAt < PREP_WORKING_MS && (writtenAt === undefined || writtenAt < startedAt)) {
    // The thread still at work keeps its own meeting; a second recording is not opened beside it.
    return { sessionId: existing, ...(follow && page.doc.notes?.meetingItemId ? { itemId: page.doc.notes.meetingItemId } : {}) }
  }
  const title = page.event.title
  const notesDoc = page.doc.notes?.file
  const sessionId = await ctx.threads.start({
    workspaceId,
    title: follow ? followTitle(title) : briefTitle(title),
    about: { kind: 'event', label: title, ref: { at: 'lifeos', table: 'events', id: eventId } },
    text: follow ? followMessage(page, { recording: !!recording, document: !recording && notesDoc?.at === 'file' }) : briefMessage(page)
  })
  if (!recording) {
    writePage(ctx, workspaceId, event, last, page.doc, now, { [kind]: sessionId })
    if (follow && notesDoc?.at === 'file') {
      // His notes document, beside the thread that reads it; a host whose canvas cannot open it still has the thread.
      try {
        ctx.canvas.open(ctx.canvas.paneOf(sessionId), 'document', notesDoc, fileTitle(notesDoc.path))
      } catch (err) {
        ctx.log(`prep: the notes document did not open beside its thread: ${errorText(err)}`)
      }
    }
    return { sessionId }
  }
  // An empty meeting in the new thread's own pane: the window puts his file there through the meetings pillar's start,
  // so the recording lands on this host and nowhere else, and the thread reads it with meeting_read.
  let itemId: string | undefined
  try {
    itemId = ctx.canvas.open(ctx.canvas.paneOf(sessionId), 'meeting', { at: 'thread' }, recording.name).id
  } finally {
    // The thread is his either way: the page names it even when the meeting could not be opened.
    const notes = itemId ? { text: page.doc.notes?.text ?? '', at: now, meetingItemId: itemId } : page.doc.notes
    writePage(ctx, workspaceId, event, last, { ...page.doc, notes }, now, { follow: sessionId })
  }
  return { sessionId, itemId }
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
        const recording = req.method === 'work.prep.followUp' ? req.params.recording : undefined
        const restart = req.params.restart === true
        return handled(await changeInOrder(ctx, [workspaceId, eventId], () => startThread(ctx, workspaceId, eventId, kind, { ...(recording ? { recording } : {}), restart })))
      }
      case 'work.prep.notesDoc': {
        mustBePerson(by)
        const { workspaceId, eventId, today } = req.params
        return handled(await changeInOrder(ctx, [workspaceId, eventId], () => makeNotesDoc(ctx, by, workspaceId, eventId, today)))
      }
      case 'work.prep.notes': {
        mustBePerson(by)
        const { workspaceId, eventId, text, dropFile } = req.params
        return handled({ page: await changeInOrder(ctx, [workspaceId, eventId], () => setNotes(ctx, workspaceId, eventId, text, dropFile === true)) })
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
