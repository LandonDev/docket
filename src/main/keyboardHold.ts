import { isFullScreenKey, type KeyInput } from './fullScreen'

/**
 * The keyboard in full screen (docs/agents/live-video.md "Driving"): while a
 * computer's picture holds the keyboard in full screen, main holds it too.
 * The page asks (`window:keyboardHold`), and main confirms only while the
 * window covers its display and has the focus. While main holds it the
 * menu's shortcuts stand down (`setIgnoreMenuShortcuts`), so the ⌘ chords
 * reach the page, and ⌘Q is Windows' Alt+F4: main keeps it from the page
 * and the menu and tells the page to send it. Whenever main does not hold
 * the keyboard ⌘Q is the menu's Quit, as ever. The two ways out are heard
 * here, before the page and whatever the menu's state: ⌃⌘F (fullScreen.ts)
 * and ⌃⌥ pressed with nothing else and let go. Main lets go, and tells the
 * page, on either, on a blur, a crashed renderer, a navigation and leaving
 * full screen; the page lets go itself on a lost stream and Hand back.
 */

/** What the hold asks of a page; a test hands in a fake. */
export interface HoldContents {
  isDestroyed(): boolean
  setIgnoreMenuShortcuts(ignore: boolean): void
  send(channel: string, ...args: unknown[]): void
}

/** What main tells the page while it holds the keyboard: let go of it, or send Alt+F4 (⌘Q). */
export type HeldKey = 'freed' | 'closeWindow'
export const HELD_KEY_CHANNEL = 'window:heldKey'

/** What a key heard before the page does: reach the page, stop there, take full screen in or out, or close a Windows window. */
export type KeyAction = 'page' | 'drop' | 'fullScreen' | 'closeWindow'

const isCtrlOrAlt = (input: KeyInput, platform: NodeJS.Platform): boolean =>
  input.key === 'Control' || (input.key === 'Alt' && (platform === 'darwin' || input.code !== 'AltRight'))

export class KeyboardHold {
  private held = false
  /** ⌃ and ⌥ are down and nothing else has been pressed since */
  private leaving = false

  constructor(
    private readonly contents: HoldContents,
    /** the window covers its display and has the focus */
    private readonly mayHold: () => boolean,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  get holding(): boolean {
    return this.held
  }

  /** The page says whether its picture holds the keyboard in full screen; answers whether main holds it. */
  ask(on: boolean): boolean {
    if (!on || this.contents.isDestroyed() || !this.mayHold()) {
      this.letGo(false)
      return false
    }
    if (!this.held) {
      this.held = true
      this.contents.setIgnoreMenuShortcuts(true)
    }
    return true
  }

  /** The menu's shortcuts come back; `tell`: the page hears it, and its picture lets go of the keyboard. */
  letGo(tell = true): void {
    this.leaving = false
    if (!this.held) return
    this.held = false
    if (this.contents.isDestroyed()) return
    this.contents.setIgnoreMenuShortcuts(false)
    if (tell) this.contents.send(HELD_KEY_CHANNEL, 'freed' satisfies HeldKey)
  }

  /** A key, before the page and the menu. */
  heard(input: KeyInput): KeyAction {
    if (isFullScreenKey(input, this.platform)) {
      this.letGo()
      return 'fullScreen'
    }
    if (input.type === 'keyDown') {
      if (isCtrlOrAlt(input, this.platform)) {
        // a held modifier repeating is no other key
        if (!input.isAutoRepeat) this.leaving = input.control && input.alt && !input.meta && !input.shift
      } else this.leaving = false
      if (this.held && this.platform === 'darwin' && input.meta && !input.control && !input.alt && input.key.toLowerCase() === 'q') {
        if (input.isAutoRepeat) return 'drop'
        this.contents.send(HELD_KEY_CHANNEL, 'closeWindow' satisfies HeldKey)
        return 'closeWindow'
      }
      return 'page'
    }
    if (input.type === 'keyUp' && this.leaving && isCtrlOrAlt(input, this.platform)) this.letGo()
    return 'page'
  }
}

/** A thing that tells of itself; Electron's windows and web contents both do. */
export interface Emits {
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

/** The losses that let go: the window's blur and its leaving full screen, the page's crash and a navigation of its own. */
export function followHold(hold: KeyboardHold, win: Emits, contents: Emits): void {
  const letGo = (): void => hold.letGo()
  win.on('blur', letGo)
  win.on('leave-full-screen', letGo)
  contents.on('render-process-gone', letGo)
  contents.on('did-start-navigation', (...args) => {
    const details = args[0] as { isMainFrame?: boolean; isSameDocument?: boolean } | undefined
    // the page's own route changes keep it; a reload or a new page does not
    if (details?.isMainFrame !== false && !details?.isSameDocument) letGo()
  })
}
