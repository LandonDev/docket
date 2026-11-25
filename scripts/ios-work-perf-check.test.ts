// The Work performance proof's checker (scripts/lib/ios_work_perf_check.py, run by
// scripts/ios-sim-proof.sh `work_perf_set`) on hand-made reports in the shape the
// app writes (ios/TempCodeClient/Sources/TempCodeClient/Support/WorkPerfReport.swift).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const check = resolve(__dirname, 'lib', 'ios_work_perf_check.py')
const shipped = JSON.parse(readFileSync(resolve(__dirname, 'lib', 'ios_work_perf_gates.json'), 'utf8')) as Record<string, boolean>
const REST_GATES = ['rest-ticks', 'rest-queries', 'rest-polls', 'rest-cpu']
const LIST_GATES = ['list-rows-built', 'list-rows-remade', 'list-offset-writes']
const GATES = ['network-before-frame', 'rows-remade', 'first-frame', 'cached-row', 'row-hit', ...REST_GATES, ...LIST_GATES, 'editor-memory']
/** A list check that holds: 14 rows on screen, 20 built first, 26 alive at most, nothing built again or under the finger. */
const list = { rows: 1000, window: 14, firstPaintMade: 20, peakAlive: 26, madeAgain: 0, madeAgainKeys: [], stillSeconds: 6, stillMade: 0, stillPushes: 12, offsetWrites: 0, foreignMoves: 0, frames: 900, late: 3, frameP95Ms: 8.3, frameWorstMs: 25, hitchMsPerS: 1.2, mainP95Ms: 3.1, thermal: 'nominal' }
const memory = { samples: 80, peakMB: 210, lastMB: 190, webLoads: 1 }
const rest = { seconds: 10, mainCpuMs: 100, ticks: 2, ticksAllowed: 2, tickNames: ['clock'], queries: 1, queriesAllowed: 1, queryNames: ['tasks'], reads: 0 }
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Report = Record<string, unknown>

/** One launch that meets every target. */
function split(name: string): Report {
  return {
    split: name,
    counted: true,
    marks: { firstFrameMs: 180, firstRowMs: 240, cachedRowMs: name === 'empty' ? undefined : 240, rowHitMs: name === 'empty' ? undefined : 262, requestsBeforeFirstFrame: 0 },
    rowsMade: 6,
    rowsRemade: 0,
    rowsRemadeChanged: 1,
    remade: [],
    cpuMs: 410,
    seconds: 8
  }
}

/** A pass: the three splits the simulator makes. */
function good(): Record<string, Report> {
  return {
    empty: split('empty'),
    cached: split('cached'),
    restored: split('restored'),
    rest: { ...split('rest'), rest },
    'list-idle': { ...split('list'), list },
    'list-busy': { ...split('list'), list },
    editor: { ...split('open'), memory },
    webkit: { samples: 40, peakMB: 320, pids: [4001, 4002] }
  }
}

function change(name: string, patch: Report): Record<string, Report> {
  const splits = good()
  splits[name] = { ...splits[name], ...patch }
  return splits
}

function write(splits: Record<string, Report>): string {
  const dir = mkdtempSync(join(tmpdir(), 'work-perf-check-'))
  dirs.push(dir)
  const { rest, 'list-idle': idle, 'list-busy': busy, editor, webkit, ...launch } = splits
  writeFileSync(join(dir, 'launch-today.json'), JSON.stringify({ run: 'launch-today', splits: launch }))
  if (rest) writeFileSync(join(dir, 'rest-today.json'), JSON.stringify({ run: 'rest-today', splits: rest.split ? { rest } : {} }))
  for (const [name, report] of [['list-idle', idle], ['list-busy', busy]] as const) {
    if (report) writeFileSync(join(dir, `${name}.json`), JSON.stringify({ run: name, splits: { list: report } }))
  }
  if (editor) writeFileSync(join(dir, 'editor.json'), JSON.stringify({ run: 'editor', splits: { open: editor } }))
  if (webkit) writeFileSync(join(dir, 'editor-webkit.json'), JSON.stringify(webkit))
  return dir
}

