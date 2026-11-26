import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKPRESSURE_BYTES,
  countPush,
  countWorkCall,
  isSlowRequest,
  LONG_POLL_GRACE_MS,
  LONG_POLL_MS,
  noteRequest,
  requestNotesField,
  SLOW_REQUEST_MS,
  SLOW_WORK_MS,
  withRequestNotes,
  workCallsLine,
  currentLag,
  flushStallLog,
  DEFAULT_IDLE_MAX_WAIT_MS,
  DEFAULT_IDLE_THRESHOLD_MS,
  inFlightRequests,
  loopLine,
  recordBackpressure,
  pushesField,
  recordCheckpoint,
  recordSlowFlush,
  recordGatewayTimings,
  recordSendSpan,
  recordSlowRequest,
  reportRendererStall,
  resetPushesForTests,
  setBufferedBytes,
  setLaneStats,
  setRunningCount,
  setStallLog,
  setLagForTests,
  startStallMonitor,
  STALL_MS,
  timed,
  TIMED_MS,
  trackRequest,
  untrackRequest,
  untilLoopIdle,
  whenLoopIdle,
  yieldUntilIdle
} from './stalls'

let dir: string
const log = async (): Promise<string> => {
  await flushStallLog()
  return readFileSync(join(dir, 'stalls.log'), 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stalls-'))
  setStallLog(dir)
  setRunningCount(() => 3)
})

