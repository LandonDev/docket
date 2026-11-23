import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, ipcMain, powerSaveBlocker, screen, webContents, type BrowserWindowConstructorOptions, type HandlerDetails, type Rectangle } from 'electron'
import { SHOW_FRAME_PREFIX, type ShowAsk, type ShowDisplay, type ShowFrames, type ShowMode, type ShowSurface } from '../shared/slidesShow'

/**
 * The show's windows (docs/agents/work-slides.md "The show", docs/DESIGN.md
 * "The show"): the slideshow the room sees and the presenter's view. The
 * main window draws both, as it draws the pop-out (popOut.ts): its page
 * asks for a show (`show:begin`), main works out which windows it gets and
 * where and answers a frame name for each, made for that one show; the page
 * opens each window under its name, which this file lets through once, and
 * fills it through a portal. So a show has one
 * state, in one page, and its windows cannot fall out of step; it reaches
 * the deck's host as that page does.
 *
 * Main owns what a page cannot: which display each window is on, full
 * screen, the display kept awake and the page kept drawing behind its own
 * slideshow for the show's life, and a display that leaves mid-show.
 */

export type { ShowAsk, ShowDisplay, ShowFrames, ShowMode } from '../shared/slidesShow'
type ShowFrame = ShowSurface

/** As much of Electron's Display as the plan reads. */
export interface DisplayLike {
  id: number
  label?: string
  bounds: Rectangle
  workArea: Rectangle
}

export interface ShowPlan {
  audience: BrowserWindowConstructorOptions | null
  presenter: BrowserWindowConstructorOptions | null
  /** the display the slideshow fills: when it leaves, that window goes */
  display: number | null
}

/** The slideshow in a window, and the presenter's view beside it: their sizes on a 1440 by 900 screen, shrunk to fit a smaller one. */
export const WINDOWED = { audience: { width: 640, height: 360 }, presenter: { width: 744, height: 582 }, gap: 16 }
const PRESENTER_MIN = { width: 400, height: 360 }
const AUDIENCE_MIN = { width: 320, height: 180 }

/**
 * A window the main window's page opens, with none of its preload or slot argument (it would answer the main
 * window's IPC as a second window of that slot), and never throttled: the slideshow keeps painting while he works
 * in the other window. It is no child of the main window to the system: it neither moves nor hides with it.
 */
const CHILD: BrowserWindowConstructorOptions = { show: false, webPreferences: { preload: undefined, additionalArguments: [], backgroundThrottling: false } }

/** A window made over the whole of a display; it is taken full screen once it is shown (`created`), never while hidden. */
const fullScreenOn = (display: DisplayLike): BrowserWindowConstructorOptions => ({
  ...CHILD,
  ...display.bounds,
  frame: false,
  fullscreenable: true,
  // the matte, so no white shows before the first slide paints
  backgroundColor: '#000000'
})

const windowIn = (area: Rectangle, min: { width: number; height: number }): BrowserWindowConstructorOptions => ({
  ...CHILD,
  ...area,
  minWidth: min.width,
  minHeight: min.height,
  fullscreenable: true
})

/** Which windows a show gets and where, from the displays there are and the one his window is on. */
export function planShow(displays: readonly DisplayLike[], ownId: number, ask: ShowAsk): ShowPlan {
  const own = displays.find((d) => d.id === ownId) ?? displays[0]
  if (!own) return { audience: null, presenter: null, display: null }
  const others = displays.filter((d) => d.id !== own.id)
  if (ask.mode === 'windowed') {
    // Side by side in his display's work area, the pair centred; on a small screen both shrink by one factor.
    const { audience: a, presenter: p, gap } = WINDOWED
    const k = Math.min(1, (own.workArea.width - gap) / (a.width + p.width), own.workArea.height / p.height)
    const [aw, ah, pw, ph] = [a.width * k, a.height * k, p.width * k, p.height * k].map(Math.round)
    const x = own.workArea.x + Math.round((own.workArea.width - aw - pw - gap) / 2)
    const y = own.workArea.y + Math.round((own.workArea.height - ph) / 2)
    return {
      audience: { ...windowIn({ x, y, width: aw, height: ah }, AUDIENCE_MIN), backgroundColor: '#000000' },
      presenter: windowIn({ x: x + aw + gap, y, width: pw, height: ph }, PRESENTER_MIN),
      display: null
    }
  }
  if (others.length === 0) {
    if (ask.mode === 'presenter') return { audience: null, presenter: windowIn(own.workArea, PRESENTER_MIN), display: null }
    return { audience: fullScreenOn(own), presenter: null, display: own.id }
  }
  // Two displays or more: the slideshow on the one he picked (the other by default), the presenter's view on
  // his own; when he picked his own for the slideshow, the presenter's view takes the other.
  const room = displays.find((d) => d.id === ask.display) ?? others[0]
  const desk = room.id === own.id ? others[0] : own
  return { audience: fullScreenOn(room), presenter: windowIn(desk.workArea, PRESENTER_MIN), display: room.id }
}

