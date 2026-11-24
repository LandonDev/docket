import { describe, expect, it } from 'vitest'
import {
  addDays,
  byCategory,
  byMonth,
  categoriesFor,
  centsFrom,
  centsOf,
  cleanSeller,
  columnLetter,
  countOf,
  csvOf,
  datesIn,
  dayOf,
  figuresIn,
  findRow,
  formatDay,
  formatMoney,
  invoiceHtml,
  invoiceTotal,
  isDay,
  joinLines,
  knownSellers,
  lineTotal,
  LEDGER_COLUMNS,
  mileageMissing,
  mileageOf,
  milesLine,
  milesOf,
  moneyWords,
  monthPeriod,
  nextInvoiceNumber,
  owedOf,
  paidStatus,
  parseReceipt,
  rateFor,
  rateWords,
  receiptFileName,
  receiptName,
  rowsOf,
  sheetOnly,
  sigOf,
  statusOf,
  sumsOf,
  taxSummaryHtml,
  yearPeriod,
  type Cell,
  type LedgerRow
} from './money'

const HEADER: Cell[] = [...LEDGER_COLUMNS]
const line = (date: string, who: string, cin: number | '', cout: number | '', status = '', extra: Partial<Record<'for' | 'category' | 'paidOn' | 'receipt' | 'ref', string>> = {}): Cell[] => [
  date,
  who,
  extra.for ?? '',
  extra.category ?? '',
  cin,
  cout,
  status,
  extra.paidOn ?? '',
  extra.receipt ?? '',
  extra.ref ?? ''
]
const read = (...body: Cell[][]): LedgerRow[] => rowsOf(HEADER, body).rows

describe('cells', () => {
  it('reads cents from a number of dollars and from money as he types it', () => {
    expect(centsOf(10.43)).toBe(1043)
    expect(centsOf('$1,204.50')).toBe(120450)
    expect(centsOf('48.17')).toBe(4817)
    expect(centsOf('(12.00)')).toBe(-1200)
    expect(centsOf('twelve')).toBe(0)
    expect(centsOf(undefined)).toBe(0)
    // 0.1 + 0.2 in a cell is still thirty cents.
    expect(centsOf(0.1 + 0.2)).toBe(30)
  })

  it('reads a day from ISO text, a US date, words and a sheet serial', () => {
    expect(dayOf('2026-11-21')).toBe('2026-11-21')
    expect(dayOf('11/21/2026')).toBe('2026-11-21')
    expect(dayOf('11/21/26')).toBe('2026-11-21')
    expect(dayOf('Nov 21, 2026')).toBe('2026-11-21')
    expect(dayOf('21 November 2026')).toBe('2026-11-21')
    expect(dayOf(46347)).toBe('2026-11-21')
    expect(dayOf('02/30/2026')).toBeNull()
    expect(dayOf('soon')).toBeNull()
    expect(dayOf(12)).toBeNull()
  })

  it('writes money and days for a person', () => {
    expect(formatMoney(120450)).toBe('$1,204.50')
    expect(formatMoney(-5)).toBe('-$0.05')
    expect(formatDay('2026-11-03')).toBe('Nov 3, 2026')
    expect(formatDay('2026-11-03', false)).toBe('Nov 3')
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08')
    expect(columnLetter(0) + columnLetter(9) + columnLetter(26)).toBe('AJAA')
  })

  it('reads a status without regard to case, and an empty or unknown word as Paid', () => {
    expect(statusOf('unpaid')).toBe('Unpaid')
    expect(statusOf(' TO REIMBURSE ')).toBe('To reimburse')
    expect(statusOf('')).toBe('Paid')
    expect(statusOf('pending?')).toBe('Paid')
    expect(statusOf(undefined)).toBe('Paid')
  })
})

