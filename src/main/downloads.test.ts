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

describe('safeFileName and turned-round names', () => {
  it('drops the marks that turn a name round or hide in it', () => {
    // With a right-to-left override, "invoice\u202Efdp.exe" reads as "invoiceexe.pdf" in a file list.
    expect(safeFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe')
    expect(safeFileName('a\u200Bb\u2066c\u2069\uFEFF.txt')).toBe('abc.txt')
    expect(safeFileName('\u202E')).toBe('file')
  })
})

describe('safeFileName and a long name', () => {
  it('cuts a long name from its stem, so the extension that says what the file is stays', () => {
    const name = `${'a'.repeat(176)}.exe.txt`
    const kept = safeFileName(name)
    expect(kept.length).toBe(180)
    expect(kept.endsWith('.txt')).toBe(true)
    expect(kept).not.toMatch(/\.exe$/)
    // A name with no extension, or one too long to be one, is cut plainly.
    expect(safeFileName('b'.repeat(400))).toBe('b'.repeat(180))
    expect(safeFileName(`c.${'d'.repeat(300)}`).length).toBe(180)
    // A tail too long to be an extension may not leave an earlier one at the cut.
    const cut = safeFileName(`${'e'.repeat(176)}.exe.${'x'.repeat(40)}`)
    expect(cut.length).toBe(180)
    expect(cut).not.toContain('.')
  })
})

describe('freeName', () => {
  it('numbers a name already taken, before its extension', () => {
    const taken = new Set(['a.pdf', 'a (1).pdf', 'README'])
    expect(freeName('b.pdf', (n) => taken.has(n))).toBe('b.pdf')
    expect(freeName('a.pdf', (n) => taken.has(n))).toBe('a (2).pdf')
    expect(freeName('README', (n) => taken.has(n))).toBe('README (1)')
  })
})

describe('a file saved from a mail', () => {
  const taken = new Set<string>()
  const save = (name: string) => {
    const file = freeName(safeFileName(name), (n) => taken.has(n))
    taken.add(file)
    return file
  }
  it('keeps its own name and extension, made safe, and never replaces a file', () => {
    // A named PDF.
    expect(save('Invoice 1042.pdf')).toBe('Invoice 1042.pdf')
    // The same file saved again.
    expect(save('Invoice 1042.pdf')).toBe('Invoice 1042 (1).pdf')
    expect(save('Invoice 1042.pdf')).toBe('Invoice 1042 (2).pdf')
    // A name with a path in it stays one name, in Downloads.
    expect(save('../../Library/LaunchAgents/x.plist')).toBe('__.._Library_LaunchAgents_x.plist')
    expect(save('C:\\Users\\me\\report.docx')).toBe('C__Users_me_report.docx')
    // A very long name keeps its extension.
    const long = save(`${'q'.repeat(300)}.xlsx`)
    expect(long.length).toBe(180)
    expect(long.endsWith('.xlsx')).toBe(true)
  })
})
