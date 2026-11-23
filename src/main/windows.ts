import { showWindowOptions } from './present'
import { POP_OUT_BAR, POP_OUT_FRAME, popOutCreated, readPopOutBounds, windowOpenHandler, type PopOutBounds } from './popOut'
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, shell, type IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { appIndexUrl } from './appScheme'
import { isCaptureWindow } from './captureWindow'
import { badgeText, shouldBounce } from './dockBadge'
import { registerNotices } from './notice'
import { killPtysForOwner } from './pty'
import { QuitGate } from './quitGate'
import { soakWindow } from './soakWindow'
import { bootMark } from './server/boot'
import { CAPTION_HEIGHT, captionInk, frameOptions, isDarkColor, BACKING, readAppearance, withPlace, type WindowAppearance, takeAppearance } from './windowFrame'

/**
 * The window registry. Every window has a *slot*: a stable id that names
 * its bounds in `window-state.json` and its workspace snapshot in the
 * server's settings KV (`workspace.getSnapshot { window }`). The renderer
 * learns its slot from preload (`--tc-window-slot=` in argv), so a window
 * restores the tab set it had, not whichever window saved last. Launch
 * opens one window per saved slot; the first ever is `main`.
 *
 * Close and quit follow the donor: a renderer that subscribed to
 * close-requested answers with hide (busy) or destroy (idle, after it
 * persisted). Closing the last window keeps the app in the dock on macOS
 * and keeps its slot, so the dock click brings the same tabs back; closing
 * one of several drops that slot and its snapshot. Quit asks the focused
 * window first (dialog when busy, then persist, then `confirm_quit`); main
 * then asks every other window to persist, waits briefly, and exits.
 */

/** A floor the layout still fits in. */
const MIN_WIDTH = 800
const MIN_HEIGHT = 520
export const MAIN_SLOT = 'main'
const CASCADE = 24
const PERSIST_TIMEOUT_MS = 2_000

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
  /** The theme the window last wore and the kind of place it showed, as its page told us
   *  (`appearance:scheme`): the next launch opens with that backing and that class. Absent
   *  until a page has said. */
  appearance?: WindowAppearance
}

interface StateFile {
  windows: Record<string, WindowState>
  focused?: string
  /** where the pop-out was left, and its size (popOut.ts) */
  popOut?: PopOutBounds
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 800, maximized: false }

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function readWindowState(raw: Partial<WindowState>): WindowState {
  return {
    x: typeof raw.x === 'number' ? raw.x : undefined,
    y: typeof raw.y === 'number' ? raw.y : undefined,
    width: Math.max(MIN_WIDTH, Number(raw.width) || DEFAULT_STATE.width),
    height: Math.max(MIN_HEIGHT, Number(raw.height) || DEFAULT_STATE.height),
    maximized: raw.maximized === true,
    ...appearanceOf(readAppearance(raw.appearance))
  }
}

/** `{ appearance }` when there is one, for a spread. */
const appearanceOf = (appearance: WindowAppearance | null | undefined): { appearance?: WindowAppearance } =>
  appearance ? { appearance } : {}

let stateFile: StateFile | null = null

/** The file before M12 held one window's bounds; that window is `main`. */
function loadStateFile(): StateFile {
  if (stateFile) return stateFile
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Record<string, unknown>
    const windows: Record<string, WindowState> = {}
    if (raw.windows && typeof raw.windows === 'object') {
      for (const [slot, state] of Object.entries(raw.windows as Record<string, unknown>)) {
        if (state && typeof state === 'object') windows[slot] = readWindowState(state as never)
      }
    } else if (typeof raw.width === 'number') {
      windows[MAIN_SLOT] = readWindowState(raw as never)
    }
    stateFile = {
      windows,
      // A `glass` key from before the one neutral palette is ignored.
      focused: typeof raw.focused === 'string' ? raw.focused : undefined,
      popOut: readPopOutBounds(raw.popOut) ?? undefined
    }
  } catch {
    stateFile = { windows: {} }
  }
  return stateFile
}

let saveTimer: NodeJS.Timeout | null = null
function saveStateSoon(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveStateNow()
  }, 400)
  saveTimer.unref()
}