describe('what a row counts as', () => {
  const count = (cin: number, cout: number, status: string) => countOf({ in: cin, out: cout, status: statusOf(status) })
  it('holds every row of the status table', () => {
    expect(count(7500, 0, 'Paid')).toEqual({ income: 7500, cost: 0, owedToHim: 0, heOwes: 0 })
    expect(count(7500, 0, 'Unpaid')).toEqual({ income: 0, cost: 0, owedToHim: 7500, heOwes: 0 })
    expect(count(0, 4817, 'Paid')).toEqual({ income: 0, cost: 4817, owedToHim: 0, heOwes: 0 })
    expect(count(0, 4817, 'Unpaid')).toEqual({ income: 0, cost: 0, owedToHim: 0, heOwes: 4817 })
    expect(count(0, 4817, 'To reimburse')).toEqual({ income: 0, cost: 4817, owedToHim: 4817, heOwes: 0 })
    expect(count(0, 4817, 'Reimbursed')).toEqual({ income: 0, cost: 0, owedToHim: 0, heOwes: 0 })
    expect(count(0, 4817, 'Requested')).toEqual({ income: 0, cost: 0, owedToHim: 0, heOwes: 0 })
  })

  it('pays an unpaid row and reimburses one waiting to be paid back', () => {
    expect(paidStatus('Unpaid')).toBe('Paid')
    expect(paidStatus('To reimburse')).toBe('Reimbursed')
    expect(paidStatus('Requested')).toBe('Reimbursed')
  })
})

