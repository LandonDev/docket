import type { MsFormResponses } from '@shared/contract-work-msforms'
import type { MsAnyQuestion } from '@shared/work/msforms'
import type { Caller, WorkCtx } from '../modules'
import { responsesOf } from './answers/read'
import { formReach, MsformsError } from './reach'
import { refuseWithheld } from './withhold'

/**
 * A Microsoft form's answers as a dashboard's source (docs/agents/work-msforms.md
 * "Dashboards"): counts read from the answers Work holds in memory, never a copy.
 * A dashboard names what it counts in `range`:
 *  - `count`: how many answered;
 *  - `option:<question title>`: each declared option's count for a choice question of the form, any other answer
 *    counted under `OTHER` (`#labels` for the options): a label is never an answer's own words, so no name, address
 *    or free text can become one;
 *  - `day`: answers per day of completion (`#labels` for the days).
 */

type Cell = { at: string; v?: string | number | boolean }
export type SeriesCells = Cell[][]

const lower = (s: string): string => s.trim().toLowerCase()
const col = (i: number): string => String.fromCharCode(65 + (i % 26))

/** One column of cells, as a range read down a sheet reads. */
const column = (values: readonly (string | number)[], c = 0): SeriesCells => values.map((v, r) => [{ at: `${col(c)}${r + 1}`, v }])

/** The one label every answer that is no declared option is counted under. */
export const OTHER = 'Other'

/** A choice question as a series counts it: its declared options and the answers' column that is its own (`q<index>`), -1 for none yet. */
export interface ChoiceColumn {
  options: readonly string[]
  column: number
  multiple?: boolean
}

export function seriesOf(got: Pick<MsFormResponses, 'columns' | 'rows' | 'count'>, range: string, choice?: ChoiceColumn): SeriesCells {
  const [spec, part] = range.split('#')
  const labels = part === 'labels'
  if (spec === 'count') return [[{ at: 'A1', v: got.count }]]
  if (spec === 'day') {
    const time = got.columns.findIndex((c) => lower(c.label) === 'completion time')
    const days = new Map<string, number>()
    for (const r of got.rows) {
      const d = (r[time] ?? '').slice(0, 10)
      if (d) days.set(d, (days.get(d) ?? 0) + 1)
    }
    const sorted = [...days].sort(([a], [b]) => (a < b ? -1 : 1))
    return column(sorted.map(([d, n]) => (labels ? d : n)))
  }
  if (spec?.startsWith('option:')) {
    if (!choice) throw new MsformsError(`The form has no choice question "${spec.slice('option:'.length)}".`)
    const declared = new Map(choice.options.map((o) => [lower(o), o]))
    const counts = new Map<string, number>(choice.options.map((o) => [o, 0]))
    let other = 0
    if (choice.column >= 0)
      for (const r of got.rows) {
        const cell = (r[choice.column] ?? '').trim()
        // Forms writes a many-answer choice as the picked options joined by semicolons
        const picked = choice.multiple ? cell.split(';').map((v) => v.trim()).filter(Boolean) : cell ? [cell] : []
        for (const v of picked) {
          const option = declared.get(lower(v))
          if (option !== undefined) counts.set(option, (counts.get(option) ?? 0) + 1)
          else other++
        }
      }
    const rows: [string, number][] = [...counts, ...(other ? ([[OTHER, other]] as [string, number][]) : [])]
    return column(rows.map(([o, n]) => (labels ? o : n)))
  }
  throw new MsformsError('A form is counted by count, option:<question> or day.')
}

/** A choice question of the form by its Forms id or its title, with its place in the list (the answers' `q<index>` column). */
export function choiceOf(questions: readonly MsAnyQuestion[], named: string): { index: number; options: string[]; multiple?: boolean } | null {
  const want = lower(named)
  const index = questions.findIndex((q) => q.type === 'choice' && ((q.ref !== undefined && q.ref === named) || lower(q.title) === want))
  const q = index >= 0 ? questions[index] : undefined
  return q && q.type === 'choice' ? { index, options: [...(q.options ?? [])], ...(q.multiple ? { multiple: true } : {}) } : null
}

/**
 * The form a dashboard reads, through the one reach check on the dashboard's job, and the counts asked for.
 * `rev` is the form's count: the page reads again when it moved.
 */
export async function msformSeries(ctx: WorkCtx, by: Caller, ask: { workspaceId: string; formId: string; range?: string }): Promise<{ title: string; rev: number; cells: SeriesCells; stale: boolean }> {
  const at = formReach(ctx, by, ask)
  if (!ask.range) return { title: at.row.title, rev: at.row.count, cells: [], stale: false }
  refuseWithheld(ctx, by, at.row.sector)
  const choice = ask.range.startsWith('option:') ? choiceOf(at.row.questions, ask.range.slice('option:'.length).split('#')[0]!) : undefined
  // A series of no choice question of the form is refused before any answer is read.
  if (ask.range.startsWith('option:') && !choice) throw new MsformsError(`The form has no choice question "${ask.range.slice('option:'.length).split('#')[0]}".`)
  const got = await responsesOf(ctx, at, by)
  const cells = seriesOf(got, ask.range, choice ? { ...choice, column: got.columns.findIndex((c) => c.id === `q${choice.index}`) } : undefined)
  return { title: at.row.title, rev: at.row.count, cells, stale: got.stale }
}
