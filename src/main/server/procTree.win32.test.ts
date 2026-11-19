import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, describe, expect, it } from 'vitest'
import { defaultShell } from '../pty-core'
import { commandShell, shellLine } from './loginShell'
import { adoptTree, JobHost, killTree, scanWinProcesses, treeSpawnOptions, winListeners } from './procTree'

// The real thing on a Windows host (the rig, docs/agents/windows-vm.md): Job
// Objects, taskkill, Git Bash, CIM, netstat and ConPTY. Skipped elsewhere.

const win = process.platform === 'win32'
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (ok: () => boolean, ms = 10_000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (ok()) return true
  return ok()
}

/**
 * A node that starts a node grandchild (printing its pid) and then waits
 * forever. Detached: Node (libuv) puts a plain child in a kill-on-close job of
 * its own, so it dies with its parent anyway; a harness CLI's tools are not
 * all started that way (a shell's children, a detached server), and those are
 * what a Job Object of ours has to catch.
 */
const PARENT = `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true }); console.log(c.pid); setInterval(() => {}, 1000)`

function parentWithGrandchild(adopt: (child: ChildProcess) => ChildProcess): Promise<{ parent: ChildProcess; grandchild: number }> {
  const parent = adopt(spawn(process.execPath, ['-e', PARENT], { ...treeSpawnOptions(), stdio: ['ignore', 'pipe', 'ignore'] }))
  return new Promise((resolve) => createInterface({ input: parent.stdout! }).once('line', (line) => resolve({ parent, grandchild: Number(line) })))
}

const strays: number[] = []
afterAll(() => {
  for (const pid of strays) killTree(pid, 'SIGKILL')
})

describe.runIf(win)('process trees on Windows', () => {
  it('lets a grandchild outlive its parent with no job: the reason for one', async () => {
    const { parent, grandchild } = await parentWithGrandchild((c) => c)
    strays.push(grandchild)
    expect(alive(grandchild)).toBe(true)
    parent.kill()
    await until(() => !alive(parent.pid!))
    await new Promise((r) => setTimeout(r, 1_000))
    expect(alive(grandchild)).toBe(true)
  })

  it("ends an adopted child's whole job when the child exits", async () => {
    const host = new JobHost()
    const { parent, grandchild } = await parentWithGrandchild((c) => adoptTree(c, 'win32', () => host))
    strays.push(grandchild)
    // the helper compiles once (csc.exe), then takes the pid
    expect(await until(() => host.has(parent.pid!), 60_000)).toBe(true)
    await new Promise((r) => setTimeout(r, 500))
    expect(alive(grandchild)).toBe(true)
    parent.kill()
    expect(await until(() => !alive(grandchild))).toBe(true)
  }, 90_000)

  it('stops a tree with killTree, the root and what it started', async () => {
    const { parent, grandchild } = await parentWithGrandchild((c) => c)
    strays.push(grandchild)
    expect(alive(grandchild)).toBe(true)
    expect(killTree(parent.pid!, 'SIGTERM')).toBe(true)
    expect(await until(() => !alive(parent.pid!) && !alive(grandchild))).toBe(true)
  })

  it('reads the process table and the listeners', async () => {
    const rows = await scanWinProcesses()
    expect(rows.find((r) => r.pid === process.pid)?.args).toContain('node')
    expect(rows.find((r) => r.pid === process.pid)?.rssKb).toBeGreaterThan(0)
    const { createServer } = await import('node:net')
    const server = createServer().listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const port = (server.address() as { port: number }).port
    expect((await winListeners()).some((l) => l.port === port && l.pid === process.pid)).toBe(true)
    server.close()
  })
})

describe.runIf(win)('the command shell on Windows', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tc-shell-')))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('runs a command string in Git Bash in the cwd, with the tool dirs on PATH, hidden', async () => {
    const sh = commandShell()
    expect(sh.file.toLowerCase()).toMatch(/bash\.exe$/)
    const child = spawn(sh.file, sh.args(shellLine('pwd -W; echo "$PATH" | tr : "\\n" | head -1; exit 3', sh)), { cwd: dir, ...sh.options, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout!.on('data', (d) => (out += d))
    const code = await new Promise((r) => child.once('close', r))
    expect(code).toBe(3)
    const [cwd, first] = out.trim().split(/\r?\n/)
    expect(cwd!.toLowerCase()).toBe(dir.replaceAll('\\', '/').toLowerCase())
    // withToolPath leads with a tool dir the PATH lacked (both, when it had neither)
    expect(first).toMatch(/\/\.(bun|local)\/bin$/)
  })
})

describe.runIf(win)('a terminal on Windows', () => {
  it('opens PowerShell under ConPTY and runs a line', async () => {
    const req = createRequire(import.meta.url)
    const pty = req('node-pty') as typeof import('node-pty')
    const { shell, args } = defaultShell('win32', process.env)
    const term = pty.spawn(shell, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: process.cwd(), env: process.env as Record<string, string> })
    let out = ''
    term.onData((d) => (out += d))
    term.write('echo tc-$((6*7))\r')
    expect(await until(() => out.includes('tc-42'), 20_000)).toBe(true)
    const pid = term.pid
    killTree(pid, 'SIGKILL')
    expect(await until(() => !alive(pid))).toBe(true)
    // node-pty keeps its console reader alive until the pty itself is closed
    term.kill()
  }, 30_000)
})