afterEach(async () => {
  vi.useRealTimers()
  await flushStallLog()
  setLagForTests(null)
  setStallLog(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('loop lag', () => {
  it('returns zeros without a monitor', () => {
    expect(currentLag()).toEqual({ meanMs: 0, maxMs: 0, ewmaMs: 0 })
  })

  it('reports a busy section in the last second', async () => {
    const stop = startStallMonitor()
    try {
      await new Promise((resolve) => setTimeout(resolve, 60))
      spin(120)
      await new Promise((resolve) => setTimeout(resolve, 1100))
      expect(currentLag().maxMs).toBeGreaterThanOrEqual(100)
      expect(currentLag().meanMs).toBeGreaterThan(0)
      expect(currentLag().ewmaMs).toBeGreaterThan(0)
    } finally {
      stop()
    }
    expect(currentLag()).toEqual({ meanMs: 0, maxMs: 0, ewmaMs: 0 })
  })

  it('returns every in-flight request with its age without exposing the map', () => {
    vi.useFakeTimers()
    for (let i = 0; i < 14; i++) trackRequest(`lag:${i}`, 'git.status')
    try {
      vi.advanceTimersByTime(1200)
      const requests = inFlightRequests()
      expect(requests).toHaveLength(14)
      expect(requests[0]).toEqual({ method: 'git.status', ageMs: 1200 })
      requests[0].method = 'changed'
      expect(inFlightRequests()[0].method).toBe('git.status')
    } finally {
      for (let i = 0; i < 14; i++) untrackRequest(`lag:${i}`)
    }
  })

  it('resolves at once below the default threshold', async () => {
    vi.useFakeTimers()
    setLagForTests({ meanMs: DEFAULT_IDLE_THRESHOLD_MS - 1, maxMs: 120, ewmaMs: 80 })
    await untilLoopIdle()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('polls until lag drops below the chosen threshold', async () => {
    vi.useFakeTimers()
    setLagForTests({ meanMs: 30, maxMs: 100, ewmaMs: 50 })
    let done = false
    const wait = untilLoopIdle({ thresholdMs: 30 }).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(100)
    expect(done).toBe(false)
    setLagForTests({ meanMs: 29, maxMs: 100, ewmaMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    await wait
    expect(done).toBe(true)
  })

  it('a host job runs at once on a quiet loop and waits for quiet on a busy one', async () => {
    vi.useFakeTimers()
    const ran: string[] = []
    whenLoopIdle(() => ran.push('quiet'))
    expect(ran).toEqual(['quiet'])
    setLagForTests({ meanMs: 80, maxMs: 200, ewmaMs: 60 })
    whenLoopIdle(() => ran.push('busy'))
    await vi.advanceTimersByTimeAsync(500)
    expect(ran).toEqual(['quiet'])
    setLagForTests({ meanMs: 5, maxMs: 20, ewmaMs: 30 })
    await vi.advanceTimersByTimeAsync(50)
    expect(ran).toEqual(['quiet', 'busy'])
  })

  it('a background slice gives the loop a turn even when it is quiet', async () => {
    let turned = false
    setImmediate(() => (turned = true))
    await yieldUntilIdle()
    expect(turned).toBe(true)
  })

  it('resolves at the wait bound even while lag stays high', async () => {
    vi.useFakeTimers()
    setLagForTests({ meanMs: 90, maxMs: 200, ewmaMs: 80 })
    for (const maxWaitMs of [125, DEFAULT_IDLE_MAX_WAIT_MS]) {
      let done = false
      const wait = untilLoopIdle(maxWaitMs === 125 ? { maxWaitMs } : undefined).then(() => { done = true })
      await vi.advanceTimersByTimeAsync(maxWaitMs - 1)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await wait
      expect(done).toBe(true)
    }
  })
})

const spin = (ms: number): void => {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // hold the thread
  }
}

describe('stall recorder', () => {
  it('writes a loop line only when the sampled max reaches the threshold', async () => {
    expect(loopLine({ max: (STALL_MS - 1) * 1e6, mean: 1e6 })).toBeNull()
    expect(loopLine({ max: 312e6, mean: 40e6 })).toBe('loop max=312ms mean=40ms')
  })

  it('a slow request line carries the in-flight requests, pushes, running count, load and rss', async () => {
    trackRequest('1:7', 'session.events')
    countPush('meta')
    countPush('meta')
    countPush('event')
    recordSlowRequest('queue.list', 812)
    untrackRequest('1:7')
    const line = (await log()).trim()
    expect(line).toMatch(/^\d{4}-\d\d-\d\dT[^ ]+ slow-request queue\.list 812ms inflight=session\.events:\d+ms pushes=meta:2,event:1 running=3 load=\d+\.\d rss=\d+MB wsbuf=0KB lane=bulk:0\/0 pool=\d+ms\+?$/)
  })

  it('a meta push names its producer and its session: the field reads the breakdown and the distinct ids', async () => {
    resetPushesForTests()
    countPush('meta', 'accounts', 's1')
    countPush('meta', 'accounts', 's2')
    countPush('meta', 'accounts', 's1')
    countPush('meta', 'status', 's3')
    countPush('meta')
    countPush('event')
    expect(pushesField()).toBe('pushes=meta:5/3ids(accounts:3,status:1),event:1')
    recordSlowRequest('session.list', 700)
    expect((await log()).trim()).toMatch(/ pushes=meta:5\/3ids\(accounts:3,status:1\),event:1 running=3 /)
    resetPushesForTests()
    expect(pushesField()).toBe('pushes=meta:0,event:0')
  })

  it('writes an hourly gateway line with both sample counts', async () => {
    recordGatewayTimings({ n: 3, out: { n: 3, p50: 1, p95: 2, max: 3 }, byte: { n: 2, p50: 4, p95: 5, max: 6 } })
    expect((await log()).trim()).toMatch(/ gateway n=3 out.p50=1 out.p95=2 out.max=3 byte.p50=4 byte.p95=5 byte.max=6 byte.n=2$/)
  })

  it('records the existing slow flush with all three phase fields', async () => {
    recordSlowFlush(TIMED_MS, 2, 17, 33)
    expect((await log()).trim()).toMatch(/ timed event flush \d+ms ser=\d+ write=\d+ commit=\d+ inflight=/)
  })

  it('a send span line rides with the context', async () => {
    recordSendSpan('send session=s1 accepted=0 prepared=12 handle=340(warm) delivered=355 init=- first-message=- first-content=-')
    expect((await log()).trim()).toMatch(/ send session=s1 accepted=0 prepared=12 handle=340\(warm\) delivered=355 init=- first-message=- first-content=- inflight=- pushes=/)
  })

  it('the context carries the most unsent bytes on any client socket, and a backpressure line names the connection', async () => {
    setBufferedBytes(() => 9 * 1024 * 1024)
    recordBackpressure(2, 9 * 1024 * 1024)
    setBufferedBytes(() => 0)
    const line = (await log()).trim()
    expect(line).toMatch(/ backpressure connection=2 unsent=9216KB inflight=- pushes=meta:\d+,event:\d+ running=3 load=\d+\.\d rss=\d+MB wsbuf=9216KB lane=bulk:0\/0 pool=\d+ms\+?$/)
    expect(BACKPRESSURE_BYTES).toBe(8 * 1024 * 1024)
  })

  it('the context names the bulk lane\'s requests running and waiting', async () => {
    setLaneStats(() => ({ running: 2, held: 7 }))
    recordSlowRequest('git.diffStats', 900)
    setLaneStats(() => ({ running: 0, held: 0 }))
    expect((await log()).trim()).toMatch(/ slow-request git\.diffStats 900ms .* wsbuf=\d+KB lane=bulk:2\/7 pool=\d+ms\+?$/)
  })

  it('a slow request names its lane, and a bulk one its wait in the gate or that it joined another', async () => {
    recordSlowRequest('session.list', 700, { lane: 'normal', gateMs: null })
    recordSlowRequest('git.diffIndex', 21_000, { lane: 'bulk', gateMs: 20_000 })
    recordSlowRequest('git.diffIndex', 9_000, { lane: 'bulk', gateMs: null })
    const lines = (await log()).trim().split('\n')
    expect(lines[0]).toMatch(/ slow-request session\.list 700ms lane=normal inflight=/)
    expect(lines[1]).toMatch(/ slow-request git\.diffIndex 21000ms lane=bulk gate=20000ms inflight=/)
    expect(lines[2]).toMatch(/ slow-request git\.diffIndex 9000ms lane=bulk gate=joined inflight=/)
  })

  it('a worker checkpoint at or over the threshold writes a checkpoint line with the context', async () => {
    recordCheckpoint('main', 40, TIMED_MS - 1)
    expect(existsSync(join(dir, 'stalls.log'))).toBe(false)
    recordCheckpoint('cold', 1547, 81.6)
    expect((await log()).trim()).toMatch(/ checkpoint schema=cold frames=1547 ms=82 inflight=- pushes=meta:\d+,event:\d+ running=3 load=/)
  })

  it('timed logs a section at or over the threshold and returns its value', async () => {
    expect(timed('fast', () => 1)).toBe(1)
    expect(existsSync(join(dir, 'stalls.log'))).toBe(false)
    expect(timed('mirrorSession', () => { spin(TIMED_MS + 10); return 'done' })).toBe('done')
    expect((await log())).toMatch(/ timed mirrorSession \d+ms inflight=/)
  })

  it('renderer lines are prefixed and kept to one line without server context', async () => {
    reportRendererStall('longtask 320ms switch=tab-switch:abc\nextra')
    const line = (await log()).trim()
    expect(line).toMatch(/ \[renderer\] longtask 320ms switch=tab-switch:abc extra$/)
    expect(line).not.toContain('inflight=')
  })

  it('rotates the file to stalls.log.1 once it reaches 2 MB', async () => {
    writeFileSync(join(dir, 'stalls.log'), 'x'.repeat(2 * 1024 * 1024))
    recordSlowRequest('session.list', 900)
    expect((await log())).toContain('slow-request session.list 900ms')
    expect(readFileSync(join(dir, 'stalls.log.1'), 'utf8').length).toBe(2 * 1024 * 1024)
  })

  it('a long poll is slow only past its own wait plus the grace; every other request past the cap', async () => {
    expect(isSlowRequest('session.list', SLOW_REQUEST_MS)).toBe(false)
    expect(isSlowRequest('session.list', SLOW_REQUEST_MS + 1)).toBe(true)
    const wait = LONG_POLL_MS['work.docs.recv']
    expect(wait).toBe(20_000)
    expect(isSlowRequest('work.docs.recv', 15_000)).toBe(false)
    expect(isSlowRequest('work.docs.recv', wait + LONG_POLL_GRACE_MS)).toBe(false)
    expect(isSlowRequest('work.docs.recv', wait + LONG_POLL_GRACE_MS + 1)).toBe(true)
  })

  it('a handler\'s notes ride on its own slow-request and timed lines, and on no other request\'s', async () => {
    await withRequestNotes(async () => {
      noteRequest('place', 'vm')
      await Promise.resolve()
      noteRequest('wake', '13200ms')
      recordSlowRequest('work.files.list', 15_300, { lane: 'normal', gateMs: null })
    })
    withRequestNotes(() => {
      noteRequest('profile', 'remote')
      timed('events tail scan', () => spin(TIMED_MS + 10))
    })
    noteRequest('place', 'dropped outside a request')
    recordSlowRequest('work.files.list', 900)
    const lines = (await log()).trim().split('\n')
    expect(lines[0]).toMatch(/ slow-request work\.files\.list 15300ms lane=normal place=vm wake=13200ms inflight=/)
    expect(lines[1]).toMatch(/ timed events tail scan \d+ms profile=remote inflight=/)
    expect(lines[2]).toMatch(/ slow-request work\.files\.list 900ms inflight=/)
  })

  it('a note is one word of at most 40 characters', async () => {
    withRequestNotes(() => {
      noteRequest('place', 'a b\nc')
      noteRequest('long', 'x'.repeat(100))
      expect(requestNotesField()).toBe(' place=a_b_c long=' + 'x'.repeat(40))
    })
    expect(requestNotesField()).toBe('')
  })

  it('the hourly line counts each work.* method and its slow calls, busiest first, and starts again', async () => {
    expect(workCallsLine()).toBeNull()
    for (let i = 0; i < 120; i++) countWorkCall('work.files.list', i < 3 ? SLOW_WORK_MS + 1 : 20)
    for (let i = 0; i < 800; i++) countWorkCall('work.get', 5)
    countWorkCall('work.docs.recv', 15_000)
    countWorkCall('session.list', 9000)
    expect(workCallsLine()).toBe('work-calls work.get:800/0,work.files.list:120/3,work.docs.recv:1/1')
    expect(workCallsLine()).toBeNull()
  })

  it('does nothing without a log dir', async () => {
    setStallLog(null)
    recordSlowRequest('session.list', 900)
    expect(existsSync(join(dir, 'stalls.log'))).toBe(false)
  })
})
