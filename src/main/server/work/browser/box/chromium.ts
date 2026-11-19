import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * The box's one Chromium (docs/agents/work-browser.md "The box's browser"):
 * a real browser with a profile of its own under the Work data folder,
 * started only when Work needs it, stopped after ten idle minutes, held
 * under a memory cap, its DevTools bound to 127.0.0.1 alone. The box is
 * shared by every other thread, so there is exactly one, and it is never
 * started as root or with its sandbox off.
 */

export const IDLE_STOP_MS = 10 * 60_000
/** the whole tree's resident memory, browser and renderers together */
export const MEMORY_CAP_MB = 2048
const WATCH_MS = 15_000
const START_MS = 20_000

/** The newest Chromium this host has: TEMP_CODE_BOX_CHROMIUM, one on PATH, else Playwright's download. Null when none. */
export function findChromium(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  if (env.TEMP_CODE_BOX_CHROMIUM) return exists(env.TEMP_CODE_BOX_CHROMIUM) ? env.TEMP_CODE_BOX_CHROMIUM : null
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean))
    for (const name of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome']) if (exists(join(dir, name))) return join(dir, name)
  const cache = join(env.HOME || homedir(), '.cache', 'ms-playwright')
  let names: string[] = []
  try {
    names = readdirSync(cache)
  } catch {
    return null
  }
  const builds = names.flatMap((n) => (/^chromium-(\d+)$/.exec(n) ? [{ n, rev: Number(n.slice(9)) }] : [])).sort((a, b) => b.rev - a.rev)
  for (const { n } of builds)
    for (const sub of ['chrome-linux64', 'chrome-linux']) {
      const bin = join(cache, n, sub, 'chrome')
      if (exists(bin)) return bin
    }
  return null
}

/** The flags every launch carries: headless, its own profile, DevTools on loopback, small renderers. */
export function chromiumArgs(profile: string): string[] {
  return [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-sync',
    '--renderer-process-limit=4',
    '--js-flags=--max-old-space-size=512',
    '--window-size=1280,800',
    '--lang=en-US',
    'about:blank'
  ]
}

/** Resident memory of `pid` and every process under it, in MB, read from /proc. */
export function treeRssMb(pid: number, proc = '/proc'): number {
  const children = new Map<number, number[]>()
  const rss = new Map<number, number>()
  for (const name of readdirSync(proc)) {
    if (!/^\d+$/.test(name)) continue
    try {
      const status = readFileSync(join(proc, name, 'status'), 'utf8')
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0)
      rss.set(Number(name), Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0))
      children.set(ppid, [...(children.get(ppid) ?? []), Number(name)])
    } catch {
      // gone between the listing and the read
    }
  }
  let kb = 0
  const walk = [pid]
  for (let p = walk.pop(); p !== undefined; p = walk.pop()) {
    kb += rss.get(p) ?? 0
    walk.push(...(children.get(p) ?? []))
  }
  return Math.round(kb / 1024)
}

export interface BoxChromiumOptions {
  /** <dataDir>/work-browser/box: the profile lives in `profile/` under it */
  root: string
  bin?: () => string | null
  capMb?: number
  idleMs?: number
  spawn?: typeof nodeSpawn
  rssMb?: (pid: number) => number
  /** how often the cap is checked */
  watchMs?: number
  /** something waits on a page (a held step): the idle stop waits too */
  busy?: () => boolean
  log?: (line: string) => void
}

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

export class BoxChromium {
  private child: ChildProcess | null = null
  private starting: Promise<string> | null = null
  private ws: string | null = null
  private idle: ReturnType<typeof setTimeout> | null = null
  private watch: ReturnType<typeof setInterval> | null = null
  private readonly stopped = new Set<(why: string) => void>()
  /** the last browser's exit: a new one never opens the profile while the old one still writes it */
  private exiting: Promise<void> = Promise.resolve()
  /** moved by every stop: a start that a stop overtook does not go on to launch */
  private generation = 0

  constructor(private readonly opts: BoxChromiumOptions) {}

