import { describe, expect, it } from 'vitest'
import { bootLayout, bootRows, hostFlags, HOST_SCENES, lastAllowedCores, onceInOrder, over, percentile, stallSlices } from './host'
import { loadStream } from './lib/load'
import { requireScrubbed } from './scrubCopy'

describe('host scene flags', () => {
  it('lists the host budget rows, one scene per call', () => {
    expect(HOST_SCENES).toEqual({
      connect: 'H01', loop: 'H02', read: 'H03', flush: 'H04', settle: 'H05', watch: 'H09', boot: 'H06'
    })
    for (const scene of ['connect', 'loop', 'read', 'flush', 'settle', 'watch'])
      expect(hostFlags(['--scene', scene]).scene).toBe(scene)
    expect(hostFlags(['--scene', 'loop', '--browser']).browser).toBe(true)
  })

  it('defaults to the small boot seed and accepts the real layout or a copy', () => {
    expect(bootLayout(hostFlags(['--boot']).seedSize)).toEqual({ threads: 48, rows: 6000, long: 900 })
    expect(bootLayout(hostFlags(['--boot', '--seed-size', 'real']).seedSize)).toEqual({
      threads: 2000, rows: 1_000_000, long: 30_000
    })
    expect(hostFlags(['--boot', '--copy', '/tmp/scrubbed']).copy).toBe('/tmp/scrubbed')
    const layout = bootLayout('real')
    expect(bootRows(layout, 0)).toBe(30_000)
    expect(Array.from({ length: layout.threads }, (_, i) => bootRows(layout, i)).reduce((a, b) => a + b, 0)).toBe(1_000_000)
  })

  it.each([
    [], ['--scene'], ['--scene', 'boot'], ['--scene', 'toString'], ['--scene', 'connect', '--boot'],
    ['--scene', 'connect', '--browser'], ['--scene', 'loop', '--browser', '--browser'],
    ['--scene', 'read', '--copy', '/tmp/copy'], ['--boot', '--copy'], ['--boot', '--copy', '--boot'],
    ['--boot', '--seed-size', 'large'], ['--boot', '--copy', '/tmp/copy', '--seed-size', 'small']
  ].map((args) => ({ args })))('rejects incompatible or incomplete flags %j', ({ args }) => {
    expect(() => hostFlags(args)).toThrow()
  })

  it('rejects a boot copy without a scrub marker', () => {
    expect(() => requireScrubbed('/tmp/host-bench-test-missing-scrub-marker')).toThrow()
  })

  it('selects the last eight available CPUs, including a sparse mask', () => {
    expect(lastAllowedCores('0-31')).toBe('24,25,26,27,28,29,30,31')
    expect(lastAllowedCores('2,6-7,10-15')).toBe('6,7,10,11,12,13,14,15')
    expect(lastAllowedCores('3')).toBe('3')
  })
})

describe('timing and row counts', () => {
  it('requires every sequence number within the expected bounds once', () => {
    expect(onceInOrder([12, 13, 14], 12, 14)).toBe(true)
    expect(onceInOrder([13, 12, 14], 12, 14)).toBe(false)
    expect(onceInOrder([12, 12, 14], 12, 14)).toBe(false)
    expect(onceInOrder([12, 14], 12, 14)).toBe(false)
    expect(onceInOrder([12, 13], 12, 14)).toBe(false)
    expect(onceInOrder([12, 13, 14, 15], 12, 14)).toBe(false)
  })

  it('uses nearest rank without changing the original samples', () => {
    const values = [20, 0, ...Array.from({ length: 18 }, (_, i) => i + 1)]
    expect([0, 50, 95, 99, 100].map((rank) => percentile(values, rank))).toEqual([0, 9, 18, 20, 20])
    expect(percentile([], 95)).toBeNull()
    expect(values.slice(0, 2)).toEqual([20, 0])
  })

  it('keeps timed causes and loop blocks in the window with strict cutoffs', () => {
    const from = Date.parse('2026-11-26T00:00:01Z')
    const to = from + 3000
    const log = [
      '2026-11-26T00:00:00.000Z timed event flush 70ms',
      '2026-11-26T00:00:01.000Z timed event flush 51ms running=40',
      '2026-11-26T00:00:02.000Z timed threads mirror 50ms',
      '2026-11-26T00:00:03.000Z loop max=181ms mean=21ms',
      '2026-11-26T00:00:03.000Z slow-request commands.list 644ms lane=interactive',
      '2026-11-26T00:00:05.000Z timed event flush 58ms'
    ].join('\n')
    const slices = stallSlices(log, from, to)
    expect(slices.map(({ cause, ms }) => [cause, ms])).toEqual([['event flush', 51], ['threads mirror', 50], ['loop', 181]])
    expect(over(slices, 50, from, to)).toHaveLength(2)
    expect(over(slices, 100, from, to)).toHaveLength(1)
    expect(over(slices, 50, from + 1, to)).toHaveLength(1)
  })

  it('ends every loopback stream on the same signal with one stop frame each', async () => {
    const end = new AbortController()
    const streams = [loadStream('dummy', 240, 1, end.signal), loadStream('dummy', 240, 1, end.signal)]
    end.abort()
    const replies = await Promise.all(streams.map((stream) => new Response(stream).text()))
    for (const reply of replies) {
      expect(reply.match(/^event: message_start$/gm)).toHaveLength(1)
      expect(reply.match(/^event: message_stop$/gm)).toHaveLength(1)
      expect(reply.match(/^event: content_block_stop$/gm)).toHaveLength(1)
    }
  })
})
