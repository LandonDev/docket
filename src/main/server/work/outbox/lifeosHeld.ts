import { z } from 'zod'
import type { OutboxItem } from '@shared/contract-work-outbox'
import { errorText, NotBuilt, type HeldRef } from '@shared/work'
import type { ActKindDef, WorkCtx } from '../modules'
import { ActStale } from './kinds'
import type { LifeosHeld, Outbox } from './outbox'
import { INTERRUPTED } from './store'

/**
 * The mail and calendar acts LifeOS holds for this host's threads
 * (docs/agents/work-outbox.md). A draft an agent made lives in LifeOS's
 * `outbox` (or `calendarOps`), not here: LifeOS's key for a TempCode thread
 * drafts and never sends. This file is the one owner of what the host does
 * with them:
 *
 *  - the watcher: one owner subscription to the drafts and failed sends
 *    whose origin names this host, so they are listed with this host's own
 *    held rows and nobody reads LifeOS's `outbox` for the Outbox;
 *  - the two act kinds, `mail.send` and `calendar.op`, whose `execute` is
 *    the owner's own send in LifeOS on the host's device session;
 *  - a grant made before a draft and fitting it sends the draft when the
 *    watcher first sees it; every other new draft raises the held notice.
 *
 * Every press goes through `work.outbox.send`, never from a screen to
 * LifeOS, so the run-once claim, the linked task and the record of who
 * decided are always the host's.
 */

type LifeosRef = Extract<HeldRef, { at: 'lifeos' }>

const AddressSchema = z.object({ name: z.string().optional(), address: z.string() })
/** A mail as LifeOS holds it (`outbox.message`, kind `mail`), passed back whole on the send so what goes is what was shown. */
const MailMessageSchema = z.looseObject({
  kind: z.literal('mail'),
  accountId: z.string(),
  to: z.array(AddressSchema),
  cc: z.array(AddressSchema),
  bcc: z.array(AddressSchema),
  subject: z.string(),
  html: z.string(),
  text: z.string(),
  from: AddressSchema.optional()
})
export const MailSendPayloadSchema = z.object({
  /** the `outbox` row */
  id: z.string(),
  /** LifeOS's own status of the row when it was read: `draft` or `failed` */
  status: z.string(),
  message: MailMessageSchema,
  /** why LifeOS's last send of it failed */
  error: z.string().optional(),
  /** an agent's rewrite waits in the draft (`outbox.proposed`): subject, text and who proposed it */
  proposed: z.looseObject({ subject: z.string().optional(), text: z.string().optional(), by: z.string().optional() }).optional()
})
export type MailSendPayload = z.infer<typeof MailSendPayloadSchema>

/** What a grant fixes for mail: every recipient must be one of these people or at one of these domains, from this account when it names one. */
export const MailSendMatcherSchema = z
  .object({
    accountId: z.string().optional(),
    recipients: z.array(z.string().min(3)).max(50).optional(),
    domains: z.array(z.string().min(3)).max(20).optional()
  })
  .refine((m) => (m.recipients?.length ?? 0) + (m.domains?.length ?? 0) > 0, 'a mail grant names the people or the domains it is for')
export type MailSendMatcher = z.infer<typeof MailSendMatcherSchema>

const lower = (text: string): string => text.trim().toLowerCase()
const domainOf = (address: string): string => lower(address).split('@').pop() ?? ''
const everyone = (m: MailSendPayload['message']): string[] => [...m.to, ...m.cc, ...m.bcc].map((a) => lower(a.address))

export function mailGrantFits(m: MailSendMatcher, p: MailSendPayload): boolean {
  if (m.accountId && m.accountId !== p.message.accountId) return false
  const people = new Set((m.recipients ?? []).map(lower))
  // A domain fits itself only: `purdue.edu` does not let mail go to `evil-purdue.edu` or to a subdomain nobody named.
  const domains = new Set((m.domains ?? []).map((d) => lower(d).replace(/^@/, '')))
  const all = everyone(p.message)
  return all.length > 0 && all.every((address) => people.has(address) || domains.has(domainOf(address)))
}

const names = (list: readonly { name?: string | undefined; address: string }[]): string => {
  const shown = list.slice(0, 3).map((a) => a.name?.trim() || a.address)
  return list.length > 3 ? `${shown.join(', ')} and ${list.length - 3} more` : shown.join(', ')
}
export function mailWords(p: MailSendPayload): { summary: string; verb: string } {
  const to = [...p.message.to, ...p.message.cc, ...p.message.bcc]
  const subject = p.message.subject.replace(/\s+/g, ' ').trim()
  return { summary: `Send to ${to.length ? names(to) : 'nobody yet'}: ${subject || '(no subject)'}`.slice(0, 240), verb: 'Send' }
}

