import { Worker } from 'node:worker_threads'

/**
 * What the main thread waits in while its loop is blocked (Linux): a worker
 * reads the thread's `/proc/<pid>/task/<pid>/syscall` and `wchan` four times
 * a second while the loop's heartbeat is late, and when the loop is back the
 * stall log says `loop-blocked <ms> in <syscall> (<kernel wait>, n of m samples)`,
 * or `in JavaScript` when the thread was running, not waiting.
 *
 * Why: on 2026-11-24 the box's loop stopped for 82 s while an agent's QEMU
 * flushed the disk, and the stall log could say only that it stopped.
 * `running` and the syscall number come from /proc; the names below cover the
 * calls a stalled loop is found in on x86_64.
 */

/** x86_64 syscall numbers the loop may wait in. */
export const SYSCALLS: Record<number, string> = {
  0: 'read', 1: 'write', 2: 'open', 3: 'close', 4: 'stat', 5: 'fstat', 6: 'lstat', 7: 'poll', 8: 'lseek',
  17: 'pread64', 18: 'pwrite64', 19: 'readv', 20: 'writev', 61: 'wait4', 74: 'fsync', 75: 'fdatasync', 76: 'truncate',
  77: 'ftruncate', 82: 'rename', 83: 'mkdir', 84: 'rmdir', 87: 'unlink', 202: 'futex', 217: 'getdents64', 232: 'epoll_wait',
  257: 'openat', 262: 'newfstatat', 263: 'unlinkat', 264: 'renameat', 281: 'epoll_pwait', 285: 'fallocate', 316: 'renameat2', 332: 'statx'
}

/** One /proc sample as a name: the syscall and its kernel wait, or JavaScript when running. */
export function sampleName(syscall: string, wchan: string): string {
  const text = syscall.trim()
  if (text === 'running') return 'JavaScript'
  const nr = Number(text.split(' ')[0])
  if (!Number.isInteger(nr) || nr < 0) return wchan && wchan !== '0' ? `the kernel (${wchan})` : 'the kernel'
  const call = SYSCALLS[nr] ?? `syscall ${nr}`
  return wchan && wchan !== '0' ? `${call} (${wchan})` : call
}

/** The stall line's words for a block's samples: the most seen first. */
export function blockLine(ms: number, samples: readonly string[]): string {
  if (samples.length === 0) return `loop-blocked ${Math.round(ms)}ms`
  const counts = new Map<string, number>()
  for (const s of samples) counts.set(s, (counts.get(s) ?? 0) + 1)
  const ranked = [...counts].sort((a, b) => b[1] - a[1])
  const [top, n] = ranked[0]
  const rest = ranked.slice(1, 3).map(([s, k]) => `${s} ${k}`).join(', ')
  return `loop-blocked ${Math.round(ms)}ms in ${top}, ${n} of ${samples.length} samples${rest ? `; also ${rest}` : ''}`
}

export const LATE_MS = 1_000
const BEAT_MS = 100
const SAMPLE_MS = 250
const MAX_SAMPLES = 2_000

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { readFileSync } = require('node:fs')
const { beat, pid, lateMs, sampleMs, maxSamples } = workerData
const at = new Float64Array(beat)
const base = '/proc/' + pid + '/task/' + pid + '/'
const read = (f) => { try { return readFileSync(base + f, 'utf8') } catch { return '' } }
let since = 0
let samples = []
setInterval(() => {
  const last = at[0]
  const late = Date.now() - last
  if (late > lateMs) {
    if (!since) { since = last; samples = [] }
    if (samples.length < maxSamples) samples.push([read('syscall'), read('wchan')])
  } else if (since) {
    parentPort.postMessage({ ms: last - since, samples })
    since = 0
    samples = []
  }
}, sampleMs)
`

/** Starts the watch beside the main thread (Linux only); the return stops it. */
export function startLoopWatch(log: (line: string) => void, o: { lateMs?: number } = {}): () => void {
  if (process.platform !== 'linux') return () => {}
  const beat = new SharedArrayBuffer(8)
  const at = new Float64Array(beat)
  at[0] = Date.now()
  const timer = setInterval(() => (at[0] = Date.now()), BEAT_MS)
  timer.unref()
  let worker: Worker
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { beat, pid: process.pid, lateMs: o.lateMs ?? LATE_MS, sampleMs: SAMPLE_MS, maxSamples: MAX_SAMPLES } })
  } catch {
    clearInterval(timer)
    return () => {}
  }
  worker.unref()
  worker.on('message', (m: { ms: number; samples: [string, string][] }) => log(blockLine(m.ms, m.samples.map(([s, w]) => sampleName(s, w)))))
  worker.on('error', () => {})
  return () => {
    clearInterval(timer)
    void worker.terminate()
  }
}
