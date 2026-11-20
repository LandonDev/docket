import { app, BrowserWindow, globalShortcut, ipcMain, nativeTheme, screen, type BrowserWindowConstructorOptions, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { APP_HOST, APP_SCHEME } from './appScheme'
import { captureWindowRef } from './captureWindow'

/**
 * Capture from anywhere (docs/agents/work-capture.md): a key he sets opens
 * a small window over whatever app is in front, whether or not a TempCode
 * window is open. He types, pastes or drops a file, picks a sector and
 * presses Return; the page files it through the local host's
 * `work.capture.file` and the window is gone.
 *
 * The key is held only while Work is on here. The window is made once,
 * hidden, as soon as the key is held, so the key shows a page that is
 * already painted: it opens and closes with no motion at all (a key used
 * many times a day gets none). It stays open while he drags a file from
 * another app, so it hides on Escape, on Return, or on the key again, not
 * when it loses focus.
 */

export const CAPTURE_WIDTH = 680
/** index.css's `--popover` per theme as the window's backing (capture.test.ts holds them equal): oklch(0.24 0.004 270), white. */
export const CAPTURE_BACKING = { dark: '#1e1f21', light: '#ffffff' } as const
/** The window's height before the page says how tall it is, and its bounds after. */
export const CAPTURE_MIN_HEIGHT = 112
export const CAPTURE_MAX_HEIGHT = 560
/** Its top, as a share of the display's work area from the top: where Spotlight puts its field. */
const TOP_SHARE = 0.22

/** The default key: free on macOS (Spotlight is ⌘Space, the input menu ⌃Space and ⌃⌥Space, Finder's search ⌥⌘Space)
 *  and on Windows, where Ctrl+Shift+Space is Word's no-break space and Alt+Space the window menu. */
export function captureKeyDefault(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'Command+Shift+Space' : 'Alt+Shift+Space'
}

/** What `<userData>/capture.json` holds: the key, or null when he turned it off; absent means the default. */
export interface CaptureFile {
  key: string | null
}

export function readCaptureKey(userData: string, platform: NodeJS.Platform = process.platform): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(userData, 'capture.json'), 'utf8')) as Partial<CaptureFile>
    if (raw.key === null) return null
    if (typeof raw.key === 'string' && isAccelerator(raw.key)) return raw.key
  } catch {
    // none saved, or unreadable: the default
  }
  return captureKeyDefault(platform)
}

export function writeCaptureKey(userData: string, key: string | null): void {
  writeFileSync(join(userData, 'capture.json'), JSON.stringify({ key } satisfies CaptureFile))
}

const MODIFIERS = new Set(['Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta'])

/** An accelerator a global key may be: at least one modifier other than Shift alone, and one key that is not a modifier. */
export function isAccelerator(key: string): boolean {
  const parts = key.split('+')
  if (parts.length < 2 || parts.length > 5 || parts.some((p) => !p)) return false
  const mods = parts.slice(0, -1)
  const last = parts[parts.length - 1]!
  if (MODIFIERS.has(last) || !mods.every((m) => MODIFIERS.has(m))) return false
  if (mods.every((m) => m === 'Shift')) return false
  return /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|Plus|[-=,./;'`\\[\]])$/.test(last)
}

/** Where the window sits: centred across the work area of the display under the pointer, its top a fifth of the way down. */
export function capturePlacement(area: { x: number; y: number; width: number; height: number }, height: number): { x: number; y: number; width: number; height: number } {
  const width = Math.min(CAPTURE_WIDTH, area.width - 32)
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height * TOP_SHARE),
    width,
    height: clampHeight(height)
  }
}

export const clampHeight = (h: number): number => Math.max(CAPTURE_MIN_HEIGHT, Math.min(CAPTURE_MAX_HEIGHT, Math.round(Number.isFinite(h) ? h : CAPTURE_MIN_HEIGHT)))

export function captureWindowOptions(dark: boolean, preload: string): BrowserWindowConstructorOptions {
  return {
    width: CAPTURE_WIDTH,
    height: CAPTURE_MIN_HEIGHT,
    show: false,
    frame: false,
    // a panel on macOS: it floats over other apps, even a full-screen one, and takes no place in the Dock or the app switcher
    type: process.platform === 'darwin' ? 'panel' : undefined,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    // the popover fill of the theme it will wear, so nothing flashes before the page paints
    backgroundColor: dark ? CAPTURE_BACKING.dark : CAPTURE_BACKING.light,
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true }
  }
}

export function captureUrl(): string {
  const dev = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  return dev ? `${dev.replace(/\/$/, '')}/capture.html?place=work` : `${APP_SCHEME}://${APP_HOST}/capture.html?place=work`
}

export interface CaptureDeps {
  work: { enabled(): boolean; onChange(fn: () => void): () => void }
  port(): number | null
}

let window: BrowserWindow | null = null
const setWindow = (w: BrowserWindow | null): void => {
  window = w
  captureWindowRef.current = w
}
/** Settles once the window's page has loaded: a key pressed before then shows it when it can take the field's focus. */
let loaded: Promise<void> = Promise.resolve()
let held: string | null = null
let keyError: string | null = null
let deps: CaptureDeps | null = null
let prewarm: ReturnType<typeof setTimeout> | null = null
/** The window is made this long after the key is first held, clear of the launch's own windows painting. */
const PREWARM_MS = 8_000

/** Pasted pictures wait here until the host has copied them; the folder is emptied at each start. */
const picturesDir = (): string => join(app.getPath('userData'), 'capture-pictures')

