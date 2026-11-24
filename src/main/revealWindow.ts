import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMain } from 'electron'
import { REVEAL_LOCKED, REVEAL_NO_WINDOW, type RevealNavigation } from '@shared/contract-work-reveal'
import type { MacPresence } from '@shared/macPresence'
import type { RevealWindow } from './server/work/reveal'

const WAIT_MS = 5_000
const WRONG_SCREEN = 'This computer’s screen is unavailable.'
const ASLEEP = 'Wake this computer to open that destination.'

interface RevealWindowDeps {
  target(ready: (window: BrowserWindow) => boolean): BrowserWindow | null
  presence(): Pick<MacPresence, 'screen' | 'power' | 'saver'>
  dismissSaver?(): Promise<unknown>
  onReady(): void
}

export function revealScreenRefusal({ screen, power }: ReturnType<RevealWindowDeps['presence']>): string | null {
  if (power === 'asleep') return ASLEEP
  if (screen === 'locked') return REVEAL_LOCKED
  return screen === 'unlocked' ? null : WRONG_SCREEN
}

/** One window gets the navigation. It arms the read guard before we give it focus. */
export function registerRevealWindow(ipc: IpcMain, deps: RevealWindowDeps): RevealWindow {
  const ready = new WeakMap<Electron.WebContents, object>()
  const pending = new Map<string, { contents: Electron.WebContents; accept(): void }>()
  const target = () => deps.target((window) => !window.webContents.isDestroyed() && ready.has(window.webContents))
  const screen = () => revealScreenRefusal(deps.presence())

  ipc.on('app:reveal-ready', ({ sender, senderFrame }) => {
    if (senderFrame !== sender.mainFrame || ready.has(sender) || !deps.target((win) => win.webContents === sender)) return
    ready.set(sender, {})
    sender.once('did-start-loading', () => ready.delete(sender))
    deps.onReady()
  })
  ipc.on('app:reveal-prepared', ({ sender, senderFrame }, token: unknown) => {
    if (senderFrame !== sender.mainFrame || typeof token !== 'string') return
    const ask = pending.get(token)
    if (ask?.contents === sender) ask.accept()
  })

  return {
    check: () => screen() ?? (target() ? null : REVEAL_NO_WINDOW),
    async open(navigation: RevealNavigation, signal?: AbortSignal) {
      const before = screen()
      if (before) throw new Error(before)
      const win = target()
      if (!win) throw new Error(REVEAL_NO_WINDOW)

      const { webContents: contents } = win
      const shell = ready.get(contents)
      const token = randomUUID()
      try {
        await new Promise<void>((resolve, reject) => {
          function finish(error?: Error): void {
            clearTimeout(timer)
            pending.delete(token)
            contents.removeListener('destroyed', closed)
            if (error) reject(error)
            else resolve()
          }
          const closed = () => finish(new Error(REVEAL_NO_WINDOW))
          const timer = setTimeout(closed, WAIT_MS)
          pending.set(token, { contents, accept: () => finish() })
          contents.once('destroyed', closed)
          try { contents.send('app:reveal-prepare', token) } catch { closed() }
        })
        // The host uses the same passwordless-saver check as other screen work.
        if (!signal?.aborted && deps.presence().saver) await deps.dismissSaver?.()
        if (signal?.aborted) throw new Error('The connection closed before the destination opened.')
        const after = screen()
        if (after) throw new Error(after)
        if (win.isDestroyed() || ready.get(contents) !== shell) throw new Error(REVEAL_NO_WINDOW)
        contents.send('app:reveal-open', token, navigation)
      } catch (err) {
        if (!contents.isDestroyed()) {
          try { contents.send('app:reveal-cancel', token) } catch { /* The renderer may be gone. */ }
        }
        throw err
      }
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  }
}
