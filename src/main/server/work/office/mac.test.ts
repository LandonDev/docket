import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { macCarrier, SCRIPTS, type ScriptName } from './mac'
import { osaError, type Osa } from './osa'

/**
 * The Mac carrier on the box: each JXA script is run in a sandbox against a
 * stand-in for the objects JXA hands it (Excel's and Outlook's, by the names
 * their dictionaries give), and the carrier against a recorded osascript.
 * Neither proves a real Excel or Outlook answers so; docs/agents/work-office.md
 * "Not proven" lists the live test.
 */

/** A JXA property: called to read, assigned to write. */
function prop<T>(obj: Record<string, unknown>, name: string, value: T, writes: [string, unknown][]): void {
  let v = value
  Object.defineProperty(obj, name, { get: () => () => v, set: (x: T) => (writes.push([name, x]), (v = x)), enumerable: true })
}

function runScript(name: ScriptName, args: unknown, apps: Record<string, unknown>): unknown {
  const out = runInNewContext(`${SCRIPTS[name]}\nrun([${JSON.stringify(JSON.stringify(args))}])`, { Application: (n: string) => apps[n], JSON, Date, Math, String, Number, Error })
  return JSON.parse(String(out))
}

function excel(writes: [string, unknown][], cells: { value: unknown; formula2: unknown; numberFormat: unknown }) {
  const range: Record<string, unknown> = {}
  prop(range, 'value', cells.value, writes)
  prop(range, 'formula2', cells.formula2, writes)
  prop(range, 'numberFormat', cells.numberFormat, writes)
  const sheet = {
    name: () => 'Sheet1',
    usedRange: { rows: { length: 3 }, columns: { length: 2 }, firstRowIndex: () => 2, firstColumnIndex: () => 1, value: () => 1 },
    ranges: { byName: (a: string) => (writes.push(['range', a]), range) }
  }
  const worksheets = Object.assign(() => [sheet], { byName: () => sheet })
  const book = { fullName: () => '/tmp/Book.xlsx', name: () => 'Book.xlsx', worksheets }
  return { running: () => true, workbooks: () => [book] }
}

describe('the Excel scripts', () => {
  it('list workbooks with each sheet used from A1 to its last cell', () => {
    expect(runScript('workbooks', {}, { 'Microsoft Excel': excel([], { value: 1, formula2: '', numberFormat: '' }) })).toEqual([
      { key: '/tmp/Book.xlsx', name: 'Book.xlsx', sheets: [{ name: 'Sheet1', rows: 4, columns: 2 }] }
    ])
  })

  it('read a block as rows, empty cells as null, dates as ISO, formulas only where there is one', () => {
    const when = new Date(Date.UTC(2026, 10, 19))
    const got = runScript('readRange', { book: '/tmp/Book.xlsx', sheet: 'Sheet1', address: 'A1:B2' }, {
      'Microsoft Excel': excel([], { value: [['a', ''], [when, 3]], formula2: [['a', ''], ['2026-11-19', '=B1+1']], numberFormat: [['General', 'General'], ['yyyy-mm-dd', '0']] })
    })
    expect(got).toEqual({ values: [['a', null], ['2026-11-19T00:00:00.000Z', 3]], formulas: [['', ''], ['', '=B1+1']], formats: [['General', 'General'], ['yyyy-mm-dd', '0']] })
  })

  it('read one cell, which JXA answers as a bare value, as a 1 by 1 block', () => {
    expect(runScript('readRange', { book: 'Book.xlsx', sheet: 'Sheet1', address: 'B2' }, { 'Microsoft Excel': excel([], { value: 7, formula2: '7', numberFormat: 'General' }) })).toEqual({
      values: [[7]],
      formulas: [['']],
      formats: [['General']]
    })
  })

  it('write a block in one assignment: values as they are, or every cell as formula text when one is a formula', () => {
    const w1: [string, unknown][] = []
    runScript('writeRange', { book: 'Book.xlsx', sheet: 'Sheet1', address: 'A1:B1', grid: [[1, null]], formulas: false }, { 'Microsoft Excel': excel(w1, { value: 0, formula2: '', numberFormat: '' }) })
    expect(w1).toEqual([['range', 'A1:B1'], ['value', [[1, '']]]])
    const w2: [string, unknown][] = []
    runScript('writeRange', { book: 'Book.xlsx', sheet: 'Sheet1', address: 'A1:B1', grid: [[1, '=A1*2']], formulas: true }, { 'Microsoft Excel': excel(w2, { value: 0, formula2: '', numberFormat: '' }) })
    expect(w2).toEqual([['range', 'A1:B1'], ['formula2', [['1', '=A1*2']]]])
    const w3: [string, unknown][] = []
    runScript('writeRange', { book: 'Book.xlsx', sheet: 'Sheet1', address: 'A1', grid: [['2026-11-19T00:00:00.000Z']], formulas: false }, { 'Microsoft Excel': excel(w3, { value: 0, formula2: '', numberFormat: '' }) })
    expect(w3[1][1]).toBeInstanceOf(Date)
  })

  it('answer an empty list, not a TypeError, when Excel is open with no workbook (JXA gives null)', () => {
    const xl = { running: () => true, workbooks: () => null }
    expect(runScript('workbooks', {}, { 'Microsoft Excel': xl })).toEqual([])
    expect(() => runScript('readRange', { book: 'B.xlsx', sheet: 'Sheet1', address: 'A1' }, { 'Microsoft Excel': xl })).toThrow('(-1728)')
  })

  it('refuse a workbook that is not open', () => {
    expect(() => runScript('readRange', { book: 'Other.xlsx', sheet: 'Sheet1', address: 'A1' }, { 'Microsoft Excel': excel([], { value: 1, formula2: '', numberFormat: '' }) })).toThrow('(-1728)')
  })
})

