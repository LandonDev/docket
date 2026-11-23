import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ActKindDef, WorkCtx } from '../modules'
import { ActNotSent, ActStale } from '../outbox/kinds'
import { eventById, OfficeError, type OfficeCarrier } from './carrier'
import { changeWords } from '@shared/work/changeWords'
import { fileKey } from './shared'

/**
 * The office pillar's held acts (docs/agents/work-office.md "What is
 * held"): `office.mail.send` (a send, a reply, a forward through Outlook),
 * `office.calendar.op` (a meeting with others, or his answer to an
 * invitation) and `office.edit` (an agent's own change to a Word document or
 * a PowerPoint deck others can open, kept here until he approves it). An
 * agent's tool only ever makes one; the app is called in `execute`, which
 * the Outbox runs once, after his press or a grant he made from one of
 * these. Each act runs on the host it was held on, which is the host whose
 * Office carries it.
 */

const Address = z.string().trim().min(3).max(320).regex(/^[^\s@<>,;]+@[^\s@<>,;]+$/, 'an email address')

export const OfficeMailSchema = z.object({
  host: z.string(),
  account: z.string().optional(),
  to: z.array(Address).max(100),
  cc: z.array(Address).max(100).default([]),
  bcc: z.array(Address).max(100).default([]),
  subject: z.string().max(998),
  html: z.string().max(2_000_000),
  replyTo: z.string().max(200).optional(),
  forward: z.string().max(200).optional(),
  /** What Outlook puts under the body of a reply or a forward: the mail it answers or passes on, named so the Outbox shows it. */
  outlookAdds: z.string().max(1000).optional()
})
export type OfficeMail = z.infer<typeof OfficeMailSchema>

/**
 * An edit in the Outbox keeps what Outlook fixes for itself: the host it goes
 * from, the account, and the mail it answers or passes on; a reply's
 * recipients and the subject of a reply or forward too, since Outlook sets
 * those from the mail it answers. So what he edits is what goes.
 */
export function keepOfficeMail(old: OfficeMail, next: OfficeMail): OfficeMail {
  const kept: OfficeMail = { ...next, host: old.host, account: old.account, replyTo: old.replyTo, forward: old.forward, outlookAdds: old.outlookAdds }
  if (old.replyTo || old.forward) kept.subject = old.subject
  if (old.replyTo) kept.to = old.to
  return kept
}

/** What a grant may fix: the account, and every recipient by address or by domain. */
export const OfficeMailMatcherSchema = z.object({
  account: z.string().optional(),
  recipients: z.array(z.string()).optional(),
  domains: z.array(z.string()).optional()
})
export type OfficeMailMatcher = z.infer<typeof OfficeMailMatcherSchema>

const EventSchema = z.object({
  account: z.string().optional(),
  subject: z.string().min(1).max(255),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  location: z.string().max(255).optional(),
  body: z.string().max(100_000).optional(),
  attendees: z.array(Address).max(200)
})
export const OfficeCalendarSchema = z.discriminatedUnion('op', [
  z.object({ host: z.string(), op: z.literal('create'), event: EventSchema }),
  z.object({
    host: z.string(),
    op: z.literal('answer'),
    id: z.string().max(200),
    /** read from the event by its id when the act is made, never the model's word; the press checks the event still reads so */
    subject: z.string().max(255),
    start: z.string().max(40).optional(),
    /** its end and place as read then; a hold made before they were kept has neither, and its press is refused */
    end: z.string().max(40).optional(),
    location: z.string().max(1_000).optional(),
    organizer: z.string().max(320).optional(),
    answer: z.enum(['accept', 'decline', 'tentative']),
    comment: z.string().max(10_000).optional()
  })
])
export type OfficeCalendarOp = z.infer<typeof OfficeCalendarSchema>

/**
 * An agent's own change to a file others can open (the owner's ruling of 2026-11-23): nothing of it reaches
 * the file, its sync folder or its co-authors until his press, which makes it as a plain edit. With what the
 * file read as when it was suggested, so the press can say the file moved under it.
 */
export const OfficeEditSchema = z.object({
  host: z.string(),
  app: z.enum(['word', 'powerpoint']),
  /** the file's key as the carrier gave it: a path or a URL */
  key: z.string().max(4_000),
  name: z.string().max(500),
  edit: z.union([z.object({ find: z.string().min(1).max(1_000), replace: z.string().max(1_000) }), z.object({ insert: z.string().max(100_000), at: z.enum(['start', 'end']) })]),
  /** how many places held `find` then; 0 for an insert */
  places: z.number().int().min(0),
  /** `textHash` of the file's text then */
  base: z.string().max(100),
  /** held through Office in the Windows VM: his press goes there, never to this host's desktop Office */
  vm: z.literal(true).optional()
})
export type OfficeEdit = z.infer<typeof OfficeEditSchema>

