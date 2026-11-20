import type { BrowserWindow } from 'electron'

/**
 * Which window is the capture window (capture.ts), for the window code that
 * must pass it by: the dock click, show-all, the appshot's "is a window
 * open". A file of its own so those modules take nothing else of capture.
 */
export const captureWindowRef: { current: BrowserWindow | null } = { current: null }

export const isCaptureWindow = (w: BrowserWindow): boolean => w === captureWindowRef.current
