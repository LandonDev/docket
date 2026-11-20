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

export function popOutWindowOptions(): BrowserWindowConstructorOptions {
  return {
    ...POP_OUT_SIZE,
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
export function windowOpenHandler(details: Pick<HandlerDetails, 'url' | 'frameName'>, openExternal: (url: string) => void): WindowOpenHandlerResponse {
  if (details.frameName === POP_OUT_FRAME && details.url === 'about:blank') return { action: 'allow', overrideBrowserWindowOptions: popOutWindowOptions() }
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
