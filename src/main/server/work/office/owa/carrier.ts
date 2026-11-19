import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { OfficeAppState } from '@shared/contract-work-office'
import { OfficeError, type EventAnswer, type EventOut, type MailFull, type MailOut, type OfficeCarrier } from '../carrier'
import * as ews from './ews'
import type { OwaTransport } from './page'

/**
 * Outlook on the web as an Office carrier, on the box (docs/agents/work-office.md
 * "Outlook on the web"): mail and calendar through the signed-in page's own
 * requests, so a held mail on an Outlook account goes out from the box,
 * formatted, with no Mac awake. It carries Outlook only; Excel, Word and
 * PowerPoint stay the Mac's (and Windows', M44).
 *
 * Who is signed in is kept in `owa.json` beside the browser's profile, so
 * the route's minute beat answers without starting the browser; the page
 * refreshes it whenever it opens, and a page that wants a sign-in clears it.
 */

const NOT_HERE = (what: string) => new OfficeError(`${what} is not on the box: only Outlook on the web is. Use the Mac for it.`, 'not-installed')

export interface OwaCarrierDeps {
  /** the page, or null when the box has no browser */
  page(): OwaTransport | null
  /** where the signed-in address is kept */
  marker(): string | null
  running(): boolean
  /** the profile holds a Microsoft sign-in (cookies of its hosts): worth asking the page who it is */
  hasSignIn(): boolean
  now?: () => number
}

const ASK_EVERY_MS = 3_600_000

export class OwaCarrier implements OfficeCarrier {
  readonly kind = 'owa' as const
  private askedAt = -Infinity

  constructor(private readonly d: OwaCarrierDeps) {}

  /** The address last seen signed in, without opening anything. */
  known(): string | null {
    const path = this.d.marker()
    if (!path) return null
    try {
      return (JSON.parse(readFileSync(path, 'utf8')) as { account?: string }).account ?? null
    } catch {
      return null
    }
  }

