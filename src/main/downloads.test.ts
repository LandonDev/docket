import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, ipcMain: { handle: () => {} } }))
// A disk that refuses the finished file's name: every way of naming it fails. And a disk with no links (FAT), where
// another file takes the free name between its check and the link.
const refuse = vi.hoisted(() => ({ name: false, links: null as null | ((path: string) => void) }))
vi.mock('node:fs/promises', async (real) => {
  const fs = await real<typeof import('node:fs/promises')>()
  const refused = (): Promise<never> => Promise.reject(Object.assign(new Error('ENAMETOOLONG: name too long'), { code: 'ENAMETOOLONG' }))
  const noLinks = (path: string): Promise<never> => {
    refuse.links!(path)
    return Promise.reject(Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' }))
  }
  return {
    ...fs,
    link: (...a: Parameters<typeof fs.link>) => (refuse.name ? refused() : refuse.links ? noLinks(String(a[1])) : fs.link(...a)),
    rename: (...a: Parameters<typeof fs.rename>) => (refuse.name ? refused() : fs.rename(...a)),
    copyFile: (...a: Parameters<typeof fs.copyFile>) => (refuse.name ? refused() : fs.copyFile(...a))
  }
})
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
    // Within the disk's 255 bytes too, whatever its letters.
    const wide = safeFileName(`${'é'.repeat(170)}.pdf`)
    expect(Buffer.byteLength(wide)).toBeLessThanOrEqual(255)
    expect(wide.endsWith('é.pdf')).toBe(true)
  })
})

