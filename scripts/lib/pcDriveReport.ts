/**
 * The PC drive bench's readable record (scripts/bench-pc-drive.ts): one table of the steps in the two windows, one of
 * the calls straight to each host, and per step a line of where its time went (its calls by name, the link's round
 * trips and bytes, the hosts' own slow lines).
 */
import { callLine, median, sumCalls, type WindowTake } from './pcDriveProbe'

export interface ReportTake {
  window: 'pc' | 'mac'
  step: string
  run: number
  ms: number | null
  marks: Record<string, number | null>
  failed: string | null
  link: { up: number; down: number; turns: number }
  take: WindowTake
  stalls: { pc: string[]; box: string[] }
  note?: string
}
export interface ReportRpc {
  host: 'pc' | 'box'
  call: string
  ms: number | null
  failed: string | null
  answer: string
  link: { up: number; down: number; turns: number }
  stalls: string[]
}
export interface ReportInput {
  label: string
  version: string
  installer: string
  tree: string
  shape: { delayMs: number; rateMbit: number }
  runs: number
  startedAt: string
  minutes: number
  takes: ReportTake[]
  rpcs: ReportRpc[]
  /** the PC's own environment for the run, and what its doctor.get said of its folder reader */
  pcEnv?: Record<string, string>
  folderReader?: unknown
}

const sec = (ms: number | null | undefined): string => (ms == null || !Number.isFinite(ms) ? '—' : `${(ms / 1000).toFixed(1)}`)
const mb = (bytes: number): string => (bytes / 2 ** 20).toFixed(1)
const WIN = { pc: "PC's window", mac: "Mac's window (via the box)" }

/** The takes of one step in one window, in the order they ran. */
export function groups(takes: ReportTake[]): ReportTake[][] {
  const by = new Map<string, ReportTake[]>()
  for (const t of takes) {
    const key = `${t.window}\u0000${t.step}`
    by.set(key, [...(by.get(key) ?? []), t])
  }
  return [...by.values()]
}

/** The median of the runs that finished; "never (n of m)" when some did not. */
export function medianCell(ts: ReportTake[]): string {
  const done = ts.filter((t) => t.ms !== null).map((t) => t.ms!)
  if (!done.length) return `never (0 of ${ts.length})`
  const m = sec(median(done))
  return done.length === ts.length ? m : `${m} (${done.length} of ${ts.length})`
}

const marksCell = (ts: ReportTake[]): string => {
  const keys = [...new Set(ts.flatMap((t) => Object.keys(t.marks)))]
  return keys.map((k) => `${k} ${sec(median(ts.map((t) => t.marks[k] ?? NaN)))}`).join(', ')
}

export function report(r: ReportInput): string {
  const out: string[] = []
  out.push(`# PC drive bench: ${r.label}`)
  out.push('')
  out.push(`TempCode ${r.version} (${r.installer.split('/').pop()}), stand-ins from ${r.tree}. J: an SMB share on the box through a slow link: ${r.shape.delayMs} ms each way (${r.shape.delayMs * 2} ms round trip), ${r.shape.rateMbit} Mbit/s each way. ${r.runs} run(s) per step, every step cold (the PC's TempCode restarted, 12 s for Windows' SMB caches, the window reloaded). Started ${r.startedAt}, ${r.minutes} minutes. Times in seconds; "—" never came.`)
  out.push('')
  if (r.pcEnv && Object.keys(r.pcEnv).length) out.push(`The PC's TempCode ran with ${Object.entries(r.pcEnv).map(([k, v]) => `\`${k}=${v}\``).join(', ')}.`)
  if (r.folderReader !== undefined) out.push(`The PC's \`doctor.get\` folderReader: \`${JSON.stringify(r.folderReader)}\`.`)
  if ((r.pcEnv && Object.keys(r.pcEnv).length) || r.folderReader !== undefined) out.push('')
  out.push('| Step | Window | Median s | Marks (median s) | Calls | Round trips | MB moved (down/up) | Longest frame gap ms |')
  out.push('|---|---|---|---|---|---|---|---|')
  for (const ts of groups(r.takes)) {
    const t = ts[0]!
    const calls = median(ts.map((x) => x.take.calls.length))
    const turns = median(ts.map((x) => x.link.turns))
    const down = median(ts.map((x) => x.link.down))
    const up = median(ts.map((x) => x.link.up))
    const gap = Math.max(...ts.map((x) => x.take.gap))
    out.push(`| ${t.step} | ${WIN[t.window]} | ${medianCell(ts)} | ${marksCell(ts)} | ${calls} | ${turns} | ${mb(down)} / ${mb(up)} | ${gap} |`)
  }
  out.push('')
  out.push('## The calls alone, straight to each host')
  out.push('')
  out.push('| Host | Call | s | Answer | Round trips | MB down | Host lines |')
  out.push('|---|---|---|---|---|---|---|')
  for (const c of r.rpcs) out.push(`| ${c.host === 'pc' ? 'PC' : 'box'} | ${c.call} | ${c.ms === null ? `failed: ${c.failed}` : sec(c.ms)} | ${c.answer} | ${c.link.turns} | ${mb(c.link.down)} | ${c.stalls.slice(0, 2).join('; ').replace(/\|/g, '/')} |`)
  out.push('')
  out.push('## Per step: the calls, the link, the hosts')
  out.push('')
  for (const ts of groups(r.takes)) {
    const t = ts[0]!
    out.push(`**${t.step}, ${WIN[t.window]}**`)
    for (const x of ts) {
      const sums = sumCalls(x.take.calls)
      out.push(`- run ${x.run}: ${x.ms === null ? `never${x.failed ? ` (${x.failed})` : ''}` : `${sec(x.ms)} s`}; ${x.take.calls.length} calls: ${callLine(x.take.calls, 5) || 'none'}; link ${x.link.turns} round trips, ${mb(x.link.down)} MB down, ${mb(x.link.up)} MB up; frame gap ${x.take.gap} ms, longest task ${x.take.task} ms${sums.some((s) => s.pending) ? '; some calls still unanswered at the step\'s end' : ''}`)
      const bare = (l: string): string => l.replace(/^\S+ /, '').replace(/\|/g, '/')
      const hostLines = [...x.stalls.pc.map((l) => `PC ${bare(l)}`), ...x.stalls.box.map((l) => `box ${bare(l)}`)]
      if (hostLines.length) out.push(`  - host lines: ${hostLines.slice(0, 6).join('; ')}${hostLines.length > 6 ? `; … ${hostLines.length - 6} more` : ''}`)
    }
  }
  return out.join('\n') + '\n'
}