  private remember(account: string | null): void {
    const path = this.d.marker()
    if (!path) return
    if (!account) return void rmSync(path, { force: true })
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ account, at: Date.now() }), { mode: 0o600 })
  }

  /** One request, its answer read by `read`; Outlook's refusals come out as the tools' own errors. */
  private async call<R>(req: { action: string; body: unknown }, read: (answer: unknown) => R): Promise<R> {
    const page = this.d.page()
    if (!page) throw new OfficeError('The box has no browser for Outlook on the web.', 'not-installed')
    try {
      return read(await page.call(req.action, req.body))
    } catch (err) {
      if (err instanceof OfficeError && err.code === 'needs-consent') this.remember(null)
      // Exchange answered with an error: nothing went, so the route fails the row. An answer it could not read may have sent: `failed`, kept as maybe sent.
      if (err instanceof ews.EwsError) throw new OfficeError(`Outlook on the web: ${err.message}`, err.code === 'NoAnswer' ? 'failed' : err.code === 'ErrorItemNotFound' ? 'not-found' : 'not-allowed')
      throw err
    }
  }

  /** Asks the page who is signed in, and keeps it. */
  async signedIn(): Promise<string> {
    const account = await this.call(ews.userConfiguration(), ews.accountOf)
    this.remember(account)
    return account
  }

  async apps(): Promise<OfficeAppState[]> {
    // A sign-in that came by an import or by his hand is learnt here, at most once an hour while none is known.
    const now = (this.d.now ?? Date.now)()
    if (!this.known() && this.d.page() && now - this.askedAt >= ASK_EVERY_MS && this.d.hasSignIn()) {
      this.askedAt = now
      await this.signedIn().catch(() => null)
    }
    const signed = !!this.d.page() && !!this.known()
    return [
      { app: 'excel', installed: false, running: false, allowed: 'unknown' },
      { app: 'word', installed: false, running: false, allowed: 'unknown' },
      { app: 'powerpoint', installed: false, running: false, allowed: 'unknown' },
      { app: 'outlook', installed: signed, running: signed && this.d.running(), allowed: signed ? 'yes' : 'unknown' }
    ]
  }

  /** The signed-in address, as the route reports it each minute: from the marker, so the browser is not started for it. */
  async accounts(): Promise<string[]> {
    const a = this.known()
    return a ? [a] : []
  }

  private async account(want?: string): Promise<string> {
    const have = this.known() ?? (await this.signedIn())
    if (want && want.trim().toLowerCase() !== have) throw new OfficeError(`Outlook on the web on the box is signed in as ${have}, not ${want}.`, 'not-found')
    return have
  }

  async listMail(q: { folder: 'inbox' | 'sent' | 'drafts'; limit: number; query?: string }) {
    const folder = q.folder === 'sent' ? 'sentitems' : q.folder
    const account = await this.account()
    return this.call(ews.findMail(folder, q.limit, q.query), (a) => ews.mailList(a, account))
  }

  async readMail(id: string): Promise<MailFull> {
    const account = await this.account()
    return this.call(ews.getItem(id, 'Text'), (a) => ews.mailFull(a, account))
  }

  /** A mail as it was sent, its HTML whole: what the done-when reads back from Sent. */
  async readMailHtml(id: string): Promise<MailFull & { html?: string }> {
    const account = await this.account()
    return this.call(ews.getItem(id, 'HTML'), (a) => ews.mailFull(a, account))
  }

  async draftMail(m: MailOut): Promise<string> {
    await this.account(m.account)
    const id = await this.call(ews.sendMail(m, 'SaveOnly'), ews.createdId)
    if (!id) throw new OfficeError('Outlook on the web saved the draft but gave no id', 'failed')
    return id
  }

  /** Only from a held act's execute, after his press. Outlook answers no id for a sent mail: it is found in Sent. */
  async sendMail(m: MailOut): Promise<{ id: string | null }> {
    await this.account(m.account)
    await this.call(ews.sendMail(m, 'SendAndSaveCopy'), ews.messageOf)
    return { id: null }
  }

  async events(from: string, to: string) {
    return this.call(ews.calendarView(from, to), (a) => ews.eventList(a).map(({ uid: _uid, ...e }) => e))
  }

  async createEvent(e: EventOut): Promise<string> {
    await this.account(e.account)
    const id = await this.call(ews.createEvent(e), ews.createdId)
    if (!id) throw new OfficeError('Outlook on the web made the event but gave no id', 'failed')
    return id
  }

  async answerEvent(id: string, answer: EventAnswer, comment?: string): Promise<void> {
    await this.call(ews.answerEvent(id, answer, comment), ews.messageOf)
  }

  /** The invitation whose UID is exactly this, from a week back to half a year on. */
  async eventByUid(uid: string): Promise<string | null> {
    const day = 86_400_000
    const now = Date.now()
    const list = await this.call(ews.calendarView(new Date(now - 7 * day).toISOString(), new Date(now + 183 * day).toISOString()), ews.eventList)
    return list.find((e) => e.uid === uid)?.id ?? null
  }

  async workbooks(): Promise<never> {
    throw NOT_HERE('Excel')
  }
  async readRange(): Promise<never> {
    throw NOT_HERE('Excel')
  }
  async writeRange(): Promise<never> {
    throw NOT_HERE('Excel')
  }
  async documents(): Promise<never> {
    throw NOT_HERE('Word')
  }
  async readDocument(): Promise<never> {
    throw NOT_HERE('Word')
  }
  async editDocument(): Promise<never> {
    throw NOT_HERE('Word')
  }
  async presentations(): Promise<never> {
    throw NOT_HERE('PowerPoint')
  }
  async readSlides(): Promise<never> {
    throw NOT_HERE('PowerPoint')
  }
  async replaceSlideText(): Promise<never> {
    throw NOT_HERE('PowerPoint')
  }
  async open(app: 'excel' | 'word' | 'powerpoint' | 'outlook'): Promise<void> {
    throw NOT_HERE(app === 'outlook' ? 'Outlook as an app' : app[0]!.toUpperCase() + app.slice(1))
  }
}
