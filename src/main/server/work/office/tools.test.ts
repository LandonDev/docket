import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HeldItem, WorkToolResult } from '@shared/work'
import type { ActCtx, ToolCtx, WorkCtx } from '../modules'
import { ensureSuggestionTables, SuggestionStore } from '../sheets/suggestions'
import { ensureExcelTables, excelStore, ExcelHelper } from './excel'
import { FakeOffice } from './fake'
import { cleanMailHtml, keepOfficeMail, officeActs, OfficeCalendarSchema, OfficeMailSchema, type OfficeMail } from './held'
import { OFFICE_TOOLS, sharedKey, workTools, type Env } from './tools'

/**
 * The tool set over a fake Office: what is written, what waits as a
 * suggestion or a tracked change, and that every verb that sends answers a
 * held act while Outlook sends nothing until the act's own execute.
 */
const SHARED = 'https://contoso.sharepoint.com/sites/t/Plan.xlsx'
const MINE = '/Users/owner/Documents/Mine.xlsx'
let office: FakeOffice
let db: DatabaseSync
let suggestions: SuggestionStore
let held: { kind: string; sessionId: string | null; payload: unknown }[]
let said: string[]
let peerCalls: { host: string; module: string; verb: string; args: unknown }[]

const ctx = (): ToolCtx =>
  ({
    db,
    host: 'env_mac',
    held: {
      create(act: { kind: string; sessionId: string | null; payload: unknown }) {
        held.push(act)
        return { state: 'held', summary: `held ${act.kind}` } as HeldItem
      }
    },
    threads: { ownerSaid: (_s: string, q: string) => said.some((w) => w.includes(q)) },
    settings: { workspace: () => ({ mayUseDesktop: ['env_mac'], voice: false }) },
    peer: (host: string) => ({ call: async (module: string, verb: string, args: unknown) => (peerCalls.push({ host, module, verb, args }), { content: [{ type: 'text', text: 'from the Mac' }] }) }),
    scope: { workspaceId: 'w1' },
    sessionId: 't1'
  }) as unknown as ToolCtx

