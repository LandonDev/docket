import { Cdp } from './cdp'
import type { BoxDisplay } from './display'
import { CARRIER_X, STAGING_X, fitWindows, landWindows } from './xclient'

/**
 * Where the headed browser's windows are and which is on top
 * (docs/agents/live-video.md "The box"). The engine captures the whole
 * display, so what is on the display is what he sees:
 * - every page is its own window, full screen, at the screen's own size: the
 *   frame is the page alone, with no tab strip and no address bar
 * - a new page's window is made off the screen and put on it under the
 *   others, so it never covers the page he watches, even for a frame
 * - the watched page is on top; a window another page opens is put back
 *   under it, unless the watched page opened it (a sign-in popup is part of
 *   what he watches) or he is driving (a window he opens stays)
 * - the Outlook carrier's window lives off the screen and is never raised
 * - while he drives, the page's window leaves full screen so the browser's
 *   own toolbar shows; it returns to full screen when he hands back
 *
 * For a headless browser all of this is nothing: a page is a tab.
 */

export interface StageLink {
  /** the running browser's DevTools address (starting it when it is not running) */
  endpoint(): Promise<string>
  /** the display of a headed browser while it runs, else null */
  display(): BoxDisplay | null
}

export interface TargetInfo {
  targetId: string
  type: string
  url: string
  openerId?: string
}

/** The window a new page is asked for: off the screen, at the screen's size. */
export function stagedWindow(where: 'page' | 'carrier', size: { width: number; height: number }): { newWindow: true; left: number; top: number; width: number; height: number } {
  return { newWindow: true, left: where === 'carrier' ? CARRIER_X : STAGING_X, top: 0, ...size }
}

