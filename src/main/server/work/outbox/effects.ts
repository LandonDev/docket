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
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

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

const day = (at: number): string => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(at)
const ROLE = { view: 'view', comment: 'comment on', edit: 'edit' } as Record<string, string>
const GOOGLE_ROLE = { reader: 'view', commenter: 'comment on', writer: 'edit' } as Record<string, string>
const ANSWER = { accept: 'you will come to', decline: 'you will not come to', tentative: 'you might come to' } as Record<string, string>

const EFFECTS: Partial<Record<ActKind, (p: P) => string | undefined>> = {
  'mail.send': (p) => {
    const m = (p?.message ?? null) as P
    if (!m) return undefined
    const from = str((m.from as P)?.address)
    const cc = arr(m.cc).length + arr(m.bcc).length
    return `Goes${from ? ` from ${from}` : ''} to ${people(arr(m.to))}${cc ? `, with ${cc} more on copy` : ''} after your undo time.`
  },
  'calendar.op': (p) => {
    const title = str(p?.eventTitle) ?? str((p?.payload as P)?.title) ?? 'the event'
    const kind = str(p?.kind)
    if (kind && ANSWER[kind]) return `Tells the organizer ${ANSWER[kind]} ${title}.`
    if (kind === 'cancel') return `Cancels ${title} for everyone invited.`
    if (kind === 'update') return `Changes ${title} for everyone invited.`
    if (kind === 'propose') return `Asks the organizer to move ${title}.`
    const guests = arr((p?.payload as P)?.attendees)
    return `Sends an invite for ${title}${guests.length ? ` to ${people(guests)}` : ''}.`
  },
  'office.mail.send': (p) => {
    const to = arr(p?.to)
    const cc = arr(p?.cc).length + arr(p?.bcc).length
    const account = str(p?.account)
    const what = str(p?.replyTo) ? 'Your reply goes' : str(p?.forward) ? 'Forwards it' : 'Goes'
    return `${what} from ${account ?? 'Outlook'} to ${people(to)}${cc ? `, with ${cc} more on copy` : ''} as soon as you press.`
  },
  'office.calendar.op': (p) => {
    if (p?.op === 'create') {
      const e = (p.event ?? null) as P
      return `Sends an Outlook invite for ${str(e?.subject) ?? 'the event'} to ${people(arr(e?.attendees))}.`
    }
    const answer = str(p?.answer)
    return `Tells ${str(p?.organizer) ?? 'the organizer'} ${(answer && ANSWER[answer]) ?? 'your answer to'} ${str(p?.subject) ?? 'the event'}.`
  },
  'teams.post': (p) => `Posts as you in Teams, in ${str(p?.chat) ?? 'the chat'}, where everyone in it sees it.`,
  'chat.reply': (p) => {
    const where = str(p?.to) ?? str(p?.chat)
    const source = str(p?.source)
    return `Sends as you${source ? ` in ${source[0]!.toUpperCase()}${source.slice(1)}` : ''}${where ? ` to ${where}` : ''}.`
  },
  'share.guestLink': (p) => {
    const until = typeof p?.expiresAt === 'number' ? ` until ${day(p.expiresAt)}` : ''
    return `Makes a link ${str(p?.name) ?? 'your guest'} opens without signing in. They can ${ROLE[str(p?.role) ?? ''] ?? 'view'} ${str(p?.title) ?? 'it'}${until}.`
  },
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
  'file.act': () => 'Changes files in a place others can open, the moment you press.'
}

/** The sentence for an item: the kind's own, else the table's, else the plain line. Never throws. */
export function effectOf(kind: ActKind, payload: unknown, own?: (p: unknown) => string): string {
  try {
    const said = own?.(payload) ?? EFFECTS[kind]?.((payload ?? null) as P)
    if (said) return said
  } catch {
    // a payload the words cannot read: the plain line
  }
  return PRIVATE_CHANGE_KINDS.has(kind) ? PRIVATE_EFFECT : PLAIN
}
