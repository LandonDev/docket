import { describe, expect, it } from 'vitest'
import { sendsSummary, stallsSummary } from '../stalls-summary'
import { readStalls, stallReport } from './stall-report'

const TAIL = 'inflight=- pushes=meta:1,event:2 running=3 load=1.0 rss=400MB wsbuf=0KB lane=bulk:0/0 pool=0ms'
const LOG = [
  `2026-11-24T10:00:00.000Z loop max=183ms mean=20ms ${TAIL}`,
  `2026-11-24T10:10:00.000Z loop max=450ms mean=90ms ${TAIL}`,
  `2026-11-24T10:20:00.000Z loop max=1605ms mean=300ms ${TAIL}`,
  `2026-11-24T10:21:00.000Z timed events tail scan 88ms profile=remote ${TAIL}`,
  `2026-11-24T10:21:01.000Z timed events tail scan 112ms profile=remote ${TAIL}`,
  `2026-11-24T10:22:00.000Z timed writeThreadsIndex 380ms ${TAIL}`,
  `2026-11-24T10:30:00.000Z slow-request work.files.list 15300ms lane=normal place=vm wake=13200ms ${TAIL}`,
  `2026-11-24T10:31:00.000Z slow-request work.files.list 900ms lane=normal place=folder ${TAIL}`,
  `2026-11-24T10:32:00.000Z slow-request batch.archive 9121ms lane=interactive ${TAIL}`,
  `2026-11-24T10:40:00.000Z send session=a accepted=0 prepared=7 handle=6(cold) delivered=7 init=56 first-message=56 model=1204(hit) first-content=3000 ${TAIL}`,
  `2026-11-24T10:41:00.000Z send session=b accepted=0 prepared=1 handle=1(warm) delivered=1 init=- first-message=- model=- first-content=- ${TAIL}`,
  '2026-11-24T11:00:00.000Z work-calls work.get:800/0,work.files.list:120/3',
  '2026-11-24T12:00:00.000Z work-calls work.get:200/1',
  '2026-11-24T12:00:01.000Z [renderer] longtask 320ms switch=tab-switch:abc'
].join('\n')

describe('the stall report', () => {
  it('counts the loop, the timed sections by profile, Work calls by place, wakes, first content and the hourly shares', () => {
    const c = readStalls(LOG)
    expect(c.loop).toEqual([183, 450, 1605])
    expect(c.timed.get('events tail scan (remote)')).toEqual([88, 112])
    expect(c.timed.get('writeThreadsIndex')).toEqual([380])
    expect(c.work.get('work.files.list')).toEqual([15300, 900])
    expect(c.placed.get('work.files.list place=vm')).toEqual([15300])
    expect(c.wakes).toEqual([13200])
    expect(c.other.get('batch.archive')).toEqual([9121])
    expect([...c.first]).toEqual([['cold', [3000]]])
    expect(c.calls.get('work.get')).toEqual([1000, 1])
    expect(c.calls.get('work.files.list')).toEqual([120, 3])
  })

  it('keeps to the lines between --since and --until', () => {
    const c = readStalls(LOG, Date.parse('2026-11-24T10:15:00Z'), Date.parse('2026-11-24T10:21:30Z'))
    expect(c.loop).toEqual([1605])
    expect(c.work.size).toBe(0)
  })

  it('prints the tables, and says so when nothing is in range', () => {
    const report = stallReport(LOG)
    expect(report).toContain('| Stalls of 1 s or more | 1 |')
    expect(report).toContain('| Stalls of 400 ms or more | 2 (1.0 an hour) |')
    expect(report).toContain('| `work.files.list place=vm` | 1 | 15.3 s | 15.3 s | 15.3 s | 15.3 s |')
    expect(report).toContain("Calls that waited on the VM's door: 1; middle 13.2 s; worst 13.2 s.")
    expect(report).toContain('| `work.files.list` | 120 | 3 | 2.5% |')
    expect(stallReport(LOG, Date.parse('2027-01-01T00:00:00Z'))).toBe('No stall lines in that range.')
  })
})

it('reads both generations of stamps and prints every section in both report commands', () => {
  const rows = [
    'boot listening ms=10',
    'boot hello-ready ms=11',
    'boot resumed-first ms=30',
    'boot resumed n=4 ms=40',
    'send session=a handle=1(live boot=focus) delivered=9(mcp=800) first-content=0',
    'send session=b handle=2(warm) handle-wait=22 queue=24000 mcp=1700 mcp.source=codex-gate mcp.servers=linear:1650,app:120 gateway-dispatch=1710 first-byte=2000 first-row=2111 first-content=2100',
    'send session=c handle=8(cold) mcp=1700 mcp.servers=linear:1700,app%20two:135 first-content=2111',
    'gateway n=6 out.p50=1 out.p95=5 out.max=8 byte.p50=2 byte.p95=6 byte.max=9',
    'flush n=2 rows=19 ser.p95=1 write.p95=2 commit.p95=3 max=6',
    'timed event flush 201ms ser=1 write=25 commit=176',
    '[renderer] first-paint session=s1 host=box ms=254 why=reconnect queued=5 fetch=82 fold=116 text=40',
    '[renderer] first-paint session=s2 ms=300',
    '[renderer] first-paint-hist n=12 p50=10 p90=22 p95=25 max=30 open=9 restore=2 reconnect=1',
    '[renderer] longtask 300ms cause=push:events',
    '[renderer] longtask 320ms switch=tab-switch:abc',
    '[renderer] board-paint session=s1 ms=46 answer=40 render=6',
    '[renderer] board-paint session=s2 ms=50',
    ...Array.from({ length: 10 }, (_, i) => `slow-request method.${i} 540ms`)
  ].map((line) => `2026-11-24T12:00:00.000Z ${line}`).join('\n')
  const c = readStalls(rows)
  expect(c.boot.map((s) => s.fields.stage)).toEqual(['listening', 'hello-ready', 'resumed-first', 'resumed'])
  expect(c.first.get('live')).toEqual([0])
  expect(c.send.get('warm queue')).toEqual([24000])
  expect(c.mcpServers.get('linear')).toEqual([1650, 1700])
  expect(c.mcpServers.has('app two')).toBe(true)
  expect(c.gateway[0].fields['byte.p95']).toBe('6')
  expect(c.flush[0].fields.rows).toBe('19')
  expect(c.slowFlush.get('event flush commit')).toEqual([176])
  expect(c.firstPaint.map((s) => s.fields.why)).toEqual(['reconnect', undefined])
  expect(c.paintHist[0].fields.open).toBe('9')
  expect(c.longtask.get('unreported')).toEqual([320])
  expect(c.longtask.get('push:events')).toEqual([300])
  expect(c.boardPaint.get('board paint ms')).toEqual([46, 50])
  expect(c.boardPaint.get('board paint answer')).toEqual([40])
  expect(c.other.size).toBe(10)
  for (const out of [stallReport(rows), stallsSummary(rows)]) {
    for (const heading of [
      'Boot and resume', 'Send stamps by handle', 'MCP startup by server', 'Gateway windows', 'Slow event flush phases',
      'Event flush windows', 'Renderer slow first paints', 'Renderer first-paint windows', 'Renderer long tasks by cause', 'Renderer board paint phases'
    ]) expect(out).toContain(heading)
    expect(out).toContain('method.9')
    expect(out).toContain('| \`linear\` | 2 | 1.65 s | 1.70 s |')
  }
  expect(sendsSummary(rows)).toContain('MCP startup by server')
})