describe('the ledger', () => {
  it('reads rows under the headers', () => {
    const rows = read(line('2026-11-21', 'Blue Heron Coffee', '', 10.43, 'Paid', { category: 'Food', receipt: 'Receipts/2026/x.png', ref: 'm7k2q9' }), line('11/20/2026', 'Harrison HS', 75, '', 'unpaid', { for: 'Varsity' }))
    expect(rows).toEqual([
      { row: 2, ref: 'm7k2q9', date: '2026-11-21', who: 'Blue Heron Coffee', what: '', category: 'Food', in: 0, out: 1043, status: 'Paid', paidOn: null, receipt: 'Receipts/2026/x.png' },
      { row: 3, ref: null, date: '2026-11-20', who: 'Harrison HS', what: 'Varsity', category: '', in: 7500, out: 0, status: 'Unpaid', paidOn: null, receipt: '' }
    ])
  })

  it('finds columns by name, in any order and any case, with columns of his own between', () => {
    const got = rowsOf(['out', 'Notes', 'WHO', 'in', ' date '], [[12, 'mine', 'Granger', '', '2026-11-03']])
    expect(got.missing).toEqual([])
    expect(got.rows[0]).toMatchObject({ date: '2026-11-03', who: 'Granger', out: 1200, in: 0, category: '', ref: null })
  })

  it('reads nothing and names the headers when a needed one is gone, and the columns that may hold it under another name', () => {
    const got = rowsOf(['Date', 'Who', 'Amount'], [['2026-11-03', 'Granger', 12]])
    expect(got.rows).toEqual([])
    expect(got.missing).toEqual(['In', 'Out'])
    expect(got.renamed).toEqual(['Amount'])
    // Cells under no header at all count too; a ledger with no rows has nothing to lose.
    expect(rowsOf(['Date', 'Who', 'In', ''], [['2026-11-03', 'Granger', '', 12]]).renamed).toEqual(['column D'])
    expect(rowsOf(['Date', 'Who', 'In'], []).renamed).toEqual([])
    expect(rowsOf(HEADER, []).renamed).toEqual([])
  })

  it('reads a row he typed with no Ref, and skips a blank line without losing count of the rows', () => {
    const rows = read(line('2026-11-01', 'A', 1, ''), line('', '', '', ''), line('2026-11-02', 'By hand', '', 5))
    expect(rows.map((r) => [r.row, r.who, r.ref])).toEqual([
      [2, 'A', null],
      [4, 'By hand', null]
    ])
  })

  it('finds a row to act on by Ref, else by its number while it reads the same', () => {
    const rows = read(line('2026-11-01', 'A', 1, '', '', { ref: 'aaa111' }), line('2026-11-02', 'B', '', 5))
    // He sorted the sheet: the Ref still finds it, wherever it stands now.
    expect(findRow(rows, { ref: 'aaa111', row: 9, sig: sigOf(rows[0]) })?.who).toBe('A')
    expect(findRow(rows, { row: 3, sig: sigOf(rows[1]) })?.who).toBe('B')
    // The row at that number is no longer the one the window saw.
    expect(findRow(rows, { row: 3, sig: sigOf({ ...rows[1], out: 900 }) })).toBeNull()
    expect(findRow(rows, { ref: 'gone', row: 7, sig: 'x' })).toBeNull()
    // A Ref alone is not enough: a row he changed since the window read it is not written over, amount or status.
    expect(findRow(rows, { ref: 'aaa111', row: 2, sig: sigOf({ ...rows[0], in: 999 }) })).toBeNull()
    expect(findRow(rows, { ref: 'aaa111', row: 2, sig: sigOf({ ...rows[0], status: 'Unpaid' }) })).toBeNull()
    // Nor a row whose category, purpose, paid day or receipt he changed: saving one field must not put the others back.
    for (const change of [{ category: 'Other' }, { what: 'Late fee' }, { paidOn: '2026-11-05' }, { receipt: 'Receipts/2026/x.png' }]) {
      expect(findRow(rows, { ref: 'aaa111', row: 2, sig: sigOf({ ...rows[0], ...change }) })).toBeNull()
    }
  })

  it('never takes the row now at a deleted row’s number for it: a Ref that is gone or stands twice finds nothing', () => {
    // Two $75 games filed apart; he deleted the first, so the second moved up into its place and reads the same.
    const [first] = read(line('2026-11-01', 'Harrison HS', 75, '', 'Unpaid', { ref: 'mgame1' }))
    const now = read(line('2026-11-01', 'Harrison HS', 75, '', 'Unpaid', { ref: 'mgame2' }))
    expect(sigOf(now[0])).toBe(sigOf(first))
    expect(findRow(now, { ref: 'mgame1', row: 2, sig: sigOf(first) })).toBeNull()
    const twice = read(line('2026-11-01', 'A', 1, '', '', { ref: 'mtwin1' }), line('2026-11-01', 'A', 1, '', '', { ref: 'mtwin1' }))
    expect(findRow(twice, { ref: 'mtwin1', row: 2, sig: sigOf(twice[0]) })).toBeNull()
  })

  const year = read(
    line('2026-10-03', 'Harrison HS', 75, '', 'Paid', { category: 'Game fees' }),
    line('2026-11-07', 'West Side HS', 80, '', 'Unpaid', { category: 'Game fees' }),
    line('2026-11-14', 'Northside Fuel', '', 48.17, 'Paid', { category: 'Travel' }),
    line('2026-11-15', 'Ref Gear Outlet', '', 50.99, 'To reimburse', { category: 'Uniform and gear' }),
    line('2026-11-16', 'IHSAA', '', 60, 'Unpaid', { category: 'Dues and registration' }),
    line('2026-11-18', 'Clinic', '', 25, 'Reimbursed', { category: 'Training' }),
    line('2025-12-30', 'Old', 40, '', 'Paid')
  )

  it("sums the period's in and out, and what is open whenever it was", () => {
    expect(sumsOf(year, monthPeriod(2026, 11))).toEqual({ in: 0, out: 4817 + 5099, net: -(4817 + 5099), owedToHim: 8000 + 5099, heOwes: 6000 })
    expect(sumsOf(year, yearPeriod(2026))).toMatchObject({ in: 7500, out: 9916, net: -2416 })
    // December's last day is in the month and January's first is not.
    expect(sumsOf(year, monthPeriod(2025, 12)).in).toBe(4000)
  })

  it('splits the period by category, each one’s bar on the one scale of the largest', () => {
    // One scale for the list, the largest category's: equal bars are equal dollars, money in or out.
    expect(byCategory(year, yearPeriod(2026))).toEqual([
      { category: 'Game fees', amount: 7500, share: 1 },
      { category: 'Uniform and gear', amount: -5099, share: 5099 / 7500 },
      { category: 'Travel', amount: -4817, share: 4817 / 7500 }
    ])
  })

  it('gives a year month by month', () => {
    const months = byMonth(year, 2026)
    expect(months).toHaveLength(12)
    expect(months[9]).toEqual({ month: 10, in: 7500, out: 0 })
    expect(months[10]).toEqual({ month: 11, in: 0, out: 9916 })
  })

  it('lists what is owed, the oldest first, each way', () => {
    // A cost to be paid back says so: the shop he paid does not owe him.
    expect(owedOf(year).map((o) => [o.who, o.amount, o.way, o.since, o.reimburse])).toEqual([
      ['West Side HS', 8000, 'toHim', '2026-11-07', false],
      ['Ref Gear Outlet', 5099, 'toHim', '2026-11-15', true],
      ['IHSAA', 6000, 'byHim', '2026-11-16', false]
    ])
  })

  it('reads a row he typed with money both ways as unpaid money owed, not as a cost to be paid back', () => {
    const both = read(line('2026-11-01', 'Mixed', 30, 20, 'Unpaid'))
    // Both sides say the row has two: Paid on one would settle the other.
    expect(owedOf(both).map((o) => [o.way, o.amount, o.reimburse, o.both])).toEqual([
      ['toHim', 3000, false, true],
      ['byHim', 2000, false, true]
    ])
    expect(owedOf(year).every((o) => !o.both)).toBe(true)
  })

  it('knows the category he last gave a seller', () => {
    expect(knownSellers(year)['northside fuel']).toBe('Travel')
  })
})

