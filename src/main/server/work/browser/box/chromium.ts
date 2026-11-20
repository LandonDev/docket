import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { BoxXDisplay, DISPLAY_SCALE, PAGE_HEIGHT, PAGE_WIDTH, displayEnv, type BoxDisplay } from './display'
import type { VideoTools } from './videoSetting'
import { BoxWindowManager } from './xwm'

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
    // A headed browser is handed its own display and nothing of this process's; a headless one needs none.
    const child = (this.opts.spawn ?? nodeSpawn)(bin, args, { stdio: 'ignore', detached: true, ...(pair ? { env: displayEnv(pair) } : {}) })
    this.child = child
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = null
      this.ws = null
      this.clear()
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
    this.opts.log?.(`box browser: started ${pair ? `headed on ${pair.DISPLAY}` : 'headless'} (pid ${child.pid})`)
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

  private clear(): void {
    if (this.idle) clearTimeout(this.idle)
    if (this.watch) clearInterval(this.watch)
    this.idle = this.watch = null
  }
  private tell(why: string): void {
    for (const fn of this.stopped) fn(why)
  }
}
