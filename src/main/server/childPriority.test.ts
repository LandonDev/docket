import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NICE_LEVEL } from '@shared/bashMarks'
import { LOWERED, lowerCommand, lowerPrefix, placeLowered, setupCgroupSplit, spawnLowered, SPLIT, type LoweredKind } from './childPriority'

const NICE = ['nice', '-n', String(NICE_LEVEL)]
const IO: Record<LoweredKind, string[]> = {
  harness: ['/usr/bin/ionice', '-c', '2', '-n', '7'],
  mcp: ['/usr/bin/ionice', '-c', '2', '-n', '7'],
  job: ['/usr/bin/ionice', '-c', '3'],
  devServer: ['/usr/bin/ionice', '-c', '2', '-n', '7'],
  vm: ['/usr/bin/ionice', '-c', '2', '-n', '7'],
  tool: ['/usr/bin/ionice', '-c', '2', '-n', '7'],
  browser: ['/usr/bin/ionice', '-c', '2', '-n', '7'],
  terminal: ['/usr/bin/ionice', '-c', '2', '-n', '7']
}

describe('the prefix each lowered kind starts under', () => {
  it.each(LOWERED)('%s: ionice then nice on Linux, nice alone without ionice or on the Mac, nothing on Windows', (kind) => {
    expect(lowerPrefix(kind, 'linux', true)).toEqual([...IO[kind], ...NICE])
    expect(lowerPrefix(kind, 'linux', false)).toEqual(NICE)
    expect(lowerPrefix(kind, 'darwin')).toEqual(NICE)
    expect(lowerPrefix(kind, 'win32')).toEqual([])
  })

  it('puts the command after the prefix, and leaves it whole on Windows', () => {
    expect(lowerCommand('harness', '/bin/claude', ['-p'], 'darwin')).toEqual({ file: 'nice', args: ['-n', String(NICE_LEVEL), '/bin/claude', '-p'] })
    expect(lowerCommand('harness', 'claude.exe', ['-p'], 'win32')).toEqual({ file: 'claude.exe', args: ['-p'] })
  })
})

/** Every site the host lowers, and the kind it lowers by: a site that stops calling the module fails here. */
const SITES: [file: string, kind: LoweredKind][] = [
  ['src/main/server/drivers/claudeWarm.ts', 'harness'],
  ['src/main/server/drivers/codex.ts', 'harness'],
  ['src/main/server/drivers/cursor.ts', 'harness'],
  ['src/main/server/drivers/harness/child.ts', 'harness'],
  ['src/main/server/drivers/harness/museHost.ts', 'harness'],
  ['src/main/server/addons/downstream.ts', 'mcp'],
  ['src/main/server/gateRun.ts', 'job'],
  ['src/main/server/hostJobs.ts', 'job'],
  ['src/main/server/batch.ts', 'job'],
  ['src/main/server/build.ts', 'job'],
  ['src/main/server/lsp.ts', 'job'],
  ['src/main/server/remote/macRunner.ts', 'job'],
  ['src/main/server/remote/macJobs.ts', 'job'],
  ['src/main/server/devRuns.ts', 'devServer'],
  ['src/main/server/work/winvm/machine/daemons.ts', 'vm'],
  ['src/main/server/work/slides/resident.ts', 'tool'],
  ['src/main/server/work/slides/deckResident.ts', 'tool'],
  ['src/main/server/work/sheets/fullEditor/docservice.ts', 'tool'],
  ['src/main/server/work/meetings/pipeline.ts', 'tool'],
  ['src/main/server/work/browser/box/display.ts', 'browser'],
  ['src/main/server/work/browser/box/chromium.ts', 'browser'],
  ['src/main/server/work/browser/box/engine.ts', 'browser'],
  ['src/main/pty.ts', 'terminal']
]

describe('the lowered sites', () => {
  it.each(SITES)('%s starts its child through the module as %s', (file, kind) => {
    expect(readFileSync(file, 'utf8')).toMatch(new RegExp(`(spawnLowered|lowerCommand)\\('${kind}'`))
  })

  it('covers every kind', () => {
    expect(new Set(SITES.map(([, kind]) => kind))).toEqual(new Set(LOWERED))
  })

  it('holds every harness driver: one that starts a process lowers it', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : []))
    const spawning = walk('src/main/server/drivers').filter((f) => {
      const text = readFileSync(f, 'utf8')
      return /import \{[^}]*\bspawn\b[^}]*\} from 'node:child_process'/.test(text) || /spawnMspConnection\(/.test(text)
    })
    expect(spawning.length).toBeGreaterThan(0)
    for (const f of spawning) expect(readFileSync(f, 'utf8'), f).toMatch(/(spawnLowered|lowerCommand)\('harness'/)
  })
})

