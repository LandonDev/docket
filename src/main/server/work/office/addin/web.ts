import { OfficeError } from '../carrier'

/**
 * Excel, Word or PowerPoint for the web as the switch's page, where no
 * desktop app is installed (docs/agents/work-office.md "Office on the web";
 * the sheet research, Part D §4). Microsoft's pages refuse to be framed, so
 * the file opens as a top-level page in a `WebContentsView` of a window of
 * our own: his own sign-in, a session apart from the app's (`persist:microsoft`),
 * no Node, sandboxed. It opens only a Microsoft file; once open, the page may
 * go anywhere over https, since a school or company's sign-in passes through
 * its own sign-in site, and the window's title always names the site it is
 * on. A new window that is not Microsoft's opens in his browser.
 */

export const MICROSOFT_PARTITION = 'persist:microsoft'

const MICROSOFT = /(^|\.)(office\.com|office365\.com|officeapps\.live\.com|microsoft\.com|microsoftonline\.com|microsoft365\.com|cloud\.microsoft|sharepoint\.com|onedrive\.com)$|^(login|onedrive|account)\.live\.com$/i

/** Whether a file or a new window is Microsoft's: https on one of Microsoft's own sites. */
export function isMicrosoftUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && MICROSOFT.test(u.hostname)
  } catch {
    return false
  }
}

/** Microsoft's sign-in hides passkeys from an `Electron/` agent: it sees plain Chrome. */
export const plainChromeUa = (ua: string): string => ua.replace(/\s?Electron\/\S+/, '').replace(/\s?TempCode\/\S+/i, '')

/** "Budget.xlsx — contoso.sharepoint.com": the page's own title can claim anything, the site cannot. */
export function windowTitle(title: string, url: string): string {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    host = ''
  }
  const words = title.trim().slice(0, 120)
  return host ? (words ? `${words} — ${host}` : host) : words || 'Office'
}

let win: import('electron').BrowserWindow | null = null

export async function openOfficeWeb(url: string): Promise<void> {
  if (!isMicrosoftUrl(url)) throw new OfficeError('Only a file in OneDrive, SharePoint or Teams opens in Office on the web.', 'not-found')
  const electron = await import('electron').catch(() => null)
  if (!electron?.BrowserWindow || !electron.app?.isReady?.()) throw new OfficeError('This host has no screen to open Office on the web in.', 'not-installed')
  const { BrowserWindow, WebContentsView, session, shell } = electron
  if (win && !win.isDestroyed()) {
    const view = win.contentView.children[0] as import('electron').WebContentsView | undefined
    await view?.webContents.loadURL(url)
    win.show()
    win.focus()
    return
  }
  const ses = session.fromPartition(MICROSOFT_PARTITION)
  ses.setUserAgent(plainChromeUa(ses.getUserAgent()))
  // Nothing from Microsoft's pages asks this machine for a camera, a file or a notification.
  ses.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'clipboard-sanitized-write'))
  win = new BrowserWindow({ width: 1280, height: 860, title: 'Office', show: false, webPreferences: { sandbox: true } })
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  win.contentView.addChildView(view)
  const fit = (): void => {
    if (!win || win.isDestroyed()) return
    const [width, height] = win.getContentSize()
    view.setBounds({ x: 0, y: 0, width, height })
  }
  win.on('resize', fit)
  win.on('closed', () => {
    view.webContents.close()
    win = null
  })
  view.webContents.setWindowOpenHandler(({ url: to }) => {
    if (isMicrosoftUrl(to)) void view.webContents.loadURL(to)
    else if (/^https?:/i.test(to)) void shell.openExternal(to)
    return { action: 'deny' }
  })
  // Sign-in may pass through his school's or company's own site; nothing goes over plain http.
  const httpsOnly = (e: { preventDefault(): void }, to: string): void => {
    if (!/^https:/i.test(to)) e.preventDefault()
  }
  view.webContents.on('will-navigate', httpsOnly)
  view.webContents.on('will-redirect', httpsOnly)
  view.webContents.on('will-frame-navigate', (e) => {
    if (!/^(https:|about:|blob:|data:)/i.test(e.url)) e.preventDefault()
  })
  // There is no address bar: the title names the site the page is on.
  const titled = (): void => {
    if (!win || win.isDestroyed()) return
    win.setTitle(windowTitle(view.webContents.getTitle(), view.webContents.getURL()))
  }
  view.webContents.on('page-title-updated', titled)
  view.webContents.on('did-navigate', titled)
  fit()
  win.show()
  await view.webContents.loadURL(url)
}