/** The displays as the Present menu lists them: his own first. */
export function showDisplays(displays: readonly DisplayLike[], ownId: number): ShowDisplay[] {
  const own = displays.find((d) => d.id === ownId) ?? displays[0]
  return displays
    .map((d, i) => ({ id: d.id, label: d.label?.trim() || `Display ${i + 1}`, own: d.id === own?.id }))
    .sort((a, b) => Number(b.own) - Number(a.own))
}

/** What a show asks of a window it was given; a test hands in a fake. */
export interface ShowWindow {
  isDestroyed(): boolean
  setMenuBarVisibility(on: boolean): void
  show(): void
  setFullScreen(on: boolean): void
  setSimpleFullScreen(on: boolean): void
  close(): void
  on(event: 'closed', listener: () => void): unknown
}

export interface ShowDeps {
  displays(): DisplayLike[]
  /** the display the asking window is on */
  ownDisplay(sender: number): number
  /** holds the display awake; answers what lets it go */
  keepAwake(): () => void
  /**
   * Keeps the asking page drawing and its timers on time while its own window is covered. The page is the
   * show: it paints every slide (pdf.js schedules its drawing on that window's frames) and keeps the timer. A
   * full-screen slideshow over the main window makes the page hidden, and a hidden page gets no frames at all
   * and, after five minutes, one timer tick a minute. Answers what puts the page back as it was.
   */
  keepLive(sender: number): () => void
  /** tells the asking page (`show:display-gone`) */
  tell(sender: number, channel: 'show:display-gone'): void
  /** a beat after a display left, a window its page did not close is closed here */
  later?(fn: () => void, ms: number): void
  /** `darwin` takes the slideshow full screen without a Space of its own; a test names the platform */
  platform?: NodeJS.Platform
  /** a name for one show's frames; a test hands in a fixed one */
  nonce?(): string
}

/** A window on a display that left is closed by its page at once; this long after, by main. */
export const DISPLAY_GONE_GRACE_MS = 1000

interface Running {
  plan: ShowPlan
  frames: ShowFrames
  release: () => void
  windows: Partial<Record<ShowFrame, ShowWindow>>
}

const NO_FRAMES: ShowFrames = { audience: null, presenter: null }

/**
 * The shows running, one per main window (by its page's id). `begin` plans
 * the windows and holds the display awake; the page then opens each frame,
 * which `opens` lets through with the plan's options and `created` shows;
 * `end` lets the display sleep again and closes what is left.
 */