/** A calendar act as LifeOS holds it (`calendarOps`, milestone 24): kept whole, since LifeOS owns its shape. */
export const CalendarOpPayloadSchema = z.looseObject({ id: z.string(), status: z.string().optional(), summary: z.string().optional(), title: z.string().optional(), op: z.string().optional() })
export type CalendarOpPayload = z.infer<typeof CalendarOpPayloadSchema>

/** LifeOS's function names, in one place (architecture §4.3; `calendarOps` is milestone 24's and answers "not built" until it is deployed). */
export const LIFEOS_HELD_FNS = {
  mailHeld: 'outboxHeld:held',
  mailGet: 'compose:get',
  mailSend: 'compose:send',
  mailRetry: 'compose:retry',
  mailSave: 'compose:save',
  mailDiscard: 'compose:discard',
  calendarHeld: 'calendarOps:held',
  calendarSend: 'calendarOps:send',
  calendarDiscard: 'calendarOps:discard'
} as const

/** A function LifeOS does not have yet says so by name; anything else is LifeOS's own word. */
const notDeployed = (err: unknown): boolean => /could not find public function|is not a function|unknown function/i.test(errorText(err))

interface OutboxDoc {
  _id: string
  _creationTime: number
  status: string
  message: { kind: string } & Record<string, unknown>
  sector?: string
  error?: string
  editedAt?: number
  origin?: { app?: string; threadId?: string; host?: string; workspaceId?: string; routineRunId?: string }
  proposed?: { subject?: string; text?: string; by?: string }
}

export interface LifeosHeldDeps {
  ctx: WorkCtx
  outbox: Outbox
  /** the thread a LifeOS origin names, when this host still has it */
  session(id: string): { id: string } | null
}

export class LifeosHeldItems implements LifeosHeld {
  private mail: OutboxItem[] = []
  private calendar: OutboxItem[] = []
  /** refs the watcher has seen, so a draft is told and offered to the grants once */
  private readonly seen = new Set<string>()
  private first = { mail: true, calendar: true }

  constructor(private readonly deps: LifeosHeldDeps) {}

  /** Watch LifeOS while Work is on. Returns its stop. The subscriptions come back by themselves after a reconnect. */
  start(): () => void {
    const { ctx } = this.deps
    const offMail = ctx.lifeos.subscribe<OutboxDoc[]>(LIFEOS_HELD_FNS.mailHeld, { host: ctx.host }, (rows) => void this.took('mail', rows ?? []))
    // Until LifeOS has calendar writes this subscription fails quietly and lists nothing.
    const offCalendar = ctx.lifeos.subscribe<Record<string, unknown>[]>(LIFEOS_HELD_FNS.calendarHeld, { host: ctx.host }, (rows) => void this.took('calendar', rows ?? []))
    return () => {
      offMail()
      offCalendar()
      this.mail = []
      this.calendar = []
      this.first = { mail: true, calendar: true }
      this.deps.outbox.changed(null)
    }
  }

  items(): OutboxItem[] {
    return [...this.mail, ...this.calendar]
  }

  async read(ref: LifeosRef): Promise<OutboxItem | null> {
    if (ref.table === 'calendarOps') return this.calendar.find((i) => i.ref.at === 'lifeos' && i.ref.id === ref.id) ?? null
    let got: { row: OutboxDoc } | null
    try {
      got = await this.deps.ctx.lifeos.owner().query<{ row: OutboxDoc } | null>(LIFEOS_HELD_FNS.mailGet, { id: ref.id })
    } catch (err) {
      // An id LifeOS cannot read is no held item; LifeOS out of reach is said as it is.
      if (/validat|invalid|not found|does not match/i.test(errorText(err))) return null
      throw err
    }
    const row = got?.row
    // Only this host's own: a press through this host never reaches a draft another host's thread, or no thread, made.
    if (!row || row.origin?.host !== this.deps.ctx.host) return null
    return this.mailItem(row)
  }

  async discard(ref: LifeosRef): Promise<void> {
    const owner = this.deps.ctx.lifeos.owner()
    if (ref.table === 'outbox') await owner.mutation(LIFEOS_HELD_FNS.mailDiscard, { id: ref.id })
    else await owner.mutation(LIFEOS_HELD_FNS.calendarDiscard, { id: ref.id }).catch(calendarNotBuilt)
  }