export class BoxStage {
  private cdp: Cdp | null = null
  private connecting: Promise<Cdp> | null = null
  /** the page in video now */
  private watched: string | null = null
  /** the page he drives now: its window shows the browser's toolbar */
  private driven: string | null = null
  /** windows this stage made or took in, by target: a target in a window not here is a new window to place */
  private readonly windows = new Map<string, number>()
  /** the carrier's pages: never on the screen, never raised, never judged */
  private readonly carriers = new Set<string>()
  /** one window is placed at a time: two at the staging place could not be told apart */
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
    return this.link.display() !== null
  }

  /**
   * One new page at `url`, and its target. Headed, it is its own full-screen
   * window: under the others, or the carrier's off the screen. Headless, a tab.
   */
  async open(url: string, where: 'page' | 'carrier' = 'page'): Promise<string> {
    const cdp = await this.ready()
    const display = this.link.display()
    if (!display) return (await cdp.send<{ targetId: string }>('Target.createTarget', { url })).targetId
    return this.serial(async () => {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url, ...stagedWindow(where, this.size) })
      if (where === 'carrier') this.carriers.add(targetId)
      const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId })
      this.windows.set(targetId, windowId)
      if (where === 'carrier') return targetId
      await this.setState(cdp, windowId, 'fullscreen')
      // under the page he watches; with nobody watching, where it lands does not matter, and on top is what a person expects
      await landWindows(display, this.watched ? 'bottom' : 'top')
      await this.fit(display)
      return targetId
    })
  }

  /**
   * Asks a window for a state and waits until the browser says it has it:
   * the change is not done when the call answers, and a window sized before
   * it is done is sized again by the browser, a pixel short.
   */
  private async setState(cdp: Cdp, windowId: number, windowState: 'normal' | 'fullscreen'): Promise<void> {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } })
    for (let i = 0; i < 40; i++) {
      const { bounds } = await cdp.send<{ bounds: { windowState?: string } }>('Browser.getWindowBounds', { windowId })
      if (bounds.windowState === windowState) return
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  /** Every page window at the screen's size, and still there a moment later: the browser's own late resize is undone. */
  private async fit(display: BoxDisplay): Promise<void> {
    let quiet = 0
    for (let i = 0; i < 12 && quiet < 2; i++) {
      quiet = (await fitWindows(display).catch(() => 0)) === 0 ? quiet + 1 : 0
      if (quiet < 2) await new Promise((r) => setTimeout(r, 40))
    }
  }

  /** The browser's connection of this stage, with every window it already has put in its place. Called before the first use of a browser. */
  async ready(): Promise<Cdp> {
    if (this.cdp?.alive) return this.cdp
    this.connecting ??= this.connect().finally(() => (this.connecting = null))
    return this.connecting
  }

  /** The page in video: it is raised, and stays on top. Null when nothing is watched. */
  async watch(targetId: string | null): Promise<void> {
    this.watched = targetId
    if (!targetId || !this.headed()) return
    const cdp = await this.ready()
    await cdp.send('Target.activateTarget', { targetId }).catch(() => {})
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
    const was = this.driven
    this.driven = targetId
    const display = this.link.display()
    if (!display || was === targetId) return
    const cdp = await this.ready()
    const set = async (target: string, windowState: 'normal' | 'fullscreen'): Promise<void> => {
      const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: target })
      await this.setState(cdp, windowId, windowState)
    }
    await this.serial(async () => {
      if (was) await set(was, 'fullscreen').catch(() => {})
      if (targetId) {
        await set(targetId, 'normal').catch(() => {})
        await cdp.send('Target.activateTarget', { targetId }).catch(() => {})
      }
      await this.fit(display)
    })
  }

  get driving(): string | null {
    return this.driven
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

  /** Told when the watched page, a tab of its window or a window it opened shows an address that is closed to agents. */
  onClosedHost(fn: (targetId: string) => void): () => void {
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
    this.carriers.clear()
    this.watched = null
    this.driven = null
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  private async connect(): Promise<Cdp> {
    const cdp = await Cdp.open(await this.link.endpoint())
    this.reset()
    cdp.onClose(() => {
      if (this.cdp !== cdp) return
      this.cdp = null
      this.reset()
    })
    this.cdp = cdp
    if (!this.link.display()) return cdp
    cdp.on('Target.targetCreated', (p) => void this.arrived(cdp, p.targetInfo as TargetInfo))
    cdp.on('Target.targetInfoChanged', (p) => void this.judge(cdp, p.targetInfo as TargetInfo))
    cdp.on('Target.targetDestroyed', (p) => {
      const id = String(p.targetId)
      this.windows.delete(id)
      this.carriers.delete(id)
      if (this.watched === id) this.watched = null
      if (this.driven === id) this.driven = null
    })
    await cdp.send('Target.setDiscoverTargets', { discover: true })
    await this.adopt(cdp)
    return cdp
  }

  /** The windows the browser already has (the one it starts with): each full screen at the screen's size. */
  private async adopt(cdp: Cdp): Promise<void> {
    const display = this.link.display()
    if (!display) return
    await this.serial(async () => {
      const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets')
      for (const t of targetInfos.filter((t) => t.type === 'page' && !this.windows.has(t.targetId))) await this.fullScreen(cdp, t.targetId)
      await this.fit(display)
    })
  }

  private async fullScreen(cdp: Cdp, targetId: string): Promise<void> {
    try {
      const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId })
      this.windows.set(targetId, windowId)
      await this.setState(cdp, windowId, 'fullscreen')
    } catch {
      // closed already
    }
  }

  /** A page the stage did not make: one a page opened (a popup, a link in a new window) or he opened while he drove. */
  private async arrived(cdp: Cdp, info: TargetInfo): Promise<void> {
    if (info.type !== 'page') return
    const display = this.link.display()
    if (!display) return
    await this.serial(async () => {
      // one of this stage's own, already placed by `open`
      if (this.windows.has(info.targetId)) return
      let windowId: number
      try {
        ;({ windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: info.targetId }))
      } catch {
        return
      }
      const known = [...this.windows.values()].includes(windowId)
      this.windows.set(info.targetId, windowId)
      const mine = !!this.watched && (info.openerId === this.watched || this.windows.get(this.watched) === windowId)
      // a tab in a window that is already placed needs nothing; a window of its own is made full screen like the rest,
      // but not one he opened while driving: he gets it as the browser made it
      if (!known && !this.driven) await this.setState(cdp, windowId, 'fullscreen').catch(() => {})
      if (this.watched && !mine && !this.driven) await cdp.send('Target.activateTarget', { targetId: this.watched }).catch(() => {})
      if (!known && !this.driven) await this.fit(display)
    })
    await this.judge(cdp, info)
  }

  /** A page's address changed: one he can see that is closed to agents ends what he is shown. */
  private async judge(cdp: Cdp, info: TargetInfo): Promise<void> {
    const closed = this.opts.closed
    const watched = this.watched
    if (!closed || !watched || info.type !== 'page' || this.carriers.has(info.targetId) || !closed(info.url)) return
    let seen = info.targetId === watched || info.openerId === watched
    if (!seen) {
      const mine = this.windows.get(watched)
      const its = this.windows.get(info.targetId) ?? (await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: info.targetId }).then((w) => w.windowId, () => undefined))
      seen = mine !== undefined && mine === its
    }
    if (!seen || this.watched !== watched) return
    this.opts.log?.('box browser: the watched page shows an address that is closed to agents; its picture ends')
    for (const fn of this.closedListeners) fn(watched)
  }
}
