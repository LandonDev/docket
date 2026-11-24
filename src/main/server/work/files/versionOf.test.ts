import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A file's version (write.ts `versionOf`): its sha256 is the whole file read, so it is read once while the file stays as it was. */

const reads = vi.hoisted(() => [] as string[])
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, createReadStream: (path: string, ...rest: unknown[]) => (reads.push(path), (fs.createReadStream as (...a: unknown[]) => unknown)(path, ...rest)) }
})

const opens = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: (path: string, ...rest: unknown[]) => (opens.push(path), (fs.open as (...a: unknown[]) => unknown)(path, ...rest)) }
})

const { versionOf } = await import('./write')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-version-'))
  reads.length = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('a file read in pieces', () => {
  it('is hashed once while it is unchanged, and again once it changes', async () => {
    const file = join(dir, 'Deck.pptx')
    writeFileSync(file, 'one')
    const first = await versionOf(file)
    for (let piece = 0; piece < 4; piece++) expect(await versionOf(file)).toEqual(first)
    expect(reads).toEqual([file])
    writeFileSync(file, 'two!')
    const next = await versionOf(file)
    expect(next.sha256).not.toBe(first.sha256)
    expect(reads).toEqual([file, file])
  })

  it('on a mapped or network drive, is its size and time alone', async () => {
    const { driveOf } = await import('../office/files/reach')
    // This host has no drive letters: the rule is driveOf's, the one every Files look uses.
    expect(driveOf('J:\\Bench\\Deck.pptx', 'C:')).toBe('J:')
    expect(driveOf('\\\\files\\esports\\Deck.pptx', 'C:')).toBe('\\\\files\\esports')
  })
})

describe('a piece of a file for a copy elsewhere', () => {
  it('is the range asked, with the file size and the version it was read at', async () => {
    const { readPiece, sameWord } = await import('./save')
    const file = join(dir, 'Report.pdf')
    writeFileSync(file, '0123456789')
    const head = await readPiece(file, 0, 4)
    const tail = await readPiece(file, 8, 4)
    expect([Buffer.from(head.data, 'base64').toString(), head.size, head.end]).toEqual(['0123', 10, false])
    expect([Buffer.from(tail.data, 'base64').toString(), tail.end]).toEqual(['89', true])
    expect(tail.version).toBe(head.version)
    // Read in pieces, the file is hashed once and opened once: one handle serves every piece of a copy.
    expect(reads.filter((p) => p === file)).toHaveLength(1)
    expect(opens.filter((p) => p === file)).toHaveLength(1)
    const { closeHeldFiles } = await import('./save')
    await closeHeldFiles()
    expect(sameWord(head.version, head.version)).toBe(true)
  })

  it('names the same file when one version has no hash (a mapped drive), by its size and time', async () => {
    const { sameWord } = await import('./save')
    expect(sameWord('10:1700:', '10:1700:abc')).toBe(true)
    expect(sameWord('10:1701:', '10:1700:abc')).toBe(false)
    expect(sameWord('11:1700:', '10:1700:abc')).toBe(false)
    // Both hashed: the hash decides, a time that only moved does not.
    expect(sameWord('10:1701:abc', '10:1700:abc')).toBe(true)
    expect(sameWord('10:1700:abd', '10:1700:abc')).toBe(false)
  })
})
