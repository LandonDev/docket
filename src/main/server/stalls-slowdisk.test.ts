import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushStallLog, recordDriverNote, setStallLog, STALL_QUEUE_MAX_BYTES } from './stalls'

/** A disk whose appends take `delayMs` while it is slow (an ext4 journal stalled by a guest's flushes). */
const disk = vi.hoisted(() => ({ delayMs: 0 }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const slow = async (): Promise<void> => {
    if (disk.delayMs) await new Promise((resolve) => setTimeout(resolve, disk.delayMs))
  }
  return {
    ...fs,
    appendFile: vi.fn(async (...args: Parameters<typeof fs.appendFile>) => (await slow(), fs.appendFile(...args)))
  }
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stalls-slow-'))
  setStallLog(dir)
})
afterEach(async () => {
  disk.delayMs = 0
  await flushStallLog()
  setStallLog(null)
  rmSync(dir, { recursive: true, force: true })
})

const lines = (): string[] => readFileSync(join(dir, 'stalls.log'), 'utf8').trim().split('\n')

describe('the stall log on a slow disk', () => {
  it('keeps the loop free while an append waits 2 s, and writes every line in order once it lands', async () => {
    disk.delayMs = 2000
    const histogram = monitorEventLoopDelay({ resolution: 10 })
    histogram.enable()
    for (let i = 0; i < 200; i++) recordDriverNote(`note ${i}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
    recordDriverNote('late')
    await flushStallLog()
    histogram.disable()
    expect(histogram.max / 1e6).toBeLessThan(100)
    const got = lines()
    expect(got).toHaveLength(201)
    expect(got[0]).toMatch(/^\d{4}-\d\d-\d\dT[^ ]+ note 0$/)
    expect(got[199]).toMatch(/ note 199$/)
    expect(got[200]).toMatch(/ late$/)
  }, 10_000)

  it('drops lines past the bound while the disk is slow, and says how many once it drains', async () => {
    disk.delayMs = 300
    recordDriverNote('first') // in flight: the queue behind it fills
    await new Promise((resolve) => setImmediate(resolve))
    const body = 'x'.repeat(1000)
    const fits = Math.floor(STALL_QUEUE_MAX_BYTES / (body.length + 26))
    for (let i = 0; i < fits + 50; i++) recordDriverNote(body)
    await flushStallLog()
    const got = lines()
    expect(got[0]).toMatch(/ first$/)
    const kept = got.filter((l) => l.endsWith(body)).length
    expect(kept).toBeGreaterThan(fits - 5)
    expect(kept).toBeLessThanOrEqual(fits)
    expect(got.at(-1)).toMatch(new RegExp(`^\\S+ stall log dropped ${fits + 50 - kept} lines while the disk was slow$`))
    // The next line after the drain is written as usual.
    disk.delayMs = 0
    recordDriverNote('after')
    await flushStallLog()
    expect(lines().at(-1)).toMatch(/ after$/)
  }, 10_000)
})
