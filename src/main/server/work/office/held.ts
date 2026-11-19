import { z } from 'zod'
import type { ActKindDef } from '../modules'
import { OfficeError, type OfficeCarrier } from './carrier'

/**
 * The office pillar's two held acts (docs/agents/work-office.md "What is
 * held"): `office.mail.send` (a send, a reply, a forward through Outlook)
 * and `office.calendar.op` (a meeting with others, or his answer to an
 * invitation). An agent's tool only ever makes one; Outlook is called in
 * `execute`, which the Outbox runs once, after his press or a grant he made
 * from one of these. Each act runs on the host it was held on, which is the
 * host whose Outlook carries it.
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
  forward: z.string().max(200).optional()
})
export type OfficeMail = z.infer<typeof OfficeMailSchema>

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
  z.object({ host: z.string(), op: z.literal('answer'), id: z.string().max(200), subject: z.string().max(255), answer: z.enum(['accept', 'decline', 'tentative']), comment: z.string().max(10_000).optional() })
])
export type OfficeCalendarOp = z.infer<typeof OfficeCalendarSchema>

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
      .replace(/\s(?:xlink:)?(?:href|src|action|formaction|background)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m: string, v: string) =>
        /^(javascript|vbscript|data):/i.test(decode(v.replace(/^["']|["']$/g, ''))) ? '' : m
      )
  }
  return out
}

/** The carrier on this host; tests and the module set it. */
export interface HeldDeps {
  carrier(): OfficeCarrier | null
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
    async execute(p, ctx) {
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
      const verb = p.answer === 'accept' ? 'Accept' : p.answer === 'decline' ? 'Decline' : 'Maybe'
      return { summary: `${verb} ${p.subject}`, verb }
    },
    async execute(p, ctx) {
      const c = carrierHere(deps, p.host, ctx.host)
      if (p.op === 'create') {
        const id = await c.createEvent(p.event)
        return { summary: `Invited ${list(p.event.attendees)} to ${p.event.subject}`, ref: { outlook: id } }
      }
      await c.answerEvent(p.id, p.answer, p.comment)
      return { summary: `${p.answer === 'accept' ? 'Accepted' : p.answer === 'decline' ? 'Declined' : 'Answered maybe to'} ${p.subject}` }
    },
    wayBack: () => null
  }
  return [mail as ActKindDef, calendar as ActKindDef]
}
