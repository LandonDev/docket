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
  if (page.notesFile?.kind === 'meeting') lines.push('', `His notes are a recording or a transcript, open beside this thread as meeting ${page.notesFile.itemId}. Read it with meeting_read.`)
  if (page.notesFile?.kind === 'document') {
    lines.push('', page.notesFile.itemId ? `His notes are the document “${page.notesFile.title}”, open beside this thread as item ${page.notesFile.itemId}. Read it with doc_read.` : `His notes are the document “${page.notesFile.title}” in the workspace’s folder.`)
  }
  if (doc.notes?.text) lines.push('', 'His notes:', doc.notes.text)
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

export function followMessage(page: PrepPage, opts: { recording?: boolean; document?: boolean } = {}): string {
  return [
    pageWords(page),
    opts.document
      ? 'His notes are in a document that is being opened beside you. Call prep_read: it names the item. Read it with doc_read, and change nothing in it. Call prep_follow_up for this event with what was decided, what is still open, and the tasks. Suggest no task the page already lists as open, and no open question that a task you suggest settles. Never call add_task.'
      : opts.recording
      ? 'The meeting’s recording or transcript is being opened beside you as a meeting, and transcribed on this host if it is a recording. Call prep_read: it names the meeting. Then read it with meeting_read, which waits while it is transcribed; if it says there is no recording yet, the file is still on its way, so read again. Call prep_follow_up for this event with what was decided, what is still open, and the tasks. Suggest no task the page already lists as open, and no open question that a task you suggest settles. Write the tasks with prep_follow_up alone: write no actions with meeting_notes, or each task would be suggested twice. Never call add_task.'
      : 'Use his notes. Call prep_follow_up for this event with what was decided, what is still open, and the tasks. Suggest no task the page already lists as open, and no open question that a task you suggest settles. Never call add_task.',
    'Draft one follow-up mail to the people with addresses using draft_mail. It waits for his press. Never send it.',
    'End with the outcome as your last message.'
  ].join('\n\n')
}
