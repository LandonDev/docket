import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SheetChange } from 'work-kit/sheet/source'
import type { HeldItem, WorkToolResult } from '@shared/work'
import type { ActCtx, ToolCtx } from '../../modules'
import { ensureSuggestionTables, SuggestionStore } from '../../sheets/suggestions'
import { ensureExcelTables, excelStore, ExcelHelper, parseAddress } from '../excel'
import { officeActs, OfficeCalendarSchema, OfficeMailSchema } from '../held'
import { workTools } from '../tools'
import { comCarrier, type ComCarrier } from './carrier'

/**
 * The tool set's contract on Windows: the real tc-office.exe, built in the
 * rig with the recorded COM surface compiled in (native/tc-office-win/
 * RecordedCom.cs), driven over the rig's SSH by the real carrier, tools, held
 * acts and Excel helper. Opt in: build first with
 * `native/tc-office-win/build-in-rig.sh m44`, then
 * `TC_OFFICE_RIG=m44 NODE_ENV=test bunx vitest run src/main/server/work/office/com/rig.test.ts`.
 */
const RIG = process.env.TC_OFFICE_RIG
const VM = process.env.WINVM_DIR ?? '/srv/agents/win-vm'
/**
 * The rig's ssh as scripts/win-vm/vm.ts makes it, with Git Bash's pipes between sshd and the helper:
 * sshd hands a program one synchronous handle for stdin and stdout, so a read waiting on it holds
 * every write back. Node gives the helper two pipes of its own, as here.
 */
const sshArgs = (exe: string): string[] => [
  '-i', join(VM, 'keys', 'id_ed25519'), '-p', process.env.WINVM_SSH_PORT ?? '22220',
  '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-o', `UserKnownHostsFile=${join(VM, 'base', 'known_hosts')}`,
  'tcuser@127.0.0.1', `"C:\\Program Files\\Git\\bin\\bash.exe" -c "cat | ./${RIG}/${exe} | cat"`
]

const MINE = 'C:\\Users\\owner\\Documents\\Mine.xlsx'
const SHARED = 'https://contoso.sharepoint.com/sites/t/Plan.xlsx'
const BRIEF = 'https://contoso.sharepoint.com/sites/t/Brief.docx'
const NOTES = 'C:\\Users\\owner\\Documents\\Notes.docx'
const DECK = 'C:\\Users\\owner\\Documents\\Deck.pptx'

interface State {
  renders: Record<string, unknown>[]
  running: string[]
  sent: { account?: string; to?: string; cc?: string; bcc?: string; subject?: string; html?: string; invite?: string; meeting?: number }[]
  answers: { id: string; response: number; sent: boolean; body: string }[]
  started: Record<string, unknown>[]
  drafts: { id: string; subject: string; html: string; to: string }[]
  thrownAway: string[]
  docs: { key: string; text: string; tracked: string[] }[]
  decks: { key: string; slides: string[][] }[]
  events: { id: string; subject: string; meeting: number; attendees: string }[]
}

/** A GlobalObjectId for an invitation made elsewhere: the header, then "vCal-Uid", 01 00 00 00, the UID and a nul. */
const vcalId = (uid: string): string => {
  const head = Buffer.alloc(40)
  Buffer.from('040000008200E00074C5B7101A82E008', 'hex').copy(head)
  return Buffer.concat([head, Buffer.from('vCal-Uid'), Buffer.from([1, 0, 0, 0]), Buffer.from(uid), Buffer.from([0])]).toString('hex').toUpperCase()
}

const SEED = {
  accounts: ['owner@purdue.edu', 'owner@example.com'],
  books: [
    { key: MINE, sheets: { Sheet1: { A1: 1, B1: 'x', A2: '#DIV/0!', B2: '2026-11-19', C1: '=A1*2' } } },
    { key: SHARED, sheets: { Sheet1: { A1: 'Q1', B1: 100 } } }
  ],
  docs: [
    { key: BRIEF, paragraphs: ['Draft one.', 'Second one.'] },
    { key: NOTES, paragraphs: ['Mine.'] }
  ],
  decks: [{ key: DECK, slides: [['Q3 plan', 'Owner: Dana'], ['Q3 numbers']] }],
  mail: [
    { id: '42', account: 'owner@purdue.edu', from: 'dana@example.com', subject: 'Budget', at: '2026-11-18T10:00:00.000Z', read: false, to: ['owner@purdue.edu'], cc: ['lee@example.com'], text: 'Numbers?' },
    { id: '43', account: 'owner@purdue.edu', from: 'kim@example.com', subject: 'Lunch', at: '2026-11-18T12:00:00.000Z', to: ['owner@purdue.edu'], text: 'Noon?' }
  ],
  events: [
    { id: 'ev-9', subject: 'Standup', start: new Date(Date.now() + 864e5).toISOString(), end: new Date(Date.now() + 864e5 + 9e5).toISOString(), organizer: 'Dana', global: vcalId('abc-123@example.com'), attendees: ['owner@purdue.edu'], response: 5 }
  ]
}