function saveStateNow(): void {
  const file = loadStateFile()
  for (const { win, slot } of windows.values()) {
    if (win.isDestroyed()) continue
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
    file.windows[slot] = { ...bounds, maximized: win.isMaximized(), ...appearanceOf(file.windows[slot]?.appearance) }
  }
  const focused = entryOf(targetWindow())
  if (focused) file.focused = focused.slot
  for (const child of popOuts.values()) if (!child.isDestroyed()) file.popOut = child.getBounds()
  try {
    writeFileSync(statePath(), JSON.stringify(file))
  } catch {
    // a missing userData dir is not worth crashing over
  }
}

// ── Registry ─────────────────────────────────────────────────────────────

interface Entry {
  win: BrowserWindow
  slot: string
}

/** Live windows by webContents id. */
/** Each main window's pop-out, by the main window's webContents id. */
const popOuts = new Map<number, BrowserWindow>()
const windows = new Map<number, Entry>()
/** The window the user last had in front; pushes go here when nothing is focused. */
let lastFocusedId: number | null = null
/** Windows whose renderer asked to handle its own close. The old renderer
 *  never subscribes, so its window still closes the normal way. */
const closeSubscribers = new Set<number>()
/** Set for the one close that `window:destroy` performs itself. */
const destroying = new Set<number>()
/** Renderers that want the last word before the app exits. */
const quitSubscribers = new Set<number>()
/** Needs-you counts per window; every window reports the same hosts, so the
 *  dock shows the largest. */
const badges = new Map<number, number>()
let lastBadgeTotal = 0
/** Called when a slot is gone for good so its snapshot goes with it. */
let dropSnapshot: (slot: string) => void = () => {}

/** One staged payload: `from` staged it, `to` is the window that may take it. */
let transfer: { payload: unknown; from: number; to: number | null } | null = null

function entryOf(win: BrowserWindow | null | undefined): Entry | null {
  return win ? (windows.get(win.webContents.id) ?? null) : null
}

function windowOf(event: { sender: Electron.WebContents }): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function alive(id: number | null): BrowserWindow | null {
  if (id === null) return null
  const win = windows.get(id)?.win
  return win && !win.isDestroyed() ? win : null
}

/** Where window-scoped pushes go: the focused window, else the one the
 *  user had in front last (an appshot hotkey fires while another app is
 *  frontmost, so nothing is focused then), else any live window. */
export function targetWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getFocusedWindow() ??
    alive(lastFocusedId) ??
    [...windows.values()].map((e) => e.win).find((w) => !w.isDestroyed()) ??
    null
  )
}

export function slotOf(win: BrowserWindow): string | null {
  return entryOf(win)?.slot ?? null
}

function newSlot(): string {
  return `w-${randomUUID().slice(0, 8)}`
}

function releaseTransferFor(id: number): void {
  if (transfer && transfer.to === id) transfer = null
}

/** Bounds for a window with no saved state: a step down and right from the
 *  one in front, so a new window does not hide the old one exactly. It opens
 *  in that window's theme, the nearest guess until its own page says. */
function cascadeFrom(win: BrowserWindow | null): WindowState {
  if (!win || win.isDestroyed()) return { ...DEFAULT_STATE }
  const b = win.getBounds()
  const from = entryOf(win)
  return { x: b.x + CASCADE, y: b.y + CASCADE, width: b.width, height: b.height, maximized: false, ...appearanceOf(from && loadStateFile().windows[from.slot]?.appearance) }
}

