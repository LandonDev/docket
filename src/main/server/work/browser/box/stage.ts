import { Cdp } from './cdp'
import type { BoxWindowManager } from './xwm'

/**
 * Which of the headed browser's pages he is shown
 * (docs/agents/live-video.md "The box"). The engine captures the whole
 * display, so what is on the display is what he sees, and the display's
 * window manager (xwm.ts) lets nothing onto the top of it but what this
 * stage names:
 * - every page is its own window, full screen, at the screen's own size: the
 *   frame is the page alone, with no tab strip and no address bar
 * - the watched page is on top and holds the keyboard; a window it opens (a
 *   sign-in popup) is part of what he watches and comes up over it
 * - every other window stays under, behind the display's curtain: a new
 *   page, a window another page opens, the Outlook carrier's
 * - while he drives, the page's window leaves full screen so the browser's
 *   own toolbar shows, a window that page opens for him is left as the
 *   browser made it, and a menu he opens shows; the page returns to full
 *   screen when he hands back
 * - when the watched page closes, what he is shown of it ends
 *
 * For a headless browser all of this is nothing: a page is a tab.
 */

export interface StageLink {
  /** the running browser's DevTools address (starting it when it is not running) */
  endpoint(): Promise<string>
  /** the window manager of a headed browser's display while it runs, else null */
  wm(): BoxWindowManager | null
}

export interface TargetInfo {
  targetId: string
  type: string
  url: string
  openerId?: string
}

/** How long a window already on the display has to say which it is. */
const CLAIM_MS = 1_500

export class BoxStage {
  private cdp: Cdp | null = null
  private connecting: Promise<Cdp> | null = null
  /** the page in video now */
  private watched: string | null = null
  /** the page he drives now: its window shows the browser's toolbar */
  private driven: string | null = null
  /** the browser's window of each page this stage has seen: a page in a window not here is a new window to place */
  private readonly windows = new Map<string, number>()
  /** the display's own name for each of the browser's windows */
  private readonly xids = new Map<number, number>()
  /** the page that opened each page */
  private readonly openers = new Map<string, string>()
  /** the carrier's pages: never watched, never judged */
  private readonly carriers = new Set<string>()
  /** the window manager the names in `xids` are of: a new display has new ones */
  private managed: BoxWindowManager | null = null
  /** one change of the windows at a time */
  private queue: Promise<unknown> = Promise.resolve()
  private readonly closedListeners = new Set<(targetId: string) => void>()

  constructor(
    private readonly link: StageLink,
    private readonly opts: { size?: { width: number; height: number }; closed?: (url: string) => boolean; log?: (line: string) => void } = {}
  ) {}

  private get size(): { width: number; height: number } {
    return this.opts.size ?? { width: 1280, height: 800 }
  }

  /** The browser runs headed now. */
  headed(): boolean {
    return this.link.wm() !== null
  }

