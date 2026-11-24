/**
 * Sets perf runs beside the budgets, as markdown, and writes the table into a file between two marks:
 *
 *   bun scripts/perf/table.ts --into .temp-code/plans/perf/BASELINE.md --section before <results.json> [more]
 *
 * A later run of a row replaces an earlier one's. The section sits between `<!-- perf:<section> -->` and
 * `<!-- /perf:<section> -->`; with no such marks in the file it is added at the end. Rows that did not run keep
 * their reason: a row is never written as met without a number.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { BUDGETS, budgetsOf } from './budgets'
import type { Sample } from './lib/probe'
import type { RowResult, RunResults } from './run'

const ms = (value: number | null | undefined): string =>
  value == null ? '–' : value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`
const kb = (bytes: number): string => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} kB`)

/** `3 T (work.files.list 2, work.files.stat)`: the round trips to the host, the busiest methods named. */
export function asks(sample: Sample | undefined): string {
  if (!sample) return '–'
  const top = Object.entries(sample.counts.t).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3)
    .map(([method, n]) => (n > 1 ? `${method} ${n}` : method)).join(', ')
  return `${sample.counts.tAll} T${top ? ` (${top})` : ''}, ${sample.counts.c} C`
}

/** The newest result of each row across the runs, in the runs' row order. */
export function latest(runs: RunResults[]): { row: RowResult; run: RunResults }[] {
  const by = new Map<string, { row: RowResult; run: RunResults }>()
  for (const run of [...runs].sort((a, b) => a.at.localeCompare(b.at))) {
    for (const row of run.rows) {
      // A row a later run did not reach keeps the number an earlier run got.
      if (row.notRun && by.get(row.id)?.row.middle) continue
      by.set(row.id, { row, run })
    }
  }
  return [...by.values()]
}

export function perfTable(runs: RunResults[]): string {
  const out = [
    '| Budget | Row | Budget says | First press | Middle press | First sign | Longest task | Asks to usable | Asks in the next second | From the host | Machine |',
    '|---|---|---|---|---|---|---|---|---|---|---|'
  ]
  for (const { row, run } of latest(runs)) {
    const ids = budgetsOf(row.id)
    const budget = ids.map((b) => b.id).join(', ') || '–'
    const says = ids.map((b) => b.budget).join(' / ') || '–'
    const m = row.middle
    if (row.notRun || !m) {
      out.push(`| ${budget} | \`${row.id}\` | ${says} | not run: ${row.notRun ?? 'no press finished'} | | | | | | | |`)
      continue
    }
    const shape = `${run.link ? `${run.link.rttMs} ms, ${run.link.rateMbit} Mbit/s` : 'unslowed'}, ${run.load} threads; load ${row.machine.load}${row.machine.anonGiB === null ? '' : `, ${row.machine.anonGiB} GiB`}`
    out.push(`| ${budget} | \`${row.id}\` | ${says} | ${ms(row.samples[0]?.usable)} | ${m.usable == null ? `never usable (${m.error ?? 'timed out'})` : ms(m.usable)} | ${ms(m.first)} | ${ms(m.longest)} | ${asks(m)} | ${m.after.tAll} T, ${m.after.c} C | ${kb(m.wire?.down ?? m.counts.down)} | ${shape} |`)
  }
  out.push('', 'Not timed on the pair, or only in part:', '', ...BUDGETS.filter((b) => b.off).map((b) => `- **${b.id}** ${b.what}: ${b.off}`))
  return out.join('\n')
}

/** The file's text with the section's table in it. */
export function withSection(text: string, section: string, title: string, table: string): string {
  const open = `<!-- perf:${section} -->`
  const close = `<!-- /perf:${section} -->`
  const body = `${open}\n${title}\n\n${table}\n${close}`
  const from = text.indexOf(open)
  const to = text.indexOf(close)
  if (from >= 0 && to > from) return text.slice(0, from) + body + text.slice(to + close.length)
  return text.trimEnd() + '\n\n' + body + '\n'
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const take = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i < 0 ? undefined : args.splice(i, 2)[1]
  }
  const into = take('--into')
  const section = take('--section') ?? 'runs'
  if (!args.length) {
    console.error('usage: bun scripts/perf/table.ts [--into <file.md> --section <name>] <results.json> [more]')
    process.exit(2)
  }
  const runs = args.map((file) => JSON.parse(readFileSync(file, 'utf8')) as RunResults)
  const table = perfTable(runs)
  if (!into) console.log(table)
  else {
    const title = `## Timed on the pair: ${section} (runs ${runs.map((run) => `${run.id} at ${run.commit}`).join(', ')})`
    writeFileSync(into, withSection(existsSync(into) ? readFileSync(into, 'utf8') : '', section, title, table))
    console.log(`Wrote ${runs.length} run(s) into ${into}`)
  }
}