/** A file's text as an edit is judged on it: a document's paragraphs, or a deck's text boxes slide by slide. */
export async function fileText(c: OfficeCarrier, app: OfficeEdit['app'], key: string): Promise<string[]> {
  return app === 'word' ? c.readDocument(key) : (await c.readSlides(key)).flatMap((s) => s.texts)
}
export const textHash = (texts: readonly string[]): string => createHash('sha256').update(JSON.stringify(texts)).digest('hex')
/** How many places hold the words. */
export const placesOf = (texts: readonly string[], find: string): number => texts.reduce((n, t) => n + t.split(find).length - 1, 0)
export const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const everyone = (m: OfficeMail): string[] => [...m.to, ...m.cc, ...m.bcc].map((a) => a.toLowerCase())
const list = (xs: string[]): string => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more`)

/**
 * HTML on its way into Outlook: nothing that runs or reaches out. The composer's own output passes
 * as it is; an agent's or a signature's script, frame, form or handler does not (M22's note).
 */
export function cleanMailHtml(html: string): string {
  const tags = 'script|style|iframe|frame|frameset|object|embed|applet|form|base|meta|link|svg|math'
  const decode = (v: string) =>
    v
      .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);?/g, (_, d: string) => String.fromCharCode(Number(d)))
      .replace(/&colon;/gi, ':')
      .replace(/&tab;|&newline;|[\u0000-\u0020]/gi, '')
  let out = html
  // Again until nothing changes: taking one tag out must not join the pieces around it into another.
  for (let prev = ''; prev !== out; ) {
    prev = out
    out = out
      .replace(new RegExp(`<(${tags})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '')
      .replace(new RegExp(`<\\/?(${tags})\\b[^>]*>`, 'gi'), '')
      .replace(/([\s/"'])on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1')
      // An image's other sources would go unseen by the preview, which names its src (the hold review): only src stays.
      .replace(/([\s/"'])(?:srcset|imagesrcset)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1')
      .replace(/\s(?:xlink:)?(?:href|src|action|formaction|background)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m: string, v: string) =>
        /^(javascript|vbscript|data):/i.test(decode(v.replace(/^["']|["']$/g, ''))) ? '' : m
      )
  }
  return out
}

/** The carrier on this host; tests and the module set it. */
export interface HeldDeps {
  carrier(): OfficeCarrier | null
  /** Office in this host's Windows VM, woken for the press */
  vm?(ctx: WorkCtx): Promise<OfficeCarrier>
}

const carrierHere = (deps: HeldDeps, host: string, here: string): OfficeCarrier => {
  if (host !== here) throw new OfficeError('This act was held for another host: it goes from there.')
  const c = deps.carrier()
  if (!c) throw new OfficeError('Outlook is not on this host.', 'not-installed')
  return c
}

export function officeActs(deps: HeldDeps): ActKindDef[] {
  const mail: ActKindDef<OfficeMail, OfficeMailMatcher> = {
    kind: 'office.mail.send',
    store: 'host',
    payload: OfficeMailSchema,
    matcher: OfficeMailMatcherSchema,
    words(p) {
      const verb = p.replyTo ? 'Reply' : p.forward ? 'Forward' : 'Send'
      const who = list([...p.to, ...p.cc])
      return { summary: `${verb}${who ? ` to ${who}` : ''}: ${p.subject || '(no subject)'}`, verb }
    },
    matches(m, p) {
      if (m.account && m.account.toLowerCase() !== (p.account ?? '').toLowerCase()) return false
      if ((!m.recipients?.length && !m.domains?.length) || everyone(p).length === 0) return false
      const people = new Set((m.recipients ?? []).map((r) => r.toLowerCase()))
      const domains = new Set((m.domains ?? []).map((d) => d.toLowerCase().replace(/^@/, '')))
      return everyone(p).every((a) => people.has(a) || domains.has(a.split('@')[1]))
    },
    keep: keepOfficeMail,
    async execute(p, ctx) {
      // A new mail held before its account was bound would go from whatever Outlook's default is now: refused, never sent blind.
      if (!p.replyTo && !p.forward && !p.account) throw new ActStale('it was held before the account it goes from was kept: ask for it again')
      const sent = await carrierHere(deps, p.host, ctx.host).sendMail({ ...p, html: cleanMailHtml(p.html) })
      const { summary } = mail.words(p)
      return { summary: summary.replace(/^(Send|Reply|Forward)/, (v) => ({ Send: 'Sent', Reply: 'Replied', Forward: 'Forwarded' })[v] ?? v), ...(sent.id ? { ref: { outlook: sent.id } } : {}) }
    },
    wayBack: () => null
  }
  const calendar: ActKindDef<OfficeCalendarOp> = {
    kind: 'office.calendar.op',
    store: 'host',
    payload: OfficeCalendarSchema,
    words(p) {
      if (p.op === 'create') return { summary: `Invite ${list(p.event.attendees)} to ${p.event.subject}`, verb: 'Send invite' }
      // A tentative answer reads as the act it is ("Answer maybe to …"), so its past is "Answered maybe", never "Maybed".
      if (p.answer === 'tentative') return { summary: `Answer maybe to ${p.subject}`, verb: 'Answer maybe' }
      const verb = p.answer === 'accept' ? 'Accept' : 'Decline'
      return { summary: `${verb} ${p.subject}`, verb }
    },
    async execute(p, ctx) {
      const c = carrierHere(deps, p.host, ctx.host)
      if (p.op === 'create') {
        if (!p.event.account) throw new ActStale('it was held before the account it goes from was kept: ask for the invitation again')
        const id = await c.createEvent(p.event)
        return { summary: `Invited ${list(p.event.attendees)} to ${p.event.subject}`, ref: { outlook: id } }
      }
      // The invitation he was shown, or nothing: an event gone or changed since is stale (milestone 50's hold review, 22).
      const event = await eventById(c, p.id)
      if (!event) throw new ActStale('the invitation is no longer in his calendar')
      // A hold that kept no start, end or place cannot say what he was shown: answer it again from the calendar.
      if (p.start === undefined || p.end === undefined || p.location === undefined) throw new ActStale('it was held before its time and place were kept: ask for the answer again')
      if (event.subject !== p.subject || event.start !== p.start || event.end !== p.end || event.location !== p.location || (p.organizer !== undefined && event.organizer !== p.organizer))
        throw new ActStale('the invitation changed since it was shown')
      await c.answerEvent(p.id, p.answer, p.comment)
      return { summary: `${p.answer === 'accept' ? 'Accepted' : p.answer === 'decline' ? 'Declined' : 'Answered maybe to'} ${p.subject}` }
    },
    wayBack: () => null
  }
  // No matcher: no grant covers an agent's change to a file others can open, and no Away releases it.
  const edit: ActKindDef<OfficeEdit> = {
    kind: 'office.edit',
    store: 'host',
    payload: OfficeEditSchema,
    words(p) {
      const e = p.edit
      const what = 'find' in e ? (e.replace ? changeWords(e.find, e.replace) : `take out "${clip(e.find)}"`) : `add "${clip(e.insert)}" at its ${e.at}`
      return { summary: `Make the change in ${p.name}: ${what}`, verb: 'Make the change' }
    },
    async execute(p, ctx) {
      if (p.host !== ctx.host) throw new OfficeError('This act was held for another host: it goes from there.')
      // The Office it was judged on: the Windows VM's, else this host's own.
      const c = p.vm ? (deps.vm ? await deps.vm(ctx) : null) : carrierHere(deps, p.host, ctx.host)
      if (!c) throw new ActNotSent('Office in the Windows VM is not set up on this host. Nothing was changed.')
      const app = p.app === 'word' ? 'Word' : 'PowerPoint'
      const key = await fileKey({ carrier: c }, p.app === 'word' ? 'document' : 'deck', p.key)
      if (key === null) throw new ActNotSent(`${p.name} is not open in ${app} on this computer: open it, then press again. Nothing was changed.`)
      const texts = await fileText(c, p.app, key)
      const moved = textHash(texts) !== p.base
      if ('find' in p.edit) {
        const now = placesOf(texts, p.edit.find)
        if (now === 0) throw new ActStale(`${p.name} changed since: the words this replaces are no longer in it. Nothing was changed`)
        if (now !== p.places) throw new ActStale(`${p.name} changed since: the words stand in ${now} places now, not the ${p.places} this was suggested for. Nothing was changed`)
      }
      let n: number
      if (p.app === 'word') n = await c.editDocument(key, p.edit, false)
      else if ('find' in p.edit) n = await c.replaceSlideText(key, p.edit.find, p.edit.replace)
      else throw new ActStale('PowerPoint takes only a find and replace')
      // What the app says it changed, when that is not what he was shown.
      const short = 'find' in p.edit && p.app === 'word' && n !== p.places ? `. ${app} changed ${n} of the ${p.places} places` : ''
      return { summary: `Changed ${p.name}${short}${moved ? '. It had changed since the suggestion; the words still stood as they did' : ''}` }
    },
    wayBack: () => null
  }
  return [mail as ActKindDef, calendar as ActKindDef, edit as ActKindDef]
}
