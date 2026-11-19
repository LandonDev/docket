import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { adoptTree, JobHost, killTree, parseNetstat, parseWinProcessTable, stopTurnTrees, taskkillTreeArgs, treeSpawnOptions } from './procTree'

describe('treeSpawnOptions', () => {
  it('is a process group of its own on POSIX, a hidden child in the same console on win32', () => {
    expect(treeSpawnOptions('linux')).toEqual({ detached: true })
    expect(treeSpawnOptions('darwin')).toEqual({ detached: true })
    expect(treeSpawnOptions('win32')).toEqual({ detached: false, windowsHide: true })
  })
})

describe('killTree', () => {
  it('signals the process group on POSIX, false when none is there', () => {
    const kill = vi.fn()
    expect(killTree(42, 'SIGTERM', { platform: 'linux', kill })).toBe(true)
    expect(kill).toHaveBeenCalledWith(-42, 'SIGTERM')
    const gone = vi.fn(() => {
      throw new Error('ESRCH')
    })
    expect(killTree(42, 'SIGKILL', { platform: 'darwin', kill: gone })).toBe(false)
    expect(killTree(1, 'SIGKILL', { platform: 'linux', kill })).toBe(false)
  })

  it('ends the job and runs taskkill /T /F on win32, whatever the signal', () => {
    const taskkill = vi.fn()
    const endJob = vi.fn(() => true)
    expect(killTree(42, 'SIGTERM', { platform: 'win32', kill: () => undefined, taskkill, endJob })).toBe(true)
    expect(endJob).toHaveBeenCalledWith(42)
    expect(taskkill).toHaveBeenCalledWith(['/PID', '42', '/T', '/F'])
    expect(taskkillTreeArgs(7)).toEqual(['/PID', '7', '/T', '/F'])
  })

  it("on win32 still ends a gone root's job, which holds what it left", () => {
    const taskkill = vi.fn()
    const gone = (): void => {
      throw new Error('ESRCH')
    }
    expect(killTree(42, 'SIGKILL', { platform: 'win32', kill: gone, taskkill, endJob: () => true })).toBe(true)
    expect(killTree(43, 'SIGKILL', { platform: 'win32', kill: gone, taskkill, endJob: () => false })).toBe(false)
    expect(taskkill).not.toHaveBeenCalled()
  })
})

function fakeHelper(): { proc: ChildProcess; lines: string[] } {
  const proc = new EventEmitter() as unknown as ChildProcess
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const lines: string[] = []
  // answers as the real helper does: `ok <pid>` once a pid is in its job, `err <pid> <code>` when it cannot be
  stdin.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      lines.push(line)
      const [word, pid] = line.split(' ')
      if (word === 'add') stdout.write(Number(pid) === 13 ? `err ${pid} 5\n` : `ok ${pid}\n`)
    }
  })
  Object.assign(proc, { stdin, stdout })
  return { proc, lines }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('JobHost', () => {
  it('compiles the helper once when missing, adds and ends jobs by pid', async () => {
    const { proc, lines } = fakeHelper()
    const compile = vi.fn(async () => undefined)
    const host = new JobHost({ exe: '/nonexistent/tc-jobs.exe', compile, spawnHelper: () => proc, log: () => undefined })
    // the rename after compile fails on the fake path: the host logs and falls back
    expect(await host.add(10)).toBe(false)
    expect(compile).toHaveBeenCalledTimes(1)
    const ready = new JobHost({ exe: __filename, spawnHelper: () => proc, log: () => undefined })
    expect(await ready.add(10)).toBe(true)
    // in a job only once the helper says so
    await tick()
    expect(ready.has(10)).toBe(true)
    expect(await ready.add(13)).toBe(true)
    await tick()
    expect(ready.has(13)).toBe(false)
    expect(ready.end(13)).toBe(false)
    expect(ready.end(10)).toBe(true)
    expect(ready.end(10)).toBe(false)
    await new Promise((r) => setImmediate(r))
    expect(lines).toEqual(['add 10', 'add 13', 'end 10'])
  })

  it("skips a child that exited while the helper was starting: its pid may be another's by then", async () => {
    const { proc, lines } = fakeHelper()
    const host = new JobHost({ exe: __filename, spawnHelper: () => proc, log: () => undefined })
    expect(await host.add(12, () => true)).toBe(false)
    expect(host.has(12)).toBe(false)
    await new Promise((r) => setImmediate(r))
    expect(lines).toEqual([])
  })

  it('starts again after the helper failed to spawn, and says how many trees went with a lost helper', async () => {
    const first = fakeHelper()
    const second = fakeHelper()
    const logs: string[] = []
    const spawnHelper = vi.fn().mockReturnValueOnce(first.proc).mockReturnValueOnce(second.proc)
    const host = new JobHost({ exe: __filename, spawnHelper, log: (l) => logs.push(l) })
    await host.add(1)
    first.proc.emit('error', new Error('EACCES'))
    expect(logs.some((l) => l.includes('1 adopted tree(s) ended'))).toBe(true)
    expect(await host.add(2)).toBe(true)
    expect(spawnHelper).toHaveBeenCalledTimes(2)
  })

  it('forgets every job when the helper exits, so a later adoption starts it again', async () => {
    const first = fakeHelper()
    const second = fakeHelper()
    const spawnHelper = vi.fn().mockReturnValueOnce(first.proc).mockReturnValueOnce(second.proc)
    const host = new JobHost({ exe: __filename, spawnHelper, log: () => undefined })
    await host.add(1)
    first.proc.emit('exit', 0)
    expect(host.has(1)).toBe(false)
    await host.add(2)
    expect(spawnHelper).toHaveBeenCalledTimes(2)
  })
})

