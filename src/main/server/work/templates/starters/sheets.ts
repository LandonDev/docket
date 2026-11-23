import { excelSerial } from '@shared/work/templates'
import type { CellIn, CellStyle, SheetIn } from './xlsx'

/**
 * The starter sheets as inputs to the starters' sheet writer (xlsx.ts), by
 * starter key (manifest.ts). Inputs wear Excel's Input style, totals its
 * Total style, money its Currency format; a cell that holds only
 * `{{Date}}` wears a date format, so the fill makes it a true date. A
 * table's rows are plain cells with light rules; Input marks only the few
 * values the sheet is worked from. Every sum and difference is a formula
 * written with its result on the sample rows (worked out here from the same
 * numbers), so a reader with no calculator shows the totals; Excel works
 * each one out again when the file opens. Sample rows are plainly made up.
 */

const c = (v: string | number | null, s: CellStyle): CellIn => ({ ...(v === null ? {} : { v }), s })
/** A formula and its result on the sample rows; `''` for a formula that shows nothing yet. */
const f = (formula: string, s: CellStyle, v: string | number): CellIn => ({ f: formula, s, v })
/** Money as a sheet keeps it: to the cent, with no float's tail. */
const cents = (x: number): number => Math.round(x * 100) / 100
const sum = (xs: readonly number[]): number => cents(xs.reduce((a, b) => a + b, 0))
/** The same style across `n` cells: a heading's rule or a total's lines run the table's width. */
const span = (first: CellIn, n: number, s: CellStyle): CellIn[] => [first, ...Array.from({ length: n - 1 }, () => c(null, s))]
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i)
const YES_NO = ['Yes', 'No']

function invoice(): SheetIn[] {
  const first = 10
  const last = 17
  const lines: [string, number, number][] = [
    ['Item one: what was done or supplied', 1, 1200],
    ['Item two', 4, 150],
    ['Item three', 2, 75]
  ]
  const subtotal = sum(lines.map(([, qty, rate]) => qty * rate))
  const rows: CellIn[][] = [
    span(c('Invoice', 'title'), 4, 'title'),
    [c('From {{Job}}', 'muted')],
    [],
    [c('Bill to', 'label'), null, c('Invoice date', 'labelRight'), c('{{Date}}', 'inputDate')],
    [c('{{Client}}', 'input'), null, c('Invoice number', 'labelRight'), c('{{Invoice number}}', 'input')],
    [c('Street address', 'input'), null, c('Due date', 'labelRight'), f('IF(ISNUMBER(D4),D4+30,"")', 'date', '')],
    [c('City, state, ZIP', 'input'), null, c('Terms', 'labelRight'), c('Net 30', 'input')],
    [],
    [c('Description', 'head'), c('Qty', 'headRight'), c('Rate', 'headRight'), c('Amount', 'headRight')],
    ...range(first, last).map((r, i) => {
      const [what, qty, rate] = lines[i] ?? [null, null, null]
      return [c(what, 'cell'), c(qty, 'cellNumber'), c(rate, 'cellCurrency'), f(`IF(B${r}="","",B${r}*C${r})`, 'cellCurrency', qty === null || rate === null ? '' : cents(qty * rate))]
    }),
    [null, null, c('Subtotal', 'labelRight'), f(`SUM(D${first}:D${last})`, 'currency', subtotal)],
    [null, null, c('Tax rate', 'labelRight'), c(0, 'inputPercent')],
    [null, null, c('Tax', 'labelRight'), f('D18*D19', 'currency', 0)],
    [c(null, 'total'), c(null, 'total'), c('Total due', 'totalLabel'), f('D18+D20', 'totalCurrency', subtotal)],
    [],
    span(c('Payment', 'section'), 4, 'section'),
    [c('Pay by bank transfer within 30 days, quoting the invoice number. Account name: {{Job}}. Bank, account and routing numbers: add yours here.', 'note'), c(null, 'note'), c(null, 'note'), c(null, 'note')],
    [],
    [c('Thank you for your business.', 'muted')]
  ]
  return [{ name: 'Invoice', cols: [46, 9, 15, 19], rows, grid: false, merges: ['A24:D24'], heights: { 24: 36 }, footer: '&L{{Job}}&RPage &P of &N' }]
}

