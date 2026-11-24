import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HeldItem, WorkToolResult } from '@shared/work'
import type { ActCtx, ToolCtx, WorkCtx } from '../modules'
import { ensureSuggestionTables, SuggestionStore } from '../sheets/suggestions'
import { ensureExcelTables, excelStore, ExcelHelper } from './excel'
import { ActNotSent, ActStale } from '../outbox/kinds'
import { OfficeError } from './carrier'
import { FakeOffice } from './fake'
import { cleanMailHtml, keepOfficeMail, officeActs, OfficeCalendarSchema, OfficeEditSchema, OfficeMailSchema, type OfficeCalendarOp, type OfficeEdit, type OfficeMail } from './held'
import { fileShared } from './shared'
import { fileKey, fileName, OFFICE_TOOLS, sharedKey, type Env, workTools } from './tools'

/**
 * The tool set over a fake Office: what is written, what waits on this host
 * (cells as suggestions, a document's or a deck's words as a held
 * `office.edit`), and that every verb that sends or changes a shared file
 * answers a held act while Office does nothing until the act's own execute.
 */
const SHARED = 'https://contoso.sharepoint.com/sites/t/Plan.xlsx'
const MINE = '/Users/owner/Documents/Mine.xlsx'
let office: FakeOffice
let db: DatabaseSync
let suggestions: SuggestionStore
let held: { kind: string; sessionId: string | null; payload: unknown }[]
const dataDir = mkdtempSync(join(tmpdir(), 'office-tools-'))
let said: string[]
let peerCalls: { host: string; module: string; verb: string; args: unknown }[]