describe('adoptTree', () => {
  it('adopts on win32 and ends the job when the child exits; nothing elsewhere', async () => {
    const add = vi.fn(async () => true)
    const end = vi.fn(() => true)
    const host = (): JobHost => ({ add, end }) as unknown as JobHost
    const child = Object.assign(new EventEmitter(), { pid: 99 }) as unknown as ChildProcess
    adoptTree(child, 'linux', host)
    expect(add).not.toHaveBeenCalled()
    adoptTree(child, 'win32', host)
    expect(add).toHaveBeenCalledWith(99, expect.any(Function))
    child.emit('exit', 0)
    expect(end).toHaveBeenCalledWith(99)
  })
})

describe('the win32 readers', () => {
  it("reads CIM's process table, one row or many", () => {
    const one = JSON.stringify({ ProcessId: 4, ParentProcessId: 0, WorkingSetSize: 2048, CommandLine: null, Started: null })
    expect(parseWinProcessTable(one)).toEqual([{ pid: 4, ppid: 0, rssKb: 2, args: '', startedAt: null }])
    const many = JSON.stringify([
      { ProcessId: 10, ParentProcessId: 4, WorkingSetSize: 4096, CommandLine: 'node a.js', Started: 1700000000000 },
      { ProcessId: 0, ParentProcessId: 0 }
    ])
    expect(parseWinProcessTable(many)).toEqual([{ pid: 10, ppid: 4, rssKb: 4, args: 'node a.js', startedAt: 1700000000000 }])
    expect(parseWinProcessTable('not json')).toEqual([])
  })

  it("reads netstat's listening rows, v4 and v6, once each", () => {
    const text = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012',
      '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4242',
      '  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     4242',
      '  TCP    [::1]:5173             [::]:0                 LISTENING       4242',
      '  TCP    [::]:8080              [::]:0                 LISTENING       77',
      // netstat speaks the system's language: a German Windows says ABHÖREN
      '  TCP    127.0.0.1:3000         0.0.0.0:0              ABHÖREN         99'
    ].join('\r\n')
    expect(parseNetstat(text + '\r\n' + text)).toEqual([
      { port: 135, pid: 1012, address: '0.0.0.0' },
      { port: 5173, pid: 4242, address: '127.0.0.1' },
      { port: 5173, pid: 4242, address: '[::1]' },
      { port: 8080, pid: 77, address: '[::]' },
      { port: 3000, pid: 99, address: '127.0.0.1' }
    ])
  })
})

describe('stopTurnTrees', () => {
  it("ends the tree of each child the harness started since the turn began, never its earlier servers; nothing off win32", async () => {
    const rows = [
      { pid: 20, ppid: 10, rssKb: 1, args: 'node mcp-server.js', startedAt: 1_000 },
      { pid: 21, ppid: 10, rssKb: 1, args: 'powershell -Command Start-Sleep 902', startedAt: 50_000 },
      { pid: 22, ppid: 21, rssKb: 1, args: 'powershell -Command Start-Sleep 901', startedAt: 50_100 },
      { pid: 23, ppid: 99, rssKb: 1, args: 'unrelated', startedAt: 60_000 }
    ]
    const killed: number[] = []
    expect(await stopTurnTrees(10, 49_500, 'win32', async () => rows, (pid) => killed.push(pid))).toBe(1)
    expect(killed).toEqual([21])
    expect(await stopTurnTrees(10, 49_500, 'linux', async () => rows, (pid) => killed.push(pid))).toBe(0)
    expect(await stopTurnTrees(null, 0, 'win32', async () => rows, (pid) => killed.push(pid))).toBe(0)
  })
})
