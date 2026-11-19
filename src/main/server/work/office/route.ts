import type { DatabaseSync } from 'node:sqlite'
import { errorText } from '@shared/work/ids'
import type { LifeosClient } from '../lifeos/ctx'
import { OfficeError, type EventAnswer, type OfficeCarrier } from './carrier'
import { cleanMailHtml } from './held'

/**
 * LifeOS's local route, carried by this host's Outlook
 * (docs/agents/work-office.md "LifeOS mail through Outlook"; M22 section 4,
 * M24 section 8). A LifeOS mail on an Outlook account that he pressed Send
 * on, or a calendar act on one, waits `queued` until a machine that has the
 * account in Outlook takes it. This host joins as one:
 *
 *  - it reports each Outlook address it has (`sources.register` with the
 *    channel `outlook-local:<host>`, `sources.heartbeat` every minute);
 *  - it asks for what is due on those accounts, claims each row once
 *    (`localClaim`), journals it, hands it to Outlook, and says how it went
 *    (`localSent`/`localDone` or `localFailed`).
 *
 * The journal is written before Outlook is called and cleared after
 * LifeOS's ack, so a crash, sleep or lost link between the two is replayed
 * as sent: the row may have gone, and a second send is worse than a late
 * ack (the Purdue PC's sender does the same).
 */

export const BEAT_MS = 60_000
/** LifeOS's answer when a row this host journaled was claimed by another machine since */
const TAKEN = /another machine took that mail/
export const PUMP_MS = 20_000

