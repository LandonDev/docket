import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/events'
import { cancelMirrors, mirrorName, mirrorSession, rotateJournal, THREADS_INDEX_READS, writeDigestFile, writeThreadsIndex } from './mirror'

/** A disk whose opens and writes take their time while it is slow (an ext4
 *  journal stalled by a guest's flushes), counting what is in flight. */
const disk = vi.hoisted(() => ({ openMs: 0, writeMs: 0, opens: 0, maxOpens: 0, writing: new Set<string>(), overlapped: false }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  return {
    ...fs,
    open: vi.fn(async (...args: Parameters<typeof fs.open>) => {
      disk.maxOpens = Math.max(disk.maxOpens, ++disk.opens)
      try {
        if (disk.openMs) await wait(disk.openMs)
        return await fs.open(...args)
      } finally {
        disk.opens--
      }
    }),
    writeFile: vi.fn(async (path: string, data: string) => {
      if (disk.writing.has(path)) disk.overlapped = true
      disk.writing.add(path)
      try {
        if (disk.writeMs) await wait(disk.writeMs)
        return await fs.writeFile(path, data)
      } finally {
        disk.writing.delete(path)
      }
    })
  }
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-mirror-slow-'))
  Object.assign(disk, { openMs: 0, writeMs: 0, opens: 0, maxOpens: 0, overlapped: false })
})
afterEach(() => {
  cancelMirrors()
  rmSync(dir, { recursive: true, force: true })
})

/** Runs `fn` and returns its value with the loop's worst delay meanwhile, in ms. */
async function loopDelayDuring<T>(fn: () => Promise<T>): Promise<{ value: T; maxMs: number }> {
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  histogram.enable()
  try {
    const value = await fn()
    return { value, maxMs: histogram.max / 1e6 }
  } finally {
    histogram.disable()
  }
}

const mirror = (title: string, updated: string): string => `---\ntitle: "${title}"\ntype: chat\nstatus: idle\nupdated: ${updated}\n---\n\nbody`

describe('mirror writes on a slow disk', () => {
  it('the thread index keeps the loop free while its reads and its write wait, and lands complete', async () => {
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, `t-${i}.md`), mirror(`Thread ${i}`, `2026-11-${String(i % 28 + 1).padStart(2, '0')}T00:00:${String(i).padStart(2, '0')}.000Z`))
    disk.openMs = 100
    disk.writeMs = 2000
    const { maxMs } = await loopDelayDuring(() => writeThreadsIndex(dir, async () => {}))
    expect(maxMs).toBeLessThan(100)
    expect(disk.maxOpens).toBeLessThanOrEqual(THREADS_INDEX_READS)
    const lines = readFileSync(join(dir, 'INDEX.md'), 'utf8').split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(30)
    const dates = lines.map((l) => l.slice(2, 12))
    expect(dates).toEqual([...dates].sort().reverse())
  }, 15_000)

  it('a thread\'s mirror after a turn keeps the loop free while its write waits 2 s', async () => {
    const meta = {
      id: 'm1', parentId: null, projectId: 'p', title: 'Slow disk', threadType: 'chat', provider: 'claude', model: 'x',
      status: 'idle', cwd: dir, createdAt: 1, updatedAt: 2
    } as unknown as SessionMeta
    const reg = { get: () => meta, getProject: () => ({ cwd: dir }), readLogRows: async () => [] }
    disk.writeMs = 2000
    const { maxMs } = await loopDelayDuring(() => mirrorSession(reg as never, 'm1'))
    expect(maxMs).toBeLessThan(100)
    expect(readFileSync(join(dir, '.temp-code', 'threads', mirrorName(meta)), 'utf8')).toContain('title: "Slow disk"')
    expect(readFileSync(join(dir, '.temp-code', 'threads', 'INDEX.md'), 'utf8')).toContain('"Slow disk"')
  }, 15_000)

  it('two writes to one path run one at a time, and the later one wins', async () => {
    mkdirSync(join(dir, '.temp-code'), { recursive: true })
    disk.writeMs = 300
    const [a, b] = await Promise.all([writeDigestFile(dir, 's', 'first'), writeDigestFile(dir, 's', 'second')])
    expect(a).toBe(b)
    expect(disk.overlapped).toBe(false)
    expect(readFileSync(join(dir, a), 'utf8')).toBe('second')
  }, 10_000)

  it('two rotations of one journal run one at a time: each old entry is archived once', async () => {
    mkdirSync(join(dir, '.temp-code'), { recursive: true })
    const entries = Array.from({ length: 80 }, (_, i) => `- 2026-11-${String(i % 28 + 1).padStart(2, '0')} — entry ${i} ${'z'.repeat(80)}`)
    writeFileSync(join(dir, '.temp-code', 'PROJECT.md'), `# P\n\n## Log\n\n${entries.join('\n')}\n`)
    disk.writeMs = 200
    await Promise.all([rotateJournal(dir), rotateJournal(dir)])
    const archive = readFileSync(join(dir, '.temp-code', 'PROJECT-archive.md'), 'utf8')
    expect(archive.match(/— entry 0 /g)).toHaveLength(1)
    const kept = readFileSync(join(dir, '.temp-code', 'PROJECT.md'), 'utf8')
    for (let i = 0; i < 80; i++) expect(Number(archive.includes(`— entry ${i} `)) + Number(kept.includes(`— entry ${i} `))).toBe(1)
  }, 10_000)
})