function outlook(log: string[]) {
  const recipients = () => Object.assign([] as unknown[], { push: (r: { emailAddress: { address: string } }) => log.push(`to ${r.emailAddress.address}`) })
  const message = (id: number) => {
    const m: Record<string, unknown> = { id: () => id, toRecipients: recipients(), ccRecipients: recipients(), bccRecipients: recipients() }
    let content = '<p>quoted</p>'
    Object.defineProperty(m, 'content', { get: () => () => content, set: (x: string) => (log.push(`content ${x}`), (content = x)) })
    return m
  }
  return {
    running: () => true,
    exchangeAccounts: () => [{ emailAddress: () => 'me@example.com' }],
    imapAccounts: () => [],
    popAccounts: () => [],
    messages: { byId: (id: number) => message(id) },
    outgoingMessages: { push: () => log.push('made') },
    OutgoingMessage: (p: { subject: string }) => (log.push(`new ${p.subject}`), message(7)),
    ToRecipient: (x: unknown) => x,
    CcRecipient: (x: unknown) => x,
    BccRecipient: (x: unknown) => x,
    replyTo: (_m: unknown, p: { openingWindow: boolean }) => (log.push(`reply window=${p.openingWindow}`), message(8)),
    send: () => log.push('SENT')
  }
}

describe('the Outlook mail script', () => {
  const m = { to: ['dana@example.com'], cc: [], bcc: [], subject: 'Plan', html: '<b>hi</b>' }
  it('leaves a draft and never sends it', () => {
    const log: string[] = []
    expect(runScript('mail', { m, send: false }, { 'Microsoft Outlook': outlook(log) })).toBe('7')
    expect(log).toEqual(['new Plan', 'made', 'to dana@example.com'])
  })
  it('sends only when told to, and a reply keeps Outlook\'s quote under the new text, with no window', () => {
    const log: string[] = []
    runScript('mail', { m: { ...m, replyTo: '42' }, send: true }, { 'Microsoft Outlook': outlook(log) })
    expect(log).toEqual(['reply window=false', 'content <b>hi</b><p>quoted</p>', 'SENT'])
  })
})

describe('empty collections', () => {
  it('read as empty in every list: Word, PowerPoint and Outlook answer null for none', () => {
    const none = { running: () => true, documents: () => null, presentations: () => null, exchangeAccounts: () => null, imapAccounts: () => null, popAccounts: () => [] }
    const apps = { 'Microsoft Word': none, 'Microsoft PowerPoint': none, 'Microsoft Outlook': none }
    expect(runScript('documents', {}, apps)).toEqual([])
    expect(runScript('presentations', {}, apps)).toEqual([])
    expect(runScript('accounts', {}, apps)).toEqual([])
  })
})