describe('categories', () => {
  it('starts from the job’s list and adds the ledger’s own words once', () => {
    expect(categoriesFor('purdue')).toEqual(['Equipment', 'Events', 'Travel', 'Food', 'Software', 'Supplies', 'Other'])
    expect(categoriesFor('purdue', ['Jerseys', 'travel', 'Jerseys', ' '])).toEqual(['Equipment', 'Events', 'Travel', 'Food', 'Software', 'Supplies', 'Other', 'Jerseys'])
    expect(categoriesFor(null)).toContain('Other')
  })
})

describe('mileage', () => {
  it('uses his own rate for a year, else the table’s, else the last year known', () => {
    expect(rateFor(2025)).toBe(0.7)
    expect(rateFor(2026)).toBe(0.7)
    expect(rateFor(2024)).toBe(0.67)
    expect(rateFor(2026, { 2026: 0.725 })).toBe(0.725)
    expect(rateFor(2027, { 2026: 0.725 })).toBe(0.725)
    expect(rateFor(2019)).toBe(0.655)
  })

  it('reads the log and sums a period', () => {
    const log = mileageOf(
      ['Date', 'Trip', 'Place', 'Miles', 'Rate', 'Value', 'Ref'],
      [
        ['2026-11-21', 'Varsity at Harrison HS', 'Harrison HS', 24, 0.7, 16.8, 'm1'],
        ['2026-11-22', 'JV', 'West Side HS', 388, 0.7, 271.6, ''],
        ['2025-01-02', 'Old', 'X', 10, 0.67, '', '']
      ]
    )
    expect(log).toHaveLength(3)
    expect(log[2].value).toBe(670)
    const sum = milesOf(log, yearPeriod(2026))
    expect(sum).toEqual({ miles: 412, value: 28840, rate: 0.7 })
    expect(milesLine(sum)).toBe('412 mi · $288.40 at $0.70')
    expect(milesLine({ miles: 10, value: 655, rate: 0.655 })).toBe('10 mi · $6.55 at $0.655')
    expect(milesLine({ miles: 10, value: 655, rate: null })).toBe('10 mi · $6.55')
  })
})

