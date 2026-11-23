import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LIST_PAGE_MAX } from '@shared/work/files'
import { cutPage, DiskLister, entryOfRow, hiddenName, type DiskRow } from './disk'

/** One folder as a sorted list a page at a time (disk.ts): the order, the cursor, what is left out, and what is never read. */

let dir: string
let lister: DiskLister
let clock = 1_000_000
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tc-files-disk-')))
  clock = 1_000_000
  lister = new DiskLister({ now: () => clock })
})
afterEach(() => {
  lister.close()
  rmSync(dir, { recursive: true, force: true })
})

const file = (name: string, bytes = 1, mtime?: number): void => {
  writeFileSync(join(dir, name), 'x'.repeat(bytes))
  if (mtime !== undefined) utimesSync(join(dir, name), mtime, mtime)
}
const names = (rows: readonly DiskRow[]): string[] => rows.map((r) => r.name)

describe('one folder', () => {
  it('lists folders first, then files by name as a finder orders them, each looked at closer', async () => {
    mkdirSync(join(dir, 'Events'))
    mkdirSync(join(dir, 'archive'))
    file('Budget 10.xlsx', 30)
    file('budget 2.xlsx', 20)
    file('Run of show.tcdoc', 5)
    const { rows, next } = await lister.page(dir)
    expect(names(rows)).toEqual(['archive', 'Events', 'budget 2.xlsx', 'Budget 10.xlsx', 'Run of show.tcdoc'])
    expect(next).toBeUndefined()
    expect(rows[0]).toMatchObject({ dir: true, kind: 'folder' })
    expect(rows[0]!.size).toBeUndefined()
    expect(rows[2]).toMatchObject({ dir: false, kind: 'sheet', size: 20, local: true })
    // A `.tcdoc` is one document, one row.
    expect(rows[4]).toMatchObject({ kind: 'document', size: 5 })
    expect(rows.every((r) => typeof r.changed === 'number')).toBe(true)
  })

  it('leaves out hidden names, lock files and every link, whatever it points at', async () => {
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, 'real'))
    file('.DS_Store')
    file('~$Budget.xlsx')
    file('desktop.ini')
    file('upload.tmp')
    file('kept.txt')
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'tc-files-out-')))
    writeFileSync(join(outside, 'secret.txt'), 'no')
    symlinkSync(outside, join(dir, 'way out'))
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'secret link.txt'))
    try {
      expect(names((await lister.page(dir)).rows)).toEqual(['real', 'kept.txt'])
      expect(await lister.row(join(dir, 'way out'))).toBeNull()
      expect(await lister.row(join(dir, 'secret link.txt'))).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
    for (const name of ['.env', '~$a.docx', 'Icon\r', 'Thumbs.db']) expect(hiddenName(name), name).toBe(true)
    expect(hiddenName('a.docx')).toBe(false)
  })

  it('reads a file a cloud app keeps elsewhere by its name and size alone: no blocks means not here', async () => {
    writeFileSync(join(dir, 'Cloud only.pdf'), '')
    truncateSync(join(dir, 'Cloud only.pdf'), 200_000)
    file('here.pdf', 10)
    const { rows } = await lister.page(dir)
    expect(rows.find((r) => r.name === 'Cloud only.pdf')).toMatchObject({ size: 200_000, local: false })
    expect(rows.find((r) => r.name === 'here.pdf')).toMatchObject({ local: true })
    const entry = entryOfRow(rows.find((r) => r.name === 'Cloud only.pdf')!, 'h', join(dir, 'Cloud only.pdf'), 'k')
    expect(entry).toMatchObject({ key: 'k', local: false, state: { is: 'cloud' }, ref: { at: 'file', host: 'h' }, folder: null })
  })

  it('refuses a file where a folder was asked for', async () => {
    file('a.txt')
    await expect(lister.page(join(dir, 'a.txt'))).rejects.toThrow('That is a file, not a folder.')
  })

  it('sorts by time and by size, newest and largest first when asked, folders still first', async () => {
    mkdirSync(join(dir, 'Zeta'))
    file('old.txt', 5, 1_000)
    file('new.txt', 1, 3_000)
    file('mid.txt', 9, 2_000)
    expect(names((await lister.page(dir, { sort: { by: 'changed', dir: 'desc' } })).rows)).toEqual(['Zeta', 'new.txt', 'mid.txt', 'old.txt'])
    expect(names((await lister.page(dir, { sort: { by: 'size', dir: 'asc' } })).rows)).toEqual(['Zeta', 'new.txt', 'old.txt', 'mid.txt'])
    expect(names((await lister.page(dir, { sort: { by: 'name', dir: 'desc' } })).rows)).toEqual(['Zeta', 'old.txt', 'new.txt', 'mid.txt'])
  })

  it('lists folders alone for the sidebar', async () => {
    mkdirSync(join(dir, 'b'))
    mkdirSync(join(dir, 'a'))
    file('x.txt')
    expect(names((await lister.page(dir, { foldersOnly: true })).rows)).toEqual(['a', 'b'])
  })
})