export function ensureRouteTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_office_journal (
    tbl TEXT NOT NULL,
    id TEXT NOT NULL,
    provider_id TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (tbl, id)
  )`)
  db.exec('CREATE TABLE IF NOT EXISTS work_office_sources (account TEXT PRIMARY KEY, source_id TEXT NOT NULL)')
}

interface Addr {
  name?: string
  address: string
}
/** One row of `outbox.localDue` / `localSending`, as LifeOS answers it. */
interface LocalMail {
  row: {
    _id: string
    message: { kind: 'mail'; to: Addr[]; cc: Addr[]; bcc: Addr[]; subject: string; html: string; text: string } | { kind: string }
  }
  address: string
}
/** One `calendarOps` row, as `localDue` answers it. */
interface LocalOp {
  _id: string
  kind: 'create' | 'update' | 'accept' | 'decline' | 'tentative' | 'propose' | 'cancel'
  account: string
  uid?: string
  payload: { title?: string; startsAt?: number; endsAt?: number; location?: string; notes?: string; attendees?: Addr[]; comment?: string }
}

export interface RouteDeps {
  db: DatabaseSync
  lifeos: () => LifeosClient
  carrier: OfficeCarrier
  /** this host's name on the route: one stable name, the host id */
  host: string
  log(line: string): void
  now?: () => number
}

export interface RouteState {
  accounts: string[]
  beatAt: number | null
  error: string | null
}

const ANSWERS: Partial<Record<LocalOp['kind'], EventAnswer>> = { accept: 'accept', decline: 'decline', tentative: 'tentative' }

export class OutlookRoute {
  readonly state: RouteState = { accounts: [], beatAt: null, error: null }
  private busy = false

  constructor(private readonly deps: RouteDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Reports every Outlook address this host has, fresh. */
  async beat(): Promise<void> {
    const { db, lifeos, carrier, host } = this.deps
    try {
      // An Outlook that cannot carry anything (New Outlook on the Mac) is said once, plainly, and reports no account.
      const problem = (await carrier.outlookProblem?.()) ?? null
      if (problem) return void Object.assign(this.state, { accounts: [], beatAt: this.now, error: problem })
      const accounts = (await carrier.accounts()).map((a) => a.trim().toLowerCase()).filter(Boolean)
      for (const account of accounts) {
        let id = (db.prepare('SELECT source_id FROM work_office_sources WHERE account = ?').get(account) as { source_id: string } | undefined)?.source_id
        if (!id) {
          id = await lifeos().mutation<string>('sources:register', { kind: 'email', account, channel: `outlook-local:${host}`, label: `Outlook on ${host}` })
          db.prepare('INSERT OR REPLACE INTO work_office_sources (account, source_id) VALUES (?, ?)').run(account, id)
        }
        await lifeos().mutation('sources:heartbeat', { id, status: 'ok' })
      }
      Object.assign(this.state, { accounts, beatAt: this.now, error: null })
    } catch (err) {
      this.state.error = errorText(err)
      throw err
    }
  }

  /** One pass: replay the journal, then carry out what is due. One pass at a time. */
  async pump(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.replay()
      if (!this.state.accounts.length) return
      const { lifeos, host } = this.deps
      for (const due of await lifeos().query<LocalMail[]>('outbox:localDue', { host, now: this.now })) await this.sendMail(due)
      for (const op of await lifeos().query<LocalOp[]>('calendarOps:localDue', { accounts: this.state.accounts })) await this.carryOp(op)
    } finally {
      this.busy = false
    }
  }

  private journal(tbl: 'outbox' | 'calendarOps', id: string, providerId: string | null): void {
    this.deps.db.prepare('INSERT OR REPLACE INTO work_office_journal (tbl, id, provider_id, at) VALUES (?, ?, ?, ?)').run(tbl, id, providerId, this.now)
  }
  private journaled(tbl: string, id: string): boolean {
    return !!this.deps.db.prepare('SELECT 1 FROM work_office_journal WHERE tbl = ? AND id = ?').get(tbl, id)
  }
  private unjournal(tbl: string, id: string): void {
    this.deps.db.prepare('DELETE FROM work_office_journal WHERE tbl = ? AND id = ?').run(tbl, id)
  }

  /** What went to Outlook and was never acked: acked now. */
  private async replay(): Promise<void> {
    const { db, lifeos, host } = this.deps
    for (const j of db.prepare('SELECT tbl, id, provider_id FROM work_office_journal').all() as { tbl: string; id: string; provider_id: string | null }[]) {
      try {
        const extra = j.provider_id ? (j.tbl === 'outbox' ? { providerMessageId: j.provider_id } : { providerEventId: j.provider_id }) : {}
        await lifeos().mutation(j.tbl === 'outbox' ? 'outbox:localSent' : 'calendarOps:localDone', { id: j.id, host, ...extra })
        this.unjournal(j.tbl, j.id)
      } catch (err) {
        // Another machine has claimed the row since (LifeOS's claimedBy): it is that machine's to settle now, so the entry goes, said once.
        if (TAKEN.test(errorText(err))) this.unjournal(j.tbl, j.id)
        this.deps.log(`office route: replaying ${j.tbl} ${j.id}: ${errorText(err)}${TAKEN.test(errorText(err)) ? '; dropped from the journal' : ''}`)
      }
    }
  }

  private async sendMail(due: LocalMail): Promise<void> {
    const { lifeos, carrier, host } = this.deps
    const m = due.row.message
    if (m.kind !== 'mail' || !('to' in m)) return
    const id = due.row._id
    // A row still in the journal may have gone: the replay acks it, Outlook never sees it again.
    if (this.journaled('outbox', id)) return
    if (!(await lifeos().mutation<boolean>('outbox:localClaim', { id, host }))) return
    this.journal('outbox', id, null)
    let sent: { id: string | null }
    try {
      sent = await carrier.sendMail({
        account: due.address,
        to: m.to.map((a) => a.address),
        cc: m.cc.map((a) => a.address),
        bcc: m.bcc.map((a) => a.address),
        subject: m.subject,
        html: cleanMailHtml(m.html || plainHtml(m.text))
      })
    } catch (err) {
      // Only a plain refusal fails the row. A timeout or an unclear end may have sent it: it stays journaled and is acked as sent.
      if (!refused(err)) throw err
      this.unjournal('outbox', id)
      await lifeos().mutation('outbox:localFailed', { id, host, error: `Outlook on ${host}: ${errorText(err)}` })
      return
    }
    this.journal('outbox', id, sent.id)
    await lifeos().mutation('outbox:localSent', { id, host, ...(sent.id ? { providerMessageId: sent.id } : {}) })
    this.unjournal('outbox', id)
  }

  private async carryOp(op: LocalOp): Promise<void> {
    const { lifeos, carrier, host } = this.deps
    const id = op._id
    if (this.journaled('calendarOps', id)) return
    if (!(await lifeos().mutation<boolean>('calendarOps:localClaim', { id, host }))) return
    const fail = (error: string) => lifeos().mutation('calendarOps:localFailed', { id, host, error })
    const answer = ANSWERS[op.kind]
    if (op.kind !== 'create' && !answer) return void (await fail(`Outlook on ${host} does not carry "${op.kind}" yet: do it in Outlook.`))
    let eventId: string | null = null
    let carried = false
    try {
      if (answer) {
        if (!op.uid) return void (await fail('The invitation has no calendar UID to find it by in Outlook.'))
        eventId = await carrier.eventByUid(op.uid)
        if (!eventId) return void (await fail(`Outlook on ${host} has no event for this invitation.`))
      }
      const p = op.payload
      if (op.kind === 'create' && (p.startsAt === undefined || p.endsAt === undefined)) return void (await fail('The event has no start or end.'))
      this.journal('calendarOps', id, eventId)
      carried = true
      if (answer) await carrier.answerEvent(eventId!, answer, p.comment)
      else
        eventId = await carrier.createEvent({
          account: op.account,
          subject: p.title ?? '',
          start: new Date(p.startsAt!).toISOString(),
          end: new Date(p.endsAt!).toISOString(),
          location: p.location,
          body: p.notes,
          attendees: (p.attendees ?? []).map((a) => a.address)
        })
    } catch (err) {
      // As for mail: once Outlook was asked to send, only a plain refusal fails the op; an unclear end stays journaled and is acked as done.
      if (carried && !refused(err)) throw err
      this.unjournal('calendarOps', id)
      return void (await fail(`Outlook on ${host}: ${errorText(err)}`))
    }
    this.journal('calendarOps', id, eventId)
    const response = answer ? ({ accept: 'accepted', decline: 'declined', tentative: 'tentative' } as const)[answer] : undefined
    await lifeos().mutation('calendarOps:localDone', { id, host, ...(eventId ? { providerEventId: eventId } : {}), ...(response ? { response } : {}) })
    this.unjournal('calendarOps', id)
  }

  /** Beats and pumps until the returned stop. A pass that fails waits for the next. */
  start(): () => void {
    const tick = (fn: () => Promise<void>, what: string) => () => void fn().catch((err) => this.deps.log(`office route: ${what}: ${errorText(err)}`))
    const beat = tick(() => this.beat(), 'reporting accounts')
    const pump = tick(() => this.pump(), 'sending')
    void this.beat()
      .then(() => this.pump())
      .catch((err) => this.deps.log(`office route: ${errorText(err)}`))
    const timers = [setInterval(beat, BEAT_MS), setInterval(pump, PUMP_MS)]
    for (const t of timers) t.unref?.()
    return () => timers.forEach(clearInterval)
  }
}

/** Outlook said no before anything went: not there, not allowed, no such account or mail. */
const refused = (err: unknown): boolean => err instanceof OfficeError && err.code !== 'failed'

const plainHtml = (text: string): string =>
  `<div>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>')}</div>`
