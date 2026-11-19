import { join } from 'node:path'
import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from 'electron'

/**
 * The window's frame per platform, as options (windows.ts builds the window).
 *
 * macOS: the donor's chrome, a hidden title bar with inset traffic lights.
 * Windows: no title bar of ours and no menu bar; Windows draws its own
 * minimise, maximise and close over the top right of the page (the title bar
 * overlay), so Snap Layouts, the hover states and the close colour are the
 * system's. The renderer leaves that corner empty (chrome/WindowControls.tsx)
 * and its title bar is the drag region. Linux keeps the system frame.
 *
 * No Mica: docs/DESIGN.md has one neutral palette and no glass, so the shell
 * is the opaque `sidebar` tone on every platform.
 */

/** Donor chrome: inset traffic lights. */
const TRAFFIC_LIGHT = { x: 12, y: 13 }
export const OPAQUE_BACKGROUND = '#171717'

/** The renderer's title bar is 40px tall (TitleBar.tsx `min-h-10`); the caption buttons fill it. */
export const CAPTION_HEIGHT = 40
/** Windows 11 draws three 46px caption buttons; the renderer keeps this much of the bar's end clear. */
export const CAPTION_WIDTH = 138

const CLEAR = '#00000000'
/** The caption glyphs' ink, as main needs plain colours: light's is the app's `foreground` (windowFrame.test.ts holds it equal to index.css); dark's is held as it was. */
export const SYMBOL = { dark: '#fafafa', light: '#13161c' }

/** The caption buttons' colours alone: a clear strip, so the page's own bar shows through, and glyphs in the theme's ink. No height, so a theme change keeps the zoom's. */
export function captionInk(dark: boolean): Pick<TitleBarOverlayOptions, 'color' | 'symbolColor'> {
  return { color: CLEAR, symbolColor: dark ? SYMBOL.dark : SYMBOL.light }
}

/** The caption buttons as a new window first draws them: the bar's height, the theme's ink. */
export function captionOverlay(dark: boolean): TitleBarOverlayOptions {
  return { height: CAPTION_HEIGHT, ...captionInk(dark) }
}

/** Whether a `#rrggbb` colour (the page's theme colour) is a dark one; anything unreadable counts as dark, the default theme. */
export function isDarkColor(color: string | null | undefined): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color ?? '')
  if (!m) return true
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
}

/** The frame's part of a window's options. `icon` is the window icon's path (Linux only: the others take it from the bundle). */
export function frameOptions(
  platform: NodeJS.Platform,
  look: { dark: boolean; icon: string }
): BrowserWindowConstructorOptions {
  if (platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: captionOverlay(look.dark),
      backgroundColor: OPAQUE_BACKGROUND
    }
  }
  return {
    autoHideMenuBar: true,
    titleBarStyle: platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(platform === 'darwin' ? { trafficLightPosition: TRAFFIC_LIGHT } : {}),
    backgroundColor: OPAQUE_BACKGROUND,
    ...(platform === 'linux' ? { icon: look.icon } : {})
  }
}

/**
 * Windows keeps the database, checkpoints and logs under %LOCALAPPDATA%, not
 * Electron's default %APPDATA%: a managed PC copies the roaming profile at
 * sign-out, and this folder runs to gigabytes. The folder keeps the name
 * Electron chose (the product's). Null on any other platform, and when
 * Windows names no local folder.
 */
export function localUserData(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  defaultUserData: string
): string | null {
  if (platform !== 'win32' || !env.LOCALAPPDATA) return null
  const name = defaultUserData.split(/[\\/]/).filter(Boolean).pop()
  return name ? join(env.LOCALAPPDATA, name) : null
}

/** The id Windows files the app's taskbar button, jump list and toasts under: the installer's shortcut carries the same one (electron-builder.yml `appId`). */
export const APP_USER_MODEL_ID = 'dev.landon.tempcode'
