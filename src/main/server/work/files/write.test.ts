import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureFilesTables } from './tables'
import { admitPath, admitTree, checkName, copyNoReplace, FileRefused, fileLocked, makeFile, makeFolder, moveNoReplace, pruneOps, runOp, sameVersion, settleOps, versionOf, withFileLocks, writeSeams, type WriteFence } from './write'

/** The one module every file-changing verb writes through: names, the fence, no replace, swaps, races, locks, the journal. */

let base: string
let root: string
let outside: string
let fence: WriteFence
const made: string[] = []
const tmp = (dir = tmpdir()): string => {
  const at = realpathSync(mkdtempSync(join(dir, 'tc-files-write-')))
  made.push(at)
  return at
}

beforeEach(() => {
  base = tmp()
  root = join(base, 'root')
  outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  fence = { roots: [root] }
})
afterEach(() => {
  for (const key of Object.keys(writeSeams)) delete writeSeams[key as keyof typeof writeSeams]
  for (const at of made.splice(0)) rmSync(at, { recursive: true, force: true })
})

const put = (path: string, text: string): string => {
  writeFileSync(path, text)
  return path
}
const refusedWith = async (p: Promise<unknown>, code: FileRefused['code']): Promise<FileRefused> => {
  const e = await p.then(
    () => null,
    (e: unknown) => e
  )
  expect(e).toBeInstanceOf(FileRefused)
  expect((e as FileRefused).code).toBe(code)
  return e as FileRefused
}
/** Swaps `dir` for a link to the outside folder: what another writer, or a hostile sync, might do mid-change. */
const swapForLink = (dir: string): void => {
  renameSync(dir, `${dir}-was`)
  symlinkSync(outside, dir)
}

describe('names', () => {
  it('takes one path component and refuses the rest with the grammar sentence', async () => {
    expect(() => checkName('Budget.xlsx')).not.toThrow()
    for (const bad of ['..', 'a/b', 'a\\b', 'a\u0000b', 'CON', 'nul.txt', '']) expect(() => checkName(bad), bad).toThrow(FileRefused)
    expect(() => checkName('a/b')).toThrow('A name cannot hold /')
  })

  it('is checked by every verb that names a thing', async () => {
    const file = put(join(root, 'f.txt'), 'x')
    await refusedWith(makeFolder(fence, root, '..'), 'name')
    await refusedWith(makeFile(fence, root, 'a/b', new Uint8Array([1])), 'name')
    await refusedWith(moveNoReplace(fence, file, root, '../f.txt'), 'name')
    await refusedWith(copyNoReplace(fence, file, root, 'AUX'), 'name')
    expect(readdirSync(root)).toEqual(['f.txt'])
    expect(readdirSync(base).sort()).toEqual(['outside', 'root'])
  })
})

