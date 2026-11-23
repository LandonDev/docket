import { BrowserWindow, ipcMain, Notification } from 'electron'

/**
 * The desktop's system notification (docs/agents/work-digest.md). Only Work
 * uses it, for two things: the day's digest, and a thing that cannot wait
 * while the app is not in front. The toast in the window says the same and
 * stays; this is for a person looking at another app.
 *
 * A window asks with `app:notice {key, title, body, silent?}`. Main shows
 * it only while no app window is focused, once per key across windows; a
 * click brings the window that asked forward and tells it which key
 * (`app:notice-open`). `app:notice-close {key}` takes it back.
 */

export interface NoticeAsk {
  key: string
  title: string
  body: string
  /** the digest's: no sound */
  silent?: boolean
}

/** Shown only while no app window is focused, and once per key however many windows ask. */
export function shouldNotify(key: string, shown: ReadonlySet<string>, anyFocused: boolean): boolean {
  return !anyFocused && !shown.has(key)
}

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** The ask as main takes it: a key, a title and a body, each one line and cut; null for anything else. */
export function readAsk(value: unknown): NoticeAsk | null {
  const v = (value ?? {}) as Record<string, unknown>
  const key = text(v.key, 200)
  const title = text(v.title, 120)
  const body = text(v.body, 300)
  if (!key || !title || !body) return null
  return { key, title, body, ...(v.silent === true ? { silent: true } : {}) }
}

export function registerNotices(): void {
  const shown = new Map<string, Notification>()
  ipcMain.handle('app:notice', (e, raw: unknown) => {
    const ask = readAsk(raw)
    if (!ask || !Notification.isSupported()) return
    const anyFocused = BrowserWindow.getAllWindows().some((w) => w.isFocused())
    if (!shouldNotify(ask.key, new Set(shown.keys()), anyFocused)) return
    const sender = e.sender
    const notification = new Notification({ title: ask.title, body: ask.body, silent: ask.silent === true })
    shown.set(ask.key, notification)
    const forget = (): void => {
      if (shown.get(ask.key) === notification) shown.delete(ask.key)
    }
    notification.on('click', () => {
      forget()
      if (sender.isDestroyed()) return
      const window = BrowserWindow.fromWebContents(sender)
      if (window) {
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      }
      sender.send('app:notice-open', ask.key)
    })
    notification.on('close', forget)
    notification.show()
  })
  ipcMain.handle('app:notice-close', (_e, raw: unknown) => {
    const key = text(raw, 200)
    const notification = shown.get(key)
    if (!notification) return
    shown.delete(key)
    notification.close()
  })
}