describe('reading a receipt', () => {
  const TODAY = '2026-11-23'
  it('finds dates in the forms a receipt prints, in order', () => {
    expect(datesIn('Sold 11/21/2026 08:42 AM, due Dec 1, 2026')).toEqual(['2026-11-21', '2026-12-01'])
    expect(datesIn('Total 21, 2026')).toEqual([])
    expect(datesIn('call 317-555-0142')).toEqual([])
  })

  it('finds money figures and leaves out weights, rates and card numbers', () => {
    expect(figuresIn('TOTAL $48.17')).toEqual([4817])
    expect(figuresIn('Gallons 14.207')).toEqual([])
    expect(figuresIn('Tax 7.00% 0.68')).toEqual([68])
    expect(figuresIn('1,204.50 and $19')).toEqual([120450, 1900])
    expect(figuresIn('VISA ****4242 11/21/2026')).toEqual([])
  })

  it('joins a label and its figure when they stand on one line', () => {
    expect(
      joinLines([
        { text: '10.43', box: [500, 302, 596, 328] },
        { text: 'BLUE HERON', box: [44, 56, 300, 82] },
        { text: 'TOTAL', box: [44, 300, 130, 326] }
      ])
    ).toEqual(['BLUE HERON', 'TOTAL 10.43'])
    // With no boxes the order they came in is all there is.
    expect(joinLines([{ text: 'A' }, { text: ' ' }, { text: 'B 1.00' }])).toEqual(['A', 'B 1.00'])
  })

  it('takes the figure on the next line when the total’s label stands alone', () => {
    expect(parseReceipt([{ text: 'CORNER SHOP' }, { text: 'Total' }, { text: '$12.00' }, { text: 'Cash 20.00' }], { today: TODAY }).amount).toBe(1200)
  })

  it('never reads a date after today', () => {
    const got = parseReceipt([{ text: 'Shop' }, { text: 'Returns until 12/24/2026' }, { text: 'Sold 11/20/2026' }, { text: 'Total 5.00' }], { today: TODAY })
    expect(got.date).toBe('2026-11-20')
  })

  it('leaves each field null when it is not there', () => {
    expect(parseReceipt([], { today: TODAY })).toEqual({ amount: null, date: null, who: null, category: null })
    expect(parseReceipt([{ text: 'Corner Shop' }, { text: '11/20/2026' }], { today: TODAY })).toEqual({ amount: null, date: '2026-11-20', who: 'Corner Shop', category: null })
    expect(parseReceipt([{ text: 'Corner Shop' }, { text: 'Total 5.00' }], { today: TODAY })).toMatchObject({ amount: 500, date: null })
    // A figure on the first line: no line of words stands above it.
    expect(parseReceipt([{ text: 'Total 5.00' }, { text: 'Corner Shop' }], { today: TODAY }).who).toBeNull()
  })

  it('gives a seller the category he last gave it, before any word on the receipt', () => {
    const lines = [{ text: 'NORTHSIDE FUEL STOP' }, { text: 'Unleaded' }, { text: 'TOTAL $48.17' }]
    expect(parseReceipt(lines, { sector: 'ref', today: TODAY }).category).toBe('Travel')
    expect(parseReceipt(lines, { sector: 'ref', today: TODAY, known: { 'northside fuel stop': 'Mileage' } }).category).toBe('Mileage')
    // A job with no such category gets none.
    expect(parseReceipt([{ text: 'Pixelforge' }, { text: 'software subscription' }, { text: 'Total 5.00' }], { sector: 'ref', today: TODAY }).category).toBeNull()
  })

  it('cleans a seller’s name', () => {
    expect(cleanSeller('  ** BLUE   HERON COFFEE ** ')).toBe('Blue Heron Coffee')
    expect(cleanSeller('Pixelforge Software Inc.')).toBe('Pixelforge Software Inc.')
    expect(cleanSeller('GRANGER HARDWARE & SUPPLY')).toBe('Granger Hardware & Supply')
  })

  it('takes a file with no extension by its type, under a name that says what it is', () => {
    expect(receiptFileName('scan.PNG', 'application/octet-stream')).toBe('scan.PNG')
    expect(receiptFileName('attachment', 'application/pdf')).toBe('attachment.pdf')
    expect(receiptFileName('IMG_0042', 'image/jpeg; charset=binary')).toBe('IMG_0042.jpg')
    expect(receiptFileName('notes.docx', 'application/pdf')).toBe('notes.docx.pdf')
    expect(receiptFileName('notes.docx', 'application/msword')).toBeNull()
    expect(receiptFileName('movie.mp4', 'video/mp4')).toBeNull()
  })

  it('names a kept receipt by its day, seller and amount', () => {
    expect(receiptName({ date: '2026-11-21', who: 'Blue Heron Coffee', amount: 1043 }, 'PNG')).toBe('2026-11-21 Blue Heron Coffee 10.43.png')
    expect(receiptName({ date: null, who: 'A/B: "C"', amount: null }, '.pdf')).toBe('A B C.pdf')
    expect(receiptName({ date: null, who: '../..', amount: null }, 'jpg')).toBe('Receipt.jpg')
  })
})