export function createWindow(opts: { slot?: string; from?: number } = {}): BrowserWindow {
  const slot = opts.slot ?? newSlot()
  const state = loadStateFile().windows[slot] ?? cascadeFrom(targetWindow())
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    // The frame per platform (windowFrame.ts): traffic lights on macOS, Windows' own caption buttons over the page.
    // Its backing and its caption ink are the theme the window last wore; a window that never said takes the
    // dark backing the app starts in and the system's ink.
    ...frameOptions(process.platform, { dark: state.appearance ? state.appearance.scheme === 'dark' : nativeTheme.shouldUseDarkColors, icon }),
    ...(state.appearance ? {} : { backgroundColor: BACKING.dark }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // The soak's window keeps its timers and paint behind other windows (soakWindow.ts).
      backgroundThrottling: !soakWindow(),
      additionalArguments: [`--tc-window-slot=${slot}`]
    }
  })
  const id = win.webContents.id
  windows.set(id, { win, slot })
  loadStateFile().windows[slot] = state

  if (process.platform === 'win32') {
    // No menu bar, so Alt never reveals one; the menu's accelerators still run.
    win.setMenuBarVisibility(false)
    // The caption glyphs take the ink of the app's own theme, which only the page knows: it says so in
    // its theme-color (chrome/WindowControls.tsx), and until then the system's setting stands in.
    win.webContents.on('did-change-theme-color', (_event, color) => {
      if (color && !win.isDestroyed()) win.setTitleBarOverlay(captionInk(isDarkColor(color)))
    })
  }

  if (state.maximized) win.maximize()

  win.on('ready-to-show', () => {
    bootMark('ready-to-show', slot)
    if (soakWindow()) win.showInactive()
    else win.show()
  })
  win.on('focus', () => {
    lastFocusedId = id
    saveStateSoon()
  })
  win.on('resize', () => {
    saveStateSoon()
    if (!win.isDestroyed()) win.webContents.send('window:resized')
  })
  win.on('move', saveStateSoon)
  win.on('maximize', saveStateSoon)
  win.on('unmaximize', saveStateSoon)

  win.on('close', (e) => {
    if (destroying.delete(id) || gate.isQuitting()) return
    if (!closeSubscribers.has(id)) return
    // The renderer owns this decision (unsaved work, hide-instead-of-close);
    // it answers with `window:hide` or `window:destroy`.
    e.preventDefault()
    win.webContents.send('window:close-requested')
  })

  win.on('closed', () => {
    windows.delete(id)
    closeSubscribers.delete(id)
    quitSubscribers.delete(id)
    badges.delete(id)
    releaseTransferFor(id)
    killPtysForOwner(id)
    applyBadge(false)
    if (lastFocusedId === id) lastFocusedId = null
    // One of several closed: that layout is gone by the user's choice. The
    // last one keeps its slot so the dock click (or the next launch) brings
    // the same tabs back. Quit keeps every slot.
    if (!gate.isQuitting() && windows.size > 0) {
      delete loadStateFile().windows[slot]
      dropSnapshot(slot)
    }
    if (!gate.isQuitting()) saveStateNow()
  })

  // A destination that never boots must not hold the payload for the next
  // window that happens to be created.
  win.webContents.on('did-fail-load', () => releaseTransferFor(id))
  win.webContents.on('render-process-gone', () => releaseTransferFor(id))

  // The page's pop-out opens as a floating child of this window (popOut.ts), where he left it; anything else goes to the
  // system's browser. It goes with this window, and its place is kept.
  win.webContents.setWindowOpenHandler((details) => {
    // A show's windows first (present.ts): the slideshow and the presenter's view, while this page has a show running.
    const show = showWindowOptions(id, details)
    if (show) return { action: 'allow', overrideBrowserWindowOptions: show }
    return windowOpenHandler(details, (url) => void shell.openExternal(url), loadStateFile().popOut ?? null)
  })
  win.webContents.on('did-create-window', (child, details) => {
    if (details.frameName !== POP_OUT_FRAME) return
    popOuts.set(id, child)
    popOutCreated(child)
    child.on('moved', saveStateSoon)
    child.on('resized', saveStateSoon)
    child.on('closed', () => {
      if (popOuts.get(id) === child) popOuts.delete(id)
    })
  })
  win.on('closed', () => {
    const child = popOuts.get(id)
    if (child && !child.isDestroyed()) child.close()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(withPlace(process.env['ELECTRON_RENDERER_URL'], state.appearance))
  } else {
    // The app scheme, not file://: Chromium keeps a V8 code cache for the
    // bundle only on a scheme registered with codeCache (appScheme.ts).
    // The kind of place the window last showed rides in its address, for boot.js.
    win.loadURL(withPlace(appIndexUrl(), state.appearance))
  }

  if (transfer && transfer.to === null && (opts.from === undefined || transfer.from === opts.from)) {
    transfer.to = id
  }

  return win
}

/** Launch: one window per saved slot, the last-focused one in front. */
export function openSavedWindows(): void {
  const file = loadStateFile()
  const slots = Object.keys(file.windows)
  if (slots.length === 0) slots.push(MAIN_SLOT)
  const focused = file.focused && slots.includes(file.focused) ? file.focused : slots[0]
  for (const slot of slots) if (slot !== focused) createWindow({ slot })
  createWindow({ slot: focused })
}

