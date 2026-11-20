import type { BoxDisplay } from './display'
import { ATOM, CONFIGURE, XClient, type XEvent, type XGeometry } from './xclient'

/**
 * The window manager of the box browser's display (docs/agents/live-video.md
 * "The box"). The engine captures the whole display and his keys reach it as
 * real key presses, so what is on top of it is what he sees and the window
 * that holds the keyboard is where he types. A browser left to itself gives
 * both away: it raises a window that is clicked, even by an agent through
 * DevTools, and hands it the keyboard; it opens a new window over the others;
 * it takes a pixel off a window the size of the screen. So this is the one
 * client the display asks before a top-level window is mapped, moved, sized
 * or restacked, and the one the browser asks to bring a window forward, and
 * it answers by these rules:
 *
 * - a page's window is exactly the screen, whatever size was asked for
 * - a black curtain of this manager's own covers the screen, and a window
 *   comes onto the screen behind it: nothing that is not named below is ever
 *   seen, and when the page he watches closes he sees the curtain
 * - in front of the curtain are only the front window (the page he watches),
 *   the windows let above it (a popup that page opened) and their dialogs,
 *   and only they are given the keyboard: the one that asked last
 * - a menu, a tooltip or a notice the browser draws is not asked about by
 *   the display, and nothing says which window it belongs to. It goes behind
 *   the curtain as soon as it shows, unless he drives and his input reached
 *   the display in the two seconds before: then it is taken for his
 */

/** Where a page's window is asked for, or asked to move to, so it can be told from the others: each ask gets its own place from here on, up to the end. */
export const STAGING_X = 2000
const STAGING_END = 12_000
/** How far short of the screen the browser leaves a window it was asked to make the screen's size. */
const SHORT = 2
/** A menu that shows this long after his input, while he drives, is his. */
export const HIS_MENU_MS = 2_000

type Role = 'page' | 'other'

