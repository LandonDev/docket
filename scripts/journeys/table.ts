import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainCheckout, type JourneyResult, type Results } from './lib/record'
import { SHAPES } from './lib/shape'

const HEADER = '| Journey | Shape | Result | Fix |'
const cell = (text: string): string => text.replace(/\|/g, '&#124;').replace(/\s+/g, ' ').trim()

function rowOf(result: JourneyResult): string[] {
  const failure = result.steps.find((step) => step.error)
  return [
    result.id,
    result.shape,
    result.notRun ? `not run: ${result.notRun}` : failure ? `FAIL · ${cell(failure.name)}` : 'PASS',
    ''
  ]
}

export function updateJourneysTable(markdown: string, results: Results): string {
  if (!results.journeys.length) return markdown
  const lines = markdown.split('\n')
  const heading = lines.indexOf('## Journeys')
  const next = lines.findIndex((line, i) => i > heading && /^## /.test(line))
  const header = lines.findIndex((line, i) => i > heading && (next < 0 || i < next) && line.trim() === HEADER)
  if (heading < 0 || header < 0) throw new Error('POLISH-work.md has no Journeys table')
  const rows = new Map<string, string[]>()
  const key = (id: string, shape: string): string => `${id.match(/\bJ\d+\b/)?.[0] ?? id} ${shape}`
  let end = header + 2
  for (; lines[end]?.trim().startsWith('|'); end++) {
    const row = lines[end]!.trim().slice(1, -1).split(/(?<!\\)\|/).map((value) => value.trim())
    rows.set(key(row[0]!, row[1]!), row)
  }
  for (const journey of results.journeys) {
    const row = rowOf(journey)
    const k = key(journey.id, journey.shape)
    const old = rows.get(k)
    if (old) row[3] = old[3] ?? ''
    rows.set(k, row)
  }
  const ordered = [...rows].sort(([a, [, sa]], [b, [, sb]]) =>
    a.split(' ')[0]!.localeCompare(b.split(' ')[0]!) || SHAPES.findIndex((s) => s === sa) - SHAPES.findIndex((s) => s === sb))
  lines.splice(header + 2, end - header - 2, ...ordered.map(([, row]) => `| ${row.join(' | ')} |`))
  return lines.join('\n').replace(
    'Written by `scripts/journeys/table.ts` once the harness stands. None run yet.',
    'The journeys runner updates this table after each run.'
  )
}

export function writeJourneysTable(file: string, results: Results): void {
  const markdown = readFileSync(file, 'utf8')
  const updated = updateJourneysTable(markdown, results)
  if (updated === markdown) return
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, updated)
  renameSync(temp, file)
}

if (import.meta.main) {
  const resultsFile = process.argv[2]
  if (!resultsFile) throw new Error('Usage: bun scripts/journeys/table.ts <results.json>')
  const repo = join(import.meta.dir, '../..')
  writeJourneysTable(join(mainCheckout(repo), '.temp-code/plans/landed/POLISH-work.md'), JSON.parse(readFileSync(resultsFile, 'utf8')) as Results)
}
