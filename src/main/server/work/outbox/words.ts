import type { HeldRow } from './store'

/**
 * What a Work thread is told about a held act (docs/agents/work-outbox.md).
 * Each line is the app's own note to the thread, never the owner's message
 * and never a failure: a held act is a finished step.
 */

/**
 * The one tail of every held answer, whichever pillar held it: a finished step, what to tell the owner, and no
 * second way round. The head ("Held as item N: … It waits for the owner's press.") is read by the desktop's
 * ApprovalCard and the phone's `OutboxModel.heldOf`: keep it as it is.
 */
const CARRY_ON = "This is a finished step, not a failure: tell the owner it waits in his Outbox, do not look for another way to do it, and carry on."
/** What has not happened yet, said right after the head: an act that sends, posts, shares or books, and a change to a file others can open. */
export const NOT_SENT = 'Nothing was sent.'
export const NOT_CHANGED = 'The file has not changed.'

/** The answer to the tool call that was held. */
export function heldLine(row: Pick<HeldRow, 'n' | 'summary' | 'why'>): string {
  const why =
    row.why === 'unreviewed'
      ? " The owner has not yet said which of this add-on's tools may run by themselves, so every call to it is held until then."
      : row.why === 'screen'
        ? ' The app read this step on the screen as one that sends, posts, pays, deletes or the like.'
        : ''
  return `Held as item ${row.n}: ${row.summary}. It waits for the owner's press.${why} ${CARRY_ON}`
}

/**
 * What a pillar's tool answers for an act it held with `ctx.held.create`: the same head and tail as `heldLine`, with
 * what has not happened (`NOT_SENT` unless the pillar names more, "Nothing was shared."). A grant he made may have
 * let it go at once: then it says so.
 */
export function heldReceipt(item: { n?: number | null; summary: string; state: string }, notYet: string = NOT_SENT): string {
  const numbered = item.n != null
  if (item.state !== 'held') return `${numbered ? `Item ${item.n}` : 'This'} (${item.summary}) went at once under a standing grant of the owner's (${item.state}).`
  return `Held${numbered ? ` as item ${item.n}` : ''}: ${item.summary}. It waits for the owner's press. ${notYet} ${CARRY_ON}`
}

/** The answer when a standing grant let the act go at once. */
export const grantedLine = (row: Pick<HeldRow, 'n' | 'summary'>, label: string): string =>
  `Item ${row.n} (${row.summary}) went at once under the owner's standing grant "${label}".`

export const REFUSED_OFF = 'The owner turned this tool off for Work threads. It was not called. Carry on without it.'
export const REFUSED_NO_HOLD = 'refused: the Outbox on this host could not hold this act for the owner, so nothing was carried out and nothing waits. Tell the owner the hold failed; do not try another way.'

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/**
 * What a thread is told of its held item, as the app's own note in its transcript, which a key that may only read
 * the thread reads too: a change to a file others can open is named by its number and the plain line alone (round 3),
 * never its file, its words or a reason that could quote them. The thread made it, and knows what it proposed.
 */
type Told = Pick<HeldRow, 'n' | 'summary' | 'kind'>
const toldAs = (row: Told): string => (PRIVATE_CHANGE_KINDS.has(row.kind) ? PRIVATE_CHANGE : row.summary)
const whyOf = (row: Told & Pick<HeldRow, 'error'>, otherwise: string): string =>
  PRIVATE_CHANGE_KINDS.has(row.kind) ? 'the file is not as it was when it was held' : (row.error ?? otherwise)

/** What the thread hears when the owner (or a grant) carried a held act out. `detail` is what came back, when the thread needs it to go on. */
export function sentNote(row: Told & Pick<HeldRow, 'decidedBy'>, detail?: string): string {
  const who = row.decidedBy?.startsWith('grant:') ? "A standing grant of the owner's sent" : 'The owner sent'
  const head = `${who} held item ${row.n} (${toldAs(row)}).`
  return detail?.trim() ? `${head} What came back:\n${cut(detail.trim(), 8_000)}` : head
}

/**
 * What the thread hears when the owner (or a grant) released a mail or calendar act LifeOS holds: LifeOS took it and
 * holds it (a mail for his undo time, a calendar act until the calendar takes it). Only what is known, and no promise:
 * the act is his from here.
 */
export function queuedNote(row: Told & Pick<HeldRow, 'decidedBy'>): string {
  const who = row.decidedBy?.startsWith('grant:') ? "A standing grant of the owner's queued" : 'The owner queued'
  const when = row.kind === 'calendar.op' ? 'it is made once the calendar takes it' : 'it goes after his undo time unless he takes it back'
  return `${who} held item ${row.n} (${toldAs(row)}) in LifeOS: ${when}. It is his now; do not send, draft or schedule it again.`
}