describe('pages', () => {
  const fill = (n: number): void => {
    for (let i = 0; i < n; i++) file(`f${String(i).padStart(4, '0')}.txt`, 1, 1_000 + (i % 7))
  }

  it(`cuts a folder into pages of ${LIST_PAGE_MAX}, each starting after the last row of the one before, with no row twice and none missed`, async () => {
    fill(1203)
    mkdirSync(join(dir, 'Folder'))
    for (const sort of [{ by: 'name', dir: 'asc' }, { by: 'name', dir: 'desc' }, { by: 'changed', dir: 'desc' }, { by: 'size', dir: 'asc' }, { by: 'kind', dir: 'asc' }] as const) {
      const seen: string[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const page = await lister.page(dir, { sort, cursor })
        expect(page.stale).toBeUndefined()
        expect(page.rows.length).toBeLessThanOrEqual(LIST_PAGE_MAX)
        seen.push(...names(page.rows))
        cursor = page.next
        pages++
      } while (cursor)
      expect(pages, sort.by).toBe(3)
      expect(seen).toHaveLength(1204)
      expect(new Set(seen).size).toBe(1204)
      expect(seen[0]).toBe('Folder')
    }
  })

  it('walks the folder once for the pages of one scroll, and again once what it kept is old', async () => {
    fill(600)
    const first = await lister.page(dir)
    await lister.page(dir, { cursor: first.next })
    expect(lister.reads).toBe(1)
    clock += 6_000
    await lister.page(dir)
    expect(lister.reads).toBe(2)
  })

  it('answers stale when the folder changed between pages, and lists again from the top', async () => {
    fill(600)
    const first = await lister.page(dir)
    file('added.txt')
    // What was kept is still fresh: the page after it is cut from the same list.
    expect((await lister.page(dir, { cursor: first.next })).stale).toBeUndefined()
    clock += 6_000
    expect(await lister.page(dir, { cursor: first.next })).toEqual({ rows: [], stale: true })
    expect(names((await lister.page(dir)).rows)).toContain('added.txt')
  })

  it('answers stale for a cursor of another folder, another order, or no cursor at all', async () => {
    fill(600)
    const other = join(dir, 'other')
    mkdirSync(other)
    for (let i = 0; i < 600; i++) writeFileSync(join(other, `g${i}.txt`), 'x')
    const mine = (await lister.page(dir)).next!
    const reads = lister.reads
    expect(await lister.page(other, { cursor: mine })).toEqual({ rows: [], stale: true })
    expect(await lister.page(dir, { cursor: mine, sort: { by: 'changed', dir: 'desc' } })).toEqual({ rows: [], stale: true })
    expect(await lister.page(dir, { cursor: 'not-a-cursor' })).toEqual({ rows: [], stale: true })
    // A cursor that does not fit is refused before the disk is touched.
    expect(lister.reads).toBe(reads)
  })

  it('cuts a page by its weight too', () => {
    const rows: DiskRow[] = Array.from({ length: 400 }, (_, i) => ({ name: `${String(i).padStart(3, '0')}-${'n'.repeat(2000)}`, dir: false, kind: 'other' as const }))
    const page = cutPage(rows, { tag: 't', version: 'v', sort: { by: 'name', dir: 'asc' } })
    expect(page.rows.length).toBeLessThan(400)
    expect(page.rows.length).toBeGreaterThan(50)
    const rest = cutPage(rows, { tag: 't', version: 'v', sort: { by: 'name', dir: 'asc' }, cursor: page.next })
    expect(rest.rows[0]!.name).toBe(rows[page.rows.length]!.name)
  })
})

describe('a folder a tab shows', () => {
  it('says once when a name in it changes, and drops what it kept', async () => {
    file('a.txt')
    await lister.page(dir)
    let said = 0
    lister.watch(dir, () => void said++, { settleMs: 20 })
    // Watching the same folder again is the same watch.
    lister.watch(dir, () => void (said += 100), { settleMs: 20 })
    file('b.txt')
    renameSync(join(dir, 'a.txt'), join(dir, 'c.txt'))
    await new Promise((r) => setTimeout(r, 200))
    expect(said).toBe(1)
    expect(names((await lister.page(dir)).rows)).toEqual(['b.txt', 'c.txt'])
    expect(lister.reads).toBe(2)
  })

  it('stops watching a folder nobody listed for a while, and never watches more than it may', async () => {
    const dirs = ['one', 'two', 'three'].map((n) => join(dir, n))
    for (const d of dirs) mkdirSync(d)
    const said: string[] = []
    lister.watch(dirs[0]!, () => void said.push('one'), { most: 2, settleMs: 10 })
    clock += 1
    lister.watch(dirs[1]!, () => void said.push('two'), { most: 2, settleMs: 10 })
    clock += 1
    // The third pushes the least recently listed out.
    lister.watch(dirs[2]!, () => void said.push('three'), { most: 2, settleMs: 10 })
    for (const d of dirs) writeFileSync(join(d, 'x.txt'), 'x')
    await new Promise((r) => setTimeout(r, 150))
    expect(said.sort()).toEqual(['three', 'two'])
  })
})
