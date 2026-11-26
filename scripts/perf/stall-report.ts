/**
 * A host's stall log as the Work baseline's table (`.temp-code/plans/perf/BASELINE.md` section 3). Read only: it
 * opens the files it is given and prints. "Before" and "after" on the live box is this command run once before a
 * deploy and once after, each over its own hours:
 *
 *   bun scripts/perf/stall-report.ts [--since <ISO time>] [--until <ISO time>] <stalls.log> [more files]
 *
 * Slow requests, loop stalls, and timed sections describe the logged tail. Send and boot stamps and the
 * hourly counters describe all observations those recorders captured.
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

const SEND_KEYS = ['queue', 'handle', 'handle-wait', 'gateway-dispatch', 'first-byte', 'first-row'] as const
const GATEWAY_KEYS = ['n', 'out.p50', 'out.p95', 'out.max', 'byte.p50', 'byte.p95', 'byte.max', 'byte.n']
const FLUSH_KEYS = ['n', 'rows', 'ser.p95', 'write.p95', 'commit.p95', 'max']
const PAINT_HIST_KEYS = ['n', 'p50', 'p90', 'p95', 'max', 'open', 'restore', 'reconnect']

interface Stamp {
  when: string
  fields: Record<string, string>
}

function fieldsOf(body: string): Record<string, string> {
  return Object.fromEntries([...body.matchAll(/(?:^|\s)([\w.-]+)=([^\s(]+)(?:\([^)]*\))?/g)].map(([, key, value]) => [key, value]))
}

function fieldNumber(value: string | undefined): number | undefined {
  if (value !== undefined && /^\d+(?:\.\d+)?$/.test(value)) return Number(value)
}

function addFields(times: Map<string, Times>, label: string, fields: Stamp['fields'], keys: readonly string[]): void {
  for (const key of keys) {
    const value = fieldNumber(fields[key])
    if (value !== undefined) push(times, `${label} ${key}`, value)
  }
}

function serverName(encoded: string): string {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

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
  boot: Stamp[]
  send: Map<string, Times>
  mcpServers: Map<string, Times>
  gateway: Stamp[]
  flush: Stamp[]
  slowFlush: Map<string, Times>
  firstPaint: Stamp[]
  paintHist: Stamp[]
  longtask: Map<string, Times>
  boardPaint: Map<string, Times>
}

/** Reads the lines between two times (either may be left out). */
export function readStalls(text: string, since = -Infinity, until = Infinity): StallCounts {
  const counts: StallCounts = {
    from: Infinity, to: -Infinity, loop: [], timed: new Map(), work: new Map(), placed: new Map(), wakes: [],
    other: new Map(), first: new Map(), calls: new Map(), boot: [], send: new Map(), mcpServers: new Map(),
    gateway: [], flush: [], slowFlush: new Map(), firstPaint: [], paintHist: [], longtask: new Map(), boardPaint: new Map()
  }
  for (const line of text.split(/\r?\n/)) {
    const stamp = line.match(/^(\S+) (\S+) /)
    if (!stamp) continue
    const when = Date.parse(stamp[1]!)
    if (!Number.isFinite(when) || when < since || when > until) continue
    counts.from = Math.min(counts.from, when)
    counts.to = Math.max(counts.to, when)
    const kind = stamp[2]
    const body = line.slice(stamp[0].length)
    if (kind === 'loop') {
      const max = line.match(/ loop max=([\d.]+)ms/)
      if (max) counts.loop.push(Number(max[1]))
    } else if (kind === 'timed') {
      // The label may be several words: everything up to the time.
      const section = line.match(/ timed (.+?) ([\d.]+)ms(?: |$)/)
      if (!section) continue
      const profile = line.match(/ profile=(\S+)/)?.[1]
      push(counts.timed, section[1]! + (profile ? ` (${profile})` : ''), Number(section[2]))
      if (section[1] === 'event flush') addFields(counts.slowFlush, 'event flush', fieldsOf(body), ['ser', 'write', 'commit'])
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
      const fields = fieldsOf(body)
      const handle = body.match(/(?:^| )handle=\d+\((live|warm|cold)(?:[ )])/)?.[1]
      const content = fieldNumber(fields['first-content'])
      if (content !== undefined && handle) push(counts.first, handle, content)
      const kind = handle ?? 'unclassified'
      addFields(counts.send, kind, fields, SEND_KEYS)
      if ((fieldNumber(fields.queue) ?? 0) > 0) push(counts.send, `${kind} queue (parked)`, Number(fields.queue))
      const mcp = fieldNumber(fields.mcp)
      // Older Codex lines combined the MCP gate and the model-list wait.
      const legacy = body.match(/(?:^| )delivered=\d+\(mcp=(\d+)\)/)?.[1]
      if (mcp !== undefined) push(counts.send, `${kind} mcp (${fields['mcp.source'] ?? 'source unreported'})`, mcp)
      else if (legacy && fields.mcp === undefined) push(counts.send, `${kind} mcp (legacy combined wait)`, Number(legacy))
      for (const pair of fields['mcp.servers']?.split(',') ?? []) {
        const server = pair.match(/^(.+):(\d+(?:\.\d+)?)$/)
        if (server) push(counts.mcpServers, serverName(server[1]!), Number(server[2]))
      }
    } else if (kind === 'boot') {
      const stage = body.split(' ', 1)[0]!
      if (['listening', 'hello-ready', 'resumed-first', 'resumed'].includes(stage))
        counts.boot.push({ when: stamp[1]!, fields: { ...fieldsOf(body), stage } })
    } else if (kind === 'gateway' || kind === 'flush') {
      const series = kind === 'gateway' ? counts.gateway : counts.flush
      series.push({ when: stamp[1]!, fields: fieldsOf(body) })
    } else if (kind === '[renderer]') {
      const [stage] = body.split(' ', 1)
      const fields = fieldsOf(body)
      if (stage === 'first-paint') counts.firstPaint.push({ when: stamp[1]!, fields })
      else if (stage === 'first-paint-hist') counts.paintHist.push({ when: stamp[1]!, fields })
      else if (stage === 'longtask') {
        const time = body.match(/^longtask ([\d.]+)ms(?: |$)/)
        if (time) push(counts.longtask, fields.cause ?? 'unreported', Number(time[1]))
      } else if (stage === 'board-paint') {
        addFields(counts.boardPaint, 'board paint', fields, ['ms', 'answer', 'render'])
      }
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

function timeTable(head: string, rows: [string, Times][]): string[] {
  if (!rows.length) return []
  return [
    row([head, 'Count', 'Middle', 'p95', 'Worst', 'In all']),
    row(['---', '---', '---', '---', '---', '---']),
    ...rows.map(([name, times]) => row([
      `\`${name.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ')}\``, times.length, ms(at(times, 0.5)), ms(at(times, 0.95)), ms(worst(times)), ms(sum(times))
    ])),
    ''
  ]
}

function stampTable(title: string, stamps: Stamp[], keys: string[]): string[] {
  if (!stamps.length) return []
  return [
    `### ${title}`,
    '',
    row(['Time (UTC)', ...keys]),
    row(['---', ...keys.map(() => '---')]),
    ...stamps.map(({ when, fields }) => row([when, ...keys.map((key) => (fields[key] ?? '-').replace(/\|/g, '\\|'))])),
    ''
  ]
}

export function sendStampTables(c: StallCounts): string[] {
  return [
    ...timeTable('Send stamps by handle', [...c.send].sort(([a], [b]) => a.localeCompare(b))),
    ...timeTable('MCP startup by server', [...c.mcpServers].sort(byCount))
  ]
}

export function stampTables(c: StallCounts): string[] {
  return [
    ...stampTable('Boot and resume', c.boot, ['stage', 'n', 'ms']),
    ...sendStampTables(c),
    ...stampTable('Gateway windows', c.gateway, GATEWAY_KEYS),
    ...timeTable('Slow event flush phases', [...c.slowFlush]),
    ...stampTable('Event flush windows', c.flush, FLUSH_KEYS),
    ...stampTable('Renderer slow first paints', c.firstPaint, ['session', 'host', 'why', 'ms', 'queued', 'fetch', 'fold', 'text']),
    ...stampTable('Renderer first-paint windows', c.paintHist, PAINT_HIST_KEYS),
    ...timeTable('Renderer long tasks by cause', [...c.longtask].sort(byCount)),
    ...timeTable('Renderer board paint phases', [...c.boardPaint])
  ]
}

/** The report as markdown: the tables BASELINE.md section 3 keeps. */
export function stallReport(text: string, since?: number, until?: number): string {
  const c = readStalls(text, since, until)
  if (!Number.isFinite(c.from)) return 'No stall lines in that range.'
  const hours = Math.max((c.to - c.from) / 3_600_000, 1 / 60)
  const out: string[] = [
    `Stall log ${new Date(c.from).toISOString()} to ${new Date(c.to).toISOString()} (${hours.toFixed(1)} h).`,
    '',
    row(['The loop', 'Number']),
    row(['---', '---']),
    row(['Stalls logged (150 ms or more)', `${c.loop.length}; middle ${ms(at(c.loop, 0.5))}; worst ${ms(worst(c.loop))}`]),
    row(['Stalls of 400 ms or more', `${c.loop.filter((v) => v >= 400).length} (${(c.loop.filter((v) => v >= 400).length / hours).toFixed(1)} an hour)`]),
    row(['Stalls of 1 s or more', String(c.loop.filter((v) => v >= 1000).length)]),
    ''
  ]
  const table = (head: string, rows: [string, Times][]): void => { out.push(...timeTable(head, rows)) }
  table('On the loop (50 ms or more)', [...c.timed].sort(byCount))
  table('Slow Work calls', [...c.work].sort(byCount))
  table('Slow Files calls by place', [...c.placed].sort(byCount))
  if (c.wakes.length) out.push(`Calls that waited on the VM's door: ${c.wakes.length}; middle ${ms(at(c.wakes, 0.5))}; worst ${ms(worst(c.wakes))}.`, '')
  table("A new thread's send to first content, by handle", [...c.first].sort(byCount))
  table('Other slow requests', [...c.other].sort(byCount))
  out.push(...stampTables(c))
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
