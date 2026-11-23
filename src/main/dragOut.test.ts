import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DRAG_OUT_MOST, dragOutPaths } from './dragOut'

const dir = mkdtempSync(join(tmpdir(), 'tc-drag-out-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const file = (name: string): string => {
  const path = join(dir, name)
  writeFileSync(path, 'x')
  return path
}

describe('files dragged out to the desktop', () => {
  it('carries real files of this machine, in the order named', async () => {
    const a = file('a.txt')
    const b = file('b.txt')
    expect(await dragOutPaths([b, a])).toEqual([b, a])
  })

  it('refuses the whole drag for a folder, a link, a file that is gone, a path that is not absolute, or nothing at all', async () => {
    const a = file('real.txt')
    mkdirSync(join(dir, 'folder'))
    symlinkSync(a, join(dir, 'link.txt'))
    expect(await dragOutPaths([a, join(dir, 'folder')])).toBeNull()
    expect(await dragOutPaths([join(dir, 'link.txt')])).toBeNull()
    expect(await dragOutPaths([join(dir, 'gone.txt')])).toBeNull()
    expect(await dragOutPaths(['real.txt'])).toBeNull()
    expect(await dragOutPaths([])).toBeNull()
    expect(await dragOutPaths('not a list')).toBeNull()
    expect(await dragOutPaths([a, 7])).toBeNull()
  })

  it('carries a hundred at most', async () => {
    const a = file('many.txt')
    expect(await dragOutPaths(Array.from({ length: DRAG_OUT_MOST }, () => a))).toHaveLength(DRAG_OUT_MOST)
    expect(await dragOutPaths(Array.from({ length: DRAG_OUT_MOST + 1 }, () => a))).toBeNull()
  })
})
