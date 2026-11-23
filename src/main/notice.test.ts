import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: {}, ipcMain: {}, Notification: {} }))

import { Claims, readAsk, shouldNotify } from './notice'

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
  it('takes a key, a title and a body, each cut; the body keeps two lines, a title and its detail', () => {
    expect(readAsk({ key: 'k', title: ' Purdue ', body: 'Budget  review starts at 2:00 PM\n\n With Dana Reyes \nand a third line' })).toEqual({ key: 'k', title: 'Purdue', body: 'Budget review starts at 2:00 PM\nWith Dana Reyes' })
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


describe('who asks for a key', () => {
  it('a window that lets go does not take back what another window still asks for', () => {
    const claims = new Claims()
    claims.add('now:prep:ev1', 1)
    claims.add('now:prep:ev1', 2)
    expect(claims.drop('now:prep:ev1', 2)).toBe(false)
    expect(claims.of('now:prep:ev1')).toEqual([1])
    expect(claims.drop('now:prep:ev1', 1)).toBe(true)
    expect(claims.of('now:prep:ev1')).toEqual([])
  })
  it('a window that went away frees only the keys nobody else asks for', () => {
    const claims = new Claims()
    claims.add('digest:2026-11-24', 1)
    claims.add('digest:2026-11-24', 2)
    claims.add('now:clash:2', 2)
    expect(claims.dropWindow(2)).toEqual(['now:clash:2'])
    expect(claims.of('digest:2026-11-24')).toEqual([1])
    // A key nobody asked for is free already.
    expect(claims.drop('never', 9)).toBe(true)
  })
})
