import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnLowered } from '../../../childPriority'
import { BoxXDisplay, DISPLAY_SCALE, PAGE_HEIGHT, PAGE_WIDTH, displayEnv, type BoxDisplay } from './display'
import type { VideoTools } from './videoSetting'
import { BoxWindowManager } from './xwm'
import type { TempCodeOrigins } from '../../../remote/tempcodeOrigins'
import { startOriginProxy } from './originProxy'
import { Cdp } from './cdp'
import { clearTempCodeLogins } from './logins'

/**
 * The box's one Chromium (docs/agents/work-browser.md "The box's browser"):
 * a real browser with a profile of its own under the Work data folder,
 * started only when Work needs it, stopped after ten idle minutes, held
 * under a memory cap, its DevTools bound to 127.0.0.1 alone. The box is
 * shared by every other thread, so there is exactly one, and it is never
 * started as root or with its sandbox off.
 *
 * With the video tools installed and `work.browser.video` not off it runs
 * headed on a private display (display.ts), so the engine can capture what it
 * draws; else headless, as it did before video. A display that will not start
 * is not an error: the browser starts headless and the picture is the JPEG one.
 */

export const IDLE_STOP_MS = 10 * 60_000
/** the whole tree's resident memory, browser and renderers together */
export const MEMORY_CAP_MB = 2048
const WATCH_MS = 15_000
/** how far past its cap the browser may go while an operation holds it */
export const HOLD_CEILING = 1.5
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

/**
 * The flags every launch carries: its own profile, DevTools on loopback, small
 * renderers; headless, or headed on the private display:
 * - a window that is covered keeps painting, so a page under the watched one
 *   still answers its screencast and its captures
 * - no offer to restore pages after the browser was killed
 * - a Chrome for Testing build draws a bar that says so in every window, full
 *   screen too; `--test-type=gpu` is the one switch that leaves it out (a bare
 *   `--test-type` does not), so only such a build gets it
 * - it draws at the display's scale, so a page lays out at 1280×800 on a
 *   display of more pixels than that
 */
export function chromiumArgs(profile: string, headed?: { testing: boolean; scale?: number }): string[] {
  return [
    ...(headed
      ? [
          '--window-position=0,0',
          '--disable-backgrounding-occluded-windows',
          '--hide-crash-restore-bubble',
          `--force-device-scale-factor=${headed.scale ?? 1}`,
          ...(headed.testing ? ['--test-type=gpu'] : [])
        ]
      : ['--headless=new']),
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
    `--window-size=${PAGE_WIDTH},${PAGE_HEIGHT}`,
    '--lang=en-US',
    'about:blank'
  ]
}

/** Chromium's "block" for a site permission. */
const BLOCK = 2

/**
 * What a headed browser would otherwise put on the screen or keep, turned off
 * in the profile (headless shows none of it):
 * - no password is offered to be saved and none is filled, so one he types
 *   while he drives is never kept for the agent to submit
 * - no address or card is saved or filled
 * - every permission a page can ask for is refused without a prompt
 * - a download lands in the browser's own folder without a dialog
 * - no sign-in to the browser itself, no translate bubble
 * - the last exit reads as clean, so nothing offers to restore its pages
 */
