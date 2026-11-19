/**
 * A1 references as agents and the LifeOS tools write them (`B4`, `B4:D9`,
 * `'Q1 Budget'!B4:D9`), and Univer's zero-based rows and columns.
 */

export interface A1Range {
  /** the tab's name as written, unquoted; absent: the first sheet */
  sheet?: string
  startRow: number
  startColumn: number
  endRow: number
  endColumn: number
}

/** The most cells one read answers. */
export const READ_MAX_CELLS = 10_000

export function colName(col: number): string {
  let s = ''
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

export const cellName = (row: number, col: number): string => `${colName(col)}${row + 1}`

function cell(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/.exec(ref.trim())
  if (!m) return null
  const col = [...m[1].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
  const row = Number(m[2]) - 1
  return col < 16_384 && row < 1_048_576 ? { row, col } : null
}

/** `'Q1 Budget'!B4:D9` → its parts; null when it does not parse. */
export function parseA1(text: string): A1Range | null {
  let rest = text.trim()
  let sheet: string | undefined
  const bang = rest.lastIndexOf('!')
  if (bang >= 0) {
    sheet = rest.slice(0, bang)
    if (sheet.startsWith("'") && sheet.endsWith("'") && sheet.length >= 2) sheet = sheet.slice(1, -1).replace(/''/g, "'")
    if (!sheet) return null
    rest = rest.slice(bang + 1)
  }
  const [a, b, extra] = rest.split(':')
  if (extra !== undefined) return null
  const from = cell(a)
  const to = b === undefined ? from : cell(b)
  if (!from || !to) return null
  return {
    ...(sheet === undefined ? {} : { sheet }),
    startRow: Math.min(from.row, to.row),
    startColumn: Math.min(from.col, to.col),
    endRow: Math.max(from.row, to.row),
    endColumn: Math.max(from.col, to.col)
  }
}

export const rangeCells = (r: A1Range): number => (r.endRow - r.startRow + 1) * (r.endColumn - r.startColumn + 1)

/** A tab name as a reference writes it: quoted when it is not a plain word. */
export const sheetRef = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`)

export function rangeName(r: Omit<A1Range, 'sheet'>, sheet?: string): string {
  const head = cellName(r.startRow, r.startColumn)
  const body = r.startRow === r.endRow && r.startColumn === r.endColumn ? head : `${head}:${cellName(r.endRow, r.endColumn)}`
  return sheet === undefined ? body : `${sheetRef(sheet)}!${body}`
}