function releaseChecklist(): SheetIn[] {
  const phases: [string, string[]][] = [
    [
      'Before the release',
      [
        'Freeze the release branch and tag the build',
        'Write the release note',
        'Run the full test suite on the release build',
        'Test on a staging server with a copy of live data',
        'Back up the live databases',
        'Review config and permission changes',
        'Tell staff the release window'
      ]
    ],
    ['Release', ['Post the maintenance notice', 'Deploy the build to the live servers', 'Smoke test: join, the core loop, purchases, chat', 'Watch logs and error rates for 30 minutes', 'Lift the maintenance notice']],
    ['After the release', ['Publish the release note', 'Watch reports and support tickets for 24 hours', 'Close the release tickets', 'Hold a short review and record the follow-ups']]
  ]
  const steps = phases.reduce((n, [, list]) => n + list.length, 0)
  const rows: CellIn[][] = [
    span(c('Release checklist: {{Version}}', 'title'), 6, 'title'),
    [c('Updated {{Date}} by {{Name}}', 'muted')],
    [null, f('COUNTIF(E6:E40,"Yes")&" of "&COUNTA(B6:B40)&" steps done"', 'label', `0 of ${steps} steps done`)],
    [],
    [c('#', 'headCenter'), c('Step', 'head'), c('Owner', 'head'), c('Due', 'head'), c('Done', 'headCenter'), c('Notes', 'head')]
  ]
  let n = 0
  for (const [phase, steps] of phases) {
    rows.push([c(phase, 'label')])
    for (const step of steps) rows.push([c(++n, 'cellCenter'), c(step, 'cell'), c('Person one', 'cell'), c(null, 'cellDate'), c('No', 'cellCenter'), c(null, 'cellWrap')])
  }
  return [{ name: 'Checklist', cols: [5, 52, 16, 14, 8, 36], rows, freeze: 5, printTitles: [5, 5], landscape: true, lists: [{ range: 'E6:E40', values: YES_NO }], header: '&L{{Job}}&R{{Version}}' }]
}

function shotList(): SheetIn[] {
  const shots: [string, string, string, string, string][] = [
    ['Scene one', 'Host to camera: the hook line', 'Medium', 'Static', 'Location one'],
    ['Scene one', 'Wide of the setting to open', 'Wide', 'Pan', 'Location one'],
    ['Scene one', 'Hands on the thing being shown', 'Insert', 'Static', 'Location one'],
    ['Scene two', 'Walk and talk to the next spot', 'Medium', 'Tracking', 'Location two'],
    ['Scene two', 'Reaction from the guest', 'Close-up', 'Static', 'Location two'],
    ['Scene two', 'Over the shoulder onto the screen', 'Over the shoulder', 'Push in', 'Location two'],
    ['Scene three', 'Closing line and call to action', 'Medium', 'Static', 'Location one'],
    ['Scene three', 'Cutaways for the edit', 'Close-up', 'Handheld', 'Any']
  ]
  const head = 6
  const rows: CellIn[][] = [
    span(c('Shot list: {{Video}}', 'title'), 8, 'title'),
    [c('Prepared by {{Name}} · {{Date}}', 'muted')],
    [null, c('Shoot date', 'label'), c(null, 'inputDate')],
    [null, c('Progress', 'label'), f(`COUNTIF(H${head + 1}:H60,"Yes")&" of "&COUNTA(C${head + 1}:C60)&" shots done"`, 'normal', `0 of ${shots.length} shots done`)],
    [],
    ['#', 'Scene', 'Shot', 'Framing', 'Movement', 'Location', 'Notes', 'Done'].map((h) => c(h, h === '#' || h === 'Done' ? 'headCenter' : 'head')),
    ...range(1, 20).map((i) => {
      const s = shots[i - 1]
      return [c(i, 'cellCenter'), c(s?.[0] ?? null, 'cell'), c(s?.[1] ?? null, 'cellWrap'), c(s?.[2] ?? null, 'cell'), c(s?.[3] ?? null, 'cell'), c(s?.[4] ?? null, 'cell'), c(null, 'cellWrap'), c(s ? 'No' : null, 'cellCenter')]
    })
  ]
  const body = `${head + 1}:${head + 20}`.split(':')
  return [
    {
      name: 'Shots',
      cols: [5, 14, 40, 17, 12, 16, 30, 8],
      rows,
      freeze: head,
      printTitles: [head, head],
      landscape: true,
      lists: [
        { range: `D${body[0]}:D${body[1]}`, values: ['Wide', 'Medium', 'Close-up', 'Extreme close-up', 'Over the shoulder', 'Insert', 'Point of view'] },
        { range: `E${body[0]}:E${body[1]}`, values: ['Static', 'Pan', 'Tilt', 'Push in', 'Pull out', 'Tracking', 'Handheld'] },
        { range: `H${body[0]}:H${body[1]}`, values: YES_NO }
      ],
      header: '&L{{Job}}&R{{Video}}'
    }
  ]
}

