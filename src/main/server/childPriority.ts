import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { NICE_LEVEL } from '@shared/bashMarks'

/**
 * The server outranks what it starts (docs/box.md "Child priority"). Every
 * long-lived or heavy child of these kinds starts under `nice -n 10` and,
 * on Linux, `ionice`; both exec their target, so the pid and /proc cmdline
 * are the child's own, and its children inherit the lower priority. On the
 * Mac only `nice`; on Windows nothing (no `nice` there).
 *
 * What stays at the server's priority (the exec broker, the gateway, the
 * Work service, the sheet worker, the add-on host) says why where it starts.
 */
export const LOWERED = ['harness', 'mcp', 'job', 'devServer', 'vm', 'tool', 'browser', 'terminal'] as const
export type LoweredKind = (typeof LOWERED)[number]

/**
 * Jobs (gates, builds, releases, batch steps) take the idle I/O class: disk
 * only when nothing else wants it. Every other kind has a person waiting on
 * it as it runs (a turn, a terminal, a VM, a page, a slide's picture), so it
 * takes best-effort level 7, the lowest that still gets a turn: a busy disk
 * slows it but never stalls it outright.
 */
const IDLE_IO: readonly LoweredKind[] = ['job']

const IONICE = '/usr/bin/ionice'
let ioniceHere: boolean | undefined
const hasIonice = (): boolean => (ioniceHere ??= existsSync(IONICE))

/** The argv a kind's child starts under, before its own command. */
export function lowerPrefix(kind: LoweredKind, platform: NodeJS.Platform = process.platform, ionice: boolean = platform === 'linux' && hasIonice()): string[] {
  if (platform === 'win32') return []
  const io = ionice ? [IONICE, '-c', ...(IDLE_IO.includes(kind) ? ['3'] : ['2', '-n', '7'])] : []
  return [...io, 'nice', '-n', String(NICE_LEVEL)]
}

/** A command as it starts lowered: the prefix's first word becomes the file. */
export function lowerCommand(kind: LoweredKind, file: string, args: readonly string[], platform?: NodeJS.Platform): { file: string; args: string[] } {
  const [first, ...rest] = lowerPrefix(kind, platform)
  return first ? { file: first, args: [...rest, file, ...args] } : { file, args: [...args] }
}

/**
 * node's `spawn`, lowered: the kind's prefix, and the child moved into the
 * jobs cgroup when the split is on. Every lowered site starts its child
 * through this (a site that takes a spawn function uses it as the default,
 * so a test that hands its own sees the plain argv).
 */
export function spawnLowered(kind: LoweredKind): typeof nodeSpawn {
  return ((file: string, args?: unknown, options?: unknown) => {
    const plain = Array.isArray(args)
    const argv = plain ? (args as string[]) : []
    const opts = ((plain ? options : args) ?? {}) as SpawnOptions
    // A path that is not there starts plain, so its ENOENT reaches the caller as before (under nice it would be an exit 127).
    const missing = file.includes('/') && !existsSync(resolve(String(opts.cwd ?? ''), file))
    const c = missing ? { file, args: argv } : lowerCommand(kind, file, argv)
    const child = nodeSpawn(c.file, c.args, opts)
    placeLowered(child.pid)
    return child
  }) as typeof nodeSpawn
}

// ── the cgroup split: inert until root delegates ───────────────────────

/**
 * With a root drop-in on temp-code.service (`Delegate=cpu memory pids io`,
 * `DelegateSubgroup=server`; .temp-code/plans/landed/F-box-slow/root-change.md)
 * the server's tree sits in `<service>/server` and the agents user owns
 * `<service>`. Then the server makes `<service>/jobs` beside it, weighs
 * itself ten to one over it, keeps 4 GiB of its own memory from reclaim,
 * caps the jobs at 76 GiB, and moves every lowered child into it. Without
 * the delegation (today's box, the Mac, Windows) nothing is read past
 * /proc/self/cgroup and nothing is written.
 */
export const SPLIT = {
  server: { 'cpu.weight': '1000', 'memory.low': String(4 * 1024 ** 3) },
  jobs: { 'cpu.weight': '100', 'memory.high': String(76 * 1024 ** 3) },
  controllers: ['cpu', 'memory', 'io']
} as const

let jobsProcs: string | null = null
let warned = false
let warn: (line: string) => void = (line) => console.warn(line)

/** Best effort: the first failure is logged, later ones are not; the host carries on with nice and ionice alone. */
function attempt(what: string, fn: () => void): boolean {
  try {
    fn()
    return true
  } catch (err) {
    if (!warned) warn(`[childPriority] ${what}: ${(err as Error).message}; children keep nice and ionice alone`)
    warned = true
    return false
  }
}

export interface SplitOptions {
  /** The cgroup v2 mount; a test hands a temp dir shaped like it. */
  root?: string
  /** /proc/self/cgroup, or a test's copy. */
  self?: string
  platform?: NodeJS.Platform
  log?: (line: string) => void
  /** A helper process (the add-on host): find the jobs cgroup main made, and write nothing but its children's pids. */
  joinOnly?: boolean
}

/** At boot: sets up the jobs cgroup when the service is delegated; its cgroup.procs, else null (and nothing written). */
export function setupCgroupSplit(o: SplitOptions = {}): string | null {
  jobsProcs = null
  warned = false
  if (o.log) warn = o.log
  if ((o.platform ?? process.platform) !== 'linux') return null
  let path: string | undefined
  try {
    path = /^0::(\/.*)$/m.exec(readFileSync(o.self ?? '/proc/self/cgroup', 'utf8'))?.[1]?.trim()
  } catch {
    return null
  }
  if (!path?.endsWith('/server')) return null
  const server = join(o.root ?? '/sys/fs/cgroup', path)
  const parent = dirname(server)
  try {
    accessSync(join(parent, 'cgroup.subtree_control'), constants.W_OK)
  } catch {
    return null
  }
  const jobs = join(parent, 'jobs')
  if (o.joinOnly) return (jobsProcs = existsSync(join(jobs, 'cgroup.procs')) ? join(jobs, 'cgroup.procs') : null)
  const have = attemptRead(join(parent, 'cgroup.controllers')).split(/\s+/)
  const enable = SPLIT.controllers.filter((c) => have.includes(c))
  if (enable.length) attempt('enabling controllers', () => writeFileSync(join(parent, 'cgroup.subtree_control'), enable.map((c) => `+${c}`).join(' ')))
  if (!attempt('making the jobs cgroup', () => mkdirSync(jobs, { recursive: true }))) return null
  for (const [file, value] of Object.entries(SPLIT.server)) attempt(`server/${file}`, () => writeFileSync(join(server, file), value))
  for (const [file, value] of Object.entries(SPLIT.jobs)) attempt(`jobs/${file}`, () => writeFileSync(join(jobs, file), value))
  jobsProcs = join(jobs, 'cgroup.procs')
  return jobsProcs
}

function attemptRead(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** Moves a lowered child into the jobs cgroup (what it forks later follows); nothing while the split is off. */
export function placeLowered(pid: number | null | undefined): void {
  if (!jobsProcs || !pid) return
  const file = jobsProcs
  attempt(`moving pid ${pid} into jobs`, () => writeFileSync(file, String(pid)))
}