export function headedPrefs(downloads: string): Record<string, unknown> {
  return {
    credentials_enable_service: false,
    credentials_enable_autosignin: false,
    profile: {
      password_manager_leak_detection: false,
      exit_type: 'Normal',
      exited_cleanly: true,
      default_content_setting_values: Object.fromEntries(HEADED_BLOCKED.map((name) => [name, BLOCK]))
    },
    autofill: { profile_enabled: false, credit_card_enabled: false },
    download: { prompt_for_download: false, default_directory: downloads, directory_upgrade: true },
    signin: { allowed: false, allowed_on_next_startup: false },
    translate: { enabled: false }
  }
}
/** The permissions a page would raise a prompt for. */
export const HEADED_BLOCKED = [
  'notifications',
  'geolocation',
  'media_stream_mic',
  'media_stream_camera',
  'midi_sysex',
  'clipboard',
  'idle_detection',
  'window_placement',
  'local_fonts',
  'usb_guard',
  'serial_guard',
  'hid_guard',
  'bluetooth_guard',
  'file_system_write_guard',
  'file_system_read_guard',
  'automatic_downloads',
  'sensors',
  'ar',
  'vr',
  'captured_surface_control',
  'keyboard_lock',
  'pointer_lock'
] as const

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** `over` laid on `base`, object by object: what the profile already holds beside it stays. */
export function mergePrefs(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(over)) out[key] = isObject(value) && isObject(out[key]) ? mergePrefs(out[key] as Record<string, unknown>, value) : value
  return out
}

/** Writes the headed browser's preferences into the profile before it starts; a file that is not JSON is replaced. */
export function writeHeadedPrefs(profile: string, downloads: string): void {
  const dir = join(profile, 'Default')
  const file = join(dir, 'Preferences')
  let kept: Record<string, unknown> = {}
  try {
    const read: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (isObject(read)) kept = read
  } catch {
    // a new profile, or a file cut short by a kill
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  mkdirSync(downloads, { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(mergePrefs(kept, headedPrefs(downloads))), { mode: 0o600 })
  // a file that was already there keeps its old mode through the write
  chmodSync(file, 0o600)
  writeFileSync(join(dir, HEADED_MARK), '', { mode: 0o600 })
}

/** Beside the preferences while they hold what a headed start wrote. */
const HEADED_MARK = '.tc-headed-prefs'

/** `prefs` without every leaf `drop` names: the browser then reads its own default for each. */
export function withoutPrefs(prefs: Record<string, unknown>, drop: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prefs }
  for (const [key, value] of Object.entries(drop)) {
    if (!(key in out)) continue
    if (isObject(value) && isObject(out[key])) {
      const inner = withoutPrefs(out[key] as Record<string, unknown>, value)
      if (Object.keys(inner).length) out[key] = inner
      else delete out[key]
    } else delete out[key]
  }
  return out
}

/**
 * A headless start after a headed one takes back what the headed start wrote
 * into the profile, so the browser is as it was before video: each of those
 * preferences returns to the browser's own default.
 */
export function clearHeadedPrefs(profile: string): void {
  const dir = join(profile, 'Default')
  const mark = join(dir, HEADED_MARK)
  if (!existsSync(mark)) return
  const file = join(dir, 'Preferences')
  try {
    const read: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (isObject(read)) writeFileSync(file, JSON.stringify(withoutPrefs(read, headedPrefs(''))), { mode: 0o600 })
  } catch {
    // no preferences to take anything out of
  }
  rmSync(mark, { force: true })
}

/** True for a Chrome for Testing build, by what the binary says of itself. */
export function isChromeForTesting(bin: string): Promise<boolean> {
  return new Promise((resolve) => execFile(bin, ['--version'], { timeout: 10_000 }, (err, stdout) => resolve(!err && /for testing/i.test(stdout))))
}

/** The reads the memory watch makes of /proc: a test counts them. */
export interface ProcFiles {
  readFile(path: string): Promise<string>
  readdir(path: string): Promise<string[]>
}
const PROC_FILES: ProcFiles = { readFile: (path) => readFile(path, 'utf8'), readdir: (path) => readdir(path) }
/** Reads of /proc in flight at once, as the guard's scan keeps (procScan.ts): the pool stays free for the rest. */
const PROC_READS = 2

async function inTurns<T>(items: readonly T[], width: number, each: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const run = async (): Promise<void> => {
    while (next < items.length) await each(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, run))
}

/**
 * `pid` and every process under it, found from the tree itself: each process's threads list their own children
 * (`/proc/<pid>/task/<tid>/children`; Chromium starts its processes from a launcher thread, so every thread is
 * asked). Only the tree is read, never every process on the machine. Where a kernel keeps no children lists the
 * parents are read from one pass over `status`.
 */
export async function treePids(pid: number, proc = '/proc', files: ProcFiles = PROC_FILES): Promise<number[]> {
  const seen = new Set<number>([pid])
  let listed = false
  for (let level = [pid]; level.length;) {
    const next: number[] = []
    await inTurns(level, PROC_READS, async (parent) => {
      const tasks = await files.readdir(join(proc, String(parent), 'task')).catch(() => [] as string[])
      await inTurns(tasks, PROC_READS, async (tid) => {
        let text: string
        try {
          text = await files.readFile(join(proc, String(parent), 'task', tid, 'children'))
        } catch {
          return
        }
        listed = true
        for (const word of text.split(/\s+/)) {
          const child = Number(word)
          if (child > 0 && !seen.has(child)) {
            seen.add(child)
            next.push(child)
          }
        }
      })
    })
    level = next
  }
  if (listed) return [...seen]
  // No children lists here: every process's parent, once.
  const children = new Map<number, number[]>()
  const names = (await files.readdir(proc).catch(() => [] as string[])).filter((name) => /^\d+$/.test(name))
  await inTurns(names, PROC_READS, async (name) => {
    try {
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(await files.readFile(join(proc, name, 'status')))?.[1] ?? 0)
      children.set(ppid, [...(children.get(ppid) ?? []), Number(name)])
    } catch {
      // gone between the listing and the read
    }
  })
  const tree = [pid]
  for (let i = 0; i < tree.length; i++) for (const child of children.get(tree[i]!) ?? []) if (!tree.includes(child)) tree.push(child)
  return tree
}