describe('the fence', () => {
  it('answers a real path inside a root', async () => {
    const file = put(join(root, 'f.txt'), 'x')
    expect(await admitPath(fence, file)).toBe(file)
    expect(await admitPath(fence, join(root, 'sub', '..', 'f.txt'))).toBe(file)
  })

  it('refuses a path that leaves every root, by spelling or by a link on the way', async () => {
    put(join(outside, 'secret'), 's')
    await refusedWith(admitPath(fence, join(root, '..', 'outside', 'secret')), 'outside')
    symlinkSync(outside, join(root, 'out'))
    await refusedWith(admitPath(fence, join(root, 'out', 'secret')), 'outside')
    await refusedWith(admitPath(fence, join(root, 'out', 'x'), 'parent'), 'outside')
  })

  it('refuses a link as the last component, even one that points inside', async () => {
    const file = put(join(root, 'f.txt'), 'x')
    symlinkSync(file, join(root, 'alias'))
    await refusedWith(admitPath(fence, join(root, 'alias')), 'link')
    await refusedWith(admitPath(fence, join(root, 'alias'), 'parent'), 'link')
  })

  it('answers a new name under a real parent, and refuses a parent that is missing or a file', async () => {
    mkdirSync(join(root, 'sub'))
    symlinkSync(join(root, 'sub'), join(root, 'via'))
    expect(await admitPath(fence, join(root, 'sub', 'new.txt'), 'parent')).toBe(join(root, 'sub', 'new.txt'))
    // A link on the way that stays inside is followed to check it, and the answer is the real spelling.
    expect(await admitPath(fence, join(root, 'via', 'new.txt'), 'parent')).toBe(join(root, 'sub', 'new.txt'))
    await refusedWith(admitPath(fence, join(root, 'nope', 'new.txt'), 'parent'), 'gone')
    put(join(root, 'f.txt'), 'x')
    await refusedWith(admitPath(fence, join(root, 'f.txt', 'new.txt'), 'parent'), 'gone')
    await refusedWith(admitPath(fence, join(root, 'missing.txt')), 'gone')
  })

  it('walks a tree without following a link, and reports the link', async () => {
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    put(join(root, 'a', 'one'), '123')
    put(join(root, 'a', 'b', 'two'), '45')
    put(join(outside, 'big'), 'x'.repeat(1000))
    symlinkSync(outside, join(root, 'a', 'escape'))
    const tree = await admitTree(fence, join(root, 'a'))
    expect(tree.dirs).toEqual([join(root, 'a', 'b')])
    expect(tree.files.sort()).toEqual([join(root, 'a', 'b', 'two'), join(root, 'a', 'one')])
    expect(tree.links).toEqual([join(root, 'a', 'escape')])
    expect(tree.bytes).toBe(5)
  })

  it('refuses a tree with more entries than it may hold', async () => {
    for (let i = 0; i < 5; i++) put(join(root, `f${i}`), '')
    await refusedWith(admitTree(fence, root, 4), 'too-big')
    expect((await admitTree(fence, root, 5)).files).toHaveLength(5)
  })
})

