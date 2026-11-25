import { afterEach, describe, expect, it } from 'vitest'
import { blockLine, sampleName, startLoopWatch } from './loopWatch'

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

describe('sampleName', () => {
  it('names the syscall and its kernel wait, or JavaScript when the thread runs', () => {
    expect(sampleName('75 0x1c 0x0 0x0', 'jbd2_log_wait_commit')).toBe('fdatasync (jbd2_log_wait_commit)')
    expect(sampleName('1 0x1c 0x7f 0x40', 'balance_dirty_pages')).toBe('write (balance_dirty_pages)')
    expect(sampleName('running', '0')).toBe('JavaScript')
    expect(sampleName('999 0x0', '')).toBe('syscall 999')
    expect(sampleName('-1 0x0 0x0', 'io_schedule')).toBe('the kernel (io_schedule)')
  })
})

describe('blockLine', () => {
  it('puts the most seen first and counts the rest', () => {
    expect(blockLine(82477, ['write (wait_transaction_locked)', 'write (wait_transaction_locked)', 'fdatasync (jbd2_log_wait_commit)'])).toBe(
      'loop-blocked 82477ms in write (wait_transaction_locked), 2 of 3 samples; also fdatasync (jbd2_log_wait_commit) 1'
    )
    expect(blockLine(1200, [])).toBe('loop-blocked 1200ms')
  })
})

describe.runIf(process.platform === 'linux')('startLoopWatch', () => {
  const block = (ms: number, how: 'wait' | 'spin'): void => {
    if (how === 'wait') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    else {
      const end = Date.now() + ms
      while (Date.now() < end) {
        // the thread runs JavaScript the whole time
      }
    }
  }
  const watched = async (how: 'wait' | 'spin'): Promise<string> => {
    const lines: string[] = []
    stops.push(startLoopWatch((l) => lines.push(l), { lateMs: 300 }))
    await new Promise((r) => setTimeout(r, 300))
    block(1_800, how)
    const end = Date.now() + 3_000
    while (lines.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    return lines[0] ?? ''
  }

  it('names a block in a syscall', async () => {
    expect(await watched('wait')).toMatch(/^loop-blocked \d+ms in futex/)
  })

  it('names a block in JavaScript', async () => {
    expect(await watched('spin')).toMatch(/^loop-blocked \d+ms in JavaScript/)
  })
})