/**
 * Memory of `pid` and every process under it, in MB, read from /proc: each process's proportional share (Pss in
 * smaps_rollup), so a page Chromium's processes share counts once among them, not once a process as VmRSS does
 * (a headed browser with three pages read 2,053 MB of RSS at about half that of Pss, and was stopped mid-make).
 * VmRSS where a kernel has no smaps_rollup. Every read is asynchronous and of the tree's own processes alone: the
 * synchronous pass over every process on the box held the server's loop for 1.2 s each 15 s (docs/box.md).
 */
export async function treeRssMb(pid: number, proc = '/proc', files: ProcFiles = PROC_FILES): Promise<number> {
  let kb = 0
  await inTurns(await treePids(pid, proc, files), PROC_READS, async (member) => {
    try {
      const pss = /^Pss:\s+(\d+)/m.exec(await files.readFile(join(proc, String(member), 'smaps_rollup')))
      if (pss) return void (kb += Number(pss[1]))
    } catch {
      // no smaps_rollup here, or not ours to read
    }
    try {
      // Read first, then add: two readers run at once, and a sum taken before the wait would lose the other's.
      const status = await files.readFile(join(proc, String(member), 'status'))
      kb += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0)
    } catch {
      // gone between the listing and the read
    }
  })
  return Math.round(kb / 1024)
}