  async edit(ref: LifeosRef, payload: unknown): Promise<OutboxItem> {
    if (ref.table !== 'outbox') throw new NotBuilt('editing a held calendar act', 24)
    const now = await this.read(ref)
    if (!now) throw new Error('LifeOS no longer holds that item')
    if (now.state !== 'held') throw new Error('This mail is no longer a draft; it cannot be changed.')
    const next = MailSendPayloadSchema.shape.message.parse((payload as { message?: unknown } | null)?.message ?? payload)
    // The account and the thread it answers stay the draft's own: an edit changes what is said and to whom.
    const kept = (now.payload as MailSendPayload).message
    await this.deps.ctx.lifeos.owner().mutation(LIFEOS_HELD_FNS.mailSave, { id: ref.id, message: { ...kept, to: next.to, cc: next.cc, bcc: next.bcc, subject: next.subject, html: next.html, text: next.text } })
    const after = await this.read(ref)
    if (!after) throw new Error('LifeOS no longer holds that item')
    return after
  }

  // ── the watcher ───────────────────────────────────────────────────────

  private async took(what: 'mail' | 'calendar', rows: unknown[]): Promise<void> {
    const { outbox, ctx } = this.deps
    try {
      const items = what === 'mail' ? (rows as OutboxDoc[]).flatMap((row) => this.mailItem(row) ?? []) : (rows as Record<string, unknown>[]).flatMap((row) => this.calendarItem(row) ?? [])
      if (what === 'mail') this.mail = items
      else this.calendar = items
      const first = this.first[what]
      this.first[what] = false
      const listed = new Set<string>()
      for (const item of items) {
        const key = keyOf(item.ref)
        listed.add(key)
        const row = outbox.store.byRef(item.ref)
        // A send this host recorded as gone came back failed in LifeOS's own lane: it waits on him again.
        if (row?.state === 'sent' && item.state === 'failed') outbox.store.failSent(row.id, item.error ?? 'LifeOS could not send it')
        if (this.seen.has(key)) continue
        this.seen.add(key)
        // A draft made while a fitting grant stood goes at once; any other is told as held. What was already
        // waiting when the host came up is offered to the grants and told to nobody a second time.
        await outbox.offer(item, { quiet: first })
      }
      if (what === 'mail') await this.settleInterrupted(listed)
      outbox.changed(null)
    } catch (err) {
      ctx.log(`outbox: LifeOS's held ${what} could not be read: ${errorText(err)}`)
    }
  }

  /**
   * A mail whose send the host was stopped in the middle of: LifeOS knows
   * whether it went. A row LifeOS has queued, is sending or has sent did go
   * (`sent`); one LifeOS still holds as a draft did not, and is left failed
   * for him to send again; one LifeOS no longer has is gone.
   */
  private async settleInterrupted(listed: ReadonlySet<string>): Promise<void> {
    const { outbox, ctx } = this.deps
    for (const row of outbox.store.list({ show: 'waiting', limit: 500 })) {
      if (row.state !== 'failed' || row.error !== INTERRUPTED || row.kind !== 'mail.send') continue
      const m = /^lifeos:outbox:(.+)$/.exec(row.runKey)
      if (!m || listed.has(`outbox:${m[1]}`)) continue
      try {
        const got = await ctx.lifeos.owner().query<{ row: OutboxDoc } | null>(LIFEOS_HELD_FNS.mailGet, { id: m[1] })
        if (!got?.row) outbox.store.settleFailed(row.id, 'stale', 'LifeOS no longer has this mail')
        else if (['queued', 'sending', 'sent'].includes(got.row.status)) outbox.store.settleFailed(row.id, 'sent')
      } catch (err) {
        ctx.log(`outbox: could not ask LifeOS whether item ${row.n} went: ${errorText(err)}`)
      }
    }
  }

  private mailItem(row: OutboxDoc): OutboxItem | null {
    if (row.message?.kind !== 'mail' || (row.status !== 'draft' && row.status !== 'failed')) return null
    const payload = MailSendPayloadSchema.safeParse({ id: row._id, status: row.status, message: row.message, ...(row.error ? { error: row.error } : {}), ...(row.proposed ? { proposed: row.proposed } : {}) })
    if (!payload.success) return null
    const words = mailWords(payload.data)
    const session = row.origin?.threadId ? this.deps.session(row.origin.threadId) : null
    const scope = session ? this.deps.ctx.scopeOf(session.id) : null
    const at = row.editedAt ?? row._creationTime
    return {
      ref: { at: 'lifeos', table: 'outbox', id: row._id },
      kind: 'mail.send',
      workspaceId: scope?.workspaceId ?? row.origin?.workspaceId ?? null,
      sessionId: session?.id ?? null,
      sector: row.sector ?? scope?.sector ?? null,
      summary: words.summary,
      verb: words.verb,
      account: payload.data.message.from?.address ?? null,
      state: row.status === 'failed' ? 'failed' : 'held',
      payload: payload.data,
      createdAt: Math.round(row._creationTime),
      decidedBy: null,
      decidedAt: null,
      n: null,
      why: 'lifeos',
      grantId: null,
      error: row.status === 'failed' ? (row.error ?? 'LifeOS could not send it') : null,
      result: null,
      // The host's own stamp put the run there (catch.ts): a routine's draft fits only that routine's grants.
      routineRunId: row.origin?.routineRunId ?? null,
      ...(row.proposed ? { proposed: true } : {}),
      updatedAt: Math.round(at)
    }
  }

