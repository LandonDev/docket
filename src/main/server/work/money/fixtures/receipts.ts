import type { ReceiptFields, ReceiptLine } from '@shared/work/money'

/**
 * The made-up receipts every Money test and proof reads (docs/agents/work-money.md
 * "The fixtures"). Every seller here is invented; nothing is Purdue's or anyone's.
 * `draw.ts` draws each as a picture or a PDF from these rows, so what a test
 * expects and what a reader is shown are one text.
 */

export interface Fixture {
  /** the file beside this one */
  file: string
  /** a picture, a PDF with its text in it, or a PDF that is only a picture (a scan) */
  kind: 'picture' | 'pdf' | 'scan'
  sector: string
  /** each row: the words at the left and, for a priced line, the figure at the right */
  rows: readonly (readonly [string, string?])[]
  /** what `parseReceipt` must read, with today as `FIXTURE_TODAY` */
  expected: ReceiptFields
}

export const FIXTURE_TODAY = '2026-11-23'

export const FIXTURES: readonly Fixture[] = [
  {
    file: 'coffee.png',
    kind: 'picture',
    sector: 'life',
    rows: [['BLUE HERON COFFEE'], ['214 Canal St, Lafayette IN'], ['11/21/2026 08:42 AM'], ['Latte 12oz', '5.25'], ['Blueberry scone', '4.50'], ['Subtotal', '9.75'], ['Tax 7.00%', '0.68'], ['TOTAL', '10.43'], ['VISA ****4242']],
    expected: { amount: 1043, date: '2026-11-21', who: 'Blue Heron Coffee', category: 'Food' }
  },
  {
    file: 'fuel.jpg',
    kind: 'picture',
    sector: 'ref',
    rows: [['NORTHSIDE FUEL STOP'], ['Pump 04 Unleaded'], ['11/14/2026'], ['Gallons', '14.207'], ['Price/Gal', '$3.391'], ['TOTAL', '$48.17'], ['DEBIT ****0931']],
    expected: { amount: 4817, date: '2026-11-14', who: 'Northside Fuel Stop', category: 'Travel' }
  },
  {
    // The total is not the largest figure: cash handed over is.
    file: 'hardware.png',
    kind: 'picture',
    sector: 'unify',
    rows: [
      ['GRANGER HARDWARE & SUPPLY'],
      ['Store 118'],
      ['Date: Nov 3, 2026'],
      ['Shelf brackets x4', '31.96'],
      ['Plywood sheet', '86.17'],
      ['Subtotal', '118.13'],
      ['Sales tax', '8.27'],
      ['Amount due', '126.40'],
      ['Cash tendered', '140.00'],
      ['Change', '13.60']
    ],
    expected: { amount: 12640, date: '2026-11-03', who: 'Granger Hardware & Supply', category: 'Equipment' }
  },
  {
    file: 'software.png',
    kind: 'picture',
    sector: 'cosmic',
    rows: [['Pixelforge Software Inc.'], ['Receipt PF-20418'], ['Invoice date 2026-10-28'], ['Team plan, monthly', '$19.00'], ['Grand total', '$19.00'], ['Paid with Mastercard ending 5521']],
    expected: { amount: 1900, date: '2026-10-28', who: 'Pixelforge Software Inc.', category: 'Software' }
  },
  {
    file: 'meal.jpg',
    kind: 'picture',
    sector: 'purdue',
    rows: [['TRATTORIA LUNA'], ['Table 12 Server: Dana'], ['10/09/26 7:18 PM'], ['2 Pasta special', '38.00'], ['1 Tiramisu', '9.00'], ['Subtotal', '47.00'], ['Tax', '3.29'], ['Tip', '9.00'], ['Total', '59.29']],
    expected: { amount: 5929, date: '2026-10-09', who: 'Trattoria Luna', category: 'Food' }
  },
  {
    // No word for the total: the largest figure stands in.
    file: 'gear.png',
    kind: 'picture',
    sector: 'ref',
    rows: [['REF GEAR OUTLET'], ['09/30/2026'], ['Whistle, pealess', '8.99'], ['Striped jersey L', '42.00'], ['Paid', '50.99'], ['Thank you']],
    expected: { amount: 5099, date: '2026-09-30', who: 'Ref Gear Outlet', category: 'Uniform and gear' }
  },
  {
    // A PDF with its text in it, and nothing that names a category.
    file: 'invoice.pdf',
    kind: 'pdf',
    sector: 'unify',
    rows: [['Lakeshore Print Co.'], ['Invoice 2217'], ['October 12, 2026'], ['500 business cards', '$180.00'], ['Banner, 3x6 ft', '$132.50'], ['Balance due', '$312.50']],
    expected: { amount: 31250, date: '2026-10-12', who: 'Lakeshore Print Co.', category: null }
  },
  {
    // A scan: a PDF with no text layer, read as a picture.
    file: 'parking-scan.pdf',
    kind: 'scan',
    sector: 'purdue',
    rows: [['CITY CENTER PARKING GARAGE'], ['Ticket 004417'], ['11/02/2026 6:05 PM'], ['3 hrs', '18.00'], ['TOTAL', '18.00']],
    expected: { amount: 1800, date: '2026-11-02', who: 'City Center Parking Garage', category: 'Travel' }
  }
]

/** How a fixture is laid out on its page; `draw.ts` and `linesOf` share it. */
export const LAYOUT = { width: 640, left: 44, top: 56, line: 46, size: 26, bottom: 44 } as const
export const heightOf = (f: Fixture): number => LAYOUT.top + f.rows.length * LAYOUT.line + LAYOUT.bottom

/**
 * A fixture's rows as a reader gives them back: each run its own box, a
 * priced line's label and figure apart, in no useful order (figures first),
 * so a test of the parser also tests the joining.
 */
export function linesOf(f: Fixture): ReceiptLine[] {
  const wide = (text: string): number => text.length * LAYOUT.size * 0.6
  const labels: ReceiptLine[] = []
  const figures: ReceiptLine[] = []
  f.rows.forEach(([label, figure], i) => {
    const top = LAYOUT.top + i * LAYOUT.line
    labels.push({ text: label, box: [LAYOUT.left, top, LAYOUT.left + wide(label), top + LAYOUT.size], score: 0.99 })
    // A reader's boxes for one line seldom share an exact top: the figure sits two units lower.
    if (figure) figures.push({ text: figure, box: [LAYOUT.width - LAYOUT.left - wide(figure), top + 2, LAYOUT.width - LAYOUT.left, top + 2 + LAYOUT.size], score: 0.98 })
  })
  return [...figures, ...labels]
}