describe('out', () => {
  const rows = read(
    line('2026-03-01', 'Rivera, Dental "LLC"', 1200, '', 'Paid', { category: 'Sales', for: 'Site\nrebuild', ref: 'm1' }),
    line('2026-04-02', 'Host Co', '', 20, 'Paid', { category: 'Hosting', receipt: 'Receipts/2026/2026-04-02 Host Co 20.00.pdf' }),
    line('2026-05-02', 'Clinic', '', 25, 'Reimbursed', { category: 'Training' }),
    line('2025-04-02', 'Last year', '', 99, 'Paid')
  )
  const log = mileageOf(['Date', 'Trip', 'Place', 'Miles', 'Rate', 'Value', 'Ref'], [['2026-06-01', 'Client visit', 'Rivera Dental', 30, 0.7, 21, 't1']])

  it('writes a year’s rows as RFC 4180, quotes and commas kept, then the mileage', () => {
    const csv = csvOf(rows, log, 2026)
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('Date,Who,For,Category,In,Out,Status,Paid on,Receipt,Ref')
    expect(csv).toContain('2026-03-01,"Rivera, Dental ""LLC""","Site\nrebuild",Sales,1200.00,,Paid,,,m1')
    expect(csv).not.toContain('Last year')
    expect(csv).toContain('\r\n\r\nDate,Trip,Place,Miles,Rate,Value,Ref\r\n2026-06-01,Client visit,Rivera Dental,30,0.7,21.00,t1\r\n')
    expect(csv.endsWith('\r\n')).toBe(true)
  })

  it('prints the year with costs paid back listed and left out of the sums, and the mileage', () => {
    const html = taxSummaryHtml(rows, log, { year: 2026, job: 'Unify <Platforms>' })
    expect(html).toContain('Unify &lt;Platforms&gt;: 2026')
    // Out is the hosting alone: the reimbursed clinic is not his cost.
    expect(html).toContain('<tr><td>Out</td><td class="n">$20.00</td></tr>')
    expect(html).toContain('Clinic')
    expect(html).toContain('30 mi · $21.00 at $0.70')
    expect(html).toContain('2026-04-02 Host Co 20.00.pdf')
    expect(html).not.toContain('Last year')
    // A row with money both ways prints both, as the totals count both.
    const both = taxSummaryHtml(read(line('2026-06-01', 'Mixed', 30, 20, 'Paid')), [], { year: 2026, job: 'Ref' })
    expect(both).toContain('<td class="n">+$30.00 and $20.00</td>')
    expect(both).toContain('<tr><td>In</td><td class="n">$30.00</td></tr>')
  })

  it('numbers an invoice after the highest used, and totals its lines', () => {
    expect(nextInvoiceNumber([])).toBe(1001)
    expect(nextInvoiceNumber(['1001', 'Invoice 1042', 7])).toBe(1043)
    const lines = [
      { what: 'Design', quantity: 2.5, rate: 12000 },
      { what: 'Hosting', quantity: 1, rate: 2000 }
    ]
    expect(invoiceTotal(lines)).toBe(32000)
    const html = invoiceHtml({ kind: 'invoice', number: '1042', to: 'Rivera Dental', date: '2026-11-23', due: '2026-12-07', lines, from: { name: 'Unify Platforms', address: '1 Main St\nLafayette IN', pay: 'Check or ACH' } })
    expect(html).toContain('Invoice 1042')
    expect(html).toContain('Due Dec 7, 2026')
    expect(html).toContain('$320.00')
    expect(html).toContain('How to pay')
    const request = invoiceHtml({ kind: 'request', number: '12', to: 'Gear & Co', date: '2026-11-23', due: null, lines, from: { name: 'Esports', address: '', pay: '' }, reason: 'Jerseys for <spring>' })
    expect(request).toContain('Purchase request 12')
    expect(request).toContain('Jerseys for &lt;spring&gt;')
    expect(request).not.toContain('How to pay')
  })
})

