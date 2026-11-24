/** The reconnect fixture and measurements shared by the synthetic host and the runner. */
import type { AgentEvent } from '../../src/shared/events'
import type { SoakProfile } from './soakLoad'

export const RECONNECT_CUT_MS = 6_000
export const RECONNECT_WINDOW_MS = 20_000
export const RECONNECT_TIMEOUT_MS = 45_000

export const RECONNECT_PROFILE: SoakProfile = {
  children: 6,
  focused: 0,
  streamers: [1, 2],
  streams: [
    { kind: 'tool', child: 0, perSecond: 11, phase: 0 },
    { kind: 'tool', child: 1, perSecond: 11, phase: 0 },
    { kind: 'tool', child: 2, perSecond: 4, phase: 0 }
  ]
}

const source = (n: number, lines: number): string =>
  Array.from({ length: lines }, (_, i) => `export const billingRule${n}_${i} = (row: Row) => quote(row.cells[${i}] ?? '')`).join('\n')

/** Stay below the body omission threshold so each Read result and its markdown reach the window. */
type ToolRows = [
  Extract<AgentEvent, { type: 'assistant-text' }>,
  Extract<AgentEvent, { type: 'tool-call' }>,
  Extract<AgentEvent, { type: 'tool-result' }>
]

export function reconnectToolRows(key: string, n: number, rich: boolean): ToolRows {
  const callId = `${key}-read`
  const text = rich
    ? `### Export rule ${n}\n\nThe export reads \`row.cells\` and quotes empty cells.\n\n` +
      Array.from({ length: 8 }, (_, i) =>
        `#### Check ${i + 1}\n\n| Cell | Expected |\n| --- | --- |\n| Empty | Quoted |\n| Number | Unchanged |\n\n` +
        '- Keep the existing trim rule.\n- Check the blue, green, and red columns.\n\n' +
        '```ts\n' + source(n + i, 6) + '\n```\n\n'
      ).join('')
    : `Adjusted export rule ${n} to quote empty cells. **Checked** the header and the first data row.\n\n- Keep the trim rule.\n- Test the quoted column.`
  return [
    { type: 'assistant-text', text, delta: false, msgId: `${key}-text`, blockIndex: 0 },
    { type: 'tool-call', callId, name: 'Read', input: { file_path: `src/billing/rule${n}.ts` } },
    { type: 'tool-result', callId, output: source(n, rich ? 24 : 9), isError: false }
  ]
}

/**
 * Stream one markdown response, then finish it and run a Read. The
 * persisted deltas push the resume row budget without making twenty
 * unrelated markdown blocks per second during normal streaming.
 */
export function reconnectLiveRows(id: string, n: number): AgentEvent[] {
  const perMessage = 8
  const message = Math.floor(n / perMessage)
  const [text, call, result] = reconnectToolRows(`${id}-live-${message}`, message, true)
  const part = n % perMessage
  if (part === perMessage - 1) return [text, call, result]
  return Array.from({ length: 3 }, (_, i) => {
    const chunk = part * 3 + i
    const size = text.text.length / ((perMessage - 1) * 3)
    return { ...text, delta: true, text: text.text.slice(Math.floor(chunk * size), Math.floor((chunk + 1) * size)) }
  })
}

export function* reconnectHistory(id: string): Generator<AgentEvent> {
  for (let turn = 0; turn < 4_100; turn++) {
    yield { type: 'user-text', text: `Check billing export rule ${turn} and show what changed.` }
    yield* reconnectToolRows(`${id}-history-${turn}`, turn, false)
    yield { type: 'turn-complete' }
  }
  // Recent turns carry denser outputs, near the remote tail's byte budget.
  for (let turn = 0; turn < 10; turn++) {
    yield { type: 'user-text', text: `Review each of the export checks in group ${turn}.` }
    for (let i = 0; i < 12; i++) yield* reconnectToolRows(`${id}-recent-${turn}-${i}`, i, true)
    yield { type: 'turn-complete' }
  }
}

export type ReconnectPhase = 'cut' | 'relaunch'
export type Cursors = Record<string, number>
export type ReconnectTask = { at: number; ms: number }

export interface ReconnectWire {
  phase: ReconnectPhase
  start: number
  end: number
  connectedAt: number | null
  connections: number
  refusedUpgrades: number
  remote: boolean
  bytes: { events: number; pushes: number; other: number }
  socketBytes: number
  maxUnsentBytes: number
  answers: { events: number; queue: number; resets: number; gaps: number; tails: number }
  before: Cursors
  through: Cursors
  connected: Cursors
}

export function reconnectTasks(tasks: readonly ReconnectTask[], start: number, end: number) {
  const window = tasks.filter((task) => task.at >= start && task.at < end)
  return {
    tasks: window,
    stats: {
      count: window.length,
      maxMs: Math.max(0, ...window.map((task) => task.ms)),
      sumMs: window.reduce((sum, task) => sum + task.ms, 0),
      over100: window.filter((task) => task.ms > 100).length
    }
  }
}

/** Compare the exact subsequence the host appended while the window was away. */
export function reconnectRows(before: Cursors, through: Cursors, seen: Record<string, number[]>) {
  let expected = 0
  let observed = 0
  let exact = true
  for (const [id, first] of Object.entries(before)) {
    const count = through[id]! - first
    const rows = seen[id] ?? []
    expected += count
    observed += rows.length
    exact &&= count === rows.length && rows.every((seq, i) => seq === first + i + 1)
  }
  return { expected, observed, exact }
}
