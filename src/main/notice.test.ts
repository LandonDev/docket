import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: {}, ipcMain: {}, Notification: {} }))

import { readAsk, shouldNotify } from './notice'

describe('shouldNotify', () => {
  it('shows only while no app window is focused', () => {
    expect(shouldNotify('digest:2026-11-24', new Set(), false)).toBe(true)
    expect(shouldNotify('digest:2026-11-24', new Set(), true)).toBe(false)
  })
  it('shows a key once however many windows ask', () => {
    const shown = new Set(['now:prep:ev1'])
    expect(shouldNotify('now:prep:ev1', shown, false)).toBe(false)
    expect(shouldNotify('now:clash:2', shown, false)).toBe(true)
  })
})

describe('readAsk', () => {
  it('takes a key, a title and a body, each one line and cut', () => {
    expect(readAsk({ key: 'k', title: ' Purdue ', body: 'Budget review\nstarts at 2:00 PM' })).toEqual({ key: 'k', title: 'Purdue', body: 'Budget review starts at 2:00 PM' })
    expect(readAsk({ key: 'k', title: 'Work', body: 'x'.repeat(400), silent: true })).toEqual({ key: 'k', title: 'Work', body: 'x'.repeat(300), silent: true })
  })
  it('refuses anything else', () => {
    expect(readAsk(null)).toBeNull()
    expect(readAsk({ key: 'k', title: 'Work' })).toBeNull()
    expect(readAsk({ key: '', title: 'Work', body: 'b' })).toBeNull()
    expect(readAsk({ key: 'k', title: 7, body: 'b' })).toBeNull()
    // silent is the digest's alone: anything but true sounds
    expect(readAsk({ key: 'k', title: 'Work', body: 'b', silent: 'yes' })).toEqual({ key: 'k', title: 'Work', body: 'b' })
  })
})