function applyBadge(allowBounce: boolean): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const reports = [...badges.values()]
  const total = Math.max(0, ...reports)
  app.dock.setBadge(badgeText(reports))
  const active = BrowserWindow.getAllWindows().some((w) => w.isFocused())
  if (allowBounce && shouldBounce(lastBadgeTotal, total, active)) app.dock.bounce('informational')
  lastBadgeTotal = total
}

// ── Quit ─────────────────────────────────────────────────────────────────

export function hasQuitSubscriber(): boolean {
  return [...quitSubscribers].some((id) => alive(id) !== null)
}

/** Ask the window in front to confirm; it answers with `app:confirm-quit`. */
export function requestQuit(): void {
  const win = targetWindow()
  if (!win) return
  win.show()
  win.webContents.send('app:quit-requested')
}

/** Open once the user has confirmed; keeps `before-quit` from asking twice
 *  and lets the window close handler pass. See quitGate.ts. */
const gate = new QuitGate(() => app.quit())

export function isQuitting(): boolean {
  return gate.isQuitting()
}

/** Make the next confirmed quit end with `finish` (the updater's restart)
 *  instead of app.quit(); `declined` runs if the user says no to the dialog. */
export function armQuit(finish: () => void, declined: () => void): void {
  gate.arm(finish, declined)
}

/** An armed quit fell through after the gate opened: close it again so the
 *  windows go back to asking. */
export function cancelQuit(): void {
  gate.cancel()
}

/** The persist acks main is waiting on, by webContents id. */
const persistWaiters = new Map<number, () => void>()

/** Every other window persists its own slot before the app exits. Only the
 *  focused one had the dialog; these just write. A renderer that does not
 *  answer inside the cap does not hold the quit. */
function persistOthers(except: number): Promise<void> {
  const waits: Promise<void>[] = []
  for (const id of quitSubscribers) {
    if (id === except) continue
    const win = alive(id)
    if (!win) continue
    waits.push(
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, PERSIST_TIMEOUT_MS)
        timer.unref()
        function done(): void {
          clearTimeout(timer)
          persistWaiters.delete(id)
          resolve()
        }
        persistWaiters.set(id, done)
        win.webContents.send('window:persist-requested')
      })
    )
  }
  return Promise.all(waits).then(() => undefined)
}

/** The renderer has finished asking the user and persisted; the next
 *  `before-quit` goes straight through instead of bouncing back. With no
 *  renderer to ask (`from` -1) the quit is confirmed on its own. */
export async function confirmQuit(from: number): Promise<void> {
  if (!gate.begin()) return
  await persistOthers(from)
  saveStateNow()
  showAllWindows()
  gate.finish()
}

export function showAllWindows(): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isVisible() && !isCaptureWindow(w)) w.show()
}

// ── IPC ──────────────────────────────────────────────────────────────────

