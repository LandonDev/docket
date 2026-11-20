import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, ipcMain: { handle: () => {} } }))
const { freeName, safeFileName } = await import('./downloads')

describe('safeFileName', () => {
  it('keeps an ordinary name and takes out what is not a name', () => {
    expect(safeFileName('PO-7731.pdf')).toBe('PO-7731.pdf')
    expect(safeFileName('../../etc/passwd')).toBe('__.._etc_passwd')
    expect(safeFileName('a/b\\c:d*e?.txt')).toBe('a_b_c_d_e_.txt')
    expect(safeFileName('.hidden')).toBe('_hidden')
    expect(safeFileName('name. . ')).toBe('name')
    expect(safeFileName('line\nbreak.png')).toBe('line_break.png')
  })
  it('never answers an empty or a reserved name', () => {
    expect(safeFileName('')).toBe('file')
    expect(safeFileName('   ')).toBe('file')
    expect(safeFileName('CON')).toBe('file')
    expect(safeFileName('nul.txt')).toBe('file')
    expect(safeFileName('x'.repeat(400)).length).toBe(180)
  })
})

describe('freeName', () => {
  it('numbers a name already taken, before its extension', () => {
    const taken = new Set(['a.pdf', 'a (2).pdf', 'README'])
    expect(freeName('b.pdf', (n) => taken.has(n))).toBe('b.pdf')
    expect(freeName('a.pdf', (n) => taken.has(n))).toBe('a (3).pdf')
    expect(freeName('README', (n) => taken.has(n))).toBe('README (2)')
  })
})
