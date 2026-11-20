import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * The capture window's bridge (src/main/capture.ts): nothing of the main
 * window's preload, only what the one small page needs. Sandboxed.
 */
const capture = {
  platform: process.platform as string,
  /** the local host's port, for its socket */
  port: (): Promise<number | null> => ipcRenderer.invoke('capture:port'),
  hide: (): void => ipcRenderer.send('capture:hide'),
  /** a capture that failed after the window hid: the window comes back, without the keyboard */
  failed: (): void => ipcRenderer.send('capture:failed'),
  size: (height: number): void => ipcRenderer.send('capture:size', height),
  scheme: (scheme: 'dark' | 'light'): void => ipcRenderer.send('capture:scheme', scheme),
  /** a pasted picture, kept as a file until the host copies it; its path, or null */
  picture: (bytes: Uint8Array, type: string): Promise<string | null> => ipcRenderer.invoke('capture:picture', bytes, type),
  /** a dropped or pasted file's path on this computer; '' for one with none */
  pathOf: (file: File): string => webUtils.getPathForFile(file),
  onShown: (fn: () => void): (() => void) => {
    const listener = (): void => fn()
    ipcRenderer.on('capture:shown', listener)
    return () => ipcRenderer.removeListener('capture:shown', listener)
  },
  /** the window hid, however it was hidden */
  onHidden: (fn: () => void): (() => void) => {
    const listener = (): void => fn()
    ipcRenderer.on('capture:hidden', listener)
    return () => ipcRenderer.removeListener('capture:hidden', listener)
  }
}

export type CaptureBridge = typeof capture

contextBridge.exposeInMainWorld('capture', capture)
