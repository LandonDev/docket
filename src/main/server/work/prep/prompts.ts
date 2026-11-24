import type { PrepLine, PrepPage, PrepTask } from '@shared/contract-work-prep'

export const briefTitle = (title: string): string => `Prepare: ${title}`
export const followTitle = (title: string): string => `Follow up: ${title}`

const day = (at: number): string => new Date(at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
const time = (at: number): string => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const lineWords = (line: PrepLine): string => line.ref ? `${line.text} (${line.ref.table} ${line.ref.id})` : line.text

function taskWords(task: PrepTask): string {
  const why = task.who && task.why ? `, ${task.why === 'asked' ? 'asked by' : 'waiting on'} ${task.who}` : ''
  const due = task.dueAt === undefined ? '' : `, due ${day(task.dueAt)}`
  return `${task.title}${why}${due} (task ${task.id})`
}

/** The facts and the words kept on the page, for a thread to read. */
export function pageWords(page: PrepPage): string {
  const { event, people, tasks, files, last, doc } = page
  const lines = [
    `Meeting: ${event.title} (event ${event.id})`,
    `When: ${day(event.startsAt)}${event.allDay ? ', all day' : ` at ${time(event.startsAt)}`}`
  ]
  if (event.endsAt !== undefined && !event.allDay) lines.push(`Ends: ${day(event.endsAt)} at ${time(event.endsAt)}`)
  if (event.location) lines.push(`Place: ${event.location}`)
  const section = (heading: string, entries: string[]) => {
    if (entries.length) lines.push('', `${heading}:`, ...entries.map((entry) => `- ${entry}`))
  }
  section('People', people.map((person) => [
    person.address && person.address !== person.name ? `${person.name} <${person.address}>` : person.name,
    ...(person.declined ? ['declined'] : []),
    ...(person.mail ? [`newest mail “${person.mail.subject}” (mail thread ${person.mail.id})`] : [])
  ].join(', ')))
  section('Open tasks', tasks.map(taskWords))
  section('Files', files.map((file) => file.url ? `${file.title} ${file.url}` : file.title))
  if (last) {
    lines.push('', `Last time: ${last.title}, ${day(last.startsAt)} (event ${last.eventId})`)
    section('Decided', last.decided.map(lineWords))
    section('Open', last.open.map(lineWords))
    section('Tasks from last time', last.tasks.map(taskWords))
  }
  if (doc.brief) {
    section('Brief', doc.brief.matters.map(lineWords))
    section('Already agreed', doc.brief.agreed.map(lineWords))
  }
  if (page.notesFile?.kind === 'meeting') {
    lines.push('', page.notesFile.error ? `His notes were a recording or a transcript this host could not read: ${page.notesFile.error}` : `His notes are a recording or a transcript, open beside this thread as meeting ${page.notesFile.itemId}. Read it with meeting_read.`)
  }
  if (page.notesFile?.kind === 'document') {
    lines.push('', page.notesFile.itemId ? `His notes are the document “${page.notesFile.title}”, open beside this thread as item ${page.notesFile.itemId}. Read it with doc_read.` : `His notes are the document “${page.notesFile.title}” in the workspace’s folder.`)
  }
  if (doc.notes?.text) lines.push('', 'His notes:', doc.notes.text)
  section('Follow-up mail already waiting for his press in the Outbox', page.drafts.map((draft) => `“${draft.subject}”${draft.to.length ? ` to ${draft.to.join(', ')}` : ''}`))
  // An empty list read from a failed lookup is not "no mail": a thread told so drafts none.
  if (page.problems.includes('drafts')) lines.push('', 'Whether a follow-up mail already waits in the Outbox could not be read just now.')
  if (doc.after) {
    lines.push('', 'Outcome:')
    section('Summary', doc.after.summary.map(lineWords))
    section('Decisions', doc.after.decisions.map(lineWords))
    section('Open questions', doc.after.questions.map(lineWords))
    section('Suggested tasks', doc.after.tasks.map((task) => {
      const due = task.due === undefined ? '' : `, due ${day(task.due)}`
      return `${task.title}${task.who ? `, ${task.who}` : ''}${due} (${task.state}${task.lifeosTaskId ? `, task ${task.lifeosTaskId}` : ''})`
    }))
  }
  return lines.join('\n')
}

export function briefMessage(page: PrepPage): string {
  return [
    pageWords(page),
    'Read the newest mail with each person using read_mail_thread, and read the open tasks. Look for what changed since last time.',
    'Call prep_write for this event with the few things he should know or decide walking in. Put at most five things in matters, one line each. Use agreed only when no earlier page says it.',
    'Send nothing and add no task. End with the brief as your last message.'
  ].join('\n\n')
}

/**
 * One mail a meeting: a second follow-up drafts none beside the one the page already lists, and the page is read
 * again just before, since another thread may have drafted one since this one started.
 */
const MAIL = 'Just before any mail, call prep_read once more. If it lists a follow-up mail already waiting, or says it could not read whether one waits, draft none. Otherwise draft one to the people with addresses using draft_mail. It waits for his press. Never send it.'

export function followMessage(page: PrepPage, opts: { recording?: boolean; document?: boolean } = {}): string {
  return [
    pageWords(page),
    opts.document
      ? 'His notes are in a document that is being opened beside you. Call prep_read: it names the item. Read it with doc_read, and change nothing in it. Call prep_follow_up for this event with what was decided, what is still open, and the tasks. Suggest no task the page already lists as open, and no open question that a task you suggest settles. Never call add_task.'
      : opts.recording
      ? 'The meeting’s recording or transcript is being opened beside you as a meeting, and transcribed on this host if it is a recording. Call prep_read first: it waits until the file has arrived and names the meeting. Then read it with meeting_read, which waits while it is transcribed. If it could not be read, say why and stop: write no outcome and draft no mail. Otherwise call prep_follow_up for this event with what was decided, what is still open, and the tasks. Suggest no task the page already lists as open, and no open question that a task you suggest settles. Write the tasks with prep_follow_up alone: write no actions with meeting_notes, or each task would be suggested twice. Never call add_task.'
      : 'Use his notes. Call prep_follow_up for this event with what was decided, what is still open, and the tasks. Suggest no task the page already lists as open, and no open question that a task you suggest settles. Never call add_task.',
    MAIL,
    'End with the outcome as your last message.'
  ].join('\n\n')
}

/** Asked of a follow-up thread that stopped before it wrote, whose notes are the meeting open beside it. */
export function followAgainMessage(page: PrepPage): string {
  return [
    'He asked for this meeting’s follow-up again. The page as it stands now:',
    pageWords(page),
    'Read the meeting beside you with meeting_read. Call prep_follow_up for this event with what was decided, what is still open, and the tasks. Suggest no task the page already lists as open, and no open question that a task you suggest settles. Write the tasks with prep_follow_up alone, and never call add_task.',
    MAIL,
    'End with the outcome as your last message.'
  ].join('\n\n')
}

/** Told to a follow-up thread still at work when he changed his notes and pressed Follow up again: it started from the old ones. */
export function followNotesMessage(page: PrepPage): string {
  return [
    'He changed his notes for this meeting after you started. The page as it stands now:',
    pageWords(page),
    'Write the outcome again from these notes with prep_follow_up for this event: what was decided, what is still open, and the tasks. Suggest no task the page already lists as open, and no open question that a task you suggest settles. Never call add_task.',
    MAIL,
    'End with the outcome as your last message.'
  ].join('\n\n')
}