describe.skipIf(!RIG)('tc-office.exe over the recorded COM surface (the rig)', () => {
  let carrier: ComCarrier
  let db: DatabaseSync
  let suggestions: SuggestionStore
  let excel: ExcelHelper
  let held: { kind: string; sessionId: string | null; payload: unknown }[]
  let said: string[]
  const logged: string[] = []

  const seed = (extra: Record<string, unknown> = {}) => carrier.call('_seed', { ...SEED, ...extra })
  const state = () => carrier.call<State>('_state', {})
  const ctx = (): ToolCtx =>
    ({
      db,
      host: 'env_pc',
      held: {
        create(act: { kind: string; sessionId: string | null; payload: unknown }) {
          held.push(act)
          return { state: 'held', summary: `held ${act.kind}` } as HeldItem
        }
      },
      threads: { ownerSaid: (_s: string, q: string) => said.some((w) => w.includes(q)) },
      settings: { workspace: () => ({ mayUseDesktop: ['env_pc'], voice: false }) },
      peer: () => ({ call: async () => ({ content: [] }) }),
      scope: { workspaceId: 'w1' },
      sessionId: 't1'
    }) as unknown as ToolCtx
  const run = (name: string, args: unknown): Promise<WorkToolResult> =>
    workTools({ here: () => ({ carrier, excel, suggestions }) })
      .find((t) => t.name === name)!
      .run(args, ctx())
  const text = (r: WorkToolResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
  const actCtx = { host: 'env_pc' } as ActCtx

  beforeAll(() => {
    carrier = comCarrier({ start: async () => spawn('ssh', sshArgs('tc-office-recorded.exe'), { stdio: 'pipe' }), log: (l) => logged.push(l) })
  })
  afterAll(() => carrier?.stop())
  beforeEach(async () => {
    await seed()
    db = new DatabaseSync(':memory:')
    ensureSuggestionTables(db)
    ensureExcelTables(db)
    suggestions = new SuggestionStore(db)
    excel?.stop()
    excel = new ExcelHelper(carrier, db, suggestions)
    held = []
    said = []
  }, 60_000)

  describe('Excel', () => {
    it('lists the open workbooks with their used ranges, and reads values, formulas, formats, dates and error cells as Excel holds them', async () => {
      expect(await carrier.workbooks()).toEqual([
        { key: MINE, name: 'Mine.xlsx', sheets: [{ name: 'Sheet1', rows: 2, columns: 3 }] },
        { key: SHARED, name: 'Plan.xlsx', sheets: [{ name: 'Sheet1', rows: 1, columns: 2 }] }
      ])
      const g = await carrier.readRange(MINE, 'Sheet1', 'A1:C2')
      expect(g.values[0].slice(0, 2)).toEqual([1, 'x'])
      expect(g.values[1][0]).toBe('#DIV/0!')
      expect(g.values[1][1]).toMatch(/^2026-11-1[89]T\d\d:00:00\.000Z$/)
      expect(g.formulas).toEqual([['', '', '=A1*2'], ['', '', '']])
      expect(g.formats).toEqual([['General', 'General', 'General'], ['General', 'yyyy-mm-dd', 'General']])
      await carrier.writeRange(MINE, 'Sheet1', 'D1', [[g.values[1][1]]])
      expect((await carrier.readRange(MINE, 'Sheet1', 'D1')).values).toEqual([[g.values[1][1]]])
    })

    it('writes his own workbook at once through the tools, and a stale base answers conflict and writes nothing', async () => {
      const read = JSON.parse(text(await run('office_range_read', { workbook: MINE, range: 'Sheet1!A1' }))) as { hash: string }
      expect(text(await run('office_range_write', { workbook: MINE, range: 'Sheet1!A1', values: [[2]], base: read.hash, because: 'own' }))).toContain('writeId')
      expect((await carrier.readRange(MINE, 'Sheet1', 'A1')).values).toEqual([[2]])

      const again = JSON.parse(text(await run('office_range_read', { workbook: MINE, range: 'Sheet1!A1' }))) as { hash: string }
      await carrier.call('_type', { book: MINE, sheet: 'Sheet1', cell: 'A1', value: 5 })
      expect(JSON.parse(text(await run('office_range_write', { workbook: MINE, range: 'Sheet1!A1', values: [[7]], base: again.hash, because: 'own' })))).toEqual({ conflict: true, now: [[5]] })
      expect((await carrier.readRange(MINE, 'Sheet1', 'A1')).values).toEqual([[5]])
    })

    it("waits an agent's own idea on a shared workbook as suggestions, and writes a block with formulas", async () => {
      expect(text(await run('office_range_write', { workbook: SHARED, range: 'Sheet1!B1', values: [[120]], because: 'own' }))).toContain('1 cell waits as suggestions')
      expect((await carrier.readRange(SHARED, 'Sheet1', 'B1')).values).toEqual([[100]])
      expect(suggestions.open(excelStore(SHARED))).toMatchObject([{ sheet: 'Sheet1', row: 0, col: 1, base: { v: 100 }, proposed: { v: 120 } }])

      await run('office_range_write', { workbook: MINE, range: 'Sheet1!E1:F1', values: [[3, '=E1+1']], because: 'own' })
      expect((await carrier.readRange(MINE, 'Sheet1', 'E1:F1')).formulas).toEqual([['', '=E1+1']])
    })

    it('writes a date among formulas as a date, not as text', async () => {
      const iso = (await carrier.readRange(MINE, 'Sheet1', 'B2')).values[0][0] as string
      await carrier.writeRange(MINE, 'Sheet1', 'B2:C2', [[iso, '=B2+1']])
      const g = await carrier.readRange(MINE, 'Sheet1', 'B2:C2')
      expect(g.values[0][0]).toBe(iso)
      expect(g.formulas[0][1]).toBe('=B2+1')
    })

    it('says an app he closed is not open, though something kept it running hidden', async () => {
      await carrier.readRange(MINE, 'Sheet1', 'A1')
      await seed({ apps: { excel: { visible: false } } })
      await expect(carrier.readRange(MINE, 'Sheet1', 'A1')).rejects.toMatchObject({ code: 'not-running', message: 'Microsoft Excel is not open.' })
    })

    it('reads and writes formulas through Formula where an older Excel has no Formula2', async () => {
      await seed({ oldExcel: true })
      expect((await carrier.readRange(MINE, 'Sheet1', 'C1')).formulas).toEqual([['=A1*2']])
      await carrier.writeRange(MINE, 'Sheet1', 'C2', [['=A1*3']])
      expect((await carrier.readRange(MINE, 'Sheet1', 'C2')).formulas).toEqual([['=A1*3']])
    })

    it("hears a change typed in Excel at once, by its SheetChange, and never hears the helper's own write as his", async () => {
      const events: string[] = []
      const offChanges = carrier.changes!((book, sheet, address) => {
        events.push(`${sheet}!${address}`)
        void excel.heard(book, sheet, address)
      })
      const heard: SheetChange[] = []
      const off = excel.watch(MINE, 'Sheet1', parseAddress('A1:C2'), (c) => heard.push(c))
      await vi.waitFor(async () => expect(await excel.read(MINE, 'Sheet1', parseAddress('A1'))).toBeTruthy())
      await excel.write(MINE, 'Sheet1', parseAddress('B1'), [['ours']], { by: 'owner' })
      expect(events).toEqual([])
      await carrier.call('_type', { book: MINE, sheet: 'Sheet1', cell: 'A1', value: 9 })
      expect(events).toEqual(['Sheet1!A1'])
      await vi.waitFor(() => expect(heard.some((c) => c.kind === 'cells' && c.by === 'excel')).toBe(true))
      expect(heard.filter((c) => c.kind === 'cells' && c.by === 'tempcode')).toHaveLength(1)
      off()
      offChanges()
    })

    it("hears a co-author's edit merged in by the workbook's AfterRemoteChange, which names no range, and reads the watched blocks again", async () => {
      const events: string[] = []
      const offChanges = carrier.changes!((book, sheet, address) => {
        events.push(`${book}|${sheet}|${address}`)
        if (!sheet) void excel.pass()
      })
      const heard: SheetChange[] = []
      const off = excel.watch(SHARED, 'Sheet1', parseAddress('A1:B1'), (c) => heard.push(c))
      await vi.waitFor(async () => expect(await excel.read(SHARED, 'Sheet1', parseAddress('A1'))).toBeTruthy())
      await carrier.call('_merge', { book: SHARED, sheet: 'Sheet1', cell: 'B1', value: 150 })
      expect(events).toEqual([`${SHARED}||`])
      await vi.waitFor(() => expect(heard.some((c) => c.kind === 'cells' && c.by === 'excel')).toBe(true))
      off()
      offChanges()
    })

    it('says busy, in words that ask to try again, when Excel turns the call away, and the next call goes through', async () => {
      await carrier.call('_busy', { calls: 1 })
      const r = await run('office_range_read', { workbook: MINE, range: 'Sheet1!A1' })
      expect(r.isError).toBe(true)
      expect(text(r)).toMatch(/busy.*try again/)
      await expect(carrier.readRange(MINE, 'Sheet1', 'A1')).resolves.toMatchObject({ values: [[1]] })
    })

    it('says an app that is not open is not open, and one that is not installed is not installed, without starting either', async () => {
      await seed({ apps: { excel: { running: false }, word: { installed: false } } })
      await expect(carrier.readRange(MINE, 'Sheet1', 'A1')).rejects.toMatchObject({ code: 'not-running', message: 'Microsoft Excel is not open.' })
      await expect(carrier.documents()).rejects.toMatchObject({ code: 'not-installed' })
      expect((await carrier.apps()).map((a) => [a.app, a.installed, a.running])).toEqual([
        ['excel', true, false],
        ['word', false, false],
        ['powerpoint', true, true],
        ['outlook', true, true]
      ])
      expect((await state()).started).toEqual([])
    })

    it('the switch brings an open workbook forward, and starts Excel with a file it does not have open', async () => {
      await carrier.open('excel', { kind: 'path', path: MINE })
      await carrier.open('excel', { kind: 'path', path: 'C:\\Users\\owner\\Other.xlsx' })
      await carrier.open('word', { kind: 'url', url: BRIEF.replace('Brief', 'New') })
      expect((await state()).started).toEqual([
        { activate: MINE },
        { foreground: 101 },
        { file: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE', args: '"C:\\Users\\owner\\Other.xlsx"' },
        { file: `ms-word:ofe|u|${BRIEF.replace('Brief', 'New')}`, args: null }
      ])
    })
  })

  describe('Word and PowerPoint', () => {
    it('makes an own idea in a shared document a tracked change, edits his own directly, and puts Track Changes back as it was', async () => {
      expect(text(await run('office_doc_edit', { document: BRIEF, find: 'one', replace: 'two', because: 'own' }))).toBeTruthy()
      await run('office_doc_edit', { document: NOTES, insert: ' More.', at: 'end', because: 'own' })
      const docs = (await state()).docs
      expect(docs[0]).toEqual({ key: BRIEF, text: 'Draft two.\rSecond two.\r', tracked: ['-one +two', '-one +two'] })
      // Word keeps the last paragraph mark last: text put at the end joins the last paragraph.
      expect(docs[1]).toEqual({ key: NOTES, text: 'Mine. More.\r', tracked: [] })
      expect(await carrier.readDocument(BRIEF)).toEqual(['Draft two.', 'Second two.', ''])
      // Find ran on the final text with no markup, and the window's markup is back as he had it.
      expect((await state() as State & { markup: number }).markup).toBe(2)
    })

    it("finds a caret as itself, not as one of Word's special codes", async () => {
      await seed({ docs: [{ key: NOTES, paragraphs: ['Cost ^2 here.'] }] })
      expect(await carrier.editDocument(NOTES, { find: '^2', replace: 'squared' }, false)).toBe(1)
      expect(await carrier.readDocument(NOTES)).toEqual(['Cost squared here.', ''])
    })

    it('replaces slide text in place, shape by shape, and skips shapes with no text', async () => {
      expect(await carrier.replaceSlideText(DECK, 'Q3', 'Q4')).toBe(2)
      expect(await carrier.readSlides(DECK)).toEqual([
        { index: 1, texts: ['Q4 plan', 'Owner: Dana'] },
        { index: 2, texts: ['Q4 numbers'] }
      ])
    })
  })

  describe('Outlook: nothing is sent without his press', () => {
    it('lists and reads mail with SMTP addresses and its account', async () => {
      expect(await carrier.accounts()).toEqual(['owner@purdue.edu', 'owner@example.com'])
      const list = await carrier.listMail({ folder: 'inbox', limit: 10 })
      expect(list.map((m) => [m.id, m.from, m.account, m.read])).toEqual([
        ['43', 'kim@example.com', 'owner@purdue.edu', true],
        ['42', 'dana@example.com', 'owner@purdue.edu', false]
      ])
      expect(await carrier.listMail({ folder: 'inbox', limit: 10, query: "budg" })).toHaveLength(1)
      expect(await carrier.readMail('42')).toMatchObject({ subject: 'Budget', to: ['owner@purdue.edu'], cc: ['lee@example.com'], text: 'Numbers?', at: '2026-11-18T10:00:00.000Z' })
    })

    it('every verb that sends, replies, forwards, invites or answers returns a held act, and Outlook sends nothing', async () => {
      const SENDS: [string, unknown][] = [
        // Outlook here has two accounts: a new mail or an invitation names the one it goes from (the hold review's 16.8).
        ['office_mail_send', { account: 'owner@purdue.edu', to: ['dana@example.com'], subject: 'Plan', html: '<p><b>Here</b> it is</p>' }],
        ['office_mail_send', { to: [], subject: 'Re: Budget', html: '<p>Yes</p>', replyTo: '42' }],
        ['office_mail_send', { to: ['lee@example.com'], subject: 'Fw: Budget', html: '<p>FYI</p>', forward: '42' }],
        ['office_calendar_create', { account: 'owner@purdue.edu', subject: 'Review', start: '2026-11-20T15:00:00Z', end: '2026-11-20T15:30:00Z', attendees: ['dana@example.com'] }],
        ['office_calendar_answer', { id: 'ev-9', subject: 'Standup', answer: 'accept' }]
      ]
      for (const [name, args] of SENDS) expect(text(await run(name, args))).toMatch(/^Held for the owner/)
      expect(held.map((h) => h.kind)).toEqual(['office.mail.send', 'office.mail.send', 'office.mail.send', 'office.calendar.op', 'office.calendar.op'])
      expect(held[1].payload).toMatchObject({ to: ['dana@example.com'] })
      const s = await state()
      expect([s.sent, s.answers, s.drafts]).toEqual([[], [], []])
      expect(s.events.map((e) => e.subject)).toEqual(['Standup'])
    })

    it("the act's execute sends through Outlook with its formatting, scripts taken out, from the account it names", async () => {
      const mail = officeActs({ carrier: () => carrier }).find((a) => a.kind === 'office.mail.send')!
      const p = OfficeMailSchema.parse({ host: 'env_pc', account: 'owner@example.com', to: ['dana@example.com'], cc: ['lee@example.com'], subject: 'Plan', html: '<table border="1"><tr><td><b>1</b></td></tr></table><script>x()</script>' })
      await expect(mail.execute(p, actCtx)).resolves.toMatchObject({ summary: 'Sent to dana@example.com and lee@example.com: Plan' })
      const reply = OfficeMailSchema.parse({ host: 'env_pc', to: ['dana@example.com'], subject: 'Re: Budget', html: '<p><i>Yes</i></p>', replyTo: '42' })
      await mail.execute(reply, actCtx)
      const { sent } = await state()
      expect(sent[0]).toEqual({ account: 'owner@example.com', to: 'dana@example.com', cc: 'lee@example.com', bcc: '', subject: 'Plan', html: '<table border="1"><tr><td><b>1</b></td></tr></table>' })
      expect(sent[1]).toMatchObject({ account: 'owner@purdue.edu', to: 'dana@example.com', subject: 'RE: Budget' })
      expect(sent[1].html).toMatch(/<body><p><i>Yes<\/i><\/p><div class=quote>From: dana@example.com/)
    })

    describe("a reply or forward goes only to the recipients held (the hold review's 21.1)", () => {
      // Mail from kim whose Reply-To is a list: Outlook's own Reply addresses the list.
      const SIGNUPS = { id: '44', account: 'owner@purdue.edu', from: 'kim@example.com', replyTo: 'list@elsewhere.com', subject: 'Signups', at: '2026-11-18T13:00:00.000Z', to: ['owner@purdue.edu'], text: 'Reply to the list' }
      const mail = () => officeActs({ carrier: () => carrier }).find((a) => a.kind === 'office.mail.send')!

      it("holds a reply for the sender, and sends it there, never to the mail's Reply-To", async () => {
        await seed({ mail: [...SEED.mail, SIGNUPS] })
        expect(text(await run('office_mail_send', { to: [], subject: 'Re: Signups', html: '<p>In</p>', replyTo: '44' }))).toMatch(/^Held for the owner/)
        expect(held[0].payload).toMatchObject({ to: ['kim@example.com'] })
        await mail().execute(OfficeMailSchema.parse(held[0].payload), actCtx)
        const { sent } = await state()
        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({ to: 'kim@example.com', cc: '', bcc: '', subject: 'RE: Signups' })
      })

      it('refuses, throwing the reply away unsent, when Outlook will not let go of the recipient it made', async () => {
        await seed({ mail: [...SEED.mail, SIGNUPS] })
        await carrier.call('_fail', { member: 'Remove', hresult: '0x80020009' })
        const reply = OfficeMailSchema.parse({ host: 'env_pc', to: ['kim@example.com'], subject: 'Re: Signups', html: '<p>In</p>', replyTo: '44' })
        await expect(mail().execute(reply, actCtx)).rejects.toMatchObject({
          code: 'refused',
          message: 'Outlook made this reply for To kim@example.com, list@elsewhere.com, not To kim@example.com as held, so nothing was sent.'
        })
        const s = await state()
        expect(s.sent).toEqual([])
        expect(s.thrownAway).toEqual(['RE: Signups'])
      })

      it('sends a forward with its To, Cc and Bcc exactly as held', async () => {
        const fwd = OfficeMailSchema.parse({ host: 'env_pc', to: ['lee@example.com'], cc: ['kim@example.com'], bcc: ['owner@purdue.edu'], subject: 'Fw: Budget', html: '<p>FYI</p>', forward: '42' })
        await mail().execute(fwd, actCtx)
        expect((await state()).sent[0]).toMatchObject({ to: 'lee@example.com', cc: 'kim@example.com', bcc: 'owner@purdue.edu' })
      })
    })

    it('refuses, with nothing sent, a mail to someone Outlook does not know', async () => {
      await expect(carrier.sendMail({ to: ['dana@example.com', 'nobody'], cc: [], bcc: [], subject: 's', html: '<p>x</p>' })).rejects.toMatchObject({
        code: 'not-found',
        message: 'Outlook does not know nobody, so nothing was sent.'
      })
      expect((await state()).sent).toEqual([])
    })

    it('says busy when Outlook turns Send away, and that it may have gone when Outlook goes away during Send', async () => {
      const m = { to: ['dana@example.com'], cc: [], bcc: [], subject: 's', html: '<p>x</p>' }
      await carrier.call('_fail', { member: 'Send', hresult: '0x80010001' })
      await expect(carrier.sendMail(m)).rejects.toMatchObject({ code: 'busy' })
      await carrier.call('_fail', { member: 'Send', hresult: '0x800706BA' })
      await expect(carrier.sendMail(m)).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('it may have gone. Look in Sent') })
      await carrier.call('_fail', { member: 'HTMLBody=', hresult: '0x80020009' })
      await expect(carrier.sendMail(m)).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('so nothing was sent') })
      expect((await state()).sent).toEqual([])
    })

    it('leaves no meeting behind when Outlook refuses to send an invitation', async () => {
      await carrier.call('_fail', { member: 'Send', hresult: '0x80004004' })
      await expect(carrier.createEvent({ subject: 'Review', start: '2026-12-01T15:00:00.000Z', end: '2026-12-01T15:30:00.000Z', attendees: ['dana@example.com'] })).rejects.toMatchObject({ code: 'not-allowed' })
      expect((await state()).events.map((e) => e.subject)).toEqual(['Standup'])
    })

    it('a draft only leaves a draft, and a hold on his own calendar with nobody invited is made at once', async () => {
      await run('office_mail_draft', { to: ['dana@example.com'], subject: 'Plan', html: '<p>x</p>' })
      await run('office_calendar_create', { subject: 'Focus', start: '2026-11-20T15:00:00Z', end: '2026-11-20T17:00:00Z' })
      const s = await state()
      expect(s.drafts).toMatchObject([{ subject: 'Plan', html: '<p>x</p>', to: 'dana@example.com' }])
      expect(s.sent).toEqual([])
      expect(s.events.map((e) => [e.subject, e.meeting])).toEqual([
        ['Standup', 0],
        ['Focus', 0]
      ])
      expect(held).toEqual([])
    })

    it('an invitation is sent only by its execute, and one found by its calendar UID is answered with his comment', async () => {
      const cal = officeActs({ carrier: () => carrier }).find((a) => a.kind === 'office.calendar.op')!
      const start = new Date(Math.floor(Date.now() / 36e5) * 36e5 + 2 * 36e5).toISOString()
      const end = new Date(Date.parse(start) + 18e5).toISOString()
      await cal.execute(OfficeCalendarSchema.parse({ host: 'env_pc', op: 'create', event: { account: 'owner@purdue.edu', subject: 'Review', start, end, attendees: ['dana@example.com'] } }), actCtx)
      expect((await state()).sent).toEqual([{ invite: 'Review', to: 'dana@example.com', meeting: 1 }])

      const id = await carrier.eventByUid('abc-123@example.com')
      expect(id).toBe('ev-9')
      expect(await carrier.eventByUid('nobody@example.com')).toBeNull()
      await carrier.answerEvent(id!, 'decline', 'Out that day')
      expect((await state()).answers).toEqual([{ id: 'ev-9', response: 4, noUi: true, sent: true, body: 'Out that day' }])
      const listed = await carrier.events(new Date().toISOString(), new Date(Date.now() + 3 * 864e5).toISOString())
      expect(listed.find((e) => e.subject === 'Standup')).toMatchObject({ id: 'ev-9', organizer: 'Dana', attendees: ['owner@purdue.edu'], response: 'declined' })
      expect(listed.find((e) => e.subject === 'Review')).toMatchObject({ start, end, attendees: ['dana@example.com'] })
    })

    it("says not allowed when Outlook's object model guard refuses, and the app's state says so", async () => {
      await seed({ guard: true })
      await expect(carrier.readMail('42')).rejects.toMatchObject({ code: 'not-allowed' })
      expect((await carrier.apps()).find((a) => a.app === 'outlook')).toMatchObject({ allowed: 'no' })
    })
  })

  describe('Office as a renderer (the render verbs)', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tc-render-rig-'))
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))
    const copy = (name: string, bytes = 'a copy'): string => {
      const p = join(dir, name)
      writeFileSync(p, bytes)
      return p
    }
    const out = (name: string): string => join(dir, name)

    it("Word: the copy opened read only, out of recent files, with no window, drawn by ExportAsFixedFormat, closed unsaved, in his own Word", async () => {
      await seed({ render: { pages: 3 } })
      expect(await carrier.render({ app: 'word', to: 'pdf', input: copy('input.docx', '12345'), output: out('o.pdf') })).toEqual({ pages: 3 })
      expect(readFileSync(out('o.pdf'), 'utf8')).toBe('recorded pdf word pages=3 input=5')
      const { renders, running } = await state()
      expect(renders).toEqual([expect.objectContaining({ open: 'word', readOnly: true, recent: false, visible: false, password: 'tc-office-no-password', closed: 0 })])
      expect(String(renders[0]!.path)).toMatch(/\\TempCode\\render\\[0-9a-f]{32}\\input\.docx$/)
      expect(running).toContain('word')
    }, 60_000)

    it("Excel, where the host may start one: an Excel of its own, hidden, no macro, the workbook's own print areas, every visible sheet's pages, quit after", async () => {
      await seed({ render: { sheets: [{ pages: 1 }, { pages: 2 }, { pages: 4, visible: false }] } })
      expect(await carrier.render({ app: 'excel', to: 'pdf', input: copy('input.xlsx'), output: out('o.pdf'), start: true })).toEqual({ pages: 3 })
      expect(readFileSync(out('o.pdf'), 'utf8')).toBe('recorded pdf excel pages=3 ignorePrintAreas=False input=6')
      const { renders } = await state()
      expect(renders).toEqual([
        { created: 'excel' },
        { set: 'excel.DisplayAlerts', value: false },
        { set: 'excel.AutomationSecurity', value: 3 },
        expect.objectContaining({ open: 'excel', readOnly: true, recent: false, closed: false }),
        { quit: 'excel' }
      ])
    }, 60_000)

    it('PowerPoint: a PDF of every slide, one slide as a PNG at a width, a video, and a slide that is not there', async () => {
      await seed({ render: { slides: 12, slideWidth: 960, slideHeight: 540 } })
      expect(await carrier.render({ app: 'powerpoint', to: 'pdf', input: copy('input.pptx'), output: out('o.pdf') })).toEqual({ pages: 12 })
      expect(readFileSync(out('o.pdf'), 'utf8')).toBe('recorded pdf powerpoint pages=12 input=6')
      expect(await carrier.render({ app: 'powerpoint', to: 'png', input: copy('input.pptx'), output: out('s.png'), slide: 3, width: 1920 })).toEqual({ width: 1920, height: 1080 })
      expect(readFileSync(out('s.png'), 'utf8')).toBe('recorded png slide=3 1920x1080 input=6')
      expect(await carrier.render({ app: 'powerpoint', to: 'mp4', input: copy('input.pptx'), output: out('v.mp4'), seconds: 1, height: 720 })).toEqual({ seconds: 12, height: 720 })
      expect(readFileSync(out('v.mp4'), 'utf8')).toBe('recorded mp4 seconds=1 height=720 fps=30 input=6')
      await expect(carrier.render({ app: 'powerpoint', to: 'png', input: copy('input.pptx'), output: out('x.png'), slide: 13 })).rejects.toMatchObject({ code: 'not-found', message: 'The deck has 12 slides; there is no slide 13.' })
      const { renders } = await state()
      expect(renders.filter((r) => r.open)).toHaveLength(4)
      for (const r of renders.filter((x) => x.open)) expect(r).toMatchObject({ readOnly: -1, withWindow: 0, closed: true })
      expect(renders.find((r) => r.video)).toMatchObject({ video: { timings: false, seconds: 1, height: 720 } })
      await seed({ render: { video: 'fail' } })
      await expect(carrier.render({ app: 'powerpoint', to: 'mp4', input: copy('input.pptx'), output: out('w.mp4') })).rejects.toMatchObject({ message: 'PowerPoint could not make the video.' })
    }, 120_000)

    it('an app he has not open is refused, never started, unless the host may start one hidden (the VM), which it quits after', async () => {
      await seed({ apps: { word: { running: false } } })
      await expect(carrier.render({ app: 'word', to: 'pdf', input: copy('input.docx'), output: out('o.pdf') })).rejects.toMatchObject({ code: 'not-running', message: 'Word is not open on this PC.' })
      expect((await state()).renders).toEqual([])
      await carrier.render({ app: 'word', to: 'pdf', input: copy('input.docx'), output: out('o.pdf'), start: true })
      const { renders, running } = await state()
      expect(renders[0]).toEqual({ created: 'word' })
      expect(renders.at(-1)).toEqual({ quit: 'word' })
      expect(running).not.toContain('word')
    }, 60_000)

    it('a dialog in the app is busy, in its name; no Word at all is "No Word is in reach"', async () => {
      await seed()
      await carrier.call('_busy', { calls: 1 })
      await expect(carrier.render({ app: 'word', to: 'pdf', input: copy('input.docx'), output: out('o.pdf') })).rejects.toMatchObject({ code: 'busy', message: 'Word is busy with a dialog: try again once it is closed.' })
      await seed({ apps: { word: { installed: false } } })
      await expect(carrier.render({ app: 'word', to: 'pdf', input: copy('input.docx'), output: out('o.pdf'), start: true })).rejects.toMatchObject({ code: 'not-installed', message: 'No Word is in reach: it is not installed on this PC.' })
    }, 60_000)
  })
})

