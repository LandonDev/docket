import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, globalShortcut: {}, ipcMain: {}, nativeTheme: {}, screen: {} }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
import { CAPTURE_BACKING, CAPTURE_MAX_HEIGHT, CAPTURE_MIN_HEIGHT, CAPTURE_WIDTH, captureKeyDefault, capturePlacement, captureUrl, captureWindowOptions, clampHeight, isAccelerator, readCaptureKey, writeCaptureKey } from './capture'
import { channels, resolve, themes } from '../renderer/src/lib/colourMath'

const hex = (c: string): string => '#' + channels(c).slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')

/* The capture window's main-process parts (docs/agents/work-capture.md):
   the key, where it is kept, where the window sits and what it is made as. */

describe('the key', () => {
  it('defaults to a key free on each system', () => {
    expect(captureKeyDefault('darwin')).toBe('Command+Shift+Space')
    expect(captureKeyDefault('win32')).toBe('Alt+Shift+Space')
  })

  it('keeps his key, his choice to have none, and falls back to the default on a bad file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-key-'))
    expect(readCaptureKey(dir, 'darwin')).toBe('Command+Shift+Space')
    writeCaptureKey(dir, 'Control+Alt+K')
    expect(readCaptureKey(dir, 'darwin')).toBe('Control+Alt+K')
    writeCaptureKey(dir, null)
    expect(readCaptureKey(dir, 'darwin')).toBeNull()
    expect(JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8'))).toEqual({ key: null })
    writeFileSync(join(dir, 'capture.json'), '{"key":"Shift+A"}')
    expect(readCaptureKey(dir, 'win32')).toBe('Alt+Shift+Space')
  })

  it('takes a chord with a real modifier and one key, nothing else', () => {
    for (const ok of ['Command+Shift+Space', 'Alt+Shift+Space', 'Control+Alt+K', 'Super+F12', 'CommandOrControl+/']) expect(isAccelerator(ok), ok).toBe(true)
    for (const bad of ['Space', 'Shift+A', 'Command+Shift', 'Command++', 'Hyper+K', 'Command+Shift+Space+Alt+Ctrl+K', 'Command+ü']) expect(isAccelerator(bad), bad).toBe(false)
  })
})

describe('the window', () => {
  it('sits centred a fifth of the way down the display under the pointer', () => {
    expect(capturePlacement({ x: 0, y: 25, width: 1440, height: 875 }, 140)).toEqual({ x: 380, y: 218, width: CAPTURE_WIDTH, height: 140 })
    // a display narrower than the window: 16px each side
    expect(capturePlacement({ x: 100, y: 0, width: 600, height: 800 }, 50)).toMatchObject({ x: 116, width: 568, height: CAPTURE_MIN_HEIGHT })
  })

  it('holds its height between its bounds', () => {
    expect(clampHeight(10)).toBe(CAPTURE_MIN_HEIGHT)
    expect(clampHeight(9999)).toBe(CAPTURE_MAX_HEIGHT)
    expect(clampHeight(Number.NaN)).toBe(CAPTURE_MIN_HEIGHT)
    expect(clampHeight(201.4)).toBe(201)
  })

  it('is a hidden, frameless, sandboxed window on top, its backing the theme it will wear', () => {
    const o = captureWindowOptions(false, '/p/capture.js')
    expect(o).toMatchObject({ show: false, frame: false, skipTaskbar: true, alwaysOnTop: true, resizable: false, backgroundColor: '#ffffff' })
    expect(o.webPreferences).toMatchObject({ preload: '/p/capture.js', sandbox: true, contextIsolation: true, nodeIntegration: false })
    expect(captureWindowOptions(true, '').backgroundColor).toBe(CAPTURE_BACKING.dark)
    expect(captureUrl()).toBe('tempcode-app://renderer/capture.html?place=work')
  })

  it("backs the page with index.css's popover in each theme", () => {
    const { dark, light } = themes(readFileSync(join(__dirname, '../renderer/src/index.css'), 'utf8'))
    expect(hex(resolve(dark, 'var(--popover)'))).toBe(CAPTURE_BACKING.dark)
    expect(hex(resolve(light, 'var(--popover)'))).toBe(CAPTURE_BACKING.light)
  })
})
