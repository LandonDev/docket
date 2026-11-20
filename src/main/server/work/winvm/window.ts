import { execFile } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { BoxXDisplay, type BoxDisplay } from '../browser/box/display'
import { BoxEngines } from '../browser/box/engine'
import { VIDEO_TOOL, videoToolsAt, type VideoTools } from '../browser/box/videoSetting'
import { Toolchain } from '../formats/tools'
import { stopBlocked } from './machine/daemons'
import { VGA_DEFAULT, type VmWindow } from './machine/qemu'

/**
 * The Windows VM's picture on the box (docs/agents/live-video.md "The Windows
 * VM"): QEMU draws the guest's screen in its own GTK window on a private X
 * display of the VM's, at the guest's size, and screen-relay's engine
 * captures that display, one engine per viewer, three at most. The display
 * lives exactly as long as QEMU: QEMU's window dies with its X server, so the
 * server starts with the stop signals blocked, as QEMU does, and the stop
 * watcher ends it once QEMU has gone.
 *
 * Two tools: `qemu-window` (scripts/work-tools/winvm.json), QEMU's window
 * modules, and `screen-relay` (browser.json), the X server and the engine.
 * Without either the VM runs with no window and the page shows the 4 fps
 * picture of QMP's screenshots.
 */

export const WINDOW_TOOL = 'qemu-window'
/** Viewers of the VM at once: each has an engine of its own. */
export const VM_ENGINES = 3

/** QEMU's window modules: the folder QEMU_MODULE_DIR names (ui-gtk and ui-opengl alone) and the libraries they load. */
export interface WindowTools {
  modules: string
  libs: string
}

const chains = new Map<string, Toolchain>()

/** The installed window modules under `<dataDir>/work-tools`, or null. */
export function windowToolsAt(dataDir: string): WindowTools | null {
  let chain = chains.get(dataDir)
  if (!chain) chains.set(dataDir, (chain = new Toolchain(dataDir)))
  const gtk = chain.bin(WINDOW_TOOL)
  if (!gtk) return null
  // <tool>/mods/ui-gtk.so: the packages sit beside it, in <tool>/sys
  return { modules: dirname(gtk), libs: join(dirname(dirname(gtk)), 'sys', 'usr', 'lib', 'x86_64-linux-gnu') }
}

export type PictureTools = { window: WindowTools; video: VideoTools; missing: null } | { missing: string }

/** Both tools, or the name of the first one missing. */
export function pictureToolsAt(dataDir: string): PictureTools {
  const window = windowToolsAt(dataDir)
  if (!window) return { missing: WINDOW_TOOL }
  const video = videoToolsAt(dataDir)
  if (!video) return { missing: VIDEO_TOOL }
  return { window, video, missing: null }
}

/** What QEMU is started with to draw its window on the display: the pair, the modules and their libraries alone. */
export function windowEnv(display: BoxDisplay, window: WindowTools): Record<string, string> {
  return {
    DISPLAY: display.DISPLAY,
    XAUTHORITY: display.XAUTHORITY,
    QEMU_MODULE_DIR: window.modules,
    LD_LIBRARY_PATH: window.libs,
    GDK_BACKEND: 'x11',
    // no accessibility bus: there is no session for it, and GTK would wait on it
    NO_AT_BRIDGE: '1'
  }
}

const run = promisify(execFile)

/**
 * Whether the box's own QEMU loads the window modules. A module of another
 * QEMU build is refused, and a missing one stops the window silently, so this
 * asks QEMU before the machine starts: with no display GTK itself refuses,
 * which it does only once the module is loaded.
 */
export async function windowLoads(window: WindowTools): Promise<string | null> {
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', QEMU_MODULE_DIR: window.modules, LD_LIBRARY_PATH: window.libs }
  const out = await run('qemu-system-x86_64', ['-machine', 'none', '-nodefaults', '-display', 'gtk'], { env, timeout: 30_000 }).then(
    (r) => `${r.stdout}${r.stderr}`,
    (e: { stdout?: string; stderr?: string; message: string }) => `${e.stdout ?? ''}${e.stderr ?? e.message}`
  )
  return /gtk initialization failed/.test(out) ? null : `QEMU did not load its window: ${out.trim().split('\n').pop() ?? ''}`
}

/** The display a host left beside a running machine: its pair, its server and its size. */
interface Kept {
  display: BoxDisplay
  pid: number
  width: number
  height: number
}

export interface VmScreenOptions {
  /** <dataDir>/winvm/picture: the display's files, the engines' tokens */
  root: string
  tools: () => PictureTools
  /** the guest's screen; the std VGA's 1280×800 by default */
  size?: () => VmWindow
  /** a test's stand-in for QEMU's module check */
  loads?: (window: WindowTools) => Promise<string | null>
  log?: (line: string) => void
}

export class VmScreen {
  private display: BoxXDisplay | null = null
  /** a display a host before this one started for the machine that still runs */
  private kept: Kept | null = null
  /** why the last start had no window, in words; null when it had one */
  private why: string | null = null
  /** QEMU would not start with its window: every start runs without one until a host starts again */
  private refused: string | null = null
  readonly engines: BoxEngines