function gatesFile(on: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'work-perf-gates-'))
  dirs.push(dir)
  const path = join(dir, 'gates.json')
  writeFileSync(path, JSON.stringify(Object.fromEntries(GATES.map((g) => [g, on.includes(g)]))))
  return path
}

function run(passes: Record<string, Report>[], on: string[] = GATES): { status: number | null; out: string } {
  const out = spawnSync('python3', [check, '--gates', gatesFile(on), ...passes.map(write)], { encoding: 'utf8' })
  return { status: out.status, out: out.stdout + out.stderr }
}

describe('ios_work_perf_check.py', () => {
  it('passes a clean report with every gate on, and says the locked split was not run', () => {
    const r = run([good(), good()])
    expect(r.out).toContain('ios-work-perf-check: PASS (13 gates on)')
    expect(r.out).toMatch(/ios-work-perf: list list-busy\s+1\s+14\s+20\s+26/)
    expect(r.out).toContain('locked       1  not run (the simulator cannot lock the phone)')
    expect(r.out).toMatch(/ios-work-perf: rest-today rest\s+1\s+180/)
    expect(r.status).toBe(0)
  })

  it.each([
    ['network-before-frame', 'cached', { marks: { ...(split('cached').marks as Report), requestsBeforeFirstFrame: 2 } }, 'cached: 2 requests began before the first frame'],
    ['network-before-frame', 'empty', { counted: false, marks: { firstFrameMs: 180 } }, "empty: this build does not count the socket's requests"],
    ['rows-remade', 'cached', { rowsRemade: 3, remade: ['ws-a', 'ws-b', 'chats'] }, 'the fresh list made 3 unchanged rows again (ws-a, ws-b, chats)'],
    ['rows-remade', 'cached', { rowsMade: 0 }, 'no Today row was made'],
    ['first-frame', 'cached', { marks: { ...(split('cached').marks as Report), firstFrameMs: 520 } }, 'firstFrameMs 520 ms from the process start (400)'],
    ['cached-row', 'cached', { marks: { ...(split('cached').marks as Report), cachedRowMs: 900 } }, 'cachedRowMs 900 ms'],
    ['row-hit', 'cached', { marks: { ...(split('cached').marks as Report), rowHitMs: undefined } }, 'no pass marked rowHitMs']
  ] as const)('%s fails alone when %s misses its target', (gate, name, patch, words) => {
    const bad = change(name, patch as Report)
    const r = run([bad, bad], [gate])
    expect(r.out).toContain(words)
    expect(r.status).toBe(5)
    expect(r.out).toContain(`ios-work-perf-check: FAIL ${gate}`)
    // The same reports with the gate off are reported, never judged.
    const off = run([bad, bad], [])
    expect(off.status).toBe(0)
    expect(off.out).toMatch(new RegExp(`${gate}\\s+off miss`))
  })

  it.each([
    ['rest-ticks', { ticks: 3 }, '3/2'],
    ['rest-queries', { queries: 2 }, '2/1'],
    ['rest-polls', { reads: 1 }, '1/0'],
    ['rest-cpu', { mainCpuMs: 110 }, '11/10 ms/s']
  ] as const)('%s checks each pass and reports misses while off', (gate, patch, fact) => {
    expect(run([good()], [gate]).status).toBe(0)
    const bad = change('rest', { rest: { ...rest, ...patch } })
    const on = run([good(), bad], [gate])
    expect(on.out).toContain(`pass 2: ${fact} missed the target`)
    expect(on.out).toContain(`ios-work-perf-check: FAIL ${gate}`)
    expect(on.status).toBe(5)
    const off = run([bad], [])
    expect(off.status).toBe(0)
    expect(off.out).toMatch(new RegExp(`${gate}\\s+off miss`))
  })

  it.each(REST_GATES)('%s needs a run, a split, and a rest measurement', (gate) => {
    const noRun = good()
    delete noRun.rest
    for (const missing of [noRun, change('rest', { split: undefined }), change('rest', { note: 'no window' }), change('rest', { rest: undefined })]) {
      const result = run([good(), missing], [gate])
      expect(result.status).toBe(5)
      expect(result.out).toContain('pass 2: no rest measurement')
      expect(result.out).toContain(`ios-work-perf-check: FAIL ${gate}`)
    }
  })

  it.each([
    ['list-rows-built', 'list-idle', { peakAlive: 29 }, 'pass 2 list-idle: 29 rows alive at once (28)'],
    ['list-rows-built', 'list-busy', { firstPaintMade: 1000 }, 'pass 2 list-busy: 1000 rows built before the scroll (28)'],
    ['list-rows-built', 'list-idle', { window: 0 }, 'the list showed no rows'],
    ['list-rows-remade', 'list-busy', { stillMade: 14 }, 'pass 2 list-busy: 14 rows built while the list stood still'],
    ['list-rows-remade', 'list-idle', { madeAgain: 2, madeAgainKeys: ['list-0001', 'list-0002'] }, '2 rows built again (list-0001, list-0002)'],
    ['list-rows-remade', 'list-busy', { stillPushes: 0 }, 'no push for another place arrived in the still seconds'],
    ['list-offset-writes', 'list-idle', { offsetWrites: 1 }, '1 scrolls the app made under the finger (0)'],
    ['list-offset-writes', 'list-busy', { note: 'the list did not load' }, 'pass 2 list-busy: the list did not load']
  ] as const)('%s fails when %s misses: %s', (gate, name, patch, words) => {
    const bad = good()
    bad[name] = { ...bad[name], list: { ...list, ...patch } }
    const on = run([good(), bad], [gate])
    expect(on.out).toContain(words)
    expect(on.status).toBe(5)
    expect(run([good(), bad], []).status).toBe(0)
  })

  it('needs both list runs in every pass for a list gate that is on', () => {
    const missing = good()
    delete missing['list-busy']
    const r = run([missing], ['list-offset-writes'])
    expect(r.status).toBe(5)
    expect(r.out).toContain('pass 1 list-busy: no list report')
  })

  it('reports the editor run against its ceilings and says when no editor was up', () => {
    const r = run([good()], [])
    expect(r.out).toMatch(/editor-memory\s+off PASS\s+pass 1: app 210\/300 MB, with WebKit 530\/700 MB/)
    const heavy = good()
    heavy.editor = { ...heavy.editor, memory: { ...memory, peakMB: 320, webLoads: 0 } }
    heavy.webkit = { samples: 40, peakMB: 400 }
    const on = run([heavy], ['editor-memory'])
    expect(on.status).toBe(5)
    expect(on.out).toContain('no hosted page loaded, so no editor was up')
    expect(on.out).toContain('the app peaked at 320 MB (300)')
    expect(on.out).toContain('the app and WebKit peaked at 720 MB (700)')
    const unsampled = good()
    delete unsampled.webkit
    expect(run([unsampled], ['editor-memory']).out).toContain('the WebKit processes were not sampled')
  })

  it('holds a count in every pass: one bad pass fails', () => {
    const bad = change('cached', { rowsRemade: 1, remade: ['ws-a'] })
    expect(run([good(), bad, good()], ['rows-remade']).status).toBe(5)
  })

  it('reads a time from the best pass: one slow pass fails nothing', () => {
    const slow = change('cached', { marks: { ...(split('cached').marks as Report), firstFrameMs: 900 } })
    expect(run([good(), slow], ['first-frame']).status).toBe(0)
  })

  it('fails a gate that is on when a split it reads is missing or measured nothing', () => {
    const missing = good()
    delete missing.restored
    const r = run([missing], ['network-before-frame'])
    expect(r.status).toBe(5)
    expect(r.out).toContain('restored: 0 of 1 passes measured')
    expect(r.out).toContain('restored     1  missing')
    const noted = change('cached', { note: 'the first frame never came' })
    expect(run([noted], ['rows-remade']).out).toContain('cached: 0 of 1 passes measured')
  })
})

describe('ios_work_perf_gates.json', () => {
  it('names every gate the checker judges, and gates only counts', () => {
    expect(Object.keys(shipped).sort()).toEqual([...GATES].sort())
    const source = readFileSync(check, 'utf8')
    for (const gate of GATES) expect(source, gate).toContain(`'${gate}'`)
    expect(GATES.filter((gate) => shipped[gate])).toEqual(['network-before-frame', 'rows-remade', 'rest-ticks', 'rest-queries', 'rest-polls', ...LIST_GATES])
  })
})
