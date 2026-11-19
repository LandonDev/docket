import { OfficeError } from '../carrier'

/**
 * Excel, Word or PowerPoint for the web as the switch's page, where no
 * desktop app is installed (docs/agents/work-office.md "Office on the web";
 * the sheet research, Part D §4). Microsoft's pages refuse to be framed, so
 * the file opens as a top-level page in a `WebContentsView` of a window of
 * our own: his own sign-in, a session apart from the app's (`persist:microsoft`),
 * no Node, sandboxed, and nowhere to go but Microsoft's sites. Anything else
 * it links to opens in his browser.
 */

export const MICROSOFT_PARTITION = 'persist:microsoft'

const MICROSOFT = /(^|\.)(office\.com|office365\.com|officeapps\.live\.com|live\.com|microsoft\.com|microsoftonline\.com|microsoft365\.com|cloud\.microsoft|sharepoint\.com|onedrive\.com|msauth\.net|msftauth\.net|msauthimages\.net|msocdn\.com|akamaized\.net)$/i

/** Whether the view may go there: https on one of Microsoft's own sites. */
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
  view.webContents.on('will-navigate', (e, to) => {
    if (isMicrosoftUrl(to)) return
    e.preventDefault()
    if (/^https?:/i.test(to)) void shell.openExternal(to)
  })
  view.webContents.on('page-title-updated', (_e, title) => win?.setTitle(title))
  fit()
  win.show()
  await view.webContents.loadURL(url)
}
