import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BoxChromium, findChromium } from '../../browser/box/chromium'
import { RESERVED_TARGETS } from '../../browser/box/service'
import type { LifeosClient } from '../../lifeos/ctx'
import { OfficeError } from '../carrier'
import { ensureRouteTables, OutlookRoute } from '../route'
import { OwaCarrier } from './carrier'
import * as ews from './ews'
import { serveOwaFixture, type OwaFixture } from './fixture'
import { OwaPage } from './page'

describe("Outlook on the web's requests", () => {
  it('sends a reply as the answer to its mail, in HTML, saved to Sent', () => {
    const r = ews.sendMail({ to: ['a@x.com'], cc: [], bcc: [], subject: 'Re: Plan', html: '<b>ok</b>', replyTo: 'AAMk1' }, 'SendAndSaveCopy') as { action: string; body: { __type: string; Body: Record<string, unknown> } }
    expect(r.action).toBe('CreateItem')
    expect(r.body.__type).toBe('CreateItemJsonRequest:#Exchange')
    expect(r.body.Body).toMatchObject({
      __type: 'CreateItemRequest:#Exchange',
      MessageDisposition: 'SendAndSaveCopy',
      SavedItemFolderId: { BaseFolderId: { Id: 'sentitems' } },
      Items: [{ __type: 'ReplyToItem:#Exchange', ReferenceItemId: { Id: 'AAMk1' }, NewBodyContent: { BodyType: 'HTML', Value: '<b>ok</b>' } }]
    })
  })

  it('answers an invitation by its item, and reads a refusal as its words', () => {
    expect((ews.answerEvent('E1', 'tentative').body as { Body: { Items: unknown[] } }).Body.Items[0]).toMatchObject({ __type: 'TentativelyAcceptItem:#Exchange', ReferenceItemId: { Id: 'E1' } })
    expect(() => ews.messageOf({ Body: { ResponseMessages: { Items: [{ ResponseClass: 'Error', ResponseCode: 'ErrorItemNotFound', MessageText: 'gone' }] } } })).toThrow('gone')
    expect(ews.accountOf({ SessionSettings: { UserEmailAddress: ' Dana@X.com ' } })).toBe('dana@x.com')
  })
})

const bin = findChromium()
const d = bin && process.platform === 'linux' ? describe : describe.skip