const ctx = (): ToolCtx =>
  ({
    db,
    host: 'env_mac',
    dataDir,
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

  it("keeps an agent's own idea for a shared Word document on this host: nothing reaches Word until his press", async () => {
    const KEY = 'https://contoso.sharepoint.com/Brief.docx'
    const before = JSON.stringify([...office.docs])
    expect(text(await run('office_doc_edit', { document: KEY, find: 'one', replace: 'two', because: 'own' }))).toContain('nobody else sees it')
    expect(JSON.stringify([...office.docs])).toBe(before)
    expect(office.log.filter((c) => c.verb === 'editDocument')).toEqual([])
    expect(held).toMatchObject([{ kind: 'office.edit', sessionId: 't1', payload: { host: 'env_mac', app: 'word', key: KEY, name: 'Brief.docx', edit: { find: 'one', replace: 'two' }, places: 1 } }])
    // his press makes it a plain edit: no tracked change is left for anyone
    const edit = officeActs({ carrier: () => office }).find((a) => a.kind === 'office.edit')!
    await expect(edit.execute(OfficeEditSchema.parse(held[0]!.payload), { host: 'env_mac' } as ActCtx)).resolves.toMatchObject({ summary: 'Changed Brief.docx' })
    expect(office.docs.get(KEY)).toEqual({ paragraphs: ['Draft two.'], tracked: [] })
  })

  it("writes a shared document plainly when his own words for it are in the thread", async () => {
    said = ['change one to two please']
    await run('office_doc_edit', { document: 'https://contoso.sharepoint.com/Brief.docx', find: 'one', replace: 'two', because: 'asked', quote: 'change one to two' })
    expect(office.docs.get('https://contoso.sharepoint.com/Brief.docx')).toEqual({ paragraphs: ['Draft two.'], tracked: [] })
    expect(held).toEqual([])
  })

  it('judges a file named by its bare name, or by a Windows path, as the file the carrier opens: a shared one is not written plainly', async () => {
    const CLOUD = '/Users/owner/Library/CloudStorage/OneDrive-Contoso/Budget.docx'
    office.docs.set(CLOUD, { paragraphs: ['Draft one.'], tracked: [] })
    await run('office_doc_edit', { document: 'Budget.docx', find: 'one', replace: 'two', because: 'own' })
    expect(office.docs.get(CLOUD)).toEqual({ paragraphs: ['Draft one.'], tracked: [] })
    expect(held.at(-1)).toMatchObject({ kind: 'office.edit', payload: { key: CLOUD } })

    const BOOK = '/Users/owner/Library/CloudStorage/OneDrive-Contoso/Plan 2.xlsx'
    office.addBook(BOOK, { Sheet1: { B1: 100 } })
    expect(text(await run('office_range_write', { workbook: 'Plan 2.xlsx', range: 'Sheet1!B1', values: [[120]], because: 'own' }))).toContain('1 cell waits as suggestions')
    expect((await office.readRange(BOOK, 'Sheet1', 'B1')).values).toEqual([[100]])
    expect(suggestions.open(excelStore(BOOK))).toHaveLength(1)

    office.decks.set('/Users/owner/OneDrive - Contoso/Pitch.pptx', [['Q1 plan']])
    expect(text(await run('office_slides_replace', { deck: 'Pitch.pptx', find: 'Q1', replace: 'Q2', because: 'own' }))).toContain('nobody else sees it')
    expect(office.decks.get('/Users/owner/OneDrive - Contoso/Pitch.pptx')).toEqual([['Q1 plan']])
    expect(held.at(-1)).toMatchObject({ kind: 'office.edit', payload: { app: 'powerpoint', key: '/Users/owner/OneDrive - Contoso/Pitch.pptx', edit: { find: 'Q1', replace: 'Q2' }, places: 1 } })

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

  it("takes back a write to a shared workbook only on his words: an undo there is a change its co-authors see", async () => {
    said = ['set Q1 to 120 please']
    const w = JSON.parse(text(await run('office_range_write', { workbook: SHARED, range: 'Sheet1!B1', values: [[120]], because: 'asked', quote: 'set Q1 to 120' }))) as { writeId: string }
    expect(await run('office_range_undo', { workbook: SHARED, writeId: w.writeId })).toMatchObject({ isError: true })
    expect((await office.readRange(SHARED, 'Sheet1', 'B1')).values).toEqual([[120]])
    said.push('undo that please')
    expect(text(await run('office_range_undo', { workbook: SHARED, writeId: w.writeId, because: 'asked', quote: 'undo that' }))).toBe('Taken back.')
    expect((await office.readRange(SHARED, 'Sheet1', 'B1')).values).toEqual([[100]])
  })

  it('refuses a range with no sheet and a block of the wrong size, in words', async () => {
    expect(text(await run('office_range_read', { workbook: MINE, range: 'A1' }))).toContain("Name the sheet")
    expect(await run('office_range_write', { workbook: MINE, range: 'Sheet1!A1:B1', values: [[1]], because: 'own' })).toMatchObject({ isError: true })
  })
})

describe('office_files', () => {
  it("says why Outlook here cannot carry mail, when the carrier knows", async () => {
    office.problem = 'New Outlook does not answer scripts yet'
    expect(JSON.parse(text(await run('office_files', {})))).toMatchObject({ outlook: 'New Outlook does not answer scripts yet' })
    office.problem = null
    expect(JSON.parse(text(await run('office_files', {})))).not.toHaveProperty('outlook')
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
    expect((held[0].payload as OfficeMail).outlookAdds).toMatch(/^The mail from dana@example\.com, "Budget" \([A-Z][a-z]{2} \d{1,2}\), under this one$/)
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

  it('a reply or a forward goes from the account its mail sits in: held with that account, and another one asked for is refused', async () => {
    const asked = await run('office_mail_send', { replyTo: '42', to: [], subject: 'x', html: '<p>Sent.</p>', account: 'work@contoso.com' })
    expect(asked).toMatchObject({ isError: true })
    expect(text(asked)).toContain('That mail is in owner@example.com: a reply goes from there, not from work@contoso.com.')
    expect(await run('office_mail_send', { forward: '42', to: ['lee@example.com'], subject: 'x', html: '<p>FYI</p>', account: 'WORK@contoso.com' })).toMatchObject({ isError: true })
    expect(held).toEqual([])
    await run('office_mail_send', { replyTo: '42', to: [], subject: 'x', html: '<p>Sent.</p>' })
    await run('office_mail_send', { forward: '42', to: ['lee@example.com'], subject: 'x', html: '<p>FYI</p>', account: 'Owner@Example.com' })
    expect(held.map((h) => [(h as { account?: string }).account, (h.payload as OfficeMail).account])).toEqual([
      ['owner@example.com', 'owner@example.com'],
      ['owner@example.com', 'owner@example.com']
    ])
    expect(office.log.some((l) => l.verb === 'sendMail')).toBe(false)
  })

  it("an answer's card names the invitation as his calendar has it, whatever subject the model gives", async () => {
    await run('office_calendar_answer', { id: 'ev-9', subject: 'Something harmless', answer: 'accept' })
    expect(held[0].payload).toMatchObject({ id: 'ev-9', subject: 'Standup', organizer: expect.any(String) })
    expect(text(await run('office_calendar_answer', { id: 'ev-404', answer: 'accept' }))).toMatch(/no event with that id/)
  })

  it("an answer keeps the invitation's end and place, and the press refuses one moved or placed elsewhere since, or a hold that kept neither", async () => {
    office.calendar[0] = { ...office.calendar[0]!, end: new Date(Date.parse(office.calendar[0]!.start) + 7 * 864e5).toISOString(), location: 'Room 4' }
    await run('office_calendar_answer', { id: 'ev-9', answer: 'accept' })
    const p = held[0]!.payload as OfficeCalendarOp
    expect(p).toMatchObject({ end: office.calendar[0]!.end, location: 'Room 4' })
    const cal = officeActs({ carrier: () => office }).find((a) => a.kind === 'office.calendar.op')!
    const actCtx = { host: 'env_mac' } as ActCtx
    const was = office.calendar[0]!
    office.calendar[0] = { ...was, end: new Date(Date.parse(was.end) + 3_600_000).toISOString() }
    await expect(cal.execute(p, actCtx)).rejects.toThrow(ActStale)
    office.calendar[0] = { ...was, location: 'Lawson 1142' }
    await expect(cal.execute(p, actCtx)).rejects.toThrow('changed since it was shown')
    // a hold made before the end and place were kept says nothing of them: refused, never answered blind
    office.calendar[0] = was
    const { end: _end, location: _place, ...older } = p as Extract<OfficeCalendarOp, { op: 'answer' }>
    await expect(cal.execute(OfficeCalendarSchema.parse(older), actCtx)).rejects.toThrow('held before its time and place were kept')
    expect(office.answers).toEqual([])
    await cal.execute(p, actCtx)
    expect(office.answers).toEqual([{ id: 'ev-9', answer: 'accept' }])
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
    const p = OfficeMailSchema.parse({ host: 'env_mac', account: 'owner@example.com', to: ['dana@example.com'], subject: 'Plan', html: '<table border="1"><tr><td><b>1</b></td></tr></table><script>x()</script><a href="javascript:y()" onclick="z()">l</a>' })
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
    const { start, end, location } = office.calendar[0]!
    const shown = { host: 'env_mac', op: 'answer', id: 'ev-9', subject: 'Standup', start, end, location }
    await cal.execute(OfficeCalendarSchema.parse({ ...shown, answer: 'decline' }), actCtx)
    expect(office.answers).toEqual([{ id: 'ev-9', answer: 'decline' }])
    // an invitation that changed or went since it was shown is stale, and nothing is answered
    await expect(cal.execute(OfficeCalendarSchema.parse({ ...shown, subject: 'Board meeting', answer: 'accept' }), actCtx)).rejects.toThrow('changed since it was shown')
    await expect(cal.execute(OfficeCalendarSchema.parse({ ...shown, id: 'ev-404', answer: 'accept' }), actCtx)).rejects.toThrow('no longer in his calendar')
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

describe("the account a held mail or invitation goes from (the hold review's 16.8)", () => {
  const payloadOf = (i: number) => held[i]!.payload as { account?: string; event?: { account?: string } }

  it("binds Outlook's only account when none is named, for a mail and for an invitation", async () => {
    expect(text(await run('office_mail_send', { to: ['dana@example.com'], subject: 'Plan', html: '<p>Hi</p>' }))).toMatch(/^Held for the owner/)
    expect(payloadOf(0).account).toBe('owner@example.com')
    expect(text(await run('office_calendar_create', { subject: 'Review', start: '2026-11-20T15:00:00Z', end: '2026-11-20T15:30:00Z', attendees: ['dana@example.com'] }))).toMatch(/^Held for the owner/)
    expect(payloadOf(1).event!.account).toBe('owner@example.com')
  })

  it("with several accounts, binds the one named (as Outlook spells it) and refuses to guess when none is", async () => {
    office.addresses = ['owner@example.com', 'work@contoso.com']
    const unnamed = await run('office_mail_send', { to: ['dana@example.com'], subject: 'Plan', html: '<p>Hi</p>' })
    expect(unnamed).toMatchObject({ isError: true })
    expect(text(unnamed)).toContain('name the one it goes from in `account`')
    expect(await run('office_calendar_create', { subject: 'Review', start: '2026-11-20T15:00:00Z', end: '2026-11-20T15:30:00Z', attendees: ['dana@example.com'] })).toMatchObject({ isError: true })
    expect(held).toEqual([])
    await run('office_mail_send', { to: ['dana@example.com'], subject: 'Plan', html: '<p>Hi</p>', account: 'WORK@contoso.com' })
    expect(payloadOf(0).account).toBe('work@contoso.com')
    const unknown = await run('office_mail_send', { to: ['dana@example.com'], subject: 'Plan', html: '<p>Hi</p>', account: 'other@example.com' })
    expect(text(unknown)).toContain('Outlook has no account other@example.com')
    expect(held).toHaveLength(1)
  })

  it("keeps a reply's account the mail it answers sits in, whatever the other accounts", async () => {
    office.addresses = ['owner@example.com', 'work@contoso.com']
    await run('office_mail_send', { to: [], subject: 'x', html: '<p>Yes</p>', replyTo: '42' })
    expect(payloadOf(0).account).toBe('owner@example.com')
  })

  it("refuses at the press a new mail or invitation held before its account was kept, and sends nothing", async () => {
    const acts = officeActs({ carrier: () => office })
    const actCtx = { host: 'env_mac' } as ActCtx
    const mail = acts.find((a) => a.kind === 'office.mail.send')!
    await expect(mail.execute(OfficeMailSchema.parse({ host: 'env_mac', to: ['dana@example.com'], subject: 'Plan', html: '<p>Hi</p>' }), actCtx)).rejects.toThrow('before the account it goes from was kept')
    const cal = acts.find((a) => a.kind === 'office.calendar.op')!
    await expect(
      cal.execute(OfficeCalendarSchema.parse({ host: 'env_mac', op: 'create', event: { subject: 'Review', start: '2026-11-20T15:00:00Z', end: '2026-11-20T15:30:00Z', attendees: ['dana@example.com'] } }), actCtx),
    ).rejects.toThrow('before the account it goes from was kept')
    expect(office.sent).toEqual([])
    expect(office.log.map((l) => l.verb).filter((v) => v === 'createEvent')).toEqual([])
  })
})

describe("an agent's change to a shared document or deck, held (the owner's ruling of 2026-11-23)", () => {
  const DOC = 'https://contoso.sharepoint.com/Brief.docx'
  const DECK = '/Users/owner/Library/CloudStorage/OneDrive-Contoso/Pitch.pptx'
  const editAct = () => officeActs({ carrier: () => office }).find((a) => a.kind === 'office.edit')!
  const press = (p: unknown) => editAct().execute(OfficeEditSchema.parse(p), { host: 'env_mac' } as ActCtx)
  const state = () => JSON.stringify([[...office.docs], [...office.decks], [...office.books].map(([k, b]) => [k, JSON.stringify(b)])])

  it('leaves every open file byte for byte as it was, whatever the tool and whatever the agent says of itself', async () => {
    office.decks.set(DECK, [['Q1 plan', 'Q1 goals'], ['Close']])
    const before = state()
    await run('office_doc_edit', { document: DOC, insert: 'A new last line.', at: 'end', because: 'own' })
    await run('office_doc_edit', { document: DOC, find: 'Draft', replace: 'Final', because: 'asked', quote: 'words he never wrote' })
    await run('office_doc_edit', { document: DOC, find: 'Draft', replace: 'Final', because: 'routine' })
    await run('office_slides_replace', { deck: DECK, find: 'Q1', replace: 'Q2', because: 'own' })
    await run('office_range_write', { workbook: SHARED, range: 'Sheet1!A1', values: [['Q2']], because: 'own' })
    expect(state()).toBe(before)
    expect(office.log.filter((c) => ['editDocument', 'replaceSlideText', 'writeRange'].includes(c.verb))).toEqual([])
    expect(held.map((h) => h.kind)).toEqual(['office.edit', 'office.edit', 'office.edit', 'office.edit'])
    expect(held[3]).toMatchObject({ payload: { app: 'powerpoint', places: 2 } })
  })

  it('takes no grant and cannot be edited: every one waits for his press', () => {
    const def = editAct()
    expect(def.matcher).toBeUndefined()
    expect(def.matches).toBeUndefined()
    expect(def.keep).toBeUndefined()
  })

  it('leaves a deck change stale when its words stand on other slides than he was shown', async () => {
    office.decks.set(DECK, [['Q1 plan'], ['Close']])
    await run('office_slides_replace', { deck: DECK, find: 'Q1', replace: 'Q2', because: 'own' })
    expect(held[0]).toMatchObject({ payload: { on: [1] } })
    office.decks.set(DECK, [['Open'], ['Q1 plan']])
    await expect(press(held[0]!.payload)).rejects.toThrow('other slides')
    expect(office.decks.get(DECK)).toEqual([['Open'], ['Q1 plan']])
  })

  it('makes a deck change on his press, as a plain replace', async () => {
    office.decks.set(DECK, [['Q1 plan']])
    await run('office_slides_replace', { deck: DECK, find: 'Q1', replace: 'Q2', because: 'own' })
    await expect(press(held[0]!.payload)).resolves.toMatchObject({ summary: 'Changed Pitch.pptx' })
    expect(office.decks.get(DECK)).toEqual([['Q2 plan']])
  })

  it('says plainly when the file changed under it: written while the words still stand as they did, else nothing', async () => {
    await run('office_doc_edit', { document: DOC, find: 'one', replace: 'two', because: 'own' })
    const p = held[0]!.payload as OfficeEdit
    // someone added a line: the words still stand once, so it is written, and he is told the file moved
    office.docs.get(DOC)!.paragraphs.push('A co-author wrote this.')
    // the words still stand where he saw them: written, with nothing more to say
    await expect(press(p)).resolves.toEqual({ summary: 'Changed Brief.docx' })
    expect(office.docs.get(DOC)!.paragraphs[0]).toBe('Draft two.')
    // the words are gone: stale, nothing written
    office.docs.set(DOC, { paragraphs: ['Draft three.'], tracked: [] })
    await expect(press(p)).rejects.toThrow(ActStale)
    await expect(press(p)).rejects.toThrow('Brief.docx changed since: "one" is no longer in the document. Nothing was changed.')
    // the words stand in more places than he was shown: stale, nothing written
    office.docs.set(DOC, { paragraphs: ['one and one'], tracked: [] })
    await expect(press(p)).rejects.toThrow('"one" stands in 2 places now, not the 1 place shown')
    expect(office.docs.get(DOC)).toEqual({ paragraphs: ['one and one'], tracked: [] })
  })

  it('leaves a change stale when a co-author moved its words to another paragraph or box, the count alike', async () => {
    office.docs.set(DOC, { paragraphs: ['Budget: one.', 'Notes'], tracked: [] })
    await run('office_doc_edit', { document: DOC, find: 'one', replace: 'two', because: 'own' })
    const doc = held[0]!.payload as OfficeEdit
    expect(doc.spots).toEqual(expect.any(String))
    // The only match now stands in another paragraph: Word's replace would change words he never saw.
    office.docs.set(DOC, { paragraphs: ['Budget: TBD.', 'Notes: one'], tracked: [] })
    await expect(press(doc)).rejects.toThrow('"one" stands in other paragraphs now than the ones shown')
    expect(office.docs.get(DOC)!.paragraphs).toEqual(['Budget: TBD.', 'Notes: one'])
    // A line added elsewhere leaves its paragraph as it was: written.
    office.docs.set(DOC, { paragraphs: ['Budget: one.', 'Notes', 'A co-author wrote this.'], tracked: [] })
    await expect(press(doc)).resolves.toEqual({ summary: 'Changed Brief.docx' })
    // On one slide, from one box to another.
    office.decks.set(DECK, [['Q1 plan', 'Close']])
    await run('office_slides_replace', { deck: DECK, find: 'Q1', replace: 'Q2', because: 'own' })
    office.decks.set(DECK, [['Plan', 'Close Q1']])
    await expect(press(held[1]!.payload)).rejects.toThrow('"Q1" stands in other boxes now than the ones shown')
    expect(office.decks.get(DECK)).toEqual([['Plan', 'Close Q1']])
    // A hold from before `spots` is judged on the whole text it read.
    const { spots: _none, placed: _nor, ...older } = doc
    office.docs.set(DOC, { paragraphs: ['Budget: one.', 'Notes', 'Changed'], tracked: [] })
    await expect(press(older)).rejects.toThrow('other paragraphs')
  })

  it('leaves a change stale when its paragraph was moved whole to another place, and judges a hold from before by its own spots', async () => {
    office.docs.set(DOC, { paragraphs: ['Budget: one.', 'Notes'], tracked: [] })
    await run('office_doc_edit', { document: DOC, find: 'one', replace: 'two', because: 'own' })
    const doc = held[0]!.payload as OfficeEdit
    expect(doc.placed).toEqual(expect.any(String))
    // The same paragraph, its words alike, now stands second.
    office.docs.set(DOC, { paragraphs: ['Notes', 'Budget: one.'], tracked: [] })
    await expect(press(doc)).rejects.toThrow('"one" stands in other paragraphs now than the ones shown')
    expect(office.docs.get(DOC)!.paragraphs).toEqual(['Notes', 'Budget: one.'])
    // A hold made before round 2 has no `placed`: decided as it was made, by the words of its paragraphs alone.
    const { placed: _none, ...older } = doc
    await expect(press(older)).resolves.toEqual({ summary: 'Changed Brief.docx' })
    expect(office.docs.get(DOC)!.paragraphs).toEqual(['Notes', 'Budget: two.'])
  })

  it('is stale, nothing written, when the carrier finds another count than he was shown as it writes', async () => {
    await run('office_doc_edit', { document: DOC, find: 'one', replace: 'two', because: 'own' })
    const asked: unknown[] = []
    const racing = Object.assign(Object.create(office), {
      editDocument: async (_doc: string, _edit: unknown, _tracked: boolean, bound?: unknown) => {
        asked.push(bound)
        throw new OfficeError('The words stand in 2 places now, not the 1 shown.', 'refused')
      }
    })
    const def = officeActs({ carrier: () => racing }).find((a) => a.kind === 'office.edit')!
    await expect(def.execute(OfficeEditSchema.parse(held[0]!.payload), { host: 'env_mac' } as ActCtx)).rejects.toThrow(ActStale)
    expect(asked).toEqual([{ places: 1, at: [[0, 'Draft one.']] }])
    expect(office.docs.get(DOC)!.paragraphs).toEqual(['Draft one.'])
  })

  it('a file no longer open is not sent: open it and press again', async () => {
    await run('office_doc_edit', { document: DOC, find: 'one', replace: 'two', because: 'own' })
    office.docs.delete(DOC)
    await expect(press(held[0]!.payload)).rejects.toThrow(ActNotSent)
  })

  it('runs only on the host it was held on', async () => {
    await run('office_doc_edit', { document: DOC, find: 'one', replace: 'two', because: 'own' })
    await expect(editAct().execute(OfficeEditSchema.parse(held[0]!.payload), { host: 'env_other' } as ActCtx)).rejects.toThrow('another host')
    expect(office.docs.get(DOC)!.paragraphs).toEqual(['Draft one.'])
  })

  it('a change held through the Windows VM is pressed there, never in this host\'s own Office', async () => {
    const vmOffice = new FakeOffice()
    vmOffice.docs.set(DOC, { paragraphs: ['Draft one.'], tracked: [] })
    const tools = workTools({ here: () => ({ carrier: vmOffice, excel: new ExcelHelper(vmOffice, db, suggestions), suggestions }), vm: true })
    await tools.find((t) => t.name === 'office_doc_edit')!.run({ document: DOC, find: 'one', replace: 'two', because: 'own' }, ctx())
    expect(held[0]).toMatchObject({ kind: 'office.edit', payload: { vm: true } })
    const def = officeActs({ carrier: () => office, vm: async () => vmOffice }).find((a) => a.kind === 'office.edit')!
    await def.execute(OfficeEditSchema.parse(held[0]!.payload), { host: 'env_mac' } as ActCtx)
    expect(vmOffice.docs.get(DOC)!.paragraphs).toEqual(['Draft two.'])
    expect(office.docs.get(DOC)!.paragraphs).toEqual(['Draft one.'])
    // a host with no VM Office refuses it, with nothing written anywhere
    await expect(officeActs({ carrier: () => office }).find((a) => a.kind === 'office.edit')!.execute(OfficeEditSchema.parse(held[0]!.payload), { host: 'env_mac' } as ActCtx)).rejects.toThrow(ActNotSent)
  })

  it('says when the app changed fewer places than he was shown', async () => {
    await run('office_doc_edit', { document: DOC, find: 'one', replace: 'two', because: 'own' })
    const p = { ...(held[0]!.payload as OfficeEdit), places: 1 }
    office.failNext = null
    const real = office.editDocument.bind(office)
    office.editDocument = async (d, e, t) => (await real(d, e, t), 0)
    await expect(press(p)).resolves.toMatchObject({ summary: expect.stringContaining('Word changed 0 of the 1 place') })
  })

  it('reads its words as he approves them', () => {
    const words = (edit: OfficeEdit['edit']) => editAct().words({ host: 'h', app: 'word', key: '/x/Brief.docx', name: 'Brief.docx', edit, places: 1, base: 'b' })
    expect(words({ find: 'one', replace: 'two' })).toEqual({ summary: 'Make the change in Brief.docx: "one" to "two"', verb: 'Make the change' })
    expect(words({ find: 'one', replace: '' }).summary).toBe('Make the change in Brief.docx: take out "one"')
    // nothing to see: its escapes, in the line too
    expect(words({ insert: '\u200b', at: 'end' }).summary).toBe('Make the change in Brief.docx: add at the end: "\\u200b"')
    expect(editAct().words({ host: 'h', app: 'word', key: '/x/Brief.docx', name: 'Brief.docx', edit: { find: 'Q1', replace: 'Q2' }, places: 4, base: 'b' }).summary).toBe('Make the change in Brief.docx: 4 places, "Q1" to "Q2"')
    expect(words({ insert: 'x', at: 'end' }).summary).toBe('Make the change in Brief.docx: add at the end: "x"')
  })

  it("takes the host's own judgement of sharing when given one, as a Windows PC judges its C:\\ files", async () => {
    const PC = 'C:\\Users\\owner\\Documents\\Notes.docx'
    office.docs.set(PC, { paragraphs: ['Mine.'], tracked: [] })
    const tools = workTools({ here: () => ({ carrier: office, excel: new ExcelHelper(office, db, suggestions), suggestions }), judgeShared: (key) => key === null || sharedKey(key) })
    await tools.find((t) => t.name === 'office_doc_edit')!.run({ document: PC, insert: ' More.', at: 'end', because: 'own' }, ctx())
    expect(office.docs.get(PC)!.paragraphs).toEqual(['Mine.', ' More.'])
    expect(held).toEqual([])
    // without it, the box reads a C:\\ path as the Windows VM's, and so as shared: the change waits
    await run('office_doc_edit', { document: PC, insert: ' Again.', at: 'end', because: 'own' })
    expect(held).toMatchObject([{ kind: 'office.edit' }])
  })

  it('names a file by its key', () => {
    expect(fileName('https://contoso.sharepoint.com/sites/t/Q3%20Plan.docx?web=1')).toBe('Q3 Plan.docx')
    expect(fileName('C:\\Users\\o\\OneDrive - Contoso\\Deck.pptx')).toBe('Deck.pptx')
    expect(fileName('/x/100%.docx')).toBe('100%.docx')
  })
})

describe('fileShared: the one test of whether others can open an Office file', () => {
  const c = () => ({ db, host: 'env_mac', dataDir })
  it('counts a URL, a cloud or OneDrive folder on a Mac or in Windows, a network share and an unknown file as shared', () => {
    for (const key of ['https://contoso.sharepoint.com/x.docx', '/Users/o/Library/CloudStorage/OneDrive-Contoso/x.docx', 'C:\\Users\\o\\OneDrive - Contoso\\x.xlsx', '\\\\server\\team\\x.pptx', '//server/team/x.pptx'])
      expect(fileShared(c(), key, 'word')).toBe(true)
    expect(fileShared(c(), null, 'word')).toBe(true)
  })
  it('counts a mounted volume and a mapped Windows drive as shared: such a disk is others\' as often as not', () => {
    for (const key of ['/Volumes/Finance/Budget.xlsx', '/mnt/team/Plan.docx', 'S:\\Finance\\Budget.xlsx', 'z:/x.pptx']) expect(fileShared(c(), key, 'excel')).toBe(true)
    // C: is this computer's own disk; on a host that is not Windows, Files counts a path in the VM as shared all the same
    expect(sharedKey('C:\\Users\\tcuser\\Documents\\Mine.xlsx')).toBe(false)
    expect(fileShared(c(), 'C:\\Users\\tcuser\\Documents\\Mine.xlsx', 'excel')).toBe(process.platform !== 'win32')
  })
  it('counts his own file, and what the app keeps for him, as his', () => {
    expect(fileShared(c(), '/Users/owner/Documents/Mine.docx', 'word')).toBe(false)
    expect(fileShared(c(), join(dataDir, 'copy.docx'), 'word')).toBe(false)
  })
})

describe('fileKey', () => {
  it("finds Word's /private/tmp key from the /tmp path an agent names", async () => {
    const office = new FakeOffice()
    office.docs.set('/private/tmp/office-live/doc-test.docx', { paragraphs: [], tracked: [] })
    await expect(fileKey({ carrier: office }, 'document', '/tmp/office-live/doc-test.docx')).resolves.toBe('/private/tmp/office-live/doc-test.docx')
  })
})
