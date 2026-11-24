import { describe, expect, it } from 'vitest'
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