describe('nothing is replaced', () => {
  it('makes a folder, and refuses a taken name instead of merging into it', async () => {
    expect(await makeFolder(fence, root, 'New')).toBe(join(root, 'New'))
    expect(statSync(join(root, 'New')).isDirectory()).toBe(true)
    const e = await refusedWith(makeFolder(fence, root, 'New'), 'taken')
    expect(e.message).toBe('A folder named "New" is already there.')
  })

  it('makes a file from bytes or from a path outside the fence, and never over another', async () => {
    const at = await makeFile(fence, root, 'a.txt', new TextEncoder().encode('hello'))
    expect(readFileSync(at, 'utf8')).toBe('hello')
    const staged = put(join(outside, 'staged'), 'uploaded')
    expect(readFileSync(await makeFile(fence, root, 'b.txt', { from: staged }), 'utf8')).toBe('uploaded')
    const e = await refusedWith(makeFile(fence, root, 'a.txt', new TextEncoder().encode('other')), 'taken')
    expect(e.message).toBe('A file named "a.txt" is already there.')
    await refusedWith(makeFile(fence, root, 'a.txt', { from: staged }), 'taken')
    expect(readFileSync(at, 'utf8')).toBe('hello')
  })

  it('renames and moves a file, and refuses a taken name with both left as they were', async () => {
    const a = put(join(root, 'a.txt'), 'A')
    mkdirSync(join(root, 'sub'))
    const renamed = await moveNoReplace(fence, a, root, 'b.txt')
    expect(renamed).toBe(join(root, 'b.txt'))
    expect(existsSync(a)).toBe(false)
    const moved = await moveNoReplace(fence, renamed, join(root, 'sub'), 'b.txt')
    expect(readFileSync(moved, 'utf8')).toBe('A')
    const c = put(join(root, 'c.txt'), 'C')
    await refusedWith(moveNoReplace(fence, c, join(root, 'sub'), 'b.txt'), 'taken')
    expect(readFileSync(c, 'utf8')).toBe('C')
    expect(readFileSync(moved, 'utf8')).toBe('A')
  })

  it('moves a folder, and never onto one already there, even an empty one', async () => {
    mkdirSync(join(root, 'f'))
    put(join(root, 'f', 'x'), 'x')
    mkdirSync(join(root, 'empty'))
    await refusedWith(moveNoReplace(fence, join(root, 'f'), root, 'empty'), 'taken')
    expect(readdirSync(join(root, 'empty'))).toEqual([])
    expect(readFileSync(join(root, 'f', 'x'), 'utf8')).toBe('x')
    const to = await moveNoReplace(fence, join(root, 'f'), root, 'g')
    expect(readFileSync(join(to, 'x'), 'utf8')).toBe('x')
    expect(existsSync(join(root, 'f'))).toBe(false)
  })

  it('never replaces a folder another writer put where the move was reserved: the move is refused, both left', async () => {
    mkdirSync(join(root, 'f'))
    put(join(root, 'f', 'x'), 'x')
    // Between the reservation and the rename, the empty folder is swapped for another writer's own empty one.
    writeSeams.beforeRename = (to) => {
      rmSync(to, { recursive: true })
      mkdirSync(to)
    }
    const theirs = join(root, 'g')
    await refusedWith(moveNoReplace(fence, join(root, 'f'), root, 'g'), 'taken')
    expect(readdirSync(theirs)).toEqual([])
    expect(readFileSync(join(root, 'f', 'x'), 'utf8')).toBe('x')
    // Something put inside the reservation stays: the move is refused and the reservation is not taken away.
    writeSeams.beforeRename = (to) => void put(join(to, 'theirs.txt'), 'theirs')
    await refusedWith(moveNoReplace(fence, join(root, 'f'), root, 'h'), 'taken')
    expect(readFileSync(join(root, 'h', 'theirs.txt'), 'utf8')).toBe('theirs')
    expect(readFileSync(join(root, 'f', 'x'), 'utf8')).toBe('x')
  })

  it('on Windows keeps the reservation through a checked copy, so the name is never open while the folder moves', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      mkdirSync(join(root, 'f', 'deep'), { recursive: true })
      put(join(root, 'f', 'deep', 'two'), '22')
      const held: boolean[] = []
      writeSeams.beforeCheck = () => void held.push(existsSync(join(root, 'g')))
      const to = await moveNoReplace(fence, join(root, 'f'), root, 'g')
      expect(held.length).toBeGreaterThan(0)
      expect(held.every(Boolean)).toBe(true)
      expect(readFileSync(join(to, 'deep', 'two'), 'utf8')).toBe('22')
      expect(existsSync(join(root, 'f'))).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('refuses to move a folder inside itself, or a place itself', async () => {
    mkdirSync(join(root, 'f', 'in'), { recursive: true })
    await refusedWith(moveNoReplace(fence, join(root, 'f'), join(root, 'f', 'in'), 'f'), 'outside')
    await refusedWith(moveNoReplace(fence, root, outside, 'r'), 'outside')
    expect(existsSync(join(root, 'f', 'in'))).toBe(true)
  })

  it('copies a file and a folder, leaving a link out of the copy', async () => {
    const file = put(join(root, 'a.txt'), 'A')
    expect(readFileSync(await copyNoReplace(fence, file, root, 'a copy.txt'), 'utf8')).toBe('A')
    mkdirSync(join(root, 'f', 'deep'), { recursive: true })
    put(join(root, 'f', 'one'), '1')
    put(join(root, 'f', 'deep', 'two'), '22')
    put(join(outside, 'secret'), 's')
    symlinkSync(outside, join(root, 'f', 'escape'))
    symlinkSync(join(outside, 'secret'), join(root, 'f', 'deep', 'secret'))
    const to = await copyNoReplace(fence, join(root, 'f'), root, 'f copy')
    expect(readdirSync(to).sort()).toEqual(['deep', 'one'])
    expect(readdirSync(join(to, 'deep'))).toEqual(['two'])
    expect(readFileSync(join(to, 'deep', 'two'), 'utf8')).toBe('22')
    await refusedWith(copyNoReplace(fence, join(root, 'f'), root, 'f copy'), 'taken')
    await refusedWith(copyNoReplace(fence, file, root, 'a copy.txt'), 'taken')
  })

  it('removes a copy that fails its check, and leaves the source as it was', async () => {
    mkdirSync(join(root, 'f'))
    put(join(root, 'f', 'one'), 'one')
    writeSeams.beforeCheck = (copy) => writeFileSync(copy, 'spoilt')
    await expect(copyNoReplace(fence, join(root, 'f'), root, 'f copy')).rejects.toThrow('The copy did not match')
    expect(existsSync(join(root, 'f copy'))).toBe(false)
    expect(readFileSync(join(root, 'f', 'one'), 'utf8')).toBe('one')
  })

  it('removes a copy stopped half way', async () => {
    mkdirSync(join(root, 'f'))
    for (let i = 0; i < 5; i++) put(join(root, 'f', `f${i}`), `${i}`)
    const stop = new AbortController()
    let n = 0
    writeSeams.beforeCheck = () => void (++n === 2 && stop.abort())
    await expect(copyNoReplace(fence, join(root, 'f'), root, 'f copy', { signal: stop.signal })).rejects.toThrow()
    expect(existsSync(join(root, 'f copy'))).toBe(false)
    expect(readdirSync(join(root, 'f'))).toHaveLength(5)
  })
})

describe('across volumes', () => {
  it('moves a file and a folder as a checked copy, then removes the source', async () => {
    writeSeams.across = true
    const file = put(join(root, 'a.txt'), 'A')
    mkdirSync(join(root, 'sub'))
    expect(readFileSync(await moveNoReplace(fence, file, join(root, 'sub'), 'a.txt'), 'utf8')).toBe('A')
    expect(existsSync(file)).toBe(false)
    mkdirSync(join(root, 'f', 'deep'), { recursive: true })
    put(join(root, 'f', 'deep', 'two'), '22')
    const to = await moveNoReplace(fence, join(root, 'f'), join(root, 'sub'), 'f')
    expect(readFileSync(join(to, 'deep', 'two'), 'utf8')).toBe('22')
    expect(existsSync(join(root, 'f'))).toBe(false)
  })

  it('keeps the source when the copy fails its check', async () => {
    writeSeams.across = true
    const file = put(join(root, 'a.txt'), 'A')
    mkdirSync(join(root, 'f'))
    put(join(root, 'f', 'x'), 'x')
    writeSeams.beforeCheck = (copy) => writeFileSync(copy, 'spoilt')
    await expect(moveNoReplace(fence, file, root, 'b.txt')).rejects.toThrow('The copy did not match')
    await expect(moveNoReplace(fence, join(root, 'f'), root, 'g')).rejects.toThrow('The copy did not match')
    expect(readdirSync(root).sort()).toEqual(['a.txt', 'f'])
    expect(readFileSync(file, 'utf8')).toBe('A')
    expect(readFileSync(join(root, 'f', 'x'), 'utf8')).toBe('x')
  })

  it('refuses to move a folder that holds a link, since the copy would drop it', async () => {
    writeSeams.across = true
    mkdirSync(join(root, 'f'))
    symlinkSync(outside, join(root, 'f', 'escape'))
    await refusedWith(moveNoReplace(fence, join(root, 'f'), root, 'g'), 'link')
    expect(existsSync(join(root, 'g'))).toBe(false)
    expect(lstatSync(join(root, 'f', 'escape')).isSymbolicLink()).toBe(true)
  })

  it.skipIf(!existsSync('/dev/shm') || statSync('/dev/shm').dev === statSync(tmpdir()).dev)('moves between two real volumes', async () => {
    const other = tmp('/dev/shm')
    const two: WriteFence = { roots: [root, other] }
    const file = put(join(root, 'a.txt'), 'A')
    mkdirSync(join(root, 'f'))
    put(join(root, 'f', 'x'), 'x')
    expect(readFileSync(await moveNoReplace(two, file, other, 'a.txt'), 'utf8')).toBe('A')
    expect(readFileSync(join(await moveNoReplace(two, join(root, 'f'), other, 'f'), 'x'), 'utf8')).toBe('x')
    expect(readdirSync(root)).toEqual([])
  })
})

describe('a folder swapped for a link mid-change', () => {
  beforeEach(() => mkdirSync(join(root, 'sub')))
  const swapNext = (): void => void (writeSeams.beforeWrite = () => swapForLink(join(root, 'sub')))

  it('puts nothing outside the root, whatever the verb', async () => {
    const file = put(join(root, 'a.txt'), 'A')
    mkdirSync(join(root, 'f'))
    put(join(root, 'f', 'x'), 'x')
    const verbs: (() => Promise<unknown>)[] = [
      () => makeFile(fence, join(root, 'sub'), 'n.txt', new Uint8Array([1])),
      () => makeFile(fence, join(root, 'sub'), 'n.txt', { from: file }),
      () => makeFolder(fence, join(root, 'sub'), 'n'),
      () => moveNoReplace(fence, file, join(root, 'sub'), 'n.txt'),
      () => moveNoReplace(fence, join(root, 'f'), join(root, 'sub'), 'n'),
      () => copyNoReplace(fence, file, join(root, 'sub'), 'n.txt'),
      () => copyNoReplace(fence, join(root, 'f'), join(root, 'sub'), 'n')
    ]
    for (const verb of verbs) {
      swapNext()
      await refusedWith(verb(), 'outside')
      expect(readdirSync(outside)).toEqual([])
      rmSync(join(root, 'sub'))
      renameSync(join(root, 'sub-was'), join(root, 'sub'))
    }
    expect(readFileSync(file, 'utf8')).toBe('A')
    expect(readFileSync(join(root, 'f', 'x'), 'utf8')).toBe('x')
  })
})

describe('a second writer', () => {
  it('lets one of two makes of one name win whole, and refuses the other', async () => {
    const one = new Uint8Array(4 * 1024 * 1024).fill(1)
    const two = new Uint8Array(4 * 1024 * 1024).fill(2)
    const results = await Promise.allSettled([makeFile(fence, root, 'n.bin', one), makeFile(fence, root, 'n.bin', two)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((lost.reason as FileRefused).code).toBe('taken')
    const bytes = readFileSync(join(root, 'n.bin'))
    expect(bytes.equals(Buffer.from(one)) || bytes.equals(Buffer.from(two))).toBe(true)
  })

  it('lets one of two moves to one name win, and leaves the loser where it was', async () => {
    const a = put(join(root, 'a'), 'A')
    const b = put(join(root, 'b'), 'B')
    const results = await Promise.allSettled([moveNoReplace(fence, a, root, 'n'), moveNoReplace(fence, b, root, 'n')])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const won = readFileSync(join(root, 'n'), 'utf8')
    const loser = won === 'A' ? b : a
    expect(readFileSync(loser, 'utf8')).toBe(won === 'A' ? 'B' : 'A')
    expect(readdirSync(root).sort()).toEqual([won === 'A' ? 'b' : 'a', 'n'])
  })

  it('never replaces a file when a move races a make of its name', async () => {
    for (let i = 0; i < 20; i++) {
      const a = put(join(root, `a${i}`), 'moved')
      const [move, make] = await Promise.allSettled([moveNoReplace(fence, a, root, `n${i}`), makeFile(fence, root, `n${i}`, new TextEncoder().encode('made'))])
      expect([move.status, make.status].sort()).toEqual(['fulfilled', 'rejected'])
      const there = readFileSync(join(root, `n${i}`), 'utf8')
      if (move.status === 'fulfilled') expect([there, existsSync(a)]).toEqual(['moved', false])
      else expect([there, readFileSync(a, 'utf8')]).toEqual(['made', 'moved'])
    }
  })
})

describe('versions', () => {
  it('reads size, time and sha256, and compares by sha256 when both have it', async () => {
    const file = put(join(root, 'a'), 'abc')
    const v = await versionOf(file)
    expect(v.size).toBe(3)
    expect(v.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sameVersion(v, { ...v, mtimeMs: 1 })).toBe(true)
    expect(sameVersion(v, { ...v, sha256: 'other' })).toBe(false)
    expect(sameVersion({ size: 3, mtimeMs: 5 }, { size: 3, mtimeMs: 5 })).toBe(true)
    expect(sameVersion({ size: 3, mtimeMs: 5 }, { size: 3, mtimeMs: 6 })).toBe(false)
  })
})

describe('locks', () => {
  const later = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('runs one caller at a time per key, in the order they came', async () => {
    const seen: string[] = []
    const job = (n: number) => () => withFileLocks(['k'], async () => {
      seen.push(`in ${n}`)
      await later(5)
      seen.push(`out ${n}`)
    })
    await Promise.all([job(1)(), job(2)(), job(3)()])
    expect(seen).toEqual(['in 1', 'out 1', 'in 2', 'out 2', 'in 3', 'out 3'])
    expect(fileLocked('k')).toBe(false)
  })

  it('runs different keys together, and says which are held', async () => {
    let both = false
    let release!: () => void
    const held = withFileLocks(['a'], () => new Promise<void>((r) => (release = r)))
    await later(0)
    expect(fileLocked('a')).toBe(true)
    await withFileLocks(['b'], async () => void (both = fileLocked('a')))
    expect(both).toBe(true)
    release()
    await held
    expect(fileLocked('a')).toBe(false)
  })

  it('releases on a throw', async () => {
    await expect(withFileLocks(['k'], () => Promise.reject(new Error('no')))).rejects.toThrow('no')
    expect(fileLocked('k')).toBe(false)
    expect(await withFileLocks(['k'], async () => 1)).toBe(1)
  })

  it('never deadlocks on keys given in opposite orders', async () => {
    const one = withFileLocks(['a', 'b'], () => later(10).then(() => 1))
    const two = withFileLocks(['b', 'a'], () => later(10).then(() => 2))
    expect(await Promise.race([Promise.all([one, two]), later(2000).then(() => 'stuck')])).toEqual([1, 2])
  })
})

describe('the journal', () => {
  let db: DatabaseSync
  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    ensureFilesTables(db)
  })
  const op = { id: 'op1', workspaceId: 'w1', verb: 'rename', refs: [{ at: 'file', path: '/x' }] }

  it('runs an id once and answers the kept result again', async () => {
    let calls = 0
    const fn = async (): Promise<{ path: string }> => ({ path: `/y${++calls}` })
    expect(await runOp(db, op, fn)).toEqual({ path: '/y1' })
    expect(await runOp(db, op, fn)).toEqual({ path: '/y1' })
    expect(calls).toBe(1)
  })

  it('keeps a failed run and answers its sentence again without running', async () => {
    let calls = 0
    const fn = async (): Promise<never> => {
      calls++
      throw new FileRefused('taken', 'A file named "y" is already there.')
    }
    await refusedWith(runOp(db, op, fn), 'taken')
    const again = await refusedWith(runOp(db, op, fn), 'taken')
    expect(again.message).toBe('A file named "y" is already there.')
    expect(calls).toBe(1)
  })

  it('refuses an id reused for another workspace, verb or refs', async () => {
    await runOp(db, op, async () => 1)
    for (const other of [{ ...op, workspaceId: 'w2' }, { ...op, verb: 'move' }, { ...op, refs: [{ at: 'file', path: '/z' }] }]) {
      await expect(runOp(db, other, async () => 2)).rejects.toThrow('That operation id was used for another change.')
    }
  })

  it('runs once for two calls with one id at the same time', async () => {
    let calls = 0
    const fn = async (): Promise<number> => {
      calls++
      await new Promise((r) => setTimeout(r, 5))
      return 7
    }
    expect(await Promise.all([runOp(db, op, fn), runOp(db, op, fn)])).toEqual([7, 7])
    expect(calls).toBe(1)
  })

  it('marks a run a dead process left failed, at boot', async () => {
    db.prepare(`INSERT INTO work_files_ops (id, workspace_id, verb, refs, state, at) VALUES ('op1', 'w1', 'rename', ?, 'running', ?)`).run(JSON.stringify(op.refs), Date.now())
    expect(settleOps(db)).toBe(1)
    await expect(runOp(db, op, async () => 1)).rejects.toThrow('The app stopped before this finished.')
  })

  it('drops rows older than a week', async () => {
    const now = Date.now()
    await runOp(db, op, async () => 1)
    await runOp(db, { ...op, id: 'op2' }, async () => 2)
    db.prepare(`UPDATE work_files_ops SET at = ? WHERE id = 'op1'`).run(now - 8 * 24 * 60 * 60 * 1000)
    expect(pruneOps(db, now)).toBe(1)
    expect((db.prepare(`SELECT id FROM work_files_ops`).all() as { id: string }[]).map((r) => r.id)).toEqual(['op2'])
  })
})