function makeWindow(): BrowserWindow {
  const win = new BrowserWindow(captureWindowOptions(nativeTheme.shouldUseDarkColors, join(__dirname, '../preload/capture.js')))
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.on('closed', () => {
    if (window === win) setWindow(null)
  })
  // However it hid (Return, Escape, the key), the page hears it and lets its socket go when idle.
  win.on('hide', () => {
    if (!win.isDestroyed()) win.webContents.send('capture:hidden')
  })
  loaded = new Promise((done) => {
    win.webContents.once('did-finish-load', () => done())
    win.webContents.once('did-fail-load', () => done())
  })
  void win.loadURL(captureUrl())
  return win
}

async function show(): Promise<void> {
  if (!window) setWindow(makeWindow())
  const win = window!
  await loaded
  if (win.isDestroyed()) return
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  win.setBounds(capturePlacement(area, win.getBounds().height))
  win.webContents.send('capture:shown')
  win.show()
  win.focus()
}

function toggle(): void {
  if (window && window.isVisible() && window.isFocused()) window.hide()
  else void show()
}

/**
 * Holds the key while Work is on and one is set. A new key is held before
 * the old one is let go, so a key another app holds leaves his old one in
 * place. The window is made a little after the key is first held and kept
 * while any key is; it goes only when Work turns off or the key does.
 */
function sync(): void {
  if (!deps) return
  const want = deps.work.enabled() ? readCaptureKey(app.getPath('userData')) : null
  if (want !== held) {
    keyError = null
    if (want) {
      let ok = false
      try {
        ok = globalShortcut.register(want, toggle)
        if (!ok) keyError = 'Another app holds that key'
      } catch {
        keyError = 'Not a key this computer can hold'
      }
      if (ok) {
        if (held) globalShortcut.unregister(held)
        held = want
      }
    } else if (held) {
      globalShortcut.unregister(held)
      held = null
    }
  }
  if (held && !window && !prewarm) {
    prewarm = setTimeout(() => {
      prewarm = null
      if (held && !window) setWindow(makeWindow())
    }, PREWARM_MS)
  }
  if (!held) {
    if (prewarm) clearTimeout(prewarm)
    prewarm = null
    window?.destroy()
    setWindow(null)
  }
}

function fromCapture(e: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
  return window && e.sender === window.webContents ? window : null
}

/** What Settings → Work shows of the key: the one set, the default, and whether it is held. */
export interface CaptureKeyState {
  key: string | null
  defaultKey: string
  held: boolean
  error: string | null
  workOn: boolean
}

function keyState(): CaptureKeyState {
  return { key: readCaptureKey(app.getPath('userData')), defaultKey: captureKeyDefault(), held: held !== null, error: keyError, workOn: deps?.work.enabled() ?? false }
}

export function registerCapture(d: CaptureDeps): void {
  deps = d
  rmSync(picturesDir(), { recursive: true, force: true })
  d.work.onChange(sync)
  sync()

  ipcMain.handle('capture:key:get', () => keyState())
  ipcMain.handle('capture:key:set', (_e, key: unknown) => {
    if (key !== null && (typeof key !== 'string' || !isAccelerator(key))) return { ...keyState(), error: 'Not a key this computer can hold' }
    const before = readCaptureKey(app.getPath('userData'))
    writeCaptureKey(app.getPath('userData'), key as string | null)
    sync()
    // A key another app holds is not kept: the one before stays held, and stays saved.
    if (key !== null && held !== key && deps?.work.enabled()) writeCaptureKey(app.getPath('userData'), before)
    return keyState()
  })

  ipcMain.handle('capture:port', (e) => (fromCapture(e) ? (deps?.port() ?? null) : null))
  ipcMain.on('capture:hide', (e) => fromCapture(e)?.hide())
  // The page wears Work's theme, which only it knows: the backing follows, so a resize never shows the other one.
  ipcMain.on('capture:scheme', (e, scheme: unknown) => fromCapture(e)?.setBackgroundColor(scheme === 'light' ? CAPTURE_BACKING.light : CAPTURE_BACKING.dark))
  // A capture that failed after the window hid comes back without taking the keyboard from what he is doing.
  ipcMain.on('capture:failed', (e) => {
    const win = fromCapture(e)
    if (win && !win.isVisible()) win.showInactive()
  })
  ipcMain.on('capture:size', (e, height: unknown) => {
    const win = fromCapture(e)
    if (!win || typeof height !== 'number') return
    const b = win.getBounds()
    const next = clampHeight(height)
    if (next !== b.height) win.setBounds({ ...b, height: next })
  })
  ipcMain.handle('capture:picture', (e, bytes: unknown, type: unknown) => {
    if (!fromCapture(e) || !(bytes instanceof Uint8Array) || bytes.byteLength > 50 * 1024 * 1024) return null
    const ext = type === 'image/jpeg' ? 'jpg' : type === 'image/gif' ? 'gif' : type === 'image/webp' ? 'webp' : 'png'
    const dir = join(picturesDir(), randomUUID())
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `Pasted image.${ext}`)
    writeFileSync(path, bytes)
    return path
  })

  // On Windows and Linux the app quits when its last window closes: a hidden capture window must not keep it running.
  const lastClosed = (): void => {
    if (process.platform === 'darwin' || !window) return
    if (BrowserWindow.getAllWindows().every((w) => w === window || w.isDestroyed())) {
      window.destroy()
      setWindow(null)
    }
  }
  for (const w of BrowserWindow.getAllWindows()) w.on('closed', lastClosed)
  app.on('browser-window-created', (_e, created) => created.on('closed', lastClosed))
  app.on('will-quit', () => {
    if (held) globalShortcut.unregister(held)
    held = null
  })
}