describe('freeName', () => {
  it("numbers a long name within the disk's 255 bytes, cutting its stem and keeping its extension", () => {
    // Council r4 (Sol 6): a second download of a 253-byte name was 257 bytes with " (1)", and the disk refused it.
    const name = `${'é'.repeat(124)}.pdf`
    expect(Buffer.byteLength(name)).toBe(252)
    const next = freeName(name, (c) => c === name)
    expect(next.endsWith(' (1).pdf')).toBe(true)
    expect(Buffer.byteLength(next)).toBeLessThanOrEqual(255)
    // Never a half of a character at the cut.
    expect(next).not.toContain('\ufffd')
    expect(next.startsWith('é'.repeat(120))).toBe(true)
  })

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

describe('a download written part by part', () => {
  it('writes each part under a free name, answers the path once kept, and takes a file it did not finish away', async () => {
    const { mkdtempSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { partWriter } = await import('./downloads')
    const dir = mkdtempSync(join(tmpdir(), 'tc-download-'))
    writeFileSync(join(dir, 'Budget.xlsx'), 'his own')
    const parts = partWriter(() => dir)
    const id = await parts.begin('Budget.xlsx')
    await parts.part(id, new TextEncoder().encode('one '))
    await parts.part(id, new TextEncoder().encode('two'))
    expect(await parts.end(id, true)).toBe(join(dir, 'Budget (1).xlsx'))
    expect(readFileSync(join(dir, 'Budget (1).xlsx'), 'utf8')).toBe('one two')
    expect(readFileSync(join(dir, 'Budget.xlsx'), 'utf8')).toBe('his own')
    // Ended, it takes no more parts; one that failed on its way leaves nothing behind.
    await expect(parts.part(id, new Uint8Array(1))).rejects.toThrow('not open')
    const lost = await parts.begin('Plan.pdf')
    await parts.part(lost, new Uint8Array(3))
    expect(await parts.end(lost, false)).toBeNull()
    expect(readdirSync(dir).sort()).toEqual(['Budget (1).xlsx', 'Budget.xlsx'])
  })

  it('never puts a part-written file under its real name: it is written as .download and named only once whole, and its window gone takes it away', async () => {
    const { mkdtempSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { partWriter } = await import('./downloads')
    const dir = mkdtempSync(join(tmpdir(), 'tc-download-'))
    const parts = partWriter(() => dir)
    let close!: () => void
    const id = await parts.begin('Video.mov', (gone) => (close = gone))
    await parts.part(id, new Uint8Array(5))
    expect(readdirSync(dir)).toHaveLength(1)
    expect(readdirSync(dir)[0]).toMatch(/^TempCode download [0-9a-f]{8}\.download$/)
    // His window closes halfway: nothing is left, under either name.
    close()
    await new Promise((ok) => setTimeout(ok, 20))
    expect(readdirSync(dir)).toEqual([])
    await expect(parts.part(id, new Uint8Array(1))).rejects.toThrow('not open')
    // A whole one is named at its end, never over a file that took the name meanwhile.
    const whole = await parts.begin('Video.mov')
    await parts.part(whole, new TextEncoder().encode('all'))
    writeFileSync(join(dir, 'Video.mov'), 'came meanwhile')
    expect(await parts.end(whole, true)).toBe(join(dir, 'Video (1).mov'))
    expect(readdirSync(dir).sort()).toEqual(['Video (1).mov', 'Video.mov'])
    expect(readFileSync(join(dir, 'Video.mov'), 'utf8')).toBe('came meanwhile')
  })

  it('saves a second copy of a long name under a number that fits, and leaves no part behind when the disk refuses the name', async () => {
    const { mkdtempSync, readdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { partWriter } = await import('./downloads')
    const dir = mkdtempSync(join(tmpdir(), 'tc-download-'))
    const name = `${'é'.repeat(124)}.pdf`
    writeFileSync(join(dir, name), 'the first')
    const parts = partWriter(() => dir)
    const id = await parts.begin(name)
    await parts.part(id, new TextEncoder().encode('again'))
    const kept = await parts.end(id, true)
    expect(kept!.endsWith(' (1).pdf')).toBe(true)
    expect(readdirSync(dir)).toHaveLength(2)
    // The disk refuses the name: the download fails, and its part is taken away.
    refuse.name = true
    try {
      const lost = await parts.begin('Plan.pdf')
      await parts.part(lost, new Uint8Array(3))
      await expect(parts.end(lost, true)).rejects.toThrow('ENAMETOOLONG')
    } finally {
      refuse.name = false
    }
    expect(readdirSync(dir).filter((f) => f.endsWith('.download'))).toEqual([])
  })

  it('on a disk with no links, never replaces a file that took the free name meanwhile: it is made anew under the next number', async () => {
    const { mkdtempSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { partWriter } = await import('./downloads')
    const dir = mkdtempSync(join(tmpdir(), 'tc-download-'))
    const parts = partWriter(() => dir)
    const id = await parts.begin('Budget.xlsx')
    await parts.part(id, new TextEncoder().encode('this download'))
    // Another download takes "Budget.xlsx" after the check, before this one is named.
    refuse.links = (path) => {
      if (path.endsWith('Budget.xlsx')) writeFileSync(path, 'the other download')
    }
    try {
      expect(await parts.end(id, true)).toBe(join(dir, 'Budget (1).xlsx'))
    } finally {
      refuse.links = null
    }
    expect(readFileSync(join(dir, 'Budget.xlsx'), 'utf8')).toBe('the other download')
    expect(readFileSync(join(dir, 'Budget (1).xlsx'), 'utf8')).toBe('this download')
    expect(readdirSync(dir).sort()).toEqual(['Budget (1).xlsx', 'Budget.xlsx'])
  })

  it('saves a long name that fits the folder: the part-written file wears a short name of its own, so its ending never pushes the name past the limit', async () => {
    const { mkdtempSync, readFileSync, readdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { partWriter } = await import('./downloads')
    const dir = mkdtempSync(join(tmpdir(), 'tc-download-'))
    // 250 bytes, under every disk's 255: legal at its destination, past it with ".download" after it.
    const name = `${'é'.repeat(123)}.pdf`
    expect(Buffer.byteLength(name)).toBe(250)
    const parts = partWriter(() => dir)
    const id = await parts.begin(name)
    await parts.part(id, new TextEncoder().encode('whole'))
    expect(await parts.end(id, true)).toBe(join(dir, name))
    expect(readdirSync(dir)).toEqual([name])
    expect(readFileSync(join(dir, name), 'utf8')).toBe('whole')
  })
})
