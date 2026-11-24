import { importXlsx, isDateFormat } from 'work-kit/sheet/xlsx'
import { columnsOf } from '@shared/work/money'
import { ANSWERS_MOST, ANSWERS_TABLE, type MsAnyQuestion } from '@shared/work/msforms'
import { readTables } from '../../sheets/patch/tables'

/**
 * A Forms workbook's answers (docs/agents/work-msforms.md "Reading answers"):
 * the table Forms writes (`OfficeForms.Table`) found by its bounds, its
 * columns read by header name, case-blind, as Money reads its ledger. Forms'
 * own five come first; each question's column is matched to the form's
 * cached list by title, and a column that matches none is shown by its own
 * header. Newest first; past `ANSWERS_MOST` the newest are kept. What comes
 * back lives in memory alone (cache.ts).
 */

export interface ParsedAnswers {
  columns: { id: string; label: string }[]
  /** newest first, one string a column */
  rows: string[][]
  /** every answer in the table, the cut ones too */
  count: number
  cut: boolean
  /** the highest `Id` in the table; 0 with none */
  maxId: number
  /** the newest Completion time, as this host's clock reads its wall time; null with none */
  lastAnswerAt: number | null
}

export class AnswersUnreadable extends Error {}

/** Forms' own columns, by the header it writes, and the id each is answered under. */
export const FIXED_COLUMNS = [
  ['Id', 'id'],
  ['Start time', 'start'],
  ['Completion time', 'end'],
  ['Email', 'email'],
  ['Name', 'name']
] as const

const fold = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()

interface CellLike {
  v?: unknown
  s?: unknown
  p?: { body?: { dataStream?: string } }
}

/** An Excel serial's wall time, read as written (Excel keeps no zone). */
function wallOf(serial: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  // 25569: days from Excel's 1899-12-30 to 1970-01-01; before 1900-03-01 Excel counts a 29 February that never was
  const ms = Math.round(((serial < 61 ? serial + 1 : serial) - 25569) * 86_400_000)
  const t = new Date(ms)
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() }
}
const pad = (n: number): string => String(n).padStart(2, '0')

export function answersOf(bytes: Uint8Array, questions: readonly MsAnyQuestion[]): ParsedAnswers {
  let workbook: ReturnType<typeof importXlsx>['workbook']
  let sheets: ReturnType<typeof readTables>['sheets']
  try {
    workbook = importXlsx(bytes).workbook
    sheets = readTables(bytes).sheets
  } catch {
    // the importer's own words may quote the file: they are not passed on
    throw new AnswersUnreadable('The answers workbook could not be read.')
  }
  const found = Object.entries(sheets).flatMap(([name, tab]) => tab.tables.filter((t) => fold(t.name) === fold(ANSWERS_TABLE)).map((table) => ({ name, table })))[0]
  if (!found) throw new AnswersUnreadable(`The answers workbook has no ${ANSWERS_TABLE} table.`)
  const sheetId = workbook.sheetOrder.find((id) => workbook.sheets[id]?.name === found.name)
  const cells = (sheetId ? workbook.sheets[sheetId]?.cellData : undefined) ?? {}
  const styles = (workbook.styles ?? {}) as Record<string, { n?: { pattern?: string } } | null>
  const { startRow, endRow, startColumn, endColumn } = found.table.range

  const cellOf = (r: number, c: number): CellLike | undefined => (cells as Record<number, Record<number, CellLike>>)[r]?.[c]
  /** a cell's date as wall time when its format is a date's, else null */
  const dateOf = (cell: CellLike | undefined) => {
    if (typeof cell?.v !== 'number') return null
    const style = typeof cell.s === 'string' ? styles[cell.s] : (cell.s as { n?: { pattern?: string } } | null | undefined)
    return isDateFormat(style?.n?.pattern) ? wallOf(cell.v) : null
  }
  const textOf = (cell: CellLike | undefined): string => {
    if (!cell) return ''
    const date = dateOf(cell)
    if (date) {
      const day = `${date.y}-${pad(date.mo + 1)}-${pad(date.d)}`
      return date.h || date.mi || date.s ? `${day} ${pad(date.h)}:${pad(date.mi)}` : day
    }
    if (cell.v !== undefined && cell.v !== null) return String(cell.v)
    return (cell.p?.body?.dataStream ?? '').replace(/[\r\n]+$/, '')
  }

  const width = endColumn - startColumn + 1
  const header = Array.from({ length: width }, (_, i) => textOf(cellOf(startRow, startColumn + i)))
  const fixed = columnsOf(header, FIXED_COLUMNS.map(([name]) => name))
  const asked = questions.map((q, i) => ({ q, i })).filter(({ q }) => q.type !== 'section')
  const columns = header.map((label, i) => {
    const own = FIXED_COLUMNS.find(([name]) => fixed[name] === i)
    if (own) return { id: own[1], label: own[0] }
    const hit = asked.find(({ q }) => fold(q.title) === fold(label))
    return hit ? { id: `q${hit.i}`, label: hit.q.title } : { id: `c${i}`, label: label || `Column ${i + 1}` }
  })

  const footer = found.table.options?.showFooter ?? (found.table.options as { hasTotalRow?: boolean } | undefined)?.hasTotalRow ?? false
  const last = footer ? endRow - 1 : endRow
  const body: { row: string[]; id: number; at: number | null; order: number }[] = []
  for (let r = startRow + 1; r <= last; r++) {
    const row = Array.from({ length: width }, (_, i) => textOf(cellOf(r, startColumn + i)))
    if (row.every((v) => v === '')) continue
    const id = fixed.Id !== undefined ? Number(row[fixed.Id]) : NaN
    const done = fixed['Completion time'] !== undefined ? dateOf(cellOf(r, startColumn + fixed['Completion time'])) : null
    body.push({ row, id: Number.isFinite(id) ? id : NaN, at: done ? new Date(done.y, done.mo, done.d, done.h, done.mi, done.s).getTime() : null, order: r })
  }
  // newest first: by Id where it is a number, else the later row
  body.sort((a, b) => (Number.isFinite(a.id) && Number.isFinite(b.id) && a.id !== b.id ? b.id - a.id : b.order - a.order))
  const ids = body.map((b) => b.id).filter(Number.isFinite)
  const times = body.map((b) => b.at).filter((t): t is number => t !== null)
  return {
    columns,
    rows: body.slice(0, ANSWERS_MOST).map((b) => b.row),
    count: body.length,
    cut: body.length > ANSWERS_MOST,
    maxId: ids.length ? Math.max(...ids) : fixed.Id === undefined ? body.length : 0,
    lastAnswerAt: times.length ? Math.max(...times) : null
  }
}
