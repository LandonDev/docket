import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyWhole, hasMagic, ItemFileError, readRange, stampOf } from './file'

/** file.ts's parts that need no database; itemOf, paneItem and sourcePath run through the module in pdf.test.ts. */
let dir: string
const at = (name: string, bytes: string | Uint8Array): string => {
  const p = join(dir, name)
  writeFileSync(p, bytes)
  return p
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-pdf-file-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('hasMagic', () => {
  it('knows a PDF by its header and a .pptx by its zip header, and nothing else', () => {
    expect(hasMagic(at('a.pdf', '%PDF-1.7\n...'), 'pdf')).toBe(true)
    // Some writers put a few bytes before the header; a reader looks in the first kilobyte.
    expect(hasMagic(at('b.pdf', `${' '.repeat(20)}%PDF-1.4`), 'pdf')).toBe(true)
    expect(hasMagic(at('c.pdf', 'just text'), 'pdf')).toBe(false)
    expect(hasMagic(at('d.pptx', Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0])), 'zip')).toBe(true)
    expect(hasMagic(at('e.pptx', '%PDF-1.7'), 'zip')).toBe(false)
    expect(hasMagic(at('f.pdf', ''), 'pdf')).toBe(false)
    expect(hasMagic(join(dir, 'absent.pdf'), 'pdf')).toBe(false)
  })
})

describe('readRange', () => {
  it('reads bytes by range as base64, short at the end and empty past it, with the whole size', () => {
    const p = at('r.bin', '0123456789')
    const read = (o: number, n: number) => {
      const r = readRange(p, o, n)
      return { text: Buffer.from(r.data, 'base64').toString(), size: r.size }
    }
    expect(read(0, 4)).toEqual({ text: '0123', size: 10 })
    expect(read(6, 100)).toEqual({ text: '6789', size: 10 })
    expect(read(10, 4)).toEqual({ text: '', size: 10 })
    expect(read(50, 4)).toEqual({ text: '', size: 10 })
  })
})

describe('stampOf and copyWhole', () => {
  it('stamps a file with a rev that moves when its size or time does, and says plainly when it is gone', () => {
    const p = at('s.pdf', 'one')
    const a = stampOf(p)
    expect(a).toMatchObject({ path: p, name: 's.pdf', size: 3 })
    expect(stampOf(p, 'Shown.pdf').name).toBe('Shown.pdf')
    expect(stampOf(p).rev).toBe(a.rev)
    utimesSync(p, new Date(2020, 0, 1), new Date(2020, 0, 1))
    expect(stampOf(p).rev).not.toBe(a.rev)
    writeFileSync(p, 'longer')
    expect(stampOf(p).size).toBe(6)
    expect(() => stampOf(join(dir, 'gone.pdf'))).toThrow(ItemFileError)
    expect(() => stampOf(join(dir, 'gone.pdf'), 'Lease.pdf')).toThrow('Lease.pdf is not where it was.')
    try {
      stampOf(join(dir, 'gone.pdf'))
    } catch (err) {
      expect((err as ItemFileError).why).toBe('missing')
    }
    expect(() => stampOf(dir)).toThrow('is not a file.')
  })

  it('copies whole: the target is the new bytes, and no scratch file is left beside it', () => {
    const from = at('from.pdf', '%PDF-new')
    const to = at('to.pdf', '%PDF-old')
    copyWhole(from, to)
    expect(readFileSync(to, 'utf8')).toBe('%PDF-new')
    expect(readFileSync(from, 'utf8')).toBe('%PDF-new')
    expect(readdirSync(dir).sort()).toEqual(['from.pdf', 'to.pdf'])
  })
})