  private calendarItem(row: Record<string, unknown>): OutboxItem | null {
    const id = typeof row._id === 'string' ? row._id : null
    const origin = (row.origin ?? {}) as { threadId?: string; workspaceId?: string; routineRunId?: string }
    if (!id) return null
    const session = origin.threadId ? this.deps.session(origin.threadId) : null
    const scope = session ? this.deps.ctx.scopeOf(session.id) : null
    const text = (key: string): string | null => (typeof row[key] === 'string' && (row[key] as string).trim() ? (row[key] as string).trim() : null)
    const at = typeof row.editedAt === 'number' ? row.editedAt : typeof row._creationTime === 'number' ? row._creationTime : 0
    const failed = row.status === 'failed'
    return {
      ref: { at: 'lifeos', table: 'calendarOps', id },
      kind: 'calendar.op',
      workspaceId: scope?.workspaceId ?? origin.workspaceId ?? null,
      sessionId: session?.id ?? null,
      sector: text('sector') ?? scope?.sector ?? null,
      summary: (text('summary') ?? text('title') ?? 'A calendar change').slice(0, 240),
      verb: 'Send',
      account: text('account'),
      state: failed ? 'failed' : 'held',
      payload: { ...row, id },
      createdAt: Math.round(typeof row._creationTime === 'number' ? row._creationTime : at),
      decidedBy: null,
      decidedAt: null,
      n: null,
      why: 'lifeos',
      grantId: null,
      error: failed ? (text('error') ?? 'LifeOS could not carry it out') : null,
      result: null,
      routineRunId: origin.routineRunId ?? null,
      updatedAt: Math.round(at)
    }
  }
}

const keyOf = (ref: HeldRef): string => (ref.at === 'lifeos' ? `${ref.table}:${ref.id}` : `host:${ref.id}`)
const calendarNotBuilt = (err: unknown): never => {
  if (notDeployed(err)) throw new NotBuilt('calendar acts in LifeOS', 24)
  throw err
}

/** `mail.send`: the owner's own `compose.send` on the host's device session, with exactly the mail that was shown. */
export const mailSendKind: ActKindDef<MailSendPayload, MailSendMatcher> = {
  kind: 'mail.send',
  store: 'lifeos',
  payload: MailSendPayloadSchema,
  matcher: MailSendMatcherSchema,
  words: mailWords,
  matches: mailGrantFits,
  async execute(p, ctx) {
    const owner = ctx.lifeos.owner()
    const cause = ctx.decidedBy === 'owner' ? 'press' : 'grant'
    // What LifeOS holds now decides how it goes: a draft is sent with the mail he was shown, a failed send is queued again.
    const now = await owner.query<{ row: OutboxDoc } | null>(LIFEOS_HELD_FNS.mailGet, { id: p.id })
    if (!now?.row) throw new ActStale('LifeOS no longer has this mail')
    if (now.row.status === 'failed') await owner.mutation(LIFEOS_HELD_FNS.mailRetry, { id: p.id })
    else if (now.row.status === 'draft') await owner.mutation(LIFEOS_HELD_FNS.mailSend, { id: p.id, message: p.message, cause })
    else if (!['queued', 'sending', 'sent'].includes(now.row.status)) throw new ActStale(`LifeOS holds this mail as ${now.row.status}`)
    // Already queued, sending or sent: it went by another hand (LifeOS's own app); nothing is sent twice.
    return { summary: mailWords(p).summary.replace(/^Send to/, 'Sent to'), ref: { at: 'lifeos', table: 'outbox', id: p.id } }
  },
  wayBack: () => null
}

/** `calendar.op`: the owner's `calendarOps.send`. Registered against the architecture's names; it answers "not built" until milestone 24 deploys them. */
export const calendarOpKind: ActKindDef<CalendarOpPayload, never> = {
  kind: 'calendar.op',
  store: 'lifeos',
  payload: CalendarOpPayloadSchema,
  words: (p) => ({ summary: (p.summary ?? p.title ?? 'A calendar change').slice(0, 240), verb: 'Send' }),
  async execute(p, ctx) {
    const cause = ctx.decidedBy === 'owner' ? 'press' : 'grant'
    await ctx.lifeos.owner().mutation(LIFEOS_HELD_FNS.calendarSend, { id: p.id, cause }).catch(calendarNotBuilt)
    return { summary: (p.summary ?? p.title ?? 'A calendar change').slice(0, 240), ref: { at: 'lifeos', table: 'calendarOps', id: p.id } }
  },
  wayBack: () => null
}