  /**
   * One new page at `url`, and its target. Headed, it is its own window
   * under the others: a page's full screen, the carrier's as the browser
   * makes it, since nothing ever shows it. Headless, a tab.
   */
  async open(url: string, where: 'page' | 'carrier' = 'page'): Promise<string> {
    const cdp = await this.ready()
    const wm = this.link.wm()
    if (!wm) return (await cdp.send<{ targetId: string }>('Target.createTarget', { url })).targetId
    return this.serial(async () => {
      // made at a place of its own, so the display's name for it is known as it shows
      const coming = where === 'page' ? wm.expect() : null
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url, newWindow: true, ...(coming ? { left: coming.at, top: 0 } : {}), ...this.size })
      if (where === 'carrier') this.carriers.add(targetId)
      const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId })
      this.windows.set(targetId, windowId)
      if (!coming) return targetId
      const xid = await coming.window
      if (xid === null) this.opts.log?.('box browser: a new page showed no window in time')
      else this.xids.set(windowId, xid)
      await this.setState(cdp, windowId, 'fullscreen')
      return targetId
    })
  }

  /** The browser's connection of this stage, with every window it already has put in its place. Called before the first use of a browser. */
  async ready(): Promise<Cdp> {
    if (this.cdp?.alive) return this.cdp
    this.connecting ??= this.connect().finally(() => (this.connecting = null))
    return this.connecting
  }

  /** The page in video: it comes to the top with the keyboard, the windows it opened over it. Null when nothing is watched. */
  async watch(targetId: string | null): Promise<void> {
    const wm = this.link.wm()
    if (!wm) {
      this.watched = targetId
      return
    }
    const cdp = targetId ? await this.ready() : null
    await this.serial(async () => {
      this.watched = targetId
      if (!targetId || !cdp) return wm.setFront(null)
      const xid = await this.xidOf(cdp, wm, targetId)
      if (xid === null) this.opts.log?.('box browser: the watched page has no window to bring up')
      await wm.setFront(xid)
      for (const other of this.windows.keys()) {
        const its = this.xids.get(this.windows.get(other)!)
        if (its !== undefined && its !== xid && this.partOf(other)) await wm.allow(its)
      }
      // its window may show another tab of its own
      await cdp.send('Target.activateTarget', { targetId }).catch(() => {})
    })
  }

  get watching(): string | null {
    return this.watched
  }

  /**
   * He takes over `targetId` (its window leaves full screen, so the
   * browser's own toolbar shows) or hands back with null (the page he drove
   * returns to full screen).
   */
  async drive(targetId: string | null): Promise<void> {
    if (!this.link.wm()) {
      this.driven = targetId
      return
    }
    const cdp = await this.ready()
    const set = async (target: string, windowState: 'normal' | 'fullscreen'): Promise<void> => {
      const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: target })
      await this.setState(cdp, windowId, windowState)
    }
    await this.serial(async () => {
      const was = this.driven
      this.driven = targetId
      await this.link.wm()?.setDriving(targetId !== null)
      if (was && was !== targetId) await set(was, 'fullscreen').catch(() => {})
      if (targetId && was !== targetId) await set(targetId, 'normal').catch(() => {})
    })
  }

  get driving(): string | null {
    return this.driven
  }

  /** His input reached the display just now: a menu that opens next is his. */
  touched(): void {
    this.link.wm()?.touched()
  }

  /** A page this stage has placed, still open. Headed only: a headless browser has no stage to speak of. */
  knows(targetId: string): boolean {
    return this.windows.has(targetId) && !this.carriers.has(targetId)
  }

  /** The address a page is at, or null when it is gone. */
  async urlOf(targetId: string): Promise<string | null> {
    try {
      const cdp = await this.ready()
      return (await cdp.send<{ targetInfo: TargetInfo }>('Target.getTargetInfo', { targetId })).targetInfo.url
    } catch {
      return null
    }
  }

  /** Told when what he is shown of the watched page must end: it, a tab of its window or a window it opened shows an address that is closed to agents, or it closed. */
  onEnd(fn: (targetId: string) => void): () => void {
    this.closedListeners.add(fn)
    return () => this.closedListeners.delete(fn)
  }

  close(): void {
    this.cdp?.close()
    this.cdp = null
    this.reset()
  }

  private reset(): void {
    this.windows.clear()
    this.openers.clear()
    this.carriers.clear()
    this.watched = null
    this.driven = null
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  /** The watched page opened it, or opened the page that did: part of what he watches. */
  private partOf(targetId: string): boolean {
    let at: string | undefined = targetId
    for (let i = 0; i < 5 && at !== undefined && this.watched !== null; i++) {
      at = this.openers.get(at)
      if (at === this.watched) return true
    }
    return false
  }

  /**
   * Asks a window for a state and waits until the browser says it has it:
   * the change is not done when the call answers.
   */
  private async setState(cdp: Cdp, windowId: number, windowState: 'normal' | 'fullscreen'): Promise<void> {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } })
    for (let i = 0; i < 40; i++) {
      const { bounds } = await cdp.send<{ bounds: { windowState?: string } }>('Browser.getWindowBounds', { windowId })
      if (bounds.windowState === windowState) return
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  /** The display's name for a page's window, asked of the display when it is not known yet. */
  private async xidOf(cdp: Cdp, wm: BoxWindowManager, targetId: string): Promise<number | null> {
    try {
      const windowId = this.windows.get(targetId) ?? (await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId })).windowId
      this.windows.set(targetId, windowId)
      return await this.claim(cdp, wm, windowId)
    } catch {
      return null
    }
  }

  /**
   * The display's name for one of the browser's windows. The browser does
   * not say it, so the window is asked to move to a place handed out for it
   * alone: the window manager sees which window asks, and leaves it where it
   * is.
   */
  private async claim(cdp: Cdp, wm: BoxWindowManager, windowId: number): Promise<number | null> {
    const have = this.xids.get(windowId)
    if (have !== undefined) return have
    // a window in another state takes no place
    const { bounds } = await cdp.send<{ bounds: { windowState?: string } }>('Browser.getWindowBounds', { windowId })
    const full = bounds.windowState === 'fullscreen'
    if (bounds.windowState !== 'normal') await this.setState(cdp, windowId, 'normal')
    const coming = wm.expect(CLAIM_MS)
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: coming.at, top: 0 } }).catch(() => {})
    const xid = await coming.window
    if (xid !== null) this.xids.set(windowId, xid)
    if (full) await this.setState(cdp, windowId, 'fullscreen').catch(() => {})
    return xid
  }

  private async connect(): Promise<Cdp> {
    const cdp = await Cdp.open(await this.link.endpoint())
    this.reset()
    const wm = this.link.wm()
    if (wm !== this.managed) this.xids.clear()
    this.managed = wm
    cdp.onClose(() => {
      if (this.cdp !== cdp) return
      this.cdp = null
      this.reset()
    })
    this.cdp = cdp
    if (!wm) return cdp
    cdp.on('Target.targetCreated', (p) => void this.arrived(cdp, p.targetInfo as TargetInfo).catch(() => {}))
    cdp.on('Target.targetInfoChanged', (p) => void this.judge(cdp, p.targetInfo as TargetInfo).catch(() => {}))
    cdp.on('Target.targetDestroyed', (p) => {
      const id = String(p.targetId)
      const windowId = this.windows.get(id)
      this.windows.delete(id)
      this.openers.delete(id)
      this.carriers.delete(id)
      if (windowId !== undefined && ![...this.windows.values()].includes(windowId)) this.xids.delete(windowId)
      if (this.driven === id) {
        this.driven = null
        void this.serial(async () => void (await this.link.wm()?.setDriving(this.driven !== null)))
      }
      if (this.watched !== id) return
      // the display shows its curtain now; the stream of the page ends
      this.watched = null
      for (const fn of this.closedListeners) fn(id)
    })
    await cdp.send('Target.setDiscoverTargets', { discover: true })
    await this.adopt(cdp, wm)
    return cdp
  }

  /** The windows the browser already has (the one it starts with): each a page, full screen. */
  private async adopt(cdp: Cdp, wm: BoxWindowManager): Promise<void> {
    await this.serial(async () => {
      const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets')
      for (const t of targetInfos.filter((t) => t.type === 'page' && !this.windows.has(t.targetId))) await this.place(cdp, wm, t).catch(() => {})
    })
  }

  /** A page the stage did not make: one a page opened (a popup, a link in a new window) or he opened while he drove. */
  private async arrived(cdp: Cdp, info: TargetInfo): Promise<void> {
    const wm = this.link.wm()
    if (info.type !== 'page' || !wm) return
    await this.serial(() => this.place(cdp, wm, info).catch(() => {}))
    await this.judge(cdp, info)
  }

  private async place(cdp: Cdp, wm: BoxWindowManager, info: TargetInfo): Promise<void> {
    // one of this stage's own, already placed by `open`
    if (this.windows.has(info.targetId)) return
    const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: info.targetId })
    const tab = [...this.windows.values()].includes(windowId)
    this.windows.set(info.targetId, windowId)
    if (info.openerId) this.openers.set(info.targetId, info.openerId)
    // a tab of a window that has its place already
    if (tab) return
    const xid = await this.claim(cdp, wm, windowId)
    if (xid === null) return
    const part = this.partOf(info.targetId)
    // a window the page he drives opened for him is left as the browser made it, its address showing; any other is a page like the rest
    if (!(part && this.driven !== null && this.driven === this.watched)) {
      await wm.page(xid)
      await this.setState(cdp, windowId, 'fullscreen').catch(() => {})
    }
    if (part) await wm.allow(xid)
  }

  /** A page's address changed: one he can see that is closed to agents ends what he is shown. */
  private async judge(cdp: Cdp, info: TargetInfo): Promise<void> {
    const closed = this.opts.closed
    const watched = this.watched
    if (!closed || !watched || info.type !== 'page' || this.carriers.has(info.targetId) || !closed(info.url)) return
    let seen = info.targetId === watched || info.openerId === watched || this.partOf(info.targetId)
    if (!seen) {
      const mine = this.windows.get(watched)
      const its = this.windows.get(info.targetId) ?? (await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: info.targetId }).then((w) => w.windowId, () => undefined))
      // a tab of the watched page's window is on top of what he is shown
      seen = mine !== undefined && mine === its
    }
    if (!seen || this.watched !== watched) return
    this.opts.log?.('box browser: the watched page shows an address that is closed to agents; its picture ends')
    for (const fn of this.closedListeners) fn(watched)
  }
}
