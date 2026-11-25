import type { ActKind } from '@shared/work'
import { PRIVATE_CHANGE_KINDS } from './words'

/**
 * What a press on a held item does, in one sentence he reads before he
 * presses (docs/agents/work-outbox.md "The press"): who it reaches, as whom,
 * and when. A kind may say it itself (`ActKindDef.effect`); else the words
 * here, read from the payload as held; else a plain line. A change to a file
 * others can open gets its full sentence only on his press's screens
 * (index.ts `seenBy` puts `PRIVATE_EFFECT` in its place for any other caller).
 */

export const PRIVATE_EFFECT = 'Changes a file others can open.'
const PLAIN = 'Carries this out as you.'

type P = Record<string, unknown> | null
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** Up to three people by name, then how many more: "Dana Lee, Sam Ortiz and 2 others". */
export function people(list: readonly unknown[]): string {
  const names = list.flatMap((a) => {
    if (typeof a === 'string') return str(a) ? [a.trim()] : []
    const o = a as { name?: unknown; address?: unknown } | null
    const n = str(o?.name) ?? str(o?.address)
    return n ? [n] : []
  })
  if (names.length <= 3) return names.length < 2 ? (names[0] ?? 'no one') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`
}

const GOOGLE_ROLE = { reader: 'view', commenter: 'comment on', writer: 'edit' } as Record<string, string>
const ANSWER = { accept: 'you will come', decline: 'you will not come', tentative: 'you might come' } as Record<string, string>

const EFFECTS: Partial<Record<ActKind, (p: P, zone: string) => string | undefined>> = {
  // Mail, posts and replies draw their From, To and place right under the sentence: it says only when, and who sees it.
  'mail.send': (p) => (p?.message ? 'Goes as your mail after your undo time.' : undefined),
  // An invite's title, time and guests are drawn under the sentence: it says who hears it and as whom.
  'calendar.op': (p) => {
    const kind = str(p?.kind)
    if (kind && ANSWER[kind]) return `Tells the organizer ${ANSWER[kind]}.`
    if (kind === 'cancel') return 'Cancels it for everyone invited.'
    if (kind === 'update') return 'Changes it for everyone invited.'
    if (kind === 'propose') return 'Asks the organizer to move it.'
    return 'Sends the invite as you; each guest gets it.'
  },
  'office.mail.send': (p) => `${str(p?.replyTo) ? 'Your reply goes' : str(p?.forward) ? 'The forward goes' : 'Goes'} from Outlook as soon as you press.`,
  'office.calendar.op': (p) => {
    if (p?.op === 'create') return 'Sends the Outlook invite as you; each guest gets it.'
    const answer = str(p?.answer)
    return `Tells ${str(p?.organizer) ?? 'the organizer'} ${(answer && ANSWER[answer]) ?? 'your answer'}.`
  },
  'teams.post': () => 'Posts as you; everyone in the chat sees it.',
  'chat.reply': () => 'Sends as you; everyone in the conversation sees it.',
  // Who, what they can do and until when are its fields: the sentence says what a link means.
  'share.guestLink': () => 'Anyone with the link opens it without signing in.',
  'share.google': (p) =>
    `Lets ${str(p?.email) ?? 'them'} ${GOOGLE_ROLE[str(p?.role) ?? ''] ?? 'open'} ${str(p?.name) ?? 'the file'} in Google Drive${p?.notify ? ', and Google mails them' : ''}.`,
  'form.publish': (p) => `Publishes ${str(p?.title) ?? 'the form'}: anyone with its link can answer.`,
  'frameio.post': (p) => (p?.what === 'version' ? `Uploads ${str(p.name) ?? 'the file'} to Frame.io, where everyone on the project sees it.` : 'Posts your comment in Frame.io, where everyone on the project sees it.'),
  'msform.make': (p) => `Makes ${str(p?.title) ?? 'the form'} in Microsoft Forms, where its Team sees it at once${p?.collect ? ', and starts taking answers' : ''}.`,
  'msform.publish': (p) =>
    p?.act === 'audience' ? `Changes who can answer ${str(p.title) ?? 'the form'}.` : `${p?.act === 'reopen' ? 'Reopens' : 'Opens'} ${str(p?.title) ?? 'the form'} for answers.`,
  'computer.act': (p) => `Does this on the screen${str((p?.app as P)?.name) ? ` in ${str((p!.app as P)!.name)}` : ''}: ${str(p?.label) ?? 'the step shown'}.`,
  // The act in his words ("Uses Purdue mail to send mail as you."), never the tool's description of itself.
  'addon.call': (p) => {
    const act = str(p?.words) ?? str(p?.tool)
    return `Uses ${str(p?.addon) ?? 'the add-on'} to ${act ? act[0]!.toLowerCase() + act.slice(1) : 'do this'} as you.`
  },
  'office.edit': (p) => `Changes ${str(p?.name) ?? 'the file'} for everyone who can open it, the moment you press.`,
  'google.edit': (p) => `Changes ${str(p?.name) ?? str(p?.title) ?? 'the file'} in Google for everyone who can open it, the moment you press.`,
  'file.act': (p) => `Changes ${Array.isArray(p?.things) && p.things.length === 1 ? 'a file' : 'files'} in a place others can open, the moment you press.`
}

/** The sentence for an item: the kind's own, else the table's, else the plain line; a date on `zone`'s wall clock (his). Never throws. */
export function effectOf(kind: ActKind, payload: unknown, zone: string, own?: (p: unknown) => string, scheduled = false): string {
  // The time he set leads the item: the sentence says only as whom ("as soon as you press" would be untrue).
  if (scheduled) return 'Sends as you.'
  try {
    const said = own?.(payload) ?? EFFECTS[kind]?.((payload ?? null) as P, zone)
    if (said) return said
  } catch {
    // a payload the words cannot read: the plain line
  }
  return PRIVATE_CHANGE_KINDS.has(kind) ? PRIVATE_EFFECT : PLAIN
}