d('the Outlook on the web carrier, against a page in Outlook\'s shapes', () => {
  let root: string
  let browser: BoxChromium
  let owa: OwaFixture
  let page: OwaPage
  let carrier: OwaCarrier
  let clock = 0

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'm38-owa-'))
    browser = new BoxChromium({ root, bin: () => bin })
    owa = await serveOwaFixture()
    page = new OwaPage({ endpoint: () => browser.endpoint(), url: owa.url, waitMs: 10_000 })
    carrier = new OwaCarrier({ page: () => page, marker: () => join(root, 'owa.json'), running: () => browser.running, hasSignIn: () => true, now: () => clock })
  }, 30_000)

  afterAll(async () => {
    page?.close()
    await browser?.stop()
    await owa?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('learns who is signed in from the page itself, and says Outlook is here', async () => {
    expect(carrier.known()).toBeNull()
    const apps = await carrier.apps()
    expect(apps.find((a) => a.app === 'outlook')).toMatchObject({ installed: true, allowed: 'yes' })
    expect(apps.filter((a) => a.installed).map((a) => a.app)).toEqual(['outlook'])
    expect(await carrier.accounts()).toEqual(['dana.lee@contoso.com'])
    // the page's own first call, then ours, both signed with what the page sent
    expect(owa.calls.slice(0, 2)).toEqual([
      { action: 'GetOwaUserConfiguration', signed: true },
      { action: 'GetOwaUserConfiguration', signed: true }
    ])
    // its tab is the host's own: no thread sees it
    expect(RESERVED_TARGETS.size).toBe(1)
  }, 30_000)

  it('sends a formatted mail from its account, and reads it back from Sent with its formatting', async () => {
    const html = '<p><b>Plan</b> for <i>Friday</i></p><ul><li>one</li></ul>'
    expect(await carrier.sendMail({ account: 'Dana.Lee@contoso.com', to: ['owner@example.com'], cc: ['cc@example.com'], bcc: [], subject: 'Plan', html })).toEqual({ id: null })
    const [sent] = await carrier.listMail({ folder: 'sent', limit: 5 })
    expect(sent).toMatchObject({ subject: 'Plan', account: 'dana.lee@contoso.com' })
    const back = await carrier.readMailHtml(sent!.id)
    expect(back.html).toContain(html)
    expect(back.to).toEqual(['owner@example.com'])
    expect((await carrier.readMail(sent!.id)).text).toBe('Plan for Fridayone')
    await expect(carrier.sendMail({ account: 'someone@else.com', to: ['a@b.com'], cc: [], bcc: [], subject: 'x', html: 'x' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(carrier.readMail('AAMk-none')).rejects.toBeInstanceOf(OfficeError)
    // a refusal Exchange answered is a plain refusal: the route fails its row, never keeps it as maybe sent
    await expect(carrier.answerEvent('nothing', 'accept')).rejects.toMatchObject({ code: 'not-found' })
  }, 30_000)

  it("carries LifeOS's held Outlook mail out after his press: claimed, sent formatted, acked", async () => {
    const calls: [string, Record<string, unknown>][] = []
    const due = [{ row: { _id: 'ob1', message: { kind: 'mail', to: [{ address: 'owner@example.com' }], cc: [], bcc: [], subject: 'Weekly', html: '<p><b>Weekly</b> <a href="https://example.com">notes</a></p>', text: 'Weekly' } }, address: 'dana.lee@contoso.com' }]
    const lifeos: LifeosClient = {
      query: async <T,>(fn: string) => (fn === 'outbox:localDue' ? due.splice(0) : []) as T,
      mutation: async <T,>(fn: string, args: Record<string, unknown> = {}) => (calls.push([fn, args]), (fn === 'sources:register' ? 'src1' : fn.endsWith('localClaim') ? true : null) as T),
      action: async () => null as never
    }
    const db = new DatabaseSync(':memory:')
    ensureRouteTables(db)
    const route = new OutlookRoute({ db, lifeos: () => lifeos, carrier, host: 'env_box', log: () => {} })
    await route.beat()
    await route.pump()
    expect(calls.map(([fn]) => fn)).toEqual(['sources:register', 'sources:heartbeat', 'outbox:localClaim', 'outbox:localSent'])
    expect(calls[0]![1]).toMatchObject({ account: 'dana.lee@contoso.com', channel: 'outlook-local:env_box' })
    const sent = owa.mail.find((m) => m.subject === 'Weekly')!
    expect(sent.folder).toBe('sentitems')
    expect(sent.html).toContain('<b>Weekly</b>')
    expect(sent.html).toContain('href="https://example.com"')
  }, 30_000)

  it('books, finds an invitation by its exact UID, and answers it', async () => {
    const id = await carrier.createEvent({ subject: 'Sync', start: '2026-11-20T15:00:00Z', end: '2026-11-20T15:30:00Z', location: 'Room 2', attendees: ['owner@example.com'] })
    expect(owa.events.find((e) => e.id === id)).toMatchObject({ subject: 'Sync', attendees: ['owner@example.com'], invitations: true })
    const day = 86_400_000
    const at = (ms: number) => new Date(Date.now() + ms).toISOString()
    owa.events.push({ id: 'inv-1', uid: 'UID-ABC', subject: 'Review', start: at(day), end: at(day + 3_600_000), location: '', organizer: 'boss@contoso.com', attendees: [], response: 'NoResponseReceived', invitations: false })
    owa.events.push({ id: 'inv-2', uid: 'UID-ABCD', subject: 'Other', start: at(day), end: at(day + 3_600_000), location: '', organizer: 'boss@contoso.com', attendees: [], response: 'NoResponseReceived', invitations: false })
    expect(await carrier.eventByUid('UID-ABC')).toBe('inv-1')
    expect(await carrier.eventByUid('UID-NONE')).toBeNull()
    await carrier.answerEvent('inv-1', 'accept')
    expect(owa.events.find((e) => e.id === 'inv-1')!.response).toBe('Accept')
    expect((await carrier.events(at(-day), at(2 * day))).find((e) => e.id === 'inv-1')).toMatchObject({ response: 'accepted', organizer: 'boss@contoso.com' })
  }, 30_000)

  it('opens the page again when its session ends, and signs with the new token', async () => {
    owa.expire()
    const before = owa.calls.length
    await carrier.listMail({ folder: 'sent', limit: 1 })
    const after = owa.calls.slice(before)
    expect(after[0]).toEqual({ action: 'FindItem', signed: false })
    expect(after.at(-1)).toEqual({ action: 'FindItem', signed: true })
  }, 30_000)

  it('keeps Excel, Word and PowerPoint for the Mac', async () => {
    await expect(carrier.workbooks()).rejects.toMatchObject({ code: 'not-installed' })
    await expect(carrier.open('word')).rejects.toMatchObject({ code: 'not-installed' })
  })
})