export interface BoxChromiumOptions {
  /** <dataDir>/work-browser/box: the profile lives in `profile/` under it */
  root: string
  origins?: () => TempCodeOrigins
  bin?: () => string | null
  capMb?: number
  idleMs?: number
  spawn?: typeof nodeSpawn
  rssMb?: (pid: number) => number | Promise<number>
  /** how often the cap is checked */
  watchMs?: number
  /** something waits on a page (a held step): the idle stop waits too */
  busy?: () => boolean
  /**
   * An operation runs on its pages now (the Forms carrier's make, a call in flight): over the cap, the memory stop
   * waits for it to end, up to HOLD_CEILING times the cap, so a make is not cut part way (P5: a stop at its title step
   * left a form in Forms with no row).
   */
  holding?: () => boolean
  /** The video tools, when they are installed and the setting is on: the browser then starts headed. Asked at every start. */
  video?: () => VideoTools | null
  /** a Chrome for Testing build gets the switch that hides its bar; `isChromeForTesting` by default */
  testing?: (bin: string) => Promise<boolean>
  /** the private display a headed browser draws on; a `BoxXDisplay` on the tools by default */
  makeDisplay?: (tools: VideoTools) => Pick<BoxXDisplay, 'start' | 'stop' | 'env' | 'scale'>
  /** the display's pixels for each of a page's, for the default display; DISPLAY_SCALE by default */
  scale?: number
  /** takes that display in hand before the browser draws on it; `BoxWindowManager.start` by default */
  manage?: (display: BoxDisplay, log: (line: string) => void) => Promise<BoxWindowManager>
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
  private proxy: Awaited<ReturnType<typeof startOriginProxy>> | null = null
  refusedRequests = 0
  private starting: Promise<string> | null = null
  private ws: string | null = null
  private idle: ReturnType<typeof setTimeout> | null = null
  private watch: ReturnType<typeof setInterval> | null = null
  private readonly stopped = new Set<(why: string) => void>()
  /** the last browser's exit: a new one never opens the profile while the old one still writes it */
  private exiting: Promise<void> = Promise.resolve()
  /** moved by every stop: a start that a stop overtook does not go on to launch */
  private generation = 0
  /** the private display of a headed browser, for exactly as long as that browser runs */
  private xdisplay: Pick<BoxXDisplay, 'start' | 'stop' | 'env' | 'scale'> | null = null
  private videoTools: VideoTools | null = null
  private manager: BoxWindowManager | null = null

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
  /** The display a headed browser draws on, while it runs; null for a headless one. */
  get display(): BoxDisplay | null {
    return this.running ? (this.xdisplay?.env ?? null) : null
  }
  /** The window manager of that display: what decides which of the browser's windows is on top of it. */
  get wm(): BoxWindowManager | null {
    return this.display ? this.manager : null
  }
  /** The display's pixels for each of a page's: the headed browser's scale, 1 when headless. */
  get scale(): number {
    return this.display ? (this.xdisplay?.scale ?? 1) : 1
  }
  /** The tools the running headed browser was started with. */
  get tools(): VideoTools | null {
    return this.display ? this.videoTools : null
  }
  /** Why this host has no browser, or null. */
  unavailable(): string | null {
    if (process.platform !== 'linux') return 'the box browser runs on Linux'
    return (this.opts.bin ?? findChromium)() ? null : 'no Chromium on this host'
  }

  /** The browser's DevTools address, starting it first when it is not running. Every call counts as use. */
  async endpoint(): Promise<string> {
    this.touch()
    if (this.starting) return this.starting
    if (this.running && this.ws) return this.ws
    this.starting = this.start().finally(() => (this.starting = null))
    return this.starting
  }

