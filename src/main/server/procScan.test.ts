import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { argsOfCmdline, cgroupTreePids, pageSizeFromAuxv, parseProcStat, PROC_READERS, readProcTable } from './procScan'

/** A fixture `/proc`: one dir per pid with the two files the reader takes. */
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-proc-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const STAT = (pid: number, comm: string, ppid: number, pgid: number, rssPages: number): string =>
  `${pid} (${comm}) S ${ppid} ${pgid} ${pgid} 0 -1 4194560 1234 0 0 0 50 10 0 0 20 0 1 0 100 10000000 ${rssPages} 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0\n`

async function proc(pid: number, comm: string, ppid: number, pgid: number, rssPages: number, argv: string[]): Promise<void> {
  const dir = join(root, String(pid))
  await mkdir(dir)
  await writeFile(join(dir, 'stat'), STAT(pid, comm, ppid, pgid, rssPages))
  await writeFile(join(dir, 'cmdline'), argv.length ? `${argv.join('\0')}\0` : '')
}

describe('parseProcStat', () => {
  it('reads pid, ppid, pgid and resident pages past a comm with spaces and parens', () => {
    expect(parseProcStat(STAT(42, 'tmux: server (1)', 1, 42, 700))).toEqual({ pid: 42, ppid: 1, pgid: 42, rssPages: 700 })
  })
  it('refuses a line with no comm', () => {
    expect(parseProcStat('garbage')).toBeNull()
  })
})

describe('argsOfCmdline', () => {
  it('joins the NUL-separated argv and drops the trailing NUL', () => {
    expect(argsOfCmdline('node\0--conditions\0dev\0')).toBe('node --conditions dev')
    expect(argsOfCmdline('')).toBe('')
  })
})

describe('pageSizeFromAuxv', () => {
  it('finds AT_PAGESZ among the pairs', () => {
    const buf = Buffer.alloc(48)
    buf.writeBigUInt64LE(33n, 0)
    buf.writeBigUInt64LE(0x7fffn, 8)
    buf.writeBigUInt64LE(6n, 16)
    buf.writeBigUInt64LE(16384n, 24)
    expect(pageSizeFromAuxv(buf)).toBe(16384)
    expect(pageSizeFromAuxv(Buffer.alloc(16))).toBeNull()
  })
})

