/**
 * A host's stall log as the Work baseline's table (`.temp-code/plans/perf/BASELINE.md` section 3). Read only: it
 * opens the files it is given and prints. "Before" and "after" on the live box is this command run once before a
 * deploy and once after, each over its own hours:
 *
 *   bun scripts/perf/stall-report.ts [--since <ISO time>] [--until <ISO time>] <stalls.log> [more files]
 *
 * The log keeps only the slow tail (a request of 500 ms or more, a loop stall of 150 ms or more, a section of 50 ms
 * or more), so every count here is of slow things. The hourly `work-calls` lines are the one place that also counts
 * the quick calls: the last table gives each `work.*` method's share that was slow.
 */
import { readFileSync } from 'node:fs'

type Times = number[]
const sorted = (values: Times): Times => [...values].sort((a, b) => a - b)
const at = (values: Times, q: number): number => sorted(values)[Math.max(0, Math.ceil(values.length * q) - 1)] ?? 0
const worst = (values: Times): number => values.reduce((a, b) => Math.max(a, b), 0)
const sum = (values: Times): number => values.reduce((a, b) => a + b, 0)
const ms = (value: number): string => (value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`)
const push = (map: Map<string, Times>, key: string, value: number): void => void (map.get(key)?.push(value) ?? map.set(key, [value]))
const byCount = (a: [string, Times], b: [string, Times]): number => b[1].length - a[1].length || a[0].localeCompare(b[0])

export interface StallCounts {
  from: number
  to: number
  loop: Times
  timed: Map<string, Times>
  /** `work.*` slow requests, by method, and by method and place where the line names one */
  work: Map<string, Times>
  placed: Map<string, Times>
  /** the door waits a `wake=` word named */
  wakes: Times
  other: Map<string, Times>
  /** a new thread's send to first content, by how its handle came (`cold`, `warm`, `live`) */
  first: Map<string, Times>
  /** method → [calls, slow] summed over the hourly lines */
  calls: Map<string, [number, number]>
}

/** Reads the lines between two times (either may be left out). */
export function readStalls(text: string, since = -Infinity, until = Infinity): StallCounts {
  const counts: StallCounts = { from: Infinity, to: -Infinity, loop: [], timed: new Map(), work: new Map(), placed: new Map(), wakes: [], other: new Map(), first: new Map(), calls: new Map() }
  for (const line of text.split(/\r?\n/)) {
    const stamp = line.match(/^(\S+) (\S+) /)
    if (!stamp) continue
    const when = Date.parse(stamp[1]!)
    if (!Number.isFinite(when) || when < since || when > until) continue
    counts.from = Math.min(counts.from, when)
    counts.to = Math.max(counts.to, when)
    const kind = stamp[2]
    if (kind === 'loop') {
      const max = line.match(/ loop max=([\d.]+)ms/)
      if (max) counts.loop.push(Number(max[1]))
    } else if (kind === 'timed') {
      // The label may be several words: everything up to the time.
      const section = line.match(/ timed (.+?) ([\d.]+)ms(?: |$)/)
      if (!section) continue
      const profile = line.match(/ profile=(\S+)/)?.[1]
      push(counts.timed, section[1]! + (profile ? ` (${profile})` : ''), Number(section[2]))
    } else if (kind === 'slow-request') {
      const request = line.match(/ slow-request (\S+) ([\d.]+)ms/)
      if (!request) continue
      const [, method, took] = request as unknown as [string, string, string]
      if (!method.startsWith('work.')) {
        push(counts.other, method, Number(took))
        continue
      }
      push(counts.work, method, Number(took))
      const place = line.match(/ place=(\S+)/)?.[1]
      if (place) push(counts.placed, `${method} place=${place}`, Number(took))
      const wake = line.match(/ wake=(\d+)ms/)?.[1]
      if (wake) counts.wakes.push(Number(wake))
    } else if (kind === 'send') {
      const content = line.match(/ first-content=(\d+)/)?.[1]
      const handle = line.match(/ handle=\d+\((\w+)\)/)?.[1]
      if (content && handle) push(counts.first, handle, Number(content))
    } else if (kind === 'work-calls') {
      for (const part of line.slice(line.indexOf('work-calls ') + 11).split(',')) {
        const call = part.match(/^(work\.[\w.]+):(\d+)\/(\d+)$/)
        if (!call) continue
        const row = counts.calls.get(call[1]!) ?? [0, 0]
        row[0] += Number(call[2])
        row[1] += Number(call[3])
        counts.calls.set(call[1]!, row)
      }
    }
  }
  return counts
}

const row = (cells: (string | number)[]): string => `| ${cells.join(' | ')} |`

/** The report as markdown: the tables BASELINE.md section 3 keeps. */
export function stallReport(text: string, since?: number, until?: number): string {
  const c = readStalls(text, since, until)
  if (!Number.isFinite(c.from)) return 'No stall lines in that range.'
  const hours = Math.max((c.to - c.from) / 3_600_000, 1 / 60)
  const out: string[] = [
    `Stall log ${new Date(c.from).toISOString()} to ${new Date(c.to).toISOString()} (${hours.toFixed(1)} h). Only slow things are logged.`,
    '',
    row(['The loop', 'Number']),
    row(['---', '---']),
    row(['Stalls logged (150 ms or more)', `${c.loop.length}; middle ${ms(at(c.loop, 0.5))}; worst ${ms(worst(c.loop))}`]),
    row(['Stalls of 400 ms or more', `${c.loop.filter((v) => v >= 400).length} (${(c.loop.filter((v) => v >= 400).length / hours).toFixed(1)} an hour)`]),
    row(['Stalls of 1 s or more', String(c.loop.filter((v) => v >= 1000).length)]),
    ''
  ]
  const table = (head: string, rows: [string, Times][]): void => {
    if (!rows.length) return
    out.push(row([head, 'Count', 'Middle', 'p95', 'Worst', 'In all']), row(['---', '---', '---', '---', '---', '---']))
    for (const [name, times] of rows) out.push(row([`\`${name}\``, times.length, ms(at(times, 0.5)), ms(at(times, 0.95)), ms(worst(times)), ms(sum(times))]))
    out.push('')
  }
  table('On the loop (50 ms or more)', [...c.timed].sort(byCount))
  table('Slow Work calls', [...c.work].sort(byCount))
  table('Slow Files calls by place', [...c.placed].sort(byCount))
  if (c.wakes.length) out.push(`Calls that waited on the VM's door: ${c.wakes.length}; middle ${ms(at(c.wakes, 0.5))}; worst ${ms(worst(c.wakes))}.`, '')
  table("A new thread's send to first content, by handle", [...c.first].sort(byCount))
  table("Not Work's, in the same log", [...c.other].sort((a, b) => sum(b[1]) - sum(a[1])).slice(0, 8))
  if (c.calls.size) {
    out.push(row(['Every Work call (hourly counts)', 'Calls', 'Slow', 'Share slow']), row(['---', '---', '---', '---']))
    for (const [method, [calls, slow]] of [...c.calls].sort((a, b) => b[1][0] - a[1][0] || a[0].localeCompare(b[0]))) {
      out.push(row([`\`${method}\``, calls, slow, calls ? `${((slow / calls) * 100).toFixed(1)}%` : '-']))
    }
    out.push('')
  }
  return out.join('\n').trimEnd()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string): number | undefined => {
    const i = args.indexOf(name)
    if (i < 0) return undefined
    const [, value] = args.splice(i, 2)
    const when = Date.parse(value ?? '')
    if (!Number.isFinite(when)) throw new Error(`${name} needs an ISO time`)
    return when
  }
  const since = flag('--since')
  const until = flag('--until')
  if (!args.length) {
    console.error('usage: bun scripts/perf/stall-report.ts [--since <ISO>] [--until <ISO>] <stalls.log> [more files]')
    process.exit(2)
  }
  console.log(stallReport(args.map((file) => readFileSync(file, 'utf8')).join('\n'), since, until))
}