describe('what the fourth council round asked of the rules', () => {
  it('rounds half a cent up through a float’s noise, the same wherever a value is worked out', () => {
    // 1.4 miles at $0.725 is $1.015, held as 1.01499…: one dollar and two cents.
    expect(1.4 * 0.725 * 100).toBeLessThan(101.5)
    expect(centsFrom(1.4 * 0.725)).toBe(102)
    expect(centsOf(1.4 * 0.725)).toBe(102)
    expect(centsOf('1.015')).toBe(102)
    expect(mileageOf(['Date', 'Miles', 'Rate', 'Value'], [['2026-03-01', 1.4, 0.725, '']])[0].value).toBe(102)
    expect(centsFrom(10.43)).toBe(1043)
    expect(centsFrom(0.005)).toBe(1)
    // An invoice's line by the same rule: 1.15 hours at $32.50 is $37.375, held as 3737.4999…, and is $37.38.
    expect(1.15 * 3250).toBeLessThan(3737.5)
    expect(lineTotal({ what: 'Hours', quantity: 1.15, rate: 3250 })).toBe(3738)
    expect(invoiceTotal([{ what: 'Hours', quantity: 1.15, rate: 3250 }])).toBe(3738)
  })

  it('keeps the sign of a figure below nothing: a correction takes away from its column, as it does in the sheet', () => {
    const rows = read(line('2026-03-01', 'Shop', '', 100), line('2026-03-02', 'Shop refund', '', -20), line('2026-03-03', 'Client', 500, ''), ['2026-03-04', 'Client credit', '', '', '(50.00)', '', '', '', '', ''])
    expect(rows.map((r) => [r.in, r.out])).toEqual([
      [0, 10000],
      [0, -2000],
      [50000, 0],
      [-5000, 0]
    ])
    expect(sumsOf(rows, yearPeriod(2026))).toMatchObject({ in: 45000, out: 8000, net: 37000 })
    expect(csvOf(rows, [], 2026)).toContain('2026-03-02,Shop refund,,,,-20.00,Paid')
    // The form cannot say it, so it is his in the sheet; its words say its column, so the sign is not read as its way.
    expect(rows.map((r) => sheetOnly(r))).toEqual([null, 'negative', null, 'negative'])
    expect(sheetOnly({ in: 3000, out: 2000 })).toBe('both')
    expect(rows.map((r) => moneyWords(r))).toEqual(['$100.00', '-$20.00 out', '+$500.00', '-$50.00 in'])
    expect(moneyWords({ in: 3000, out: 2000 })).toBe('+$30.00 and $20.00')
    expect(taxSummaryHtml(rows, [], { year: 2026, job: 'Unify' })).toContain('-$20.00 out')
  })

  it('tells two rows apart whose cells run together, and is one length however long his words are', () => {
    const base = read(line('2026-03-01', 'A|B', '', 10, '', { for: 'C' }))[0]
    const other = read(line('2026-03-01', 'A', '', 10, '', { for: 'B|C' }))[0]
    expect(sigOf(base)).not.toBe(sigOf(other))
    const long = read(line('2026-03-01', 'W'.repeat(200), '', 10, '', { for: 'F'.repeat(500), receipt: 'R'.repeat(400) }))[0]
    expect(sigOf(long)).toHaveLength(32)
    expect(sigOf(base)).toHaveLength(32)
    expect(sigOf(base)).toBe(sigOf({ ...base }))
  })

  it('reads no row while a Status column stands under another name: unpaid rows would read as money in hand', () => {
    const header: Cell[] = ['Date', 'Who', 'For', 'Category', 'In', 'Out', 'State', 'Paid on', 'Receipt', 'Ref']
    const got = rowsOf(header, [line('2026-03-01', 'Client', 75, '', 'Unpaid')])
    expect(got).toMatchObject({ rows: [], missing: ['Status'], renamed: ['State'] })
    // A ledger that never had a Status column, with a column of his own beside it, reads: every row is Paid.
    const plain = rowsOf(['Date', 'Who', 'In', 'Out', 'Notes'], [['2026-03-01', 'Client', 75, '', 'sent a card']])
    expect(plain.missing).toEqual([])
    expect(plain.rows).toMatchObject([{ in: 7500, status: 'Paid' }])
  })

  it('names figures that stand under no header, wherever they are', () => {
    const header: Cell[] = ['Date', 'Who', 'For', 'Category', 'In', '', 'Status', 'Paid on', 'Receipt', 'Ref', '']
    const got = rowsOf(header, [['2026-03-01', 'Shop', '', '', '', '', '', '', '', '', 12]])
    expect(got).toMatchObject({ rows: [], missing: ['Out'], renamed: ['column K'] })
  })

  it('says a mileage log with rows and no Date or Miles cannot be read, and one with only its header can', () => {
    expect(mileageMissing(['Date', 'Trip', 'Place', 'Distance', 'Rate'], [['2026-03-01', 'Game', 'Gym', 24, 0.7]])).toEqual(['Miles'])
    expect(mileageMissing(['Date', 'Trip', 'Place', 'Distance'], [])).toEqual([])
    expect(mileageMissing(['Date', 'Miles', 'Rate'], [['2026-03-01', 24, 0.7]])).toEqual([])
    // Without Rate a trip would read as worth nothing: that is a log that cannot be read, too.
    expect(mileageMissing(['Date', 'Miles', 'Per mile'], [['2026-03-01', 24, 0.7]])).toEqual(['Rate'])
  })

  it('prints a rate as it was given, never short of what the value was worked out with', () => {
    expect([0.7, 0.725, 0.7249, 1].map(rateWords)).toEqual(['0.70', '0.725', '0.7249', '1.00'])
    expect(milesLine({ miles: 1000, value: 72490, rate: 0.7249 })).toBe('1,000 mi · $724.90 at $0.7249')
    // Never in a scientist's notation, however small: plain decimals, as he typed them.
    expect([0.0000001, 0.12345678, 12, 0.1234567890125].map(rateWords)).toEqual(['0.0000001', '0.12345678', '12.00', '0.1234567890125'])
  })

  it('takes for writing only a day a read would give back', () => {
    expect(['2026-02-28', '2024-02-29', '1990-01-01', '2100-12-31'].every(isDay)).toBe(true)
    expect(['2026-02-30', '1989-12-31', '2101-01-01', '2026-13-01', '2026-1-5', 'tomorrow'].some(isDay)).toBe(false)
  })
})