function travelBudget(): SheetIn[] {
  const first = 10
  // [category, item, quantity as a formula or number, unit cost]
  const lines: [string, string, string | number, number][] = [
    ['Transport', 'Flights or mileage, per traveler', 'B4', 320],
    ['Transport', 'Ground transport: rental, rideshare, transit', 1, 180],
    ['Transport', 'Parking, tolls and fuel', 1, 60],
    ['Lodging', 'Hotel rooms, two to a room, per night', 'ROUNDUP(B4/2,0)*B5', 150],
    ['Meals', 'Meal allowance, per traveler per day', 'B4*(B5+1)', 45],
    ['Fees', 'Registration or entry, per traveler', 'B4', 75]
  ]
  const last = first + lines.length // the contingency row
  const total = last + 1
  const travelers = 4
  const nights = 2
  const qtyOf: Record<string, number> = { B4: travelers, 'ROUNDUP(B4/2,0)*B5': Math.ceil(travelers / 2) * nights, 'B4*(B5+1)': travelers * (nights + 1) }
  const estimates = lines.map(([, , qty, cost]) => cents((typeof qty === 'number' ? qty : qtyOf[qty]!) * cost))
  const contingency = Math.round(sum(estimates) * 0.1)
  const estimate = sum([...estimates, contingency])
  const rows: CellIn[][] = [
    span(c('Travel budget: {{Trip}}', 'title'), 8, 'title'),
    [c('Prepared by {{Name}} on {{Date}}', 'muted')],
    [],
    [c('Travelers', 'label'), c(travelers, 'inputNumber')],
    [c('Nights', 'label'), c(nights, 'inputNumber')],
    [c('Leave', 'label'), c(null, 'inputDate')],
    [c('Return', 'label'), c(null, 'inputDate')],
    [],
    [c('Category', 'head'), c('Item', 'head'), c('Qty', 'headRight'), c('Unit cost', 'headRight'), c('Estimate', 'headRight'), c('Actual', 'headRight'), c('Difference', 'headRight'), c('Notes', 'head')],
    ...lines.map(([cat, item, qty, cost], i) => {
      const r = first + i
      return [c(cat, 'cell'), c(item, 'cell'), typeof qty === 'number' ? c(qty, 'cellNumber') : f(qty, 'cellNumber', qtyOf[qty]!), c(cost, 'cellCurrency'), f(`C${r}*D${r}`, 'cellCurrency', estimates[i]!), c(null, 'cellCurrency'), f(`IF(F${r}="","",E${r}-F${r})`, 'cellCurrency', ''), c(null, 'cellWrap')]
    }),
    [c('Other', 'cell'), c('Contingency, a tenth of the rest', 'cell'), c(1, 'cellNumber'), f(`ROUND(SUM(E${first}:E${last - 1})*0.1,0)`, 'cellCurrency', contingency), f(`C${last}*D${last}`, 'cellCurrency', contingency), c(null, 'cellCurrency'), f(`IF(F${last}="","",E${last}-F${last})`, 'cellCurrency', ''), c(null, 'cellWrap')],
    [c('Total', 'total'), c(null, 'total'), c(null, 'total'), c(null, 'total'), f(`SUM(E${first}:E${last})`, 'totalCurrency', estimate), f(`SUM(F${first}:F${last})`, 'totalCurrency', 0), f(`IF(F${total}=0,"",E${total}-F${total})`, 'totalCurrency', ''), c(null, 'total')],
    [null, null, null, c('Per traveler', 'labelRight'), f(`IF(B4>0,E${total}/B4,"")`, 'currency', cents(estimate / travelers)), f(`IF(AND(B4>0,F${total}>0),F${total}/B4,"")`, 'currency', '')]
  ]
  return [{ name: 'Budget', cols: [14, 42, 7, 12, 13, 13, 13, 28], rows, printTitles: [9, 9], landscape: true, header: '&L{{Job}}&R{{Trip}}' }]
}