  get profile(): string {
    return join(this.opts.root, 'profile')
  }
  get pid(): number | null {
    return this.running ? (this.child?.pid ?? null) : null
  }
  get running(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null
  }
  /** Why this host has no browser, or null. */
  unavailable(): string | null {
    if (process.platform !== 'linux') return 'the box browser runs on Linux'
    return (this.opts.bin ?? findChromium)() ? null : 'no Chromium on this host'
  }

  /** The browser's DevTools address, starting it first when it is not running. Every call counts as use. */
  async endpoint(): Promise<string> {
    this.touch()
    if (this.running && this.ws) return this.ws
    this.starting ??= this.start().finally(() => (this.starting = null))
    return this.starting
  }

  /** Use: the idle stop waits ten minutes from now. */
  touch(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => (this.opts.busy?.() ? this.touch() : void this.stop('idle')), this.opts.idleMs ?? IDLE_STOP_MS)
    this.idle.unref?.()
  }

  /** Told once per stop, with why: `idle`, `memory`, `exited`, `asked`. */
  onStop(fn: (why: string) => void): () => void {
    this.stopped.add(fn)
    return () => this.stopped.delete(fn)
  }

  private async start(): Promise<string> {
    const bin = (this.opts.bin ?? findChromium)()
    if (!bin) throw new Error('no Chromium on this host')
    const generation = this.generation
    await this.exiting
    if (generation !== this.generation) throw new Error('the box browser was stopped as it started')
    // His sessions live here: no other user of the box reads them.
    mkdirSync(this.opts.root, { recursive: true, mode: 0o700 })
    mkdirSync(this.profile, { recursive: true, mode: 0o700 })
    const portFile = join(this.profile, 'DevToolsActivePort')
    rmSync(portFile, { force: true })
    // A crash leaves the profile locked to the old pid; nothing else uses this profile, so the lock is ours to clear.
    for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(join(this.profile, lock), { force: true })
    const child = (this.opts.spawn ?? nodeSpawn)(bin, chromiumArgs(this.profile), { stdio: 'ignore', detached: true })
    this.child = child
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = null
      this.ws = null
      this.clear()
      this.tell('exited')
    })
    const until = Date.now() + START_MS
    while (Date.now() < until) {
      if (!this.running) throw new Error('Chromium exited as it started')
      try {
        const [port, path] = readFileSync(portFile, 'utf8').split('\n')
        if (port && path) {
          this.ws = `ws://127.0.0.1:${port.trim()}${path.trim()}`
          break
        }
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!this.ws) {
      void this.stop('asked')
      throw new Error('Chromium did not open DevTools in time')
    }
    this.opts.log?.(`box browser: started (pid ${child.pid})`)
    this.touch()
    const cap = this.opts.capMb ?? MEMORY_CAP_MB
    this.watch = setInterval(() => {
      const mb = this.child?.pid ? (this.opts.rssMb ?? treeRssMb)(this.child.pid) : 0
      if (mb > cap) {
        this.opts.log?.(`box browser: ${mb} MB is over its ${cap} MB cap; stopped`)
        void this.stop('memory')
      }
    }, this.opts.watchMs ?? WATCH_MS)
    this.watch.unref?.()
    return this.ws
  }

  /** Stops the whole browser, its renderers with it; resolves when it has exited. */
  stop(why: 'idle' | 'memory' | 'asked' = 'asked'): Promise<void> {
    this.generation++
    const child = this.child
    this.child = null
    this.ws = null
    this.clear()
    if (!child?.pid) return this.exiting
    const pid = child.pid
    const main = new Promise<void>((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', () => r())))
    // Its helpers (zygote, renderers) outlive the browser for a moment and still hold the profile: the stop ends when the whole group has.
    const exited = main.then(async () => {
      for (let i = 0; i < 100 && groupAlive(pid); i++) await new Promise((r) => setTimeout(r, 50))
    })
    this.exiting = exited
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // gone
      }
    }, 3_000).unref?.()
    this.opts.log?.(`box browser: stopped (${why})`)
    this.tell(why)
    return exited
  }

  private clear(): void {
    if (this.idle) clearTimeout(this.idle)
    if (this.watch) clearInterval(this.watch)
    this.idle = this.watch = null
  }
  private tell(why: string): void {
    for (const fn of this.stopped) fn(why)
  }
}