export class BoxWindowManager {
  /** every top-level window the display asked about, and what it is */
  private readonly roles = new Map<number, Role>()
  /** a dialog or a menu, and the window it belongs to */
  private readonly parents = new Map<number, number>()
  /** who waits for the window that shows up at a place */
  private readonly waiters = new Map<number, (id: number) => void>()
  private next = STAGING_X
  private front: number | null = null
  /** the windows let above the front one, the last raised last */
  private readonly above = new Set<number>()
  /** the window that asked for the keyboard last and may have it */
  private keyboard: number | null = null
  /** the menus and notices put behind the curtain: one that raises itself is put back */
  private readonly behind = new Set<number>()
  private driving = false
  private lastInput = 0
  /** events are answered one at a time, in the order they came */
  private chain: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly x: XClient,
    /** the message a client sends to have a window brought forward */
    private readonly activate: number,
    private readonly curtain: number,
    private readonly now: () => number
  ) {}

  /** Takes the display in hand. Call it before the browser starts, so its first window is asked about too. */
  static async start(display: BoxDisplay, log: (line: string) => void = () => {}, now: () => number = Date.now): Promise<BoxWindowManager> {
    const x = await XClient.open(display)
    try {
      await x.manage()
      // The browser raises and focuses its own windows unless a window manager says it brings windows forward: this says so.
      const [supported, check, activate, name, utf8] = await Promise.all(['_NET_SUPPORTED', '_NET_SUPPORTING_WM_CHECK', '_NET_ACTIVE_WINDOW', '_NET_WM_NAME', 'UTF8_STRING'].map((n) => x.atom(n)))
      const own = x.hidden()
      x.setProperty(own, check, ATOM.window, [own])
      x.setText(own, name, utf8, 'temp-code')
      x.setProperty(x.root, check, ATOM.window, [own])
      x.setProperty(x.root, supported, ATOM.atom, [activate])
      const curtain = x.curtain()
      await x.sync()
      const wm = new BoxWindowManager(x, activate, curtain, now)
      x.onEvent((event) => {
        wm.chain = wm.chain.then(() => wm.handle(event)).catch((err) => log(`box display: ${(err as Error).message}`))
      })
      return wm
    } catch (err) {
      x.close()
      throw err
    }
  }

  get alive(): boolean {
    return this.x.alive
  }
  get screen(): { width: number; height: number } {
    return { width: this.x.width, height: this.x.height }
  }

  /**
   * A place no window has been asked for yet, and the window that shows up
   * there: one made at `at`, or one already on the display whose client asks
   * to move it there (it is not moved; the ask only says which window it is).
   * Null when none came in time.
   */
  expect(timeoutMs = 3_000): { at: number; window: Promise<number | null> } {
    const at = this.next
    this.next = this.next + 1 < STAGING_END ? this.next + 1 : STAGING_X
    const window = new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(at)
        resolve(null)
      }, timeoutMs)
      this.waiters.set(at, (id) => {
        clearTimeout(timer)
        this.waiters.delete(at)
        resolve(id)
      })
    })
    return { at, window }
  }

  /** Makes a window a page: the screen's size, at its corner. */
  async page(id: number): Promise<void> {
    await this.settled()
    this.roles.set(id, 'page')
    this.x.configure(id, { x: 0, y: 0, ...this.screen })
    this.x.tell(id, { x: 0, y: 0, ...this.screen })
    await this.x.sync().catch(() => {})
  }

  /** The one window that may be on top, with the keyboard: it is raised now, over what was let above the last one. Null when nothing is watched. */
  async setFront(id: number | null): Promise<void> {
    await this.settled()
    const were = [...(this.front !== null ? [this.front] : []), ...this.above]
    this.front = id
    this.above.clear()
    this.keyboard = id
    // the new one comes up first, so the curtain is never what he sees between two pages
    this.restack()
    for (const old of were) if (!this.onTop(old)) for (const w of [old, ...this.dialogs(old)]) this.x.configure(w, { stack: 'bottom' })
    await this.x.sync().catch(() => {})
  }

  /** A window that may sit above the front one: a popup the watched page opened. It is raised now and takes the keyboard. */
  async allow(id: number): Promise<void> {
    await this.settled()
    this.above.delete(id)
    this.above.add(id)
    this.keyboard = id
    this.restack()
    await this.x.sync().catch(() => {})
  }

  /** He drives now, or does not: a menu that shows right after his input is his only while he does. */
  async setDriving(driving: boolean): Promise<void> {
    await this.settled()
    this.driving = driving
  }

  /** His input reached the display just now. */
  touched(): void {
    this.lastInput = this.now()
  }

  /** Every event that has come is answered. */
  async settled(): Promise<void> {
    await this.x.sync().catch(() => {})
    await this.chain
  }

  /** The window that holds the keyboard now. */
  async focused(): Promise<number> {
    await this.settled()
    return this.x.focused()
  }

  /** The windows drawn in front of the curtain now, the top one last; `asked` leaves out the menus and notices the display does not ask about. */
  async shown(asked = true): Promise<number[]> {
    await this.settled()
    const all = (await this.x.windows()).filter((w) => w.viewable && w.width > 1)
    return all
      .slice(all.findIndex((w) => w.id === this.curtain) + 1)
      .filter((w) => !asked || !w.overrideRedirect)
      .map((w) => w.id)
  }

  close(): void {
    this.x.close()
  }

  private dialogs(of: number): number[] {
    return [...this.parents].filter(([, parent]) => parent === of).map(([child]) => child)
  }

  /** The front window, then what is let above it, each with its dialogs over it; the keyboard to the one that asked last, else the top one. */
  private restack(): void {
    const order = [...(this.front !== null ? [this.front] : []), ...this.above]
    for (const id of order) for (const w of [id, ...this.dialogs(id)]) this.x.configure(w, { stack: 'top' })
    if (this.keyboard !== null && !this.onTop(this.keyboard)) this.keyboard = null
    const to = this.keyboard ?? order.at(-1)
    if (to !== undefined) this.x.focus(to)
  }

  private onTop(id: number, depth = 0): boolean {
    if (id === this.front || this.above.has(id)) return true
    const parent = this.parents.get(id)
    return parent !== undefined && depth < 4 && this.onTop(parent, depth + 1)
  }

  private roleOf(g: XGeometry): Role {
    if (g.x >= STAGING_X) return 'page'
    const { width, height } = this.screen
    const full = Math.abs(g.x) <= SHORT && Math.abs(g.y) <= SHORT && width - g.width >= 0 && width - g.width <= SHORT && height - g.height >= 0 && height - g.height <= SHORT
    return full ? 'page' : 'other'
  }

  private forget(id: number): void {
    this.roles.delete(id)
    this.behind.delete(id)
    this.parents.delete(id)
    this.above.delete(id)
    if (this.front === id) this.front = null
    if (this.keyboard !== id) return
    // the keyboard goes to what is on top now
    this.keyboard = null
    this.restack()
  }

  private async handle(event: XEvent): Promise<void> {
    if (event.type === 'destroy') return this.forget(event.window)
    if (event.type === 'create') return
    if (event.type === 'shown') {
      // a menu, a tooltip, a notice: the display did not ask, and nothing says whose it is. His, right after his input while he drives; else behind the curtain.
      if (!event.overrideRedirect || event.window === this.curtain) return
      if (this.driving && this.now() - this.lastInput < HIS_MENU_MS) this.behind.delete(event.window)
      else {
        this.behind.add(event.window)
        this.x.configure(event.window, { stack: 'bottom' })
      }
      return
    }
    if (event.type === 'placed') {
      // the browser raises its own notices after it shows them, and the display does not ask
      if (event.above !== 0 && this.behind.has(event.window)) this.x.configure(event.window, { stack: 'bottom' })
      return
    }
    if (event.type === 'message') {
      // the browser asks for a window of its own to be brought forward: only one that may be on top is, and it gets the keyboard
      if (event.kind !== this.activate || !this.onTop(event.window)) return
      if (this.above.delete(event.window)) this.above.add(event.window)
      this.keyboard = event.window
      this.restack()
      return
    }
    if (event.type === 'mapRequest') {
      let g: XGeometry
      try {
        g = await this.x.geometry(event.window)
      } catch {
        return
      }
      const parent = await this.x.property(event.window, ATOM.transientFor).catch(() => null)
      if (parent) this.parents.set(event.window, parent)
      const role = this.roles.get(event.window) ?? this.roleOf(g)
      this.roles.set(event.window, role)
      // onto the screen behind the curtain, unless it is a dialog of a window that may be in front of it
      const stack = this.onTop(event.window) ? 'top' : 'bottom'
      if (role === 'page') {
        this.x.configure(event.window, { x: 0, y: 0, ...this.screen, stack })
        this.x.tell(event.window, { x: 0, y: 0, ...this.screen })
      } else this.x.configure(event.window, { stack })
      this.x.map(event.window)
      this.waiters.get(g.x)?.(event.window)
      return
    }
    // an ask to move, size or restack
    const role = this.roles.get(event.window)
    const named = role !== undefined && (event.mask & CONFIGURE.x) !== 0 ? this.waiters.get(event.geometry.x) : undefined
    if (named) {
      // a window on the display asked for a place that was handed out: that says which window it is, and it stays where it is
      const at = await this.x.geometry(event.window).catch(() => null)
      if (at) this.x.tell(event.window, at)
      named(event.window)
      return
    }
    if (role === 'page') {
      // a page is the screen, whatever was asked: its client is told so, since nothing changes for it to hear of
      this.x.tell(event.window, { x: 0, y: 0, ...this.screen })
    } else {
      const to: Partial<XGeometry> = {}
      for (const key of ['x', 'y', 'width', 'height'] as const) if (event.mask & CONFIGURE[key]) to[key] = event.geometry[key]
      this.x.configure(event.window, to)
    }
    // a window that may be on top may raise itself, and still does not cover what is let above it
    if (event.mask & CONFIGURE.stack && event.stack === 'above' && this.onTop(event.window)) {
      if (this.above.delete(event.window)) this.above.add(event.window)
      this.restack()
    }
  }
}