  constructor(private readonly o: VmScreenOptions) {
    this.engines = new BoxEngines({
      root: o.root,
      tools: () => {
        const t = o.tools()
        return t.missing === null ? t.video : null
      },
      display: () => this.env,
      max: VM_ENGINES,
      log: (line) => o.log?.(`winvm ${line}`)
    })
  }

  private get keptFile(): string {
    return join(this.o.root, 'display', 'kept.json')
  }

  /** The display's pair while it runs. */
  get env(): BoxDisplay | null {
    if (this.display?.env) return this.display.env
    return this.kept && alive(this.kept.pid, this.config) ? this.kept.display : null
  }

  /** Its size while it runs. */
  get size(): VmWindow | null {
    if (this.display?.env) return this.display.size
    return this.kept && this.env ? { width: this.kept.width, height: this.kept.height } : null
  }

  /** The server's pid while it runs: the stop watcher ends it once QEMU has gone. */
  get pid(): number | null {
    return this.display?.pid ?? (this.kept && this.env ? this.kept.pid : null)
  }

  get config(): string {
    return join(this.o.root, 'display', 'xorg.conf')
  }

  /** Why the machine has no window now (a tool missing, the display or QEMU's window refused); null when it has one. */
  get missing(): string | null {
    if (this.env) return null
    const t = this.o.tools()
    return t.missing !== null ? t.missing : this.why
  }

  /** The tool that is missing, by name, whatever ran last; null when both are installed. */
  get missingTool(): string | null {
    return this.o.tools().missing
  }

  /**
   * Starts the display for a machine about to start, and answers what QEMU
   * needs to draw on it; null when it runs with no window (a tool missing,
   * QEMU refusing the modules, a display that would not start).
   */
  async up(): Promise<{ window: VmWindow; env: Record<string, string> } | null> {
    await this.down()
    this.why = null
    const tools = this.o.tools()
    if (tools.missing !== null) return null
    if (this.refused) return this.windowless(this.refused)
    const refused = await (this.o.loads ?? windowLoads)(tools.window).catch((e: Error) => e.message)
    if (refused) return this.windowless(refused)
    const size = this.o.size?.() ?? VGA_DEFAULT
    const display = new BoxXDisplay({ root: this.o.root, tools: tools.video, size, command: stopBlocked, log: (line) => this.o.log?.(`winvm ${line}`) })
    try {
      const pair = await display.start()
      this.display = display
      writeFileSync(this.keptFile, JSON.stringify({ display: pair, pid: display.pid, ...size }), { mode: 0o600 })
      return { window: { ...size }, env: windowEnv(pair, tools.window) }
    } catch (e) {
      return this.windowless(`the display did not start: ${(e as Error).message}`)
    }
  }

  /** QEMU did not start with its window: it starts without one from now on, until a host starts again. */
  async broke(why: string): Promise<void> {
    this.refused = why
    this.windowless(why)
    await this.down()
  }

  /**
   * A host started beside a machine that runs: the display it was started on
   * is taken back, so its picture plays again. Nothing when there is none.
   */
  adopt(): void {
    if (this.display?.env || this.kept) return
    try {
      const k = JSON.parse(readFileSync(this.keptFile, 'utf8')) as Kept
      if (alive(k.pid, this.config)) this.kept = k
    } catch {
      // no display was kept
    }
  }

  /** QEMU has gone: every engine stops, then the display. */
  async down(): Promise<void> {
    await this.engines.stopAll()
    const display = this.display
    this.display = null
    if (display) await display.stop()
    const kept = this.kept
    this.kept = null
    if (kept && alive(kept.pid, this.config)) {
      try {
        process.kill(kept.pid, 'SIGKILL')
      } catch {
        // gone already
      }
    }
    rmSync(this.keptFile, { force: true })
  }

  private windowless(why: string): null {
    this.why = why
    this.o.log?.(`winvm: no window: ${why}`)
    return null
  }
}

/** A pid that is still the display server started on this config (a pid comes round again). */
function alive(pid: number, config: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(config)
  } catch {
    return false
  }
}

const screens = new Map<string, VmScreen>()

/** The one screen of a data folder's VM: it outlives the Work switch, as the machine does. */
export function vmScreen(dataDir: string, log?: (line: string) => void, size?: () => VmWindow): VmScreen {
  const sizes = screenSizes.get(dataDir) ?? { now: size }
  if (size) sizes.now = size
  screenSizes.set(dataDir, sizes)
  let s = screens.get(dataDir)
  if (!s) screens.set(dataDir, (s = new VmScreen({ root: join(dataDir, 'winvm', 'picture'), tools: () => pictureToolsAt(dataDir), size: () => sizes.now?.() ?? VGA_DEFAULT, log })))
  return s
}
/** the screen setting each data folder's keeper last gave: the one screen object reads it at every start */
const screenSizes = new Map<string, { now?: () => VmWindow }>()
