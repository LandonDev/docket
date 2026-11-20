import type { BrowserWindowConstructorOptions, HandlerDetails, WindowOpenHandlerResponse } from 'electron'

/**
 * The pop-out (docs/DESIGN.md "Computers", "Pop out"): a small frameless
 * window that stays over every app, every Space and every workspace, showing
 * one computer's picture. The main window draws it: the page opens a child
 * window under this frame name with `window.open`, fills it through a React
 * portal and hands its canvas to the window's own video worker, so it plays
 * the stream the page already plays. Every other `window.open` still goes
 * to the system's browser and opens nothing here.
 */

/** The frame name a page opens its pop-out under; the only one the open handler lets through. */
export const POP_OUT_FRAME = 'tc-popout'

/** Its size before he drags it: the picture at 16:10 and a 36px bar under it. */
export const POP_OUT_SIZE = { width: 384, height: 276 }
export const POP_OUT_MIN = { width: 240, height: 186 }

/** Where he left it, and its size: kept in the window state file (windows.ts). */
export interface PopOutBounds {
  x: number
  y: number
  width: number
  height: number
}

/** The bar under the picture: the window's shape is the picture's plus this. */
export const POP_OUT_BAR = 36

/** A saved place that is whole and no smaller than the window may be; null otherwise. */
export function readPopOutBounds(raw: unknown): PopOutBounds | null {
  const b = raw as Partial<PopOutBounds> | null
  if (!b || ![b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return { x: b.x!, y: b.y!, width: Math.max(POP_OUT_MIN.width, b.width!), height: Math.max(POP_OUT_MIN.height, b.height!) }
}

export function popOutWindowOptions(saved: PopOutBounds | null = null): BrowserWindowConstructorOptions {
  return {
    ...(saved ?? POP_OUT_SIZE),
    minWidth: POP_OUT_MIN.width,
    minHeight: POP_OUT_MIN.height,
    show: false,
    frame: false,
    // a panel on macOS: it floats over other apps and takes no place in the Dock or the app switcher
    type: process.platform === 'darwin' ? 'panel' : undefined,
    skipTaskbar: true,
    fullscreenable: false,
    alwaysOnTop: true,
    // the main window's preload and its slot argument are the main window's alone: a child that took them would
    // answer to the main window's IPC as a second window of the same slot
    webPreferences: { preload: undefined, additionalArguments: [], backgroundThrottling: false }
  }
}

/** The open handler of every main window: its pop-out, as a child; anything else to the system's browser. */
export function windowOpenHandler(details: Pick<HandlerDetails, 'url' | 'frameName'>, openExternal: (url: string) => void, saved: PopOutBounds | null = null): WindowOpenHandlerResponse {
  if (details.frameName === POP_OUT_FRAME && details.url === 'about:blank') return { action: 'allow', overrideBrowserWindowOptions: popOutWindowOptions(saved) }
  openExternal(details.url)
  return { action: 'deny' }
}

/** What the pop-out is asked of the window it got: the window calls a fake in a test. */
export interface PopOutWindow {
  setAlwaysOnTop(on: boolean, level: 'floating'): void
  setVisibleOnAllWorkspaces(on: boolean, options: { visibleOnFullScreen: boolean }): void
  showInactive(): void
}

/** The child, made: over every app and on every Space, shown without taking the keyboard from what he is doing. */
export function popOutCreated(child: PopOutWindow): void {
  child.setAlwaysOnTop(true, 'floating')
  child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  child.showInactive()
}