function seasonLog(): SheetIn[] {
  const first = 7
  const last = 26
  const games: [string, string, string, string, string, number, number, string][] = [
    ['2026-09-04', 'Team one at Team two', 'Varsity', 'Site one', 'Partner one, Partner two', 85, 24, 'Yes'],
    ['2026-09-11', 'Team three at Team four', 'Junior varsity', 'Site two', 'Partner three', 60, 38, 'Yes'],
    ['2026-09-18', 'Team five at Team six', 'Varsity', 'Site three', 'Partner one, Partner four', 85, 12, 'No']
  ]
  const total = last + 1
  const rate = 0.7
  const fees = sum(games.map((g) => g[5]))
  const miles = games.reduce((n, g) => n + g[6], 0)
  const mileage = sum(games.map((g) => cents(g[6] * rate)))
  const rows: CellIn[][] = [
    span(c('Season log', 'title'), 9, 'title'),
    [c('{{Name}} · updated {{Date}}', 'muted')],
    [],
    [c('Mileage rate', 'label'), c(rate, 'inputCurrency'), c('per mile', 'muted')],
    [],
    ['Date', 'Game', 'Level', 'Site', 'Partners', 'Fee', 'Miles', 'Mileage', 'Paid'].map((h, i) => c(h, i >= 5 && i <= 7 ? 'headRight' : i === 8 ? 'headCenter' : 'head')),
    ...range(first, last).map((r, i) => {
      const g = games[i]
      return [
        c(g ? excelSerial(g[0]) : null, 'cellDate'),
        c(g?.[1] ?? null, 'cell'),
        c(g?.[2] ?? null, 'cell'),
        c(g?.[3] ?? null, 'cell'),
        c(g?.[4] ?? null, 'cell'),
        c(g?.[5] ?? null, 'cellCurrency'),
        c(g?.[6] ?? null, 'cellNumber'),
        f(`IF(G${r}="","",G${r}*$B$4)`, 'cellCurrency', g ? cents(g[6] * rate) : ''),
        c(g?.[7] ?? null, 'cellCenter')
      ]
    }),
    [
      c('Total', 'total'),
      f(`COUNTA(B${first}:B${last})&" games"`, 'total', `${games.length} games`),
      c(null, 'total'),
      c(null, 'total'),
      c(null, 'total'),
      f(`SUM(F${first}:F${last})`, 'totalCurrency', fees),
      f(`SUM(G${first}:G${last})`, 'totalNumber', miles),
      f(`SUM(H${first}:H${last})`, 'totalCurrency', mileage),
      c(null, 'total')
    ],
    [],
    [c('Earned', 'label'), f(`F${total}+H${total}`, 'currency', cents(fees + mileage)), c('fees and mileage', 'muted')],
    [c('Still owed', 'label'), f(`SUMIF(I${first}:I${last},"No",F${first}:F${last})`, 'currency', sum(games.filter((g) => g[7] === 'No').map((g) => g[5]))), c('fees not yet paid', 'muted')]
  ]
  return [{ name: 'Season', cols: [13, 30, 15, 20, 26, 10, 8, 11, 7], rows, freeze: 6, printTitles: [6, 6], landscape: true, lists: [{ range: `I${first}:I${last}`, values: YES_NO }], header: '&LSeason log&R{{Name}}' }]
}

