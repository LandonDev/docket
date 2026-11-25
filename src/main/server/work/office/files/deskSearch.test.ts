import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TeamsLibrary } from '@shared/contract-work-office'
import { deskSearchStarts } from './handle'
import { libraryWalk, searchLibraries } from './library'

/** A desktop's own search (`work.office.filesSearch`): the walk a window's next words replace stops, and a search reads no author. */

const window = { kind: 'local' as const, caps: ['read' as const] }
let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe("a desktop's search", () => {
  it('stops the walk the same caller replaces, and leaves another caller\'s alone', () => {
    const old = deskSearchStarts(window, 'budg', undefined)
    const other = deskSearchStarts({ kind: 'remote', caps: ['read'] }, 'budg', undefined)
    const next = deskSearchStarts(window, 'budget', 'budg')
    expect(old.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
    expect(next.signal.aborted).toBe(false)
    for (const w of [old, other, next]) w.done()
  })

  it('walks no folder once its signal says stop, and names no author', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-desk-'))
    for (let i = 0; i < 50; i++) mkdirSync(join(dir, `F${i}`))
    writeFileSync(join(dir, 'Plan budget.docx'), 'not a zip')
    const library = { id: 'h~1', host: 'h', path: dir } as TeamsLibrary
    const stopped = new AbortController()
    stopped.abort()
    const before = libraryWalk.folders
    await expect(searchLibraries([library], 'budget', undefined, Date.now, { signal: stopped.signal })).rejects.toThrow('cancelled')
    expect(libraryWalk.folders).toBe(before)
    const found = await searchLibraries([library], 'budget', undefined, Date.now, { who: false })
    expect(found.entries.map((e) => [e.name, e.by])).toEqual([['Plan budget.docx', null]])
  })
})