describe('the cgroup split', () => {
  let dir: string
  const SERVICE = '/agents.slice/temp-code.service'

  /** A cgroup mount shaped like the box's, the server in `<service>/server` when delegated. */
  function mount(selfPath: string): { root: string; self: string; service: string } {
    dir = mkdtempSync(join(tmpdir(), 'tc-cgroup-'))
    const root = join(dir, 'cgroup')
    const service = join(root, SERVICE)
    mkdirSync(join(service, 'server'), { recursive: true })
    writeFileSync(join(service, 'cgroup.controllers'), 'cpu io memory pids\n')
    writeFileSync(join(service, 'cgroup.subtree_control'), '')
    const self = join(dir, 'self-cgroup')
    writeFileSync(self, `0::${selfPath}\n`)
    return { root, self, service }
  }
  const files = (d: string): string[] => (existsSync(d) ? readdirSync(d, { recursive: true }).map(String).sort() : [])

  afterEach(() => {
    setupCgroupSplit({ platform: 'darwin' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('delegated: enables the controllers, makes jobs, weighs the two, and moves a lowered child', () => {
    const { root, self, service } = mount(`${SERVICE}/server`)
    const procs = setupCgroupSplit({ root, self, platform: 'linux', log: () => {} })
    expect(procs).toBe(join(service, 'jobs', 'cgroup.procs'))
    expect(readFileSync(join(service, 'cgroup.subtree_control'), 'utf8')).toBe('+cpu +memory +io')
    expect(readFileSync(join(service, 'server', 'cpu.weight'), 'utf8')).toBe('1000')
    expect(readFileSync(join(service, 'server', 'memory.low'), 'utf8')).toBe('4294967296')
    expect(readFileSync(join(service, 'jobs', 'cpu.weight'), 'utf8')).toBe('100')
    expect(readFileSync(join(service, 'jobs', 'memory.high'), 'utf8')).toBe('81604378624')
    expect(SPLIT.jobs['memory.high']).toBe('81604378624')
    placeLowered(4242)
    expect(readFileSync(procs!, 'utf8')).toBe('4242')
  })

  it('skips a controller the parent lacks', () => {
    const { root, self, service } = mount(`${SERVICE}/server`)
    writeFileSync(join(service, 'cgroup.controllers'), 'cpu memory pids\n')
    setupCgroupSplit({ root, self, platform: 'linux', log: () => {} })
    expect(readFileSync(join(service, 'cgroup.subtree_control'), 'utf8')).toBe('+cpu +memory')
  })

  it('not delegated (the server in the service itself): reads, and writes nothing', () => {
    const { root, self } = mount(SERVICE)
    const before = files(root)
    expect(setupCgroupSplit({ root, self, platform: 'linux' })).toBeNull()
    placeLowered(4242)
    expect(files(root)).toEqual(before)
  })

  it('a parent it may not write: nothing written, no jobs made', () => {
    const { root, self, service } = mount(`${SERVICE}/server`)
    chmodSync(join(service, 'cgroup.subtree_control'), 0o444)
    const before = files(root)
    expect(setupCgroupSplit({ root, self, platform: 'linux' })).toBeNull()
    expect(files(root)).toEqual(before)
  })

  it('off Linux: nothing read or written', () => {
    const { root, self } = mount(`${SERVICE}/server`)
    const before = files(root)
    expect(setupCgroupSplit({ root, self, platform: 'darwin' })).toBeNull()
    expect(setupCgroupSplit({ root, self, platform: 'win32' })).toBeNull()
    expect(files(root)).toEqual(before)
  })

  it('a failed write is logged once and the host carries on', () => {
    const { root, self, service } = mount(`${SERVICE}/server`)
    rmSync(join(service, 'server'), { recursive: true })
    const lines: string[] = []
    expect(setupCgroupSplit({ root, self, platform: 'linux', log: (l) => lines.push(l) })).toBe(join(service, 'jobs', 'cgroup.procs'))
    expect(lines).toHaveLength(1)
  })

  it('a helper process joins the jobs main made, and writes nothing else', () => {
    const { root, self, service } = mount(`${SERVICE}/server`)
    expect(setupCgroupSplit({ root, self, platform: 'linux', joinOnly: true })).toBeNull()
    mkdirSync(join(service, 'jobs'))
    writeFileSync(join(service, 'jobs', 'cgroup.procs'), '')
    const before = files(root)
    expect(setupCgroupSplit({ root, self, platform: 'linux', joinOnly: true })).toBe(join(service, 'jobs', 'cgroup.procs'))
    expect(files(root)).toEqual(before)
    expect(readFileSync(join(service, 'cgroup.subtree_control'), 'utf8')).toBe('')
  })
})

describe('spawnLowered', () => {
  it('starts a missing path plain, so the caller still sees its ENOENT', async () => {
    const child = spawnLowered('harness')('/nonexistent/bin', [], { stdio: 'ignore' })
    await expect(new Promise((_, reject) => child.once('error', reject))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('starts a real command under the prefix, as itself', async () => {
    const child = spawnLowered('job')('/bin/sh', ['-c', 'cat /proc/self/stat 2>/dev/null || echo none'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()))
    await new Promise((resolve) => child.once('close', resolve))
    // /proc/<pid>/stat field 19 is the nice value (Linux); elsewhere the command only has to run.
    if (process.platform === 'linux') expect(Number(out.slice(out.lastIndexOf(')') + 2).split(' ')[16])).toBeGreaterThanOrEqual(NICE_LEVEL)
    else expect(out).not.toBe('')
  })
})