function monthlyBudget(): SheetIn[] {
  const income: [string, number][] = [
    ['Pay, after tax', 4000],
    ['Other income', 0]
  ]
  const expenses: [string, number][] = [
    ['Housing', 1200],
    ['Utilities', 180],
    ['Groceries', 450],
    ['Transport', 250],
    ['Insurance', 150],
    ['Phone and internet', 110],
    ['Health', 60],
    ['Subscriptions', 40],
    ['Eating out', 200],
    ['Fun', 150],
    ['Gifts and giving', 80],
    ['Savings', 600],
    ['Other', 100]
  ]
  const head = (what: string): CellIn[] => [c(what, 'head'), c('Planned', 'headRight'), c('Actual', 'headRight'), c('Difference', 'headRight'), c('Notes', 'head')]
  const iFirst = 5
  const iLast = iFirst + income.length - 1
  const iTotal = iLast + 1
  const eFirst = iTotal + 3
  const eLast = eFirst + expenses.length - 1
  const eTotal = eLast + 1
  const savings = eFirst + expenses.findIndex(([name]) => name === 'Savings')
  const incomeTotal = sum(income.map(([, x]) => x))
  const expenseTotal = sum(expenses.map(([, x]) => x))
  const saved = expenses.find(([name]) => name === 'Savings')![1]
  const line = (name: string, planned: number, r: number, sign: 1 | -1): CellIn[] => [
    c(name, 'cell'),
    c(planned, 'cellCurrency'),
    c(null, 'cellCurrency'),
    f(sign === 1 ? `IF(C${r}="","",C${r}-B${r})` : `IF(C${r}="","",B${r}-C${r})`, 'cellCurrency', ''),
    c(null, 'cellWrap')
  ]
  const totalRow = (name: string, from: number, to: number, r: number, sign: 1 | -1, planned: number): CellIn[] => [
    c(name, 'total'),
    f(`SUM(B${from}:B${to})`, 'totalCurrency', planned),
    f(`SUM(C${from}:C${to})`, 'totalCurrency', 0),
    f(sign === 1 ? `IF(C${r}=0,"",C${r}-B${r})` : `IF(C${r}=0,"",B${r}-C${r})`, 'totalCurrency', ''),
    c(null, 'total')
  ]
  const rows: CellIn[][] = [
    span(c('Monthly budget', 'title'), 5, 'title'),
    [c('Month', 'label'), c('{{Date}}', 'inputMonth')],
    [],
    head('Income'),
    ...income.map(([name, planned], i) => line(name, planned, iFirst + i, 1)),
    totalRow('Total income', iFirst, iLast, iTotal, 1, incomeTotal),
    [],
    head('Expenses'),
    ...expenses.map(([name, planned], i) => line(name, planned, eFirst + i, -1)),
    totalRow('Total expenses', eFirst, eLast, eTotal, -1, expenseTotal),
    [],
    span(c('Summary', 'section'), 5, 'section'),
    [c('Left over', 'label'), f(`B${iTotal}-B${eTotal}`, 'currency', cents(incomeTotal - expenseTotal)), f(`IF(C${iTotal}=0,"",C${iTotal}-C${eTotal})`, 'currency', ''), null, c('Income less expenses', 'muted')],
    [c('Saved', 'label'), f(`IF(B${iTotal}=0,"",B${savings}/B${iTotal})`, 'percent', saved / incomeTotal), f(`IF(OR(C${iTotal}=0,C${savings}=""),"",C${savings}/C${iTotal})`, 'percent', ''), null, c('Savings as a share of income', 'muted')]
  ]
  return [{ name: 'Budget', cols: [26, 14, 14, 14, 34], rows, grid: false, header: '&LMonthly budget' }]
}

export const SHEETS: Record<string, () => SheetIn[]> = {
  'unify/invoice': invoice,
  'cosmic/release-checklist': releaseChecklist,
  'hypixel/shot-list': shotList,
  'purdue/travel-budget': travelBudget,
  'ref/season-log': seasonLog,
  'life/monthly-budget': monthlyBudget
}