describe('readProcTable', () => {
  it('lists this user\'s processes as the guard\'s rows, RSS in kB, a kernel thread by its comm', async () => {
    await proc(1, 'systemd', 0, 1, 10, ['/sbin/init'])
    await proc(2, 'kthreadd', 0, 0, 0, [])
    await proc(3100, 'node', 1, 3100, 700_000, ['node', '--conditions', 'node', '/x/tinypool/dist/entry/process.js'])
    await proc(3101, 'bash', 3100, 3100, 1_200, ['bash', '-c', 'bun test'])
    await writeFile(join(root, 'uptime'), '1 1\n')
    await mkdir(join(root, 'sys'))
    const rows = await readProcTable({ root, uid: process.getuid?.(), pageSize: 4096 })
    expect(rows.sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 1, ppid: 0, pgid: 1, rssKb: 40, args: '/sbin/init' },
      { pid: 2, ppid: 0, pgid: 0, rssKb: 0, args: '[kthreadd]' },
      { pid: 3100, ppid: 1, pgid: 3100, rssKb: 2_800_000, args: 'node --conditions node /x/tinypool/dist/entry/process.js' },
      { pid: 3101, ppid: 3100, pgid: 3100, rssKb: 4_800, args: 'bash -c bun test' }
    ])
  })

  it('leaves out another uid\'s processes and one that vanished mid-read', async () => {
    await proc(10, 'a', 1, 10, 1, ['a'])
    await mkdir(join(root, '11'))
    const mine = await readProcTable({ root, uid: process.getuid?.(), pageSize: 4096 })
    expect(mine.map((r) => r.pid)).toEqual([10])
    const theirs = await readProcTable({ root, uid: (process.getuid?.() ?? 0) + 1, pageSize: 4096 })
    expect(theirs).toEqual([])
  })

  it('skips a stat it cannot read', async () => {
    await proc(20, 'b', 1, 20, 1, ['b'])
    await chmod(join(root, '20', 'stat'), 0o000)
    expect(await readProcTable({ root, pageSize: 4096 })).toEqual([])
  })

  it('reads only the pids it is given, with no owner check, and a cmdline longer than a reader\'s buffer whole', async () => {
    const long = 'x'.repeat(40_000)
    await proc(30, 'mine', 1, 30, 1, ['node', long])
    await proc(31, 'other', 1, 31, 1, ['other'])
    const rows = await readProcTable({ root, uid: (process.getuid?.() ?? 0) + 1, pageSize: 4096, pids: async () => [30, 99] })
    expect(rows).toEqual([{ pid: 30, ppid: 1, pgid: 30, rssKb: 4, args: `node ${long}` }])
  })

  it('falls back to every pid dir when the pid list cannot be read', async () => {
    await proc(40, 'a', 1, 40, 1, ['a'])
    const rows = await readProcTable({ root, pageSize: 4096, pids: async () => null })
    expect(rows.map((r) => r.pid)).toEqual([40])
  })

  it('reads a large table through a bounded number of readers', async () => {
    for (let pid = 100; pid < 160; pid++) await proc(pid, 'p', 1, pid, 1, ['p', String(pid)])
    const rows = await readProcTable({ root, pageSize: 4096 })
    expect(rows.length).toBe(60)
    expect(PROC_READERS).toBeLessThanOrEqual(2)
  })
})

describe('cgroupTreePids', () => {
  async function tree(self: string, groups: Record<string, number[]>): Promise<{ procRoot: string; cgroupRoot: string }> {
    const procRoot = join(root, 'proc')
    const cgroupRoot = join(root, 'cgroup')
    await mkdir(join(procRoot, 'self'), { recursive: true })
    await writeFile(join(procRoot, 'self', 'cgroup'), self)
    for (const [path, pids] of Object.entries(groups)) {
      await mkdir(join(cgroupRoot, path), { recursive: true })
      await writeFile(join(cgroupRoot, path, 'cgroup.procs'), pids.map((p) => `${p}\n`).join(''))
    }
    return { procRoot, cgroupRoot }
  }

  it('lists the unit\'s own processes and its sub-groups\'', async () => {
    const t = await tree('0::/agents.slice/temp-code.service\n', { 'agents.slice/temp-code.service': [5, 6], 'agents.slice/temp-code.service/x': [7], 'agents.slice/other.service': [8] })
    expect((await cgroupTreePids(t.procRoot, t.cgroupRoot))?.sort()).toEqual([5, 6, 7])
  })

  it('reads the whole unit when the server sits in its `server` sub-group', async () => {
    const t = await tree('0::/agents.slice/temp-code.service/server\n', { 'agents.slice/temp-code.service': [], 'agents.slice/temp-code.service/server': [5], 'agents.slice/temp-code.service/jobs': [9, 10] })
    expect((await cgroupTreePids(t.procRoot, t.cgroupRoot))?.sort((a, b) => a - b)).toEqual([5, 9, 10])
  })

  it('is null in the root group, without a v2 line, or when the group cannot be read', async () => {
    expect(await cgroupTreePids((await tree('0::/\n', {})).procRoot, join(root, 'cgroup'))).toBeNull()
    await rm(join(root, 'proc'), { recursive: true, force: true })
    expect(await cgroupTreePids((await tree('1:name=systemd:/x\n', {})).procRoot, join(root, 'cgroup'))).toBeNull()
    await rm(join(root, 'proc'), { recursive: true, force: true })
    expect(await cgroupTreePids((await tree('0::/gone.service\n', {})).procRoot, join(root, 'cgroup'))).toBeNull()
  })
})
