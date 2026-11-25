/**
 * Full screen for a computer's picture (docs/DESIGN.md "Computers", "Full
 * screen"): the main window or its pop-out laid over its whole display. On a
 * Mac it is `setSimpleFullScreen`, as the slideshow's (present.ts): this
 * Space, at once, no slide, and no menu bar drops in over the top edge;
 * elsewhere `setFullScreen`. The page asks (`window:fullScreen { on }`),
 * main answers and pushes the state back (`window:fullScreenChanged`), and a
 * window that closes leaves full screen first, so a Mac's menu bar and Dock
 * never stay hidden behind it. ⌃⌘F (F11 off a Mac) is caught here, before
 * the page, so it works while the picture holds the keyboard.
 */

/** What full screen asks of a window; a test hands in a fake. */
export interface FullScreenWindow {
  isDestroyed(): boolean
  isFullScreen(): boolean
  isSimpleFullScreen(): boolean
  setFullScreen(on: boolean): void
  setSimpleFullScreen(on: boolean): void
  setFullScreenable(on: boolean): void
}

/** The window covers its display: our full screen, or the system's own (the green button). */
export function isFull(win: FullScreenWindow, platform: NodeJS.Platform = process.platform): boolean {
  if (win.isDestroyed()) return false
  return win.isFullScreen() || (platform === 'darwin' && win.isSimpleFullScreen())
}

/**
 * Takes the window full screen or out of it; answers whether it was full before. A window already full (his own
 * full screen) is left as it is on `on`, and on `off` leaves the way it came in.
 */
export function setFull(win: FullScreenWindow, on: boolean, platform: NodeJS.Platform = process.platform): boolean {
  const was = isFull(win, platform)
  if (win.isDestroyed() || was === on) return was
  if (platform === 'darwin') {
    if (on) win.setSimpleFullScreen(true)
    else if (win.isSimpleFullScreen()) win.setSimpleFullScreen(false)
    else win.setFullScreen(false)
    return was
  }
  // the pop-out is made unable to go full screen (popOut.ts), so its green button does nothing; asked, it may
  if (on) win.setFullScreenable(true)
  win.setFullScreen(on)
  return was
}

/** As much of Electron's `Input` as the key reads. */
export interface KeyInput {
  type: string
  key: string
  /** the key's place (`AltRight`); only the keyboard hold reads it (keyboardHold.ts) */
  code?: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  isAutoRepeat?: boolean
}

/** ⌃⌘F on a Mac, F11 elsewhere (a PC's keyboard has no ⌘, and Ctrl+Win+F is the system's): the key into and out of full screen. */
export function isFullScreenKey(input: KeyInput, platform: NodeJS.Platform = process.platform): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat || input.alt || input.shift) return false
  if (platform === 'darwin') return input.control && input.meta && input.key.toLowerCase() === 'f'
  return !input.control && !input.meta && input.key === 'F11'
}

/** What a window tells of itself: its full screen coming and going, and its closing. */
export interface FullScreenEvents {
  on(event: 'enter-full-screen' | 'leave-full-screen' | 'close', listener: () => void): unknown
}

/**
 * Follows one window: its full screen's state goes to `tell` as it changes (the system's events; a Mac's simple full
 * screen raises none, so `window:fullScreen` tells as well), and the window leaves full screen as it closes, and says so.
 */
export function followFullScreen(win: FullScreenWindow & FullScreenEvents, tell: (on: boolean) => void, platform: NodeJS.Platform = process.platform): void {
  win.on('enter-full-screen', () => tell(true))
  win.on('leave-full-screen', () => tell(false))
  win.on('close', () => {
    if (!isFull(win, platform)) return
    setFull(win, false, platform)
    // a page that keeps its window (an unsaved file's question) closes its full screen too
    tell(false)
  })
}