const run = async (name: string, args: unknown, withOffice = true): Promise<WorkToolResult> => {
  const excel = new ExcelHelper(office, db, suggestions)
  const tools = workTools({ here: () => (withOffice ? { carrier: office, excel, suggestions } : null) })
  return tools.find((t) => t.name === name)!.run(args, ctx())
}
const text = (r: WorkToolResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')

beforeEach(() => {
  office = new FakeOffice()
  const soon = new Date(Date.now() + 864e5).toISOString()
  office.calendar.push({ id: 'ev-9', subject: 'Standup', start: soon, end: soon, location: '', organizer: 'lee@example.com', attendees: ['me@example.com'], response: '' })
  office.addBook(SHARED, { Sheet1: { A1: 'Q1', B1: 100 } })
  office.addBook(MINE, { Sheet1: { A1: 1 } })
  office.docs.set('https://contoso.sharepoint.com/Brief.docx', { paragraphs: ['Draft one.'], tracked: [] })
  office.mailbox.push({ id: '42', account: 'owner@example.com', from: 'dana@example.com', subject: 'Budget', at: '2026-11-18T10:00:00.000Z', read: true, to: ['owner@example.com'], cc: [], text: 'Numbers?' })
  db = new DatabaseSync(':memory:')
  ensureSuggestionTables(db)
  ensureExcelTables(db)
  suggestions = new SuggestionStore(db)
  held = []
  said = []
  peerCalls = []
})

describe('writes, by the rule for files others can open', () => {
  it("writes his own workbook at once, and an agent's own idea on a shared one waits as suggestions", async () => {
    expect(text(await run('office_range_write', { workbook: MINE, range: "'Sheet1'!A1", values: [[2]], because: 'own' }))).toContain('writeId')
    expect((await office.readRange(MINE, 'Sheet1', 'A1')).values).toEqual([[2]])

    expect(text(await run('office_range_write', { workbook: SHARED, range: 'Sheet1!B1', values: [[120]], because: 'own' }))).toContain('1 cell waits as suggestions')
    expect((await office.readRange(SHARED, 'Sheet1', 'B1')).values).toEqual([[100]])
    expect(suggestions.open(excelStore(SHARED))).toMatchObject([{ sheet: 'Sheet1', row: 0, col: 1, base: { v: 100 }, proposed: { v: 120 }, state: 'pending' }])
  })

  it('writes a shared workbook when his own words for it are in the thread, and not on a quote he never wrote', async () => {
    said = ['please set Q1 to 120']
    await run('office_range_write', { workbook: SHARED, range: 'Sheet1!B1', values: [[110]], because: 'asked', quote: 'set Q1 to 999' })
    expect((await office.readRange(SHARED, 'Sheet1', 'B1')).values).toEqual([[100]])
    await run('office_range_write', { workbook: SHARED, range: 'Sheet1!B1', values: [[120]], because: 'asked', quote: 'set Q1 to 120' })
    expect((await office.readRange(SHARED, 'Sheet1', 'B1')).values).toEqual([[120]])
  })

  it('answers conflict on a stale base and writes nothing', async () => {
    const read = JSON.parse(text(await run('office_range_read', { workbook: MINE, range: 'Sheet1!A1' }))) as { hash: string }
    office.type(MINE, 'Sheet1', 'A1', 5)
    expect(JSON.parse(text(await run('office_range_write', { workbook: MINE, range: 'Sheet1!A1', values: [[7]], base: read.hash, because: 'own' })))).toEqual({ conflict: true, now: [[5]] })
    expect((await office.readRange(MINE, 'Sheet1', 'A1')).values).toEqual([[5]])
  })

  it('makes an own idea in a shared Word document a tracked change', async () => {
    await run('office_doc_edit', { document: 'https://contoso.sharepoint.com/Brief.docx', find: 'one', replace: 'two', because: 'own' })
    expect(office.docs.get('https://contoso.sharepoint.com/Brief.docx')).toEqual({ paragraphs: ['Draft two.'], tracked: [JSON.stringify({ find: 'one', replace: 'two' })] })
  })

  it('judges a file named by its bare name, or by a Windows path, as the file the carrier opens: a shared one is not written plainly', async () => {
    const CLOUD = '/Users/owner/Library/CloudStorage/OneDrive-Contoso/Budget.docx'
    office.docs.set(CLOUD, { paragraphs: ['Draft one.'], tracked: [] })
    await run('office_doc_edit', { document: 'Budget.docx', find: 'one', replace: 'two', because: 'own' })
    expect(office.docs.get(CLOUD)).toEqual({ paragraphs: ['Draft two.'], tracked: [JSON.stringify({ find: 'one', replace: 'two' })] })

    const BOOK = '/Users/owner/Library/CloudStorage/OneDrive-Contoso/Plan 2.xlsx'
    office.addBook(BOOK, { Sheet1: { B1: 100 } })
    expect(text(await run('office_range_write', { workbook: 'Plan 2.xlsx', range: 'Sheet1!B1', values: [[120]], because: 'own' }))).toContain('1 cell waits as suggestions')
    expect((await office.readRange(BOOK, 'Sheet1', 'B1')).values).toEqual([[100]])
    expect(suggestions.open(excelStore(BOOK))).toHaveLength(1)

    office.decks.set('/Users/owner/OneDrive - Contoso/Pitch.pptx', [['Q1 plan']])
    expect(await run('office_slides_replace', { deck: 'Pitch.pptx', find: 'Q1', replace: 'Q2', because: 'own' })).toMatchObject({ isError: true })
    expect(office.decks.get('/Users/owner/OneDrive - Contoso/Pitch.pptx')).toEqual([['Q1 plan']])

    expect(sharedKey('C:\\Users\\owner\\OneDrive - Company\\Budget.docx')).toBe(true)
    expect(sharedKey('C:\\Users\\owner\\Documents\\Budget.docx')).toBe(false)
    // a network share is others' to open
    expect(sharedKey('\\\\fileserver\\team\\Plan.pptx')).toBe(true)
  })

  it('counts a name no open file answers to, or two do, as shared', async () => {
    office.addBook('/Users/owner/Documents/Twin.xlsx', { Sheet1: { A1: 1 } })
    office.addBook('/Users/owner/Desktop/Twin.xlsx', { Sheet1: { A1: 1 } })
    expect(text(await run('office_range_write', { workbook: 'Twin.xlsx', range: 'Sheet1!A1', values: [[2]], because: 'own' }))).toContain('waits as suggestions')
    expect((await office.readRange('/Users/owner/Documents/Twin.xlsx', 'Sheet1', 'A1')).values).toEqual([[1]])
    expect((await office.readRange('/Users/owner/Desktop/Twin.xlsx', 'Sheet1', 'A1')).values).toEqual([[1]])
    // his own file by its bare name is his: written at once
    expect(text(await run('office_range_write', { workbook: 'Mine.xlsx', range: 'Sheet1!A1', values: [[3]], because: 'own' }))).toContain('writeId')
    expect((await office.readRange(MINE, 'Sheet1', 'A1')).values).toEqual([[3]])
  })

  it('refuses a range with no sheet and a block of the wrong size, in words', async () => {
    expect(text(await run('office_range_read', { workbook: MINE, range: 'A1' }))).toContain("Name the sheet")
    expect(await run('office_range_write', { workbook: MINE, range: 'Sheet1!A1:B1', values: [[1]], because: 'own' })).toMatchObject({ isError: true })
  })
})

describe('nothing is sent without his press', () => {
  const SENDS: [string, unknown][] = [
    ['office_mail_send', { to: ['dana@example.com'], subject: 'Plan', html: '<p><b>Here</b> it is</p>' }],
    ['office_mail_send', { to: [], subject: 'Re: Budget', html: '<p>Yes</p>', replyTo: '42' }],
    ['office_mail_send', { to: ['lee@example.com'], subject: 'Fw: Budget', html: '<p>FYI</p>', forward: '42' }],
    ['office_calendar_create', { subject: 'Review', start: '2026-11-20T15:00:00Z', end: '2026-11-20T15:30:00Z', attendees: ['dana@example.com'] }],
    ['office_calendar_answer', { id: 'ev-9', answer: 'accept' }]
  ]

  it('every verb that sends, replies, forwards, invites or answers returns a held act, and Outlook sends nothing', async () => {
    const sending = OFFICE_TOOLS.filter((t) => /mail_send|calendar_(create|answer)/.test(t.name)).map((t) => t.name)
    expect(new Set(SENDS.map(([n]) => n))).toEqual(new Set(sending))
    for (const [name, args] of SENDS) expect(text(await run(name, args))).toMatch(/^Held for the owner/)
    expect(held.map((h) => h.kind)).toEqual(['office.mail.send', 'office.mail.send', 'office.mail.send', 'office.calendar.op', 'office.calendar.op'])
    expect(held.every((h) => h.sessionId === 't1')).toBe(true)
    for (const h of held) expect((h.kind === 'office.mail.send' ? OfficeMailSchema : OfficeCalendarSchema).safeParse(h.payload).success).toBe(true)
    expect(office.log.map((l) => l.verb).filter((v) => ['sendMail', 'createEvent', 'answerEvent'].includes(v))).toEqual([])
  })

  it('a reply is held to the sender of the mail it answers, whatever `to` says, and a grant never fits a mail to nobody', async () => {
    await run('office_mail_send', { to: ['boss@example.com'], subject: 'x', html: '<p>Yes</p><script>x()</script>', replyTo: '42' })
    expect(held[0].payload).toMatchObject({ to: ['dana@example.com'], subject: 'Re: Budget', html: '<p>Yes</p>' })
    // What Outlook adds under a reply is named, so the Outbox shows it (milestone 50's hold review, finding 1).
    expect((held[0].payload as OfficeMail).outlookAdds).toMatch(/^The mail from dana@example\.com, "Budget" \(\d{4}-\d\d-\d\d\), under this one$/)
    const mail = officeActs({ carrier: () => office }).find((a) => a.kind === 'office.mail.send')!
    expect(mail.matches!({ domains: ['example.com'] }, OfficeMailSchema.parse({ host: 'env_mac', to: [], subject: 's', html: '' }))).toBe(false)
  })

  it('an edit in the Outbox keeps what Outlook fixes: the account, the mail answered, a reply\'s recipients and a reply or forward\'s subject', () => {
    const reply = OfficeMailSchema.parse({ host: 'env_mac', account: 'me@example.com', to: ['dana@example.com'], subject: 'Re: Budget', html: '<p>Yes</p>', replyTo: '42', outlookAdds: 'x' })
    const edited = keepOfficeMail(reply, { ...reply, host: 'env_box', account: 'other@example.com', to: ['boss@example.com'], subject: 'Hi', html: '<p>No</p>', cc: ['lee@example.com'], replyTo: undefined, outlookAdds: undefined })
    expect(edited).toEqual({ ...reply, html: '<p>No</p>', cc: ['lee@example.com'] })
    const forward = OfficeMailSchema.parse({ host: 'env_mac', to: ['lee@example.com'], subject: 'Fw: Budget', html: '', forward: '42' })
    expect(keepOfficeMail(forward, { ...forward, to: ['sam@example.com'], subject: 'Hi' })).toMatchObject({ to: ['sam@example.com'], subject: 'Fw: Budget' })
    const plain = OfficeMailSchema.parse({ host: 'env_mac', to: ['lee@example.com'], subject: 'Plan', html: '' })
    expect(keepOfficeMail(plain, { ...plain, to: ['sam@example.com'], subject: 'Hi' })).toMatchObject({ to: ['sam@example.com'], subject: 'Hi' })
  })

  it("an answer's card names the invitation as his calendar has it, whatever subject the model gives", async () => {
    await run('office_calendar_answer', { id: 'ev-9', subject: 'Something harmless', answer: 'accept' })
    expect(held[0].payload).toMatchObject({ id: 'ev-9', subject: 'Standup', organizer: expect.any(String) })
    expect(text(await run('office_calendar_answer', { id: 'ev-404', answer: 'accept' }))).toMatch(/no event with that id/)
  })

  it('a draft only leaves a draft, and a hold on his own calendar with nobody invited is made at once', async () => {
    await run('office_mail_draft', { to: ['dana@example.com'], subject: 'Plan', html: '<p>x</p>' })
    await run('office_calendar_create', { subject: 'Focus', start: '2026-11-20T15:00:00Z', end: '2026-11-20T17:00:00Z' })
    expect(office.drafts).toHaveLength(1)
    expect(office.sent).toEqual([])
    expect(office.calendar.map((e) => e.subject)).toEqual(['Standup', 'Focus'])
    expect(held).toEqual([])
  })

  it("the act's own execute sends with its formatting, scripts taken out, and only on the host it was held on", async () => {
    const acts = officeActs({ carrier: () => office })
    const mail = acts.find((a) => a.kind === 'office.mail.send')!
    const p = OfficeMailSchema.parse({ host: 'env_mac', to: ['dana@example.com'], subject: 'Plan', html: '<table border="1"><tr><td><b>1</b></td></tr></table><script>x()</script><a href="javascript:y()" onclick="z()">l</a>' })
    expect(mail.words(p)).toEqual({ summary: 'Send to dana@example.com: Plan', verb: 'Send' })
    const actCtx = { host: 'env_mac' } as ActCtx
    await expect(mail.execute(p, actCtx)).resolves.toMatchObject({ summary: 'Sent to dana@example.com: Plan', ref: { outlook: 'sent-1' } })
    expect(office.sent[0].html).toBe('<table border="1"><tr><td><b>1</b></td></tr></table><a >l</a>')
    expect(cleanMailHtml('<img src="https://a.test/1.png" srcset="https://b.test/2.png 2x">')).toBe('<img src="https://a.test/1.png" >')
    // however the attribute is set off from the one before it
    expect(cleanMailHtml('<img src="https://a.test/1.png"/srcset="https://b.test/2.png 2x">')).not.toContain('b.test')
    expect(cleanMailHtml('<img src="https://a.test/1.png"srcset="https://b.test/2.png 2x">')).not.toContain('b.test')
    await expect(mail.execute({ ...p, host: 'env_box' }, actCtx)).rejects.toThrow('held for another host')
    expect(office.sent).toHaveLength(1)

    const cal = acts.find((a) => a.kind === 'office.calendar.op')!
    await cal.execute(OfficeCalendarSchema.parse({ host: 'env_mac', op: 'answer', id: 'ev-9', subject: 'Standup', answer: 'decline' }), actCtx)
    expect(office.answers).toEqual([{ id: 'ev-9', answer: 'decline' }])
    // an invitation that changed or went since it was shown is stale, and nothing is answered
    await expect(cal.execute(OfficeCalendarSchema.parse({ host: 'env_mac', op: 'answer', id: 'ev-9', subject: 'Board meeting', answer: 'accept' }), actCtx)).rejects.toThrow('changed since it was shown')
    await expect(cal.execute(OfficeCalendarSchema.parse({ host: 'env_mac', op: 'answer', id: 'ev-404', subject: 'Standup', answer: 'accept' }), actCtx)).rejects.toThrow('no longer in his calendar')
    expect(office.answers).toHaveLength(1)
  })

  it('a grant fits a mail only when every recipient is named or in a named domain', () => {
    const mail = officeActs({ carrier: () => office }).find((a) => a.kind === 'office.mail.send')!
    const p = OfficeMailSchema.parse({ host: 'env_mac', to: ['dana@contoso.com'], cc: ['lee@other.com'], subject: 's', html: '' })
    expect(mail.matches!({ domains: ['contoso.com'] }, p)).toBe(false)
    expect(mail.matches!({ domains: ['contoso.com'], recipients: ['lee@other.com'] }, p)).toBe(true)
    expect(mail.matches!({}, p)).toBe(false)
  })
})

describe('a thread on a host with no Office', () => {
  it("goes to the workspace's desktop host through ctx.peer: read for a read, write with whether his words were found", async () => {
    said = ['add the row']
    await run('office_range_read', { workbook: MINE, range: 'Sheet1!A1' }, false)
    await run('office_range_write', { workbook: MINE, range: 'Sheet1!A1', values: [[1]], because: 'asked', quote: 'add the row' }, false)
    expect(peerCalls).toEqual([
      { host: 'env_mac', module: 'office', verb: 'read', args: { tool: 'office_range_read', args: { workbook: MINE, range: 'Sheet1!A1' } } },
      { host: 'env_mac', module: 'office', verb: 'write', args: { tool: 'office_range_write', args: { workbook: MINE, range: 'Sheet1!A1', values: [[1]], because: 'asked', quote: 'add the row' }, asked: true, by: 'agent:env_mac:t1' } }
    ])
  })
})

describe('cleanMailHtml', () => {
  it('holds against tags rebuilt from their pieces, handlers after a slash and encoded script links', () => {
    expect(cleanMailHtml('<scr<script>ipt>alert(1)</scr<script>ipt>')).not.toMatch(/<script/i)
    expect(cleanMailHtml('<img/onerror=alert(1) src=x>')).toBe('<img/ src=x>')
    expect(cleanMailHtml('<a href="java&#x73;cript:x()">l</a><svg><a xlink:href="javascript:y()">m</a></svg>')).toBe('<a>l</a>')
  })

  it('keeps the look and drops what runs or reaches out', () => {
    expect(cleanMailHtml('<p style="color:red">a</p><iframe src="x"></iframe><img src="cid:1" onerror="x()">')).toBe('<p style="color:red">a</p><img src="cid:1" >')
  })
})

// The Env type is what both routes hand a tool; keep the test honest about it.
export type { Env, WorkCtx }
