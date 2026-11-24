import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { staysOn } from './fullEditorCarry'

/**
 * The box's full editor, carried (fullEditorCarry.ts), in a window of its own (docs/agents/work-sheets.md "The full
 * editor"). Not the system browser: there ONLYOFFICE's code would share the browser's 127.0.0.1 cookie jar with every
 * loopback server of his (a cookie keeps no port). Here it has a session of its own, in memory, gone with the window:
 * no cookie but its own, no preload, no Node, sandboxed. Nothing it loads, frames or opens leaves its loopback
 * origin (a link elsewhere does nothing), and it is granted no permission but writing the clipboard.
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
  // Nothing of the editor leaves its origin: no request, frame or socket to another host, no link to the browser.
  const wsOwn = own.replace(/^http/, 'ws')
  jar.webRequest.onBeforeRequest((details, done) => done({ cancel: !(staysOn(own, details.url) || staysOn(wsOwn, details.url) || /^(data|blob|devtools):/.test(details.url)) }))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, to) => {
    if (!staysOn(own, to)) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event, to) => {
    if (!staysOn(own, to)) event.preventDefault()
  })
  void win.loadURL(url)
  return win
}