  refreshOriginFence(): void {
    this.proxy?.refresh()
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
    const pair = await this.startDisplay()
    if (generation !== this.generation) {
      await this.stopDisplay()
      throw new Error('the box browser was stopped as it started')
    }
    let args = chromiumArgs(this.profile)
    if (pair) {
      writeHeadedPrefs(this.profile, join(this.opts.root, 'downloads'))
      args = chromiumArgs(this.profile, { testing: await (this.opts.testing ?? isChromeForTesting)(bin), scale: this.xdisplay?.scale ?? 1 })
      // the binary was asked what it is: a stop that came meanwhile still means no launch
      if (generation !== this.generation) {
        await this.stopDisplay()
        throw new Error('the box browser was stopped as it started')
      }
    } else clearHeadedPrefs(this.profile)
    if (this.opts.origins) {
      try {
        this.proxy = await startOriginProxy(this.opts.origins, () => this.refusedRequests++)
        if (generation !== this.generation) throw new Error('the box browser was stopped as it started')
        args.unshift(
          `--proxy-server=socks5://127.0.0.1:${this.proxy.port}`,
          '--proxy-bypass-list=<-loopback>',
          '--disable-quic',
          '--disable-http2',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
        )
      } catch (error) {
        this.closeProxy()
        await this.stopDisplay()
        throw error
      }
    }
    // A headed browser is handed its own display and nothing of this process's; a headless one needs none.
    // The browser runs below the server (childPriority.ts).
    const child = (this.opts.spawn ?? spawnLowered('browser'))(bin, args, { stdio: 'ignore', detached: true, ...(pair ? { env: displayEnv(pair) } : {}) })
    this.child = child
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = null
      this.ws = null
      this.clear()
      this.closeProxy()
      // the next start waits for this: a new display must not write its cookie where the old one is still being removed
      this.exiting = this.exiting.then(() => this.stopDisplay())
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
    if (this.opts.origins) {
      try {
        const cdp = await Cdp.open(this.ws)
        try {
          await clearTempCodeLogins(cdp)
        } finally {
          cdp.close()
        }
        if (generation !== this.generation) throw new Error('the box browser was stopped as it started')
      } catch (error) {
        await this.stop()
        throw error
      }
    }
    this.opts.log?.(`box browser: started ${pair ? `headed on ${pair.DISPLAY}` : 'headless'} (pid ${child.pid})`)
    this.touch()
    const cap = this.opts.capMb ?? MEMORY_CAP_MB
    // One read at a time: a tick that finds the last read still out is passed over.
    let reading = false
    this.watch = setInterval(() => {
      const pid = this.child?.pid
      if (!pid || reading) return
      reading = true
      void Promise.resolve((this.opts.rssMb ?? treeRssMb)(pid))
        .then((mb) => {
          // The browser that was read is the one that is stopped: never one started since.
          if (this.child?.pid !== pid || mb <= cap) return
          if (mb <= cap * HOLD_CEILING && this.opts.holding?.()) return
          this.opts.log?.(`box browser: ${mb} MB is over its ${cap} MB cap; stopped`)
          void this.stop('memory')
        })
        .catch(() => undefined)
        .finally(() => {
          reading = false
        })
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
    this.closeProxy()
    if (!child?.pid) return this.exiting
    const pid = child.pid
    const main = new Promise<void>((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', () => r())))
    // Its helpers (zygote, renderers) outlive the browser for a moment and still hold the profile: the stop ends when the whole group has.
    // The display goes after them: it lives exactly as long as the browser does.
    const exited = main.then(async () => {
      for (let i = 0; i < 100 && groupAlive(pid); i++) await new Promise((r) => setTimeout(r, 50))
      await this.stopDisplay()
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

  /** The private display, when the tools are there and the setting is on. Null means headless: no tools, the setting off, or a display that would not start. */
  private async startDisplay(): Promise<BoxDisplay | null> {
    const tools = this.opts.video?.() ?? null
    if (!tools) return null
    const xdisplay = this.opts.makeDisplay?.(tools) ?? new BoxXDisplay({ root: this.opts.root, tools, scale: this.opts.scale ?? DISPLAY_SCALE, log: this.opts.log })
    try {
      const pair = await xdisplay.start()
      // nothing draws on the display before it has its window manager: the browser's first window is asked about too
      this.manager = await (this.opts.manage ?? BoxWindowManager.start)(pair, this.opts.log ?? (() => {}))
      this.xdisplay = xdisplay
      this.videoTools = tools
      return pair
    } catch (err) {
      await xdisplay.stop().catch(() => {})
      this.opts.log?.(`box browser: its display did not start (${(err as Error).message}); it runs headless`)
      return null
    }
  }

  private async stopDisplay(): Promise<void> {
    const xdisplay = this.xdisplay
    this.manager?.close()
    this.manager = null
    this.xdisplay = null
    this.videoTools = null
    await xdisplay?.stop()
  }

  private closeProxy(): void {
    this.proxy?.close()
    this.proxy = null
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
