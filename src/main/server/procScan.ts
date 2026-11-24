import { open, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { GuardProc } from './processGuard'

/**
 * The process table off `/proc`, for the guard on Linux: pid, ppid, pgid,
 * RSS and the command line of every process of one user, with no child
 * process at all (`ps` was a fork of main every 10 s and at every call end,
 * 50-70 ms of stalled loop each on the box; docs/box.md "The exec
 * broker"). Three small reads per process on the threadpool: `stat` for
 * ppid, pgid and resident pages, `cmdline` for the arguments, and the pid
 * dir's owner for the uid (the kernel gives the dir to the process's
 * effective uid). A process that leaves mid-read is skipped. `root` and the
 * page size are injectable so the parser runs over a fixture tree.
 *
 * The cost is bounded (2026-11-23, the box at 30 threads): the guard scans
 * every SCAN_SHARE_MS while calls end, and the scan read every process on
 * the host (about 1,100) all at once, `Promise.all` over three reads each,
 * with a 64 KB buffer per `readFile` of a /proc file (its size reads 0).
 * Each scan put thousands of jobs on libuv's four threads, ahead of every
 * other file read the server made (a slash menu's skills waited 104 s),
 * and 140 MB of buffers on the heap: a live profile spent 3.7 s of 10 in
 * readFile and 0.8 s in GC, the loop stalling a second every two. Now the
 * pids come from the server's own cgroup tree when it has one (on the box,
 * `temp-code.service`: the processes the guard can own), PROC_READERS
 * reads run at a time, each into its own reused buffer, so a /proc read
 * that blocks on a process stuck in reclaim holds one pool thread, never
 * the four.
 */

/** Reads in flight at once: at most this many of libuv's four threads are ever in /proc. */
export const PROC_READERS = 2
/** A reader's buffer; a longer cmdline is read in more passes. */
const READ_CHUNK = 16 * 1024

export interface ProcScanOptions {
  /** `/proc`, or a fixture tree with `<pid>/stat` and `<pid>/cmdline` files. */
  root?: string
  /** Keep only this uid's processes; absent, every process. */
  uid?: number
  /** Bytes per page, for RSS; read from the host's auxv when absent, 4096 if that fails. */
  pageSize?: number
  /** The pids to read; null or absent reads every pid dir under `root`. */
  pids?: () => Promise<number[] | null>
}

/** The fields of `/proc/<pid>/stat` the guard reads: `comm` may hold spaces and parens, so the split starts after the last `)`. */
export function parseProcStat(text: string): { pid: number; ppid: number; pgid: number; rssPages: number } | null {
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const pid = Number(text.slice(0, text.indexOf(' ')))
  const rest = text.slice(close + 2).split(' ')
  // After `)`: state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime vsize rss …
  const ppid = Number(rest[1])
  const pgid = Number(rest[2])
  const rssPages = Number(rest[21])
  if (![pid, ppid, pgid, rssPages].every(Number.isFinite)) return null
  return { pid, ppid, pgid, rssPages }
}

/** `/proc/<pid>/cmdline` (NUL-separated) as `ps` prints `args`; a kernel thread has none. */
export const argsOfCmdline = (text: string): string => text.replace(/\0+$/, '').replace(/\0/g, ' ')

/** AT_PAGESZ (6) out of `/proc/self/auxv`: 8-byte little-endian pairs on 64-bit Linux. */
export function pageSizeFromAuxv(buf: Buffer): number | null {
  for (let i = 0; i + 16 <= buf.length; i += 16) {
    const type = Number(buf.readBigUInt64LE(i))
    if (type === 6) return Number(buf.readBigUInt64LE(i + 8))
    if (type === 0) break
  }
  return null
}

let pageSizeCache: number | null = null
async function hostPageSize(): Promise<number> {
  if (pageSizeCache) return pageSizeCache
  const fromAuxv = await readFile('/proc/self/auxv').then(pageSizeFromAuxv, () => null)
  pageSizeCache = fromAuxv && fromAuxv > 0 ? fromAuxv : 4096
  return pageSizeCache
}

/**
 * The pids of this process's own cgroup tree: the unit it runs in, and the
 * unit's whole tree when the server sits in a `server` sub-group of it
 * (docs/box.md "The server above its children"). Null outside a cgroup v2
 * unit (the root group, a Mac, no /sys/fs/cgroup).
 */
export async function cgroupTreePids(procRoot = '/proc', cgroupRoot = '/sys/fs/cgroup'): Promise<number[] | null> {
  const text = await readFile(join(procRoot, 'self', 'cgroup'), 'utf8').catch(() => '')
  const line = text.split('\n').find((l) => l.startsWith('0::'))
  let path = line?.slice(3).trim() ?? ''
  if (!path || path === '/') return null
  if (path.endsWith('/server')) path = dirname(path)
  const pids: number[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const row of (await readFile(join(dir, 'cgroup.procs'), 'utf8')).split('\n')) if (row) pids.push(Number(row))
    for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await walk(join(dir, entry.name))
  }
  try {
    await walk(join(cgroupRoot, path))
  } catch {
    return null
  }
  return pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0)
}

/** A small file read whole into the reader's own buffer: open, read until 0, close. */
async function readSmall(path: string, buf: Buffer): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const parts: string[] = []
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null)
      if (bytesRead === 0) break
      parts.push(buf.toString('latin1', 0, bytesRead))
      if (bytesRead < buf.length) break
    }
    return Buffer.from(parts.join(''), 'latin1').toString('utf8')
  } finally {
    await handle.close()
  }
}

export async function readProcTable(options: ProcScanOptions = {}): Promise<GuardProc[]> {
  const root = options.root ?? '/proc'
  const pageSize = options.pageSize ?? (await hostPageSize())
  const listed = options.pids ? await options.pids().catch(() => null) : null
  // A pid from the cgroup is the server's own: no owner to check.
  const uid = listed ? undefined : options.uid
  const names = listed ? listed.map(String) : (await readdir(root)).filter((n) => /^\d+$/.test(n))
  const rows: GuardProc[] = []
  let next = 0
  const reader = async (): Promise<void> => {
    const buf = Buffer.allocUnsafe(READ_CHUNK)
    while (next < names.length) {
      const name = names[next++]
      const dir = join(root, name)
      try {
        if (uid !== undefined && (await stat(dir)).uid !== uid) continue
        const statText = await readSmall(join(dir, 'stat'), buf)
        const cmdline = await readSmall(join(dir, 'cmdline'), buf).catch(() => '')
        const parsed = parseProcStat(statText)
        if (!parsed) continue
        const comm = /\((.*)\)/.exec(statText)?.[1] ?? name
        rows.push({ pid: parsed.pid, ppid: parsed.ppid, pgid: parsed.pgid, rssKb: Math.round((parsed.rssPages * pageSize) / 1024), args: argsOfCmdline(cmdline) || `[${comm}]` })
      } catch {
        // Gone between the listing and the read.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROC_READERS, names.length) }, reader))
  return rows
}