describe.skipIf(!RIG)('tc-office.exe as shipped, on a Windows with no Office (the rig)', () => {
  it('starts, finds no Office registered, and refuses every verb as not installed without starting anything', async () => {
    const carrier = comCarrier({ start: async () => spawn('ssh', sshArgs('tc-office.exe'), { stdio: 'pipe' }), log: () => undefined })
    try {
      expect((await carrier.apps()).map((a) => [a.app, a.installed, a.running])).toEqual([
        ['excel', false, false],
        ['word', false, false],
        ['powerpoint', false, false],
        ['outlook', false, false]
      ])
      await expect(carrier.readRange('C:\\x.xlsx', 'Sheet1', 'A1')).rejects.toMatchObject({ code: 'not-installed', message: 'Microsoft Excel is not installed on this PC.' })
      await expect(carrier.sendMail({ to: ['a@example.com'], cc: [], bcc: [], subject: 's', html: '' })).rejects.toMatchObject({ code: 'not-installed', message: 'Microsoft Outlook is not installed on this PC.' })
      await expect(carrier.open('excel', { kind: 'path', path: 'C:\\x.xlsx' })).rejects.toMatchObject({ code: 'not-installed' })
      await expect(carrier.call('_seed', {})).rejects.toMatchObject({ message: 'tc-office has no verb _seed.' })
    } finally {
      carrier.stop()
    }
  }, 60_000)
})
