import type { MsFormResponses } from '@shared/contract-work-msforms'
import type { Caller, WorkCtx } from '../modules'
import { responsesOf } from './answers/read'
import { formReach, MsformsError } from './reach'
import { refuseWithheld } from './withhold'

/**
 * A Microsoft form's answers as a dashboard's source (docs/agents/work-msforms.md
 * "Dashboards"): counts read from the answers Work holds in memory, never a copy.
 * A dashboard names what it counts in `range`:
 *  - `count`: how many answered;
 *  - `option:<question title>`: each option's count for a choice question (`#labels` for the options);
 *  - `day`: answers per day of completion (`#labels` for the days).
 */

type Cell = { at: string; v?: string | number | boolean }
export type SeriesCells = Cell[][]

const lower = (s: string): string => s.trim().toLowerCase()
const col = (i: number): string => String.fromCharCode(65 + (i % 26))

/** One column of cells, as a range read down a sheet reads. */
const column = (values: readonly (string | number)[], c = 0): SeriesCells => values.map((v, r) => [{ at: `${col(c)}${r + 1}`, v }])

export function seriesOf(got: Pick<MsFormResponses, 'columns' | 'rows' | 'count'>, range: string, options: readonly string[] = []): SeriesCells {
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
    const title = spec.slice('option:'.length)
    const at = got.columns.findIndex((c) => lower(c.label) === lower(title))
    if (at < 0) throw new MsformsError(`The form has no question "${title}" among its answers.`)
    const counts = new Map<string, number>(options.map((o) => [o, 0]))
    for (const r of got.rows) {
      const v = (r[at] ?? '').trim()
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    return column([...counts].map(([o, n]) => (labels ? o : n)))
  }
  throw new MsformsError('A form is counted by count, option:<question> or day.')
}

/**
 * The form a dashboard reads, through the one reach check on the dashboard's job, and the counts asked for.
 * `rev` is the form's count: the page reads again when it moved.
 */
export async function msformSeries(ctx: WorkCtx, by: Caller, ask: { workspaceId: string; formId: string; range?: string }): Promise<{ title: string; rev: number; cells: SeriesCells; stale: boolean }> {
  const at = formReach(ctx, by, ask)
  if (!ask.range) return { title: at.row.title, rev: at.row.count, cells: [], stale: false }
  refuseWithheld(ctx, by, at.row.sector)
  const got = await responsesOf(ctx, at, by)
  const q = at.row.questions.find((x) => ask.range!.startsWith('option:') && lower(x.title) === lower(ask.range!.slice('option:'.length).split('#')[0]!))
  const options = q && q.type === 'choice' ? (q.options ?? []) : []
  return { title: at.row.title, rev: at.row.count, cells: seriesOf(got, ask.range, options), stale: got.stale }
}