describe('every script', () => {
  it('parses as JavaScript, and refuses an app that is not running without starting it', () => {
    for (const [name, src] of Object.entries(SCRIPTS)) {
      expect(() => new Function(src), name).not.toThrow()
      expect(() => runScript(name as ScriptName, {}, new Proxy({}, { get: () => ({ running: () => false }) })), name).toThrow('(-600)')
    }
  })
})

describe('the Mac carrier', () => {
  const recorded = (answers: Record<string, string | Error>, seen: string[][] = []): Osa =>
    async (_lang, script, args) => {
      const name = (Object.entries(SCRIPTS).find(([, s]) => s === script) ?? ['?'])[0]
      seen.push([name, ...args])
      const a = answers[name]
      if (a instanceof Error) throw a
      return a ?? 'null'
    }

  it('passes arguments as one JSON string and reads the answer as JSON', async () => {
    const seen: string[][] = []
    const c = macCarrier({ osa: recorded({ readRange: JSON.stringify({ values: [[1]], formulas: [['']], formats: [['General']] }) }, seen), installed: () => true })
    await expect(c.readRange('/tmp/B.xlsx', 'Sheet1', 'A1')).resolves.toEqual({ values: [[1]], formulas: [['']], formats: [['General']] })
    expect(seen).toEqual([['readRange', JSON.stringify({ book: '/tmp/B.xlsx', sheet: 'Sheet1', address: 'A1' })]])
  })

  it('records an app as allowed when it answered, with an empty list or with "no such item"', async () => {
    const c = macCarrier({ osa: recorded({ workbooks: '[]', documents: osaError('execution error: Microsoft Word got an error: Can’t get document "x". (-1728)') }), installed: () => true, running: async () => true })
    await expect(c.workbooks()).resolves.toEqual([])
    await expect(c.documents()).rejects.toMatchObject({ code: 'not-found' })
    const seen = await c.apps()
    expect(seen.find((a) => a.app === 'excel')?.allowed).toBe('yes')
    expect(seen.find((a) => a.app === 'word')?.allowed).toBe('yes')
  })

  it('says in words when macOS refuses, and remembers it for the status', async () => {
    const c = macCarrier({ osa: recorded({ workbooks: osaError('execution error: Not authorized to send Apple events to Microsoft Excel. (-1743)') }), installed: () => true, running: async () => true })
    await expect(c.workbooks()).rejects.toMatchObject({ code: 'not-allowed', message: expect.stringContaining('Automation') })
    expect((await c.apps()).find((a) => a.app === 'excel')).toEqual({ app: 'excel', installed: true, running: true, allowed: 'no' })
  })

  it('refuses an app that is not installed without running osascript, and opens a file with the switch', async () => {
    const seen: string[][] = []
    const opened: string[][] = []
    const c = macCarrier({ osa: recorded({}, seen), installed: (app) => app === 'excel', open: async (a) => void opened.push(a) })
    await expect(c.readDocument('/tmp/a.docx')).rejects.toMatchObject({ code: 'not-installed' })
    await c.open('excel', { kind: 'path', path: '/tmp/B.xlsx' })
    await c.open('excel', { kind: 'url', url: 'https://contoso.sharepoint.com/B.xlsx' })
    expect(seen).toEqual([])
    expect(opened).toEqual([['-a', 'Microsoft Excel', '/tmp/B.xlsx'], ['ms-excel:ofe|u|https://contoso.sharepoint.com/B.xlsx']])
  })

  it('maps osascript errors', () => {
    expect(osaError('Microsoft Outlook got an error: Application isn’t running. (-600)').code).toBe('not-running')
    expect(osaError('execution error: Microsoft Excel got an error: Not authorized. (-1744)').code).toBe('needs-consent')
    expect(osaError('execution error: Can’t get worksheet "X". (-1728)').code).toBe('not-found')
  })
})
