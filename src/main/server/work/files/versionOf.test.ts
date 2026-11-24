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