export const failedNote = (row: Told & Pick<HeldRow, 'error'>): string =>
  `Held item ${row.n} (${toldAs(row)}) could not be carried out: ${whyOf(row, 'it failed')}. It still waits in the owner's Outbox. Do not try another way to do it.`

/** His reason goes to the thread as he wrote it, but never for a change to a file others can open, whose thread's transcript a reader may see. */
export const discardedNote = (row: Told & Partial<Pick<HeldRow, 'decidedBy' | 'reason'>>): string => {
  const where = row.decidedBy === 'owner:remote' ? ' from another device' : ''
  const why = row.reason && !PRIVATE_CHANGE_KINDS.has(row.kind) ? `: "${cut(row.reason.replace(/\s+/g, ' ').trim(), 500)}"` : ''
  return `The owner discarded held item ${row.n} (${toldAs(row)})${where}${why}. It will not go. Do not send it another way.`
}

/** A LifeOS mail he took back in its undo time: the thread heard it was queued, so it hears it waits again. */
export const takenBackNote = (row: Told): string => `The owner took back held item ${row.n} (${toldAs(row)}) before it went. It waits in his Outbox again. Do not send it another way.`

/** The reason an item put away by Ask the thread again carries. */
export const OUT_OF_DATE = 'out of date'

/** What wakes a thread when he asks it to redo an item that went out of date. */
export const askAgainNote = (row: Told & Pick<HeldRow, 'error'>): string =>
  `The owner asks you to redo held item ${row.n} (${toldAs(row)}): it went out of date because ${PRIVATE_CHANGE_KINDS.has(row.kind) ? 'the file is not as it was when it was held' : (row.error ?? 'what it was made from moved on').replace(/\.$/, '')}. Draft it again from what is true now; it will be held again for his press.`

export const staleNote = (row: Told & Pick<HeldRow, 'error'>): string =>
  `Held item ${row.n} (${toldAs(row)}) can no longer be carried out as it was shown: ${whyOf(row, 'the screen moved on')}. If it is still needed, ${PRIVATE_CHANGE_KINDS.has(row.kind) ? 'read the file again and propose it again' : 'do the step again'}; it will be held again.`

/** The notice a phone or a desktop shows for a new held item: "Held", then the act in his words. Never a raw tool name. */
export const heldNotice = (summary: string): string => `Held: ${cut(summary, 140)}`

/**
 * The held kinds whose words are an agent's proposed change to a file others can open (`office.edit`, `google.edit`,
 * and `file.act`, whose summary names the name it would give): what they would write is shown to his press alone
 * (files/policy.ts `pressesFor`). A notice, a digest row, a webhook and a caller that may not approve read this
 * instead, with the item's link: no file name, no old words, no new ones, and no error that could quote them.
 */
export const PRIVATE_CHANGE_KINDS: ReadonlySet<string> = new Set(['office.edit', 'google.edit', 'file.act'])
export const PRIVATE_CHANGE = 'a change to a file others can open'
/** What such an item's error says outside his press: that it was not made, never why in the file's own words. */
export const PRIVATE_ERROR = 'It was not made as it was shown. The reason is in the Outbox on his own screen.'
/** The words a notice or a caller that may not approve gets for an item: its own, or the plain line for a private change. */
export const summaryFor = (item: { kind: string; summary: string }): string => (PRIVATE_CHANGE_KINDS.has(item.kind) ? PRIVATE_CHANGE : item.summary)

/**
 * What a tool answers its thread when it held a change to a file others can open (round 3): the item's number and the
 * plain line, since the thread's transcript is read by whatever may read the thread. The thread knows its own words.
 */
export function heldChange(item: { n?: number | null; ref?: { id: string } }, also = ''): string {
  const id = item.n ?? item.ref?.id
  return `Held${id !== undefined ? ` as item ${id}` : ''}: ${PRIVATE_CHANGE}. It waits for the owner's press. ${NOT_CHANGED}${also ? ` ${also}` : ''} Nobody else sees it before he approves it. ${CARRY_ON}`
}

/** What a tool answers for an edit it left as suggestions in the file's own editor (a document, a sheet, a deck): not in the Outbox, and not in the file. */
export const suggestedIn = (where: 'document' | 'sheet' | 'deck' | 'workbook' | 'PDF', what: string): string =>
  `Suggested in the ${where}: ${what}. ${NOT_CHANGED} Tell the owner it waits there for him to accept or reject.`
