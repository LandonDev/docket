import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('tcLive', { ticket: (url: string) => ipcRenderer.invoke('office-live:ticket', url) })
