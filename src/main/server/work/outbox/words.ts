import type { HeldRow } from './store'

/**
 * What a Work thread is told about a held act (docs/agents/work-outbox.md).
 * Each line is the app's own note to the thread, never the owner's message
 * and never a failure: a held act is a finished step.
 */

const CARRY_ON = 'This is a finished step, not a failure. Do not ask the owner to press, and do not look for another way to do it. Carry on with the rest.'

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

/** The answer when a standing grant let the act go at once. */
export const grantedLine = (row: Pick<HeldRow, 'n' | 'summary'>, label: string): string =>
  `Item ${row.n} (${row.summary}) went at once under the owner's standing grant "${label}".`

export const REFUSED_OFF = 'The owner turned this tool off for Work threads. It was not called. Carry on without it.'
export const REFUSED_NO_HOLD = 'refused: nothing on this host can hold this act for the owner, so it was not carried out'

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** What the thread hears when the owner (or a grant) carried a held act out. `detail` is what came back, when the thread needs it to go on. */
export function sentNote(row: Pick<HeldRow, 'n' | 'summary' | 'decidedBy'>, detail?: string): string {
  const who = row.decidedBy?.startsWith('grant:') ? "A standing grant of the owner's sent" : 'The owner sent'
  const head = `${who} held item ${row.n} (${row.summary}).`
  return detail?.trim() ? `${head} What came back:\n${cut(detail.trim(), 8_000)}` : head
}

export const failedNote = (row: Pick<HeldRow, 'n' | 'summary' | 'error'>): string =>
  `Held item ${row.n} (${row.summary}) could not be carried out: ${row.error ?? 'it failed'}. It still waits in the owner's Outbox. Do not try another way to do it.`

export const discardedNote = (row: Pick<HeldRow, 'n' | 'summary'>): string =>
  `The owner discarded held item ${row.n} (${row.summary}). It will not go. Do not send it another way.`

export const staleNote = (row: Pick<HeldRow, 'n' | 'summary' | 'error'>): string =>
  `Held item ${row.n} (${row.summary}) can no longer be carried out as it was shown: ${row.error ?? 'the screen moved on'}. If it is still needed, do the step again; it will be held again.`

/** The notice a phone or a desktop shows for a new held item: "Held", then the act in his words. Never a raw tool name. */
export const heldNotice = (summary: string): string => `Held: ${cut(summary, 140)}`

/**
 * The held kinds whose words are an agent's proposed change to a file others can open (`office.edit`, `google.edit`):
 * what they would write is shown to his press alone (files/policy.ts `pressesFor`). A notice, a digest row, a webhook
 * and a caller that may not approve read this instead, with the item's link: no file name, no old words, no new ones.
 */
export const PRIVATE_CHANGE_KINDS: ReadonlySet<string> = new Set(['office.edit', 'google.edit'])
export const PRIVATE_CHANGE = 'a change to a file others can open'
/** The words a notice or a caller that may not approve gets for an item: its own, or the plain line for a private change. */
export const summaryFor = (item: { kind: string; summary: string }): string => (PRIVATE_CHANGE_KINDS.has(item.kind) ? PRIVATE_CHANGE : item.summary)