export function registerWindows(hooks: { dropSnapshot?: (slot: string) => void } = {}): void {
  if (hooks.dropSnapshot) dropSnapshot = hooks.dropSnapshot

  ipcMain.handle('window:minimize', (e) => windowOf(e)?.minimize())
  // the pop-out keeps its picture's shape as he drags it to a size: the bar under the picture is extra
  ipcMain.handle('popout:shape', (e, ratio: unknown) => {
    const child = popOuts.get(e.sender.id)
    if (!child || child.isDestroyed() || typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return
    child.setAspectRatio(ratio, { width: 0, height: POP_OUT_BAR })
  })
  ipcMain.handle('window:toggle-maximize', (e) => {
    const win = windowOf(e)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:close', (e) => windowOf(e)?.close())
  ipcMain.handle('window:is-maximized', (e) => windowOf(e)?.isMaximized() ?? false)
  ipcMain.handle('window:is-focused', (e) => windowOf(e)?.isFocused() ?? false)
  ipcMain.handle('window:set-title', (e, title: string) => windowOf(e)?.setTitle(String(title)))

  ipcMain.on('window:close-subscribe', (e: IpcMainEvent) => {
    closeSubscribers.add(e.sender.id)
  })

  ipcMain.on('app:quit-subscribe', (e: IpcMainEvent) => {
    quitSubscribers.add(e.sender.id)
  })
  ipcMain.on('window:persisted', (e: IpcMainEvent) => {
    persistWaiters.get(e.sender.id)?.()
  })
  ipcMain.handle('app:confirm-quit', (e) => confirmQuit(e.sender.id))
  ipcMain.on('app:quit-declined', () => gate.decline())

  ipcMain.handle('window:hide', (e) => windowOf(e)?.hide())
  ipcMain.handle('window:destroy', (e) => {
    const win = windowOf(e)
    if (!win) return
    destroying.add(win.webContents.id)
    win.destroy()
  })

  ipcMain.handle('window:new', (e) => {
    createWindow({ from: e.sender.id })
  })

  ipcMain.handle('window:stage-transfer', (e, payload: unknown) => {
    if (typeof payload === 'string' && payload.trim() === '') {
      throw new Error('empty window transfer payload')
    }
    transfer = { payload, from: e.sender.id, to: null }
  })
  ipcMain.handle('window:take-transfer', (e) => {
    if (!transfer || transfer.to !== e.sender.id) return null
    const { payload } = transfer
    transfer = null
    return payload
  })

  ipcMain.handle('window:buttons-visible', (e, visible: boolean) => {
    if (process.platform !== 'darwin') return
    windowOf(e)?.setWindowButtonVisibility(visible !== false)
  })

  // The page's theme and the kind of place it is on (lib/placeScheme.ts). The window's backing takes
  // the theme's colour now, and both are kept with its bounds for the next launch.
  ipcMain.on('appearance:scheme', (e: IpcMainEvent, payload: unknown) => {
    const entry = windows.get(e.sender.id)
    if (!entry || entry.win.isDestroyed()) return
    const file = loadStateFile()
    const taken = takeAppearance(file.windows[entry.slot]?.appearance, payload)
    if (!taken) return
    entry.win.setBackgroundColor(taken.backing)
    // A window always has a state entry (createWindow writes it); one that lost it gets the default bounds until the next save.
    file.windows[entry.slot] = { ...(file.windows[entry.slot] ?? DEFAULT_STATE), appearance: taken.appearance }
    saveStateSoon()
  })

  ipcMain.handle('window:set-zoom', (e, factor: number) => {
    const f = Number(factor)
    if (!Number.isFinite(f) || f <= 0) return
    e.sender.setZoomFactor(f)
    // Windows: the caption buttons are as tall as the page's title bar, which grows with the zoom.
    if (process.platform === 'win32') windowOf(e)?.setTitleBarOverlay({ height: Math.round(CAPTION_HEIGHT * f) })
  })

  ipcMain.handle('app:dock-badge', (e, count: number) => {
    const n = Math.max(0, Math.trunc(Number(count) || 0))
    badges.set(e.sender.id, n)
    applyBadge(true)
  })
  // Work's system notifications: the day's digest, and a thing that cannot wait while no window is in front (notice.ts).
  registerNotices()
}

/** The donor's dock menu has one item. */
export function registerDock(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  app.dock.setMenu(
    Menu.buildFromTemplate([{ label: 'New Window', click: () => void createWindow() }])
  )
}

/** Clicking the dock icon should bring back a hidden window before it makes
 *  a new one. With none left, the kept slot comes back with its tabs. */
export function activateWindows(): void {
  // The capture window waits hidden for its key (capture.ts): the dock click is not that key.
  const all = BrowserWindow.getAllWindows().filter((w) => !isCaptureWindow(w))
  const hidden = all.filter((w) => !w.isVisible())
  if (hidden.length > 0) {
    for (const w of hidden) {
      if (w.isMinimized()) w.restore()
      w.show()
    }
    hidden[0].focus()
    return
  }
  if (all.length === 0) openSavedWindows()
  else (targetWindow() ?? all[0]).focus()
}

/** Dev-only: what the exit test needs to tell windows apart over CDP. */
export function describeWindows(): {
  id: number
  slot: string
  title: string
  focused: boolean
  visible: boolean
  target: boolean
}[] {
  const target = targetWindow()
  return [...windows.values()]
    .filter(({ win }) => !win.isDestroyed())
    .map(({ win, slot }) => ({
      id: win.webContents.id,
      slot,
      title: win.getTitle(),
      focused: win.isFocused(),
      visible: win.isVisible(),
      target: win === target
    }))
}