export function createShows(deps: ShowDeps) {
  const running = new Map<number, Running>()
  const later = deps.later ?? ((fn, ms) => void setTimeout(fn, ms))
  const platform = deps.platform ?? process.platform
  const nonce = deps.nonce ?? randomUUID
  const frameOf = (show: Running, name: string): ShowFrame | null => (name === show.frames.audience ? 'audience' : name === show.frames.presenter ? 'presenter' : null)

  function end(sender: number): void {
    const show = running.get(sender)
    if (!show) return
    running.delete(sender)
    show.release()
    for (const w of Object.values(show.windows)) if (w && !w.isDestroyed()) w.close()
  }

  return {
    displays: (sender: number): ShowDisplay[] => showDisplays(deps.displays(), deps.ownDisplay(sender)),
    /** Starts a show for this page (ending one it still had); answers the frame name to open each of its windows under. */
    begin(sender: number, ask: ShowAsk): ShowFrames {
      end(sender)
      const plan = planShow(deps.displays(), deps.ownDisplay(sender), ask)
      if (!plan.audience && !plan.presenter) return NO_FRAMES
      const id = nonce()
      const frames: ShowFrames = { audience: plan.audience ? `${SHOW_FRAME_PREFIX}${id}` : null, presenter: plan.presenter ? `${SHOW_FRAME_PREFIX}${id}-presenter` : null }
      const [awake, live] = [deps.keepAwake(), deps.keepLive(sender)]
      running.set(sender, { plan, frames, release: () => (awake(), live()), windows: {} })
      return frames
    },
    /** The window a page's `window.open` gets: the plan's, once per frame, for a show that is running; null for anything else. */
    opens(sender: number, details: Pick<HandlerDetails, 'url' | 'frameName'>): BrowserWindowConstructorOptions | null {
      const show = running.get(sender)
      const frame = show ? frameOf(show, details.frameName) : null
      if (!frame || !show || details.url !== 'about:blank' || show.windows[frame]) return null
      return show.plan[frame]
    },
    created(sender: number, frameName: string, child: ShowWindow): void {
      const show = running.get(sender)
      const frame = show ? frameOf(show, frameName) : null
      if (!frame || !show) return
      show.windows[frame] = child
      child.setMenuBarVisibility(false)
      child.show()
      // The slideshow that fills a display: full screen, so no menu bar, dock or taskbar is over the slide. On a Mac
      // it is the window laid over the display, with no Space of its own: a Space of its own blanks the other
      // displays where they share Spaces, and its closing animation has left black Spaces behind.
      if (frame === 'audience' && show.plan.display !== null) {
        if (platform === 'darwin') child.setSimpleFullScreen(true)
        else child.setFullScreen(true)
      }
      child.on('closed', () => {
        if (show.windows[frame] === child) delete show.windows[frame]
      })
    },
    end,
    /** A display left: the slideshow that filled it goes, and the presenter's view stays. The page closes its own window; main closes one it left. */
    displayRemoved(id: number): void {
      for (const [sender, show] of running) {
        if (show.plan.display !== id) continue
        show.plan = { ...show.plan, display: null }
        deps.tell(sender, 'show:display-gone')
        // That window, whatever show the page has by then.
        const left = show.windows.audience
        later(() => {
          if (left && !left.isDestroyed()) left.close()
        }, DISPLAY_GONE_GRACE_MS)
      }
    },
    running: (sender: number): boolean => running.has(sender)
  }
}

export type Shows = ReturnType<typeof createShows>

let shows: Shows | null = null

/** The open handler's first question (windows.ts): a show's window gets its options; anything else is not this file's. */
export function showWindowOptions(sender: number, details: Pick<HandlerDetails, 'url' | 'frameName'>): BrowserWindowConstructorOptions | null {
  return shows?.opens(sender, details) ?? null
}

/** Wires the shows to Electron: the IPC a page calls, each window it opens, the displays, and a power assertion per show. */
export function registerPresent(): void {
  const live = createShows({
    displays: () => screen.getAllDisplays(),
    ownDisplay: (sender) => {
      const contents = webContents.fromId(sender)
      const win = contents ? BrowserWindow.fromWebContents(contents) : null
      return (win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()).id
    },
    keepAwake: () => {
      const id = powerSaveBlocker.start('prevent-display-sleep')
      return () => powerSaveBlocker.stop(id)
    },
    keepLive: (sender) => {
      const contents = webContents.fromId(sender)
      if (!contents || contents.isDestroyed()) return () => undefined
      const was = contents.getBackgroundThrottling()
      contents.setBackgroundThrottling(false)
      return () => {
        if (!contents.isDestroyed()) contents.setBackgroundThrottling(was)
      }
    },
    tell: (sender, channel) => {
      const contents = webContents.fromId(sender)
      if (contents && !contents.isDestroyed()) contents.send(channel)
    }
  })
  shows = live
  ipcMain.handle('show:displays', (e) => live.displays(e.sender.id))
  ipcMain.handle('show:begin', (e, ask: unknown) => {
    const a = ask as Partial<ShowAsk> | null
    const mode: ShowMode = a?.mode === 'presenter' || a?.mode === 'windowed' ? a.mode : 'full'
    return live.begin(e.sender.id, { mode, ...(typeof a?.display === 'number' ? { display: a.display } : {}) })
  })
  ipcMain.handle('show:end', (e) => live.end(e.sender.id))
  screen.on('display-removed', (_e, display) => live.displayRemoved(display.id))
  app.on('web-contents-created', (_e, contents) => {
    const sender = contents.id
    contents.on('did-create-window', (child, details) => live.created(sender, details.frameName, child))
    // The page went (its window closed, it reloaded, its process died): its show goes with it.
    contents.on('destroyed', () => live.end(sender))
    contents.on('render-process-gone', () => live.end(sender))
    // A new page in the main frame, once it has committed (a navigation that turns into a download never does).
    contents.on('did-navigate', () => live.end(sender))
  })
}
