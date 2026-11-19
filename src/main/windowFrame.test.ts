import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { channels, resolve, themes } from '../renderer/src/lib/colourMath'
import { APP_USER_MODEL_ID, CAPTION_HEIGHT, captionInk, captionOverlay, frameOptions, isDarkColor, localUserData, SYMBOL } from './windowFrame'

/** A token of index.css in one theme, as the plain `#rrggbb` main can hand to Electron. */
const app = themes(readFileSync(join(__dirname, '../renderer/src/index.css'), 'utf8'))
const tokenHex = (theme: 'dark' | 'light', token: string): string =>
  `#${channels(resolve(app[theme], `var(${token})`))
    .slice(0, 3)
    .map((c) => Math.round(c * 255).toString(16).padStart(2, '0'))
    .join('')}`

const look = { dark: true, icon: '/app/icon.png' }

describe('the window frame per platform', () => {
  it('a Mac keeps the hidden title bar and the inset traffic lights, exactly as before the Windows port', () => {
    expect(frameOptions('darwin', look)).toEqual({
      autoHideMenuBar: true,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 13 },
      backgroundColor: '#171717'
    })
  })

  it('Linux keeps the system frame and takes the window icon', () => {
    expect(frameOptions('linux', look)).toEqual({
      autoHideMenuBar: true,
      titleBarStyle: 'default',
      backgroundColor: '#171717',
      icon: '/app/icon.png'
    })
  })

  it("Windows hides the title bar and lets Windows draw its own caption buttons over the page's bar", () => {
    const frame = frameOptions('win32', look)
    expect(frame.titleBarStyle).toBe('hidden')
    expect(frame.titleBarOverlay).toEqual({ height: CAPTION_HEIGHT, color: '#00000000', symbolColor: SYMBOL.dark })
    expect(frame.backgroundColor).toBe('#171717')
    // No traffic lights, no icon (the exe carries it), and no auto-hide: the menu bar is hidden outright.
    expect(frame).not.toHaveProperty('trafficLightPosition')
    expect(frame).not.toHaveProperty('icon')
    expect(frame).not.toHaveProperty('autoHideMenuBar')
    // One neutral palette, no glass (docs/DESIGN.md): no Mica behind the shell.
    expect(frame).not.toHaveProperty('backgroundMaterial')
  })

  it('the caption glyphs take the ink of the theme they sit on', () => {
    expect(captionOverlay(true).symbolColor).toBe(SYMBOL.dark)
    expect(captionOverlay(false).symbolColor).toBe(SYMBOL.light)
    // Light's ink is the app's own `foreground`, so the glyphs match the title bar's text; dark's is held as it was.
    expect(SYMBOL).toEqual({ dark: '#fafafa', light: tokenHex('light', '--foreground') })
    expect(frameOptions('win32', { ...look, dark: false }).titleBarOverlay).toEqual(captionOverlay(false))
  })

  it('a theme change sets the glyphs\' ink alone, so a zoomed bar keeps its caption height', () => {
    expect(captionInk(false)).toEqual({ color: '#00000000', symbolColor: SYMBOL.light })
    expect(captionInk(true)).not.toHaveProperty('height')
    expect(captionOverlay(true)).toEqual({ height: CAPTION_HEIGHT, ...captionInk(true) })
  })

  it("reads the page's theme colour as dark or light, and anything unreadable as the default dark", () => {
    expect(isDarkColor('#171717')).toBe(true)
    expect(isDarkColor('#f7f7f5')).toBe(false)
    expect(isDarkColor('#FFFFFF')).toBe(false)
    expect(isDarkColor(null)).toBe(true)
    expect(isDarkColor('oklch(0.97 0 0)')).toBe(true)
  })
})

describe('where the data lives', () => {
  it('Windows keeps it under %LOCALAPPDATA%, off the roaming profile, under the name Electron chose', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }
    expect(localUserData('win32', env, 'C:\\Users\\me\\AppData\\Roaming\\TempCode')).toMatch(/Local[\\/]TempCode$/)
    expect(localUserData('win32', env, 'C:\\Users\\me\\AppData\\Roaming\\TempCodeE2E')).toMatch(/Local[\\/]TempCodeE2E$/)
  })

  it('every other platform keeps Electron\'s own folder, and so does a Windows that names no local one', () => {
    expect(localUserData('darwin', { LOCALAPPDATA: 'C:\\x' }, '/Users/me/Library/Application Support/TempCode')).toBeNull()
    expect(localUserData('linux', {}, '/home/me/.config/TempCode')).toBeNull()
    expect(localUserData('win32', {}, 'C:\\Users\\me\\AppData\\Roaming\\TempCode')).toBeNull()
  })

  it("the app's id on Windows is the installer's (electron-builder.yml appId), so toasts find the shortcut", () => {
    expect(APP_USER_MODEL_ID).toBe('dev.landon.tempcode')
  })
})
