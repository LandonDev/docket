import { BrowserWindow, ipcMain, Notification, type WebContents } from 'electron'

/**
 * The desktop's system notification (docs/agents/work-digest.md). Only Work
 * uses it, for two things: the day's digest, and a thing that cannot wait
 * while the app is not in front. The toast in the window says the same and
 * stays; this is for a person looking at another app.
 *
 * A window asks with `app:notice {key, title, body, silent?, telling?}`. Main
 * shows it only while no app window is focused, once per key across windows,
 * and again when its words or its telling change (silent unless the ask holds
 * news: the window says which); a click brings a window that asked forward and tells it which
 * key
 * (`app:notice-open`). `app:notice-close {key}` lets go of this window's
 * ask: the notification is taken back once no window still asks for it.
 */

export interface NoticeAsk {
  key: string
  title: string
  /** one line, or two: a thing's title and its detail */
  body: string
  /** the digest's: no sound */
  silent?: boolean
  /** which tellings it says: a new one in the same words is shown again, and two windows asking the same one show it once */
  telling?: string
}

/**
 * What an ask does to the notification of its key: `said` is what the one out now says (undefined: none is out).
 * Shown only while no app window is focused, and once per key however many windows ask. Its words changed while it
 * is out (four things became five, or three): it is shown again in the new words, or only taken back when a window
 * is in front now and its toast says them.
 */
export function noticeStep(said: string | undefined, words: string, anyFocused: boolean): 'show' | 'replace' | 'withdraw' | 'keep' {
  if (said === undefined) return anyFocused ? 'keep' : 'show'
  if (said === words) return 'keep'
  return anyFocused ? 'withdraw' : 'replace'
}

/** What an ask says, as `noticeStep` compares it: its words and the tellings behind them. */
export const noticeWords = (ask: NoticeAsk): string => `${ask.title}\n${ask.body}\n${ask.telling ?? ''}`

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')
/** At most two lines, each cleaned as one. */
const lines = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? value
        .split(/\r?\n/)
        .map((line) => text(line, max))
        .filter(Boolean)
        .slice(0, 2)
        .join('\n')
        .slice(0, max)
    : ''

/** A key is the window's own name for the notice and comes back to it on a click: kept whole, never cleaned or cut (a cut one would open nothing). One past any real key's length is refused. */
const KEY_MAX = 1_000
const keyOf = (value: unknown): string => (typeof value === 'string' && value.length <= KEY_MAX ? value : '')

/** The ask as main takes it: a key, a title and a body, each cut; null for anything else. */
export function readAsk(value: unknown): NoticeAsk | null {
  const v = (value ?? {}) as Record<string, unknown>
  const key = keyOf(v.key)
  const title = text(v.title, 120)
  const body = lines(v.body, 300)
  if (!key || !title || !body) return null
  const telling = keyOf(v.telling)
  return { key, title, body, ...(v.silent === true ? { silent: true } : {}), ...(telling ? { telling } : {}) }
}

/**
 * Which windows ask for each key. Every window mirrors the same ledger, so
 * each asks for the same keys; a window that closes or lets go must not take
 * back a notification another window still stands behind.
 */
export class Claims {
  private readonly by = new Map<string, Set<number>>()
  add(key: string, window: number): void {
    const set = this.by.get(key) ?? new Set<number>()
    set.add(window)
    this.by.set(key, set)
  }
  /** Lets go of one window's ask; true once no window asks for the key. */
  drop(key: string, window: number): boolean {
    const set = this.by.get(key)
    if (!set) return true
    set.delete(window)
    if (set.size > 0) return false
    this.by.delete(key)
    return true
  }
  /** A window that went away: the keys nobody asks for any more. */
  dropWindow(window: number): string[] {
    return [...this.by.keys()].filter((key) => this.by.get(key)!.has(window) && this.drop(key, window))
  }
  of(key: string): number[] {
    return [...(this.by.get(key) ?? [])]
  }
}

export function registerNotices(): void {
  const shown = new Map<string, Notification>()
  const claims = new Claims()
  const watched = new Set<number>()
  /** What each shown one says. */
  const words = new Map<string, string>()
  const withdraw = (key: string): void => {
    const notification = shown.get(key)
    if (!notification) return
    shown.delete(key)
    words.delete(key)
    notification.close()
  }
  const watch = (sender: WebContents): void => {
    if (watched.has(sender.id)) return
    watched.add(sender.id)
    const id = sender.id
    sender.once('destroyed', () => {
      watched.delete(id)
      for (const key of claims.dropWindow(id)) withdraw(key)
    })
  }
  ipcMain.handle('app:notice', (e, raw: unknown) => {
    const ask = readAsk(raw)
    if (!ask || !Notification.isSupported()) return
    claims.add(ask.key, e.sender.id)
    watch(e.sender)
    const anyFocused = BrowserWindow.getAllWindows().some((w) => w.isFocused())
    const step = noticeStep(shown.has(ask.key) ? words.get(ask.key) : undefined, noticeWords(ask), anyFocused)
    if (step === 'keep') return
    if (step !== 'show') withdraw(ask.key)
    if (step === 'withdraw') return
    // Whether it sounds is the window's to say: it knows which of the things in it he has heard already.
    const notification = new Notification({ title: ask.title, body: ask.body, silent: ask.silent === true })
    shown.set(ask.key, notification)
    words.set(ask.key, noticeWords(ask))
    const forget = (): void => {
      if (shown.get(ask.key) !== notification) return
      shown.delete(ask.key)
      words.delete(ask.key)
    }
    notification.on('click', () => {
      forget()
      // Any window that still asks: each mirrors the same ledger and routes the key alike.
      const window = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && claims.of(ask.key).includes(w.webContents.id))
      if (!window) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      window.webContents.send('app:notice-open', ask.key)
    })
    notification.on('close', forget)
    notification.show()
  })
  ipcMain.handle('app:notice-close', (e, raw: unknown) => {
    const key = keyOf(raw)
    if (key && claims.drop(key, e.sender.id)) withdraw(key)
  })
}
