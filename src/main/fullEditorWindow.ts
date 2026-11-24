import { BrowserWindow, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { staysOn } from './fullEditorCarry'

/**
 * The box's full editor, carried (fullEditorCarry.ts), in a window of its own (docs/agents/work-sheets.md "The full
 * editor"). Not the system browser: there ONLYOFFICE's code would share the browser's 127.0.0.1 cookie jar with every
 * loopback server of his (a cookie keeps no port). Here it has a session of its own, in memory, gone with the window:
 * no cookie but its own, no preload, no Node, sandboxed. It stays on its loopback origin; a link elsewhere opens in
 * the browser, and it is asked no permission it is granted.
 */

export function openFullEditorWindow(url: string): BrowserWindow {
  const own = new URL(url).origin
  const partition = `full-editor-${randomUUID()}`
  const jar = session.fromPartition(partition)
  jar.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'clipboard-sanitized-write'))
  jar.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write')
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Full editor',
    autoHideMenuBar: true,
    webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false }
  })
  const elsewhere = (to: string): void => {
    if (/^https?:\/\//i.test(to)) void shell.openExternal(to)
  }
  win.webContents.setWindowOpenHandler(({ url: to }) => {
    if (!staysOn(own, to)) elsewhere(to)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, to) => {
    if (staysOn(own, to)) return
    event.preventDefault()
    elsewhere(to)
  })
  win.webContents.on('will-redirect', (event, to) => {
    if (!staysOn(own, to)) event.preventDefault()
  })
  void win.loadURL(url)
  return win
}
