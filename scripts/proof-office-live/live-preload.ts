// The live proof's preload: window.tcLive as src/preload/index.ts exposes it (the same five calls, the same channels).
import { contextBridge, ipcRenderer } from 'electron'

const live = {
  ticket: (url: string): Promise<{ ok: true; src: string; partition: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('office-live:ticket', url),
  fullWindow: (guestId: number, on: boolean): Promise<void> => ipcRenderer.invoke('office-live:full-window', guestId, on),
  typed: (guestId: number): Promise<number> => ipcRenderer.invoke('office-live:typed', guestId),
  unload: (guestId: number, force: boolean): Promise<'unloaded' | 'holding' | 'gone'> => ipcRenderer.invoke('office-live:unload', guestId, force),
  onKey: (cb: (init: KeyboardEventInit) => void): (() => void) => {
    const listener = (_e: unknown, init: KeyboardEventInit): void => cb(init)
    ipcRenderer.on('office-live:key', listener)
    return () => void ipcRenderer.removeListener('office-live:key', listener)
  }
}
contextBridge.exposeInMainWorld('tcLive', live)
