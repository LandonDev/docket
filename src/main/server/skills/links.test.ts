import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, win32 } from 'node:path'
import type { SkillFile } from '@shared/contract-skills'
import { SkillStore } from '../skillStore'
import { COPY_STAMPS, JUNCTIONS, linkDir, linkEntry, linkTargetOf, readDirLink, renameRetry, swapDirLink, syncCopy } from './links'
import { SCOPE_DIR, SUPERSEDED_KEEP_MS, SkillMaterializer } from './materialize'
import { SkillPointers } from './pointers'

// Off Windows a 'junction' symlink is a plain one, so junction mode here makes
// links with absolute targets: what a junction reads back as on win32.

const you = { kind: 'person' } as const
const md = (name: string): SkillFile => ({ path: 'SKILL.md', text: `---\nname: ${name}\ndescription: Use ${name}.\n---\n` })

let tmp: string
let root: string
let db: DatabaseSync
let store: SkillStore
let clock: number
let logs: string[]
let closers: (() => void)[]

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tc-links-')))
  root = join(tmp, 'harness')
  db = new DatabaseSync(':memory:')
  clock = 1_000_000
  store = new SkillStore(db, () => clock)
  logs = []
  closers = []
})
afterEach(() => {
  for (const c of closers) c()
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function materializer(junctions: boolean, over: Partial<ConstructorParameters<typeof SkillMaterializer>[0]> = {}): SkillMaterializer {
  const m = new SkillMaterializer({
    root,
    skills: store,
    workspaces: () => [{ id: 'w1', path: join(tmp, 'w1') }],
    platform: 'linux',
    home: '/home/me',
    textMap: () => ({ roots: {}, prefixes: {} }),
    now: () => clock,
    log: (l) => logs.push(l),
    between: async () => {},
    junctions,
    ...over
  })
  closers.push(() => m.close())
  return m
}

function pointers(m: SkillMaterializer, junctions: boolean): SkillPointers {
  const p = new SkillPointers({ root, materializer: m, workspaces: () => [{ id: 'w1' }], now: () => clock, log: (l) => logs.push(l), junctions })
  closers.push(() => p.close())
  return p
}

describe('directory links', () => {
  it('are symlinks with the target as given off win32, junctions on it', () => {
    expect(JUNCTIONS).toBe(process.platform === 'win32')
    mkdirSync(join(tmp, 'gen@1'))
    // A standard Windows user may not make a symlink: the plain kind is proven off win32 only.
    if (process.platform !== 'win32') {
      linkDir('gen@1', join(tmp, 'plain'), false)
      expect(readlinkSync(join(tmp, 'plain'))).toBe('gen@1')
      expect(readDirLink(join(tmp, 'plain'), false)).toBe('gen@1')
    }
    mkdirSync(join(tmp, 'scope'))
    linkDir(join('..', 'gen@1'), join(tmp, 'scope', 'global'), true)
    expect(readlinkSync(join(tmp, 'scope', 'global'))).toBe(join(tmp, 'gen@1'))
    expect(readDirLink(join(tmp, 'scope', 'global'), true)).toBe(join('..', 'gen@1'))
  })

  it('swap by rename; off win32 a failed rename is thrown and the old link kept', () => {
    mkdirSync(join(tmp, 'a'))
    mkdirSync(join(tmp, 'b'))
    linkDir('a', join(tmp, 'view'), true)
    linkDir('b', join(tmp, 'view.lnk-1-1'), true)
    swapDirLink(join(tmp, 'view.lnk-1-1'), join(tmp, 'view'), true)
    expect(readDirLink(join(tmp, 'view'), true)).toBe('b')
    expect(() => swapDirLink(join(tmp, 'nope'), join(tmp, 'view'), false)).toThrow()
    expect(readDirLink(join(tmp, 'view'), true)).toBe('b')
  })

  it('on win32, a rename Windows refuses over a junction puts the new one in place after removing the old', () => {
    mkdirSync(join(tmp, 'a'))
    mkdirSync(join(tmp, 'b'))
    linkDir('a', join(tmp, 'view'), true)
    linkDir('b', join(tmp, 'view.lnk-1-2'), true)
    const calls: string[] = []
    const refuseOnce = (from: string, to: string): void => {
      calls.push(from)
      if (calls.length === 1) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      renameSync(from, to)
    }
    swapDirLink(join(tmp, 'view.lnk-1-2'), join(tmp, 'view'), true, refuseOnce)
    expect(calls.length).toBe(2)
    expect(readDirLink(join(tmp, 'view'), true)).toBe('b')
    expect(existsSync(join(tmp, 'view.lnk-1-2'))).toBe(false)
  })

  it("on win32, a junction's target read back with its trailing backslash compares as the bare name", () => {
    // libuv gives a junction's target as an absolute path ending in a separator; the readers rely on relative() dropping it.
    expect(win32.relative('C:\\h\\claude', 'C:\\h\\claude\\global@0123456789ab\\')).toBe('global@0123456789ab')
    expect(win32.relative('C:\\h\\claude\\scope', 'C:\\h\\claude\\global@0123456789ab\\')).toBe(win32.join('..', 'global@0123456789ab'))
  })
})

describe('the skills store with junctions', () => {
  it('builds, swaps, points and keeps its live generation through gc, as with symlinks', async () => {
    store.set({ name: 'alpha', workspaceId: null, files: [md('alpha')] }, you)
    const m = materializer(true)
    m.start()
    await m.whenSettled()
    const view = join(root, 'claude', 'global')
    const first = readlinkSync(view)
    expect(isAbsolute(first)).toBe(true)
    const gen = readDirLink(view, true)
    expect(gen).toMatch(/^global@[0-9a-f]{12}$/)
    const p = pointers(m, true)
    p.start()
    const ptr = join(root, 'claude', SCOPE_DIR, 'global')
    expect(isAbsolute(readlinkSync(ptr))).toBe(true)
    expect(p.current('claude', null).generation).toBe(join(root, 'claude', gen))
    expect(readdirSync(join(ptr, 'skills'))).toEqual(['alpha'])
    // Read back as the bare name, nothing is rebuilt or re-pointed.
    const moves: string[] = []
    p.onMoved((provider, scope) => moves.push(`${provider}/${scope}`))
    logs.length = 0
    expect(m.dirFor('claude', null)).toBe(join(root, 'claude', gen))
    p.refresh()
    expect(moves).toEqual([])
    expect(logs.filter((l) => l.includes('→'))).toEqual([])
    // A new skill swaps the view over the old junction and moves the pointer.
    clock += 1000
    store.set({ name: 'beta', workspaceId: null, files: [md('beta')] }, you)
    await m.whenSettled()
    const next = readDirLink(view, true)
    expect(next).not.toBe(gen)
    expect(readdirSync(join(ptr, 'skills'))).toEqual(['alpha', 'beta'])
    expect(moves).toContain('claude/global')
    // A day on, gc takes the superseded generation and spares the one the junctions name.
    clock += SUPERSEDED_KEEP_MS + 1
    m.gc()
    expect(existsSync(join(root, 'claude', gen))).toBe(false)
    expect(existsSync(join(root, 'claude', next))).toBe(true)
    expect(lstatSync(view).isSymbolicLink()).toBe(true)
  })
})

describe('a failed write-out', () => {
  it('never throws out of start: the boot goes on and the failure is logged', async () => {
    store.set({ name: 'alpha', workspaceId: null, files: [md('alpha')] }, you)
    // A file where the root's folder belongs: every write under it fails.
    mkdirSync(tmp, { recursive: true })
    writeFileSync(root, '')
    const m = materializer(false)
    expect(() => m.start()).not.toThrow()
    await m.whenSettled()
    const p = pointers(m, false)
    expect(() => p.start()).not.toThrow()
    expect(logs.some((l) => /[\\/]scope[\\/]global not pointed:/.test(l))).toBe(true)
    expect(logs.some((l) => l.startsWith('write-out failed:') || l.startsWith('start failed:'))).toBe(true)
  })
})

describe('file copies in step (Windows)', () => {
  const at = (path: string, sec: number): void => utimesSync(path, sec, sec)

  it('copies in, copies back what the CLI rewrote by rename, and copies in what the person changed', () => {
    const person = join(tmp, 'person')
    const mine = join(tmp, 'mine')
    mkdirSync(person)
    mkdirSync(mine)
    writeFileSync(join(person, 'settings.json'), 'theirs-1')
    at(join(person, 'settings.json'), 100)
    expect(syncCopy(join(mine, 'settings.json'), join(person, 'settings.json'))).toBe('in')
    expect(readFileSync(join(mine, 'settings.json'), 'utf8')).toBe('theirs-1')
    expect(syncCopy(join(mine, 'settings.json'), join(person, 'settings.json'))).toBe('same')
    // The CLI replaces its file by rename: a new file, a later mtime.
    writeFileSync(join(mine, 'settings.json.tmp'), 'cli-2')
    renameSync(join(mine, 'settings.json.tmp'), join(mine, 'settings.json'))
    at(join(mine, 'settings.json'), 200)
    expect(syncCopy(join(mine, 'settings.json'), join(person, 'settings.json'))).toBe('back')
    expect(readFileSync(join(person, 'settings.json'), 'utf8')).toBe('cli-2')
    writeFileSync(join(person, 'settings.json'), 'theirs-3')
    at(join(person, 'settings.json'), 300)
    expect(syncCopy(join(mine, 'settings.json'), join(person, 'settings.json'))).toBe('in')
    expect(readFileSync(join(mine, 'settings.json'), 'utf8')).toBe('theirs-3')
    expect(JSON.parse(readFileSync(join(mine, COPY_STAMPS), 'utf8'))).toHaveProperty('settings.json')
  })

  it('when both changed, the later one wins', () => {
    const person = join(tmp, 'p')
    const mine = join(tmp, 'm')
    mkdirSync(person)
    mkdirSync(mine)
    writeFileSync(join(person, 'a.json'), '1')
    syncCopy(join(mine, 'a.json'), join(person, 'a.json'))
    writeFileSync(join(mine, 'a.json'), 'cli')
    at(join(mine, 'a.json'), 500)
    writeFileSync(join(person, 'a.json'), 'person')
    at(join(person, 'a.json'), 600)
    expect(syncCopy(join(mine, 'a.json'), join(person, 'a.json'))).toBe('in')
    expect(readFileSync(join(mine, 'a.json'), 'utf8')).toBe('person')
    // the loser is set aside, never lost
    expect(readFileSync(join(mine, 'a.json.diverged'), 'utf8')).toBe('cli')
  })

  it('with no record, takes a copy that is already the same, and sets the older of two different files aside', () => {
    const person = join(tmp, 'p3')
    const mine = join(tmp, 'm3')
    mkdirSync(person)
    mkdirSync(mine)
    writeFileSync(join(person, 's.json'), 'x')
    writeFileSync(join(mine, 's.json'), 'x')
    expect(syncCopy(join(mine, 's.json'), join(person, 's.json'))).toBe('same')
    writeFileSync(join(person, 't.json'), 'person')
    at(join(person, 't.json'), 100)
    writeFileSync(join(mine, 't.json'), 'mine')
    at(join(mine, 't.json'), 200)
    expect(syncCopy(join(mine, 't.json'), join(person, 't.json'))).toBe('back')
    expect(readFileSync(join(person, 't.json'), 'utf8')).toBe('mine')
    expect(readFileSync(join(mine, 't.json.diverged'), 'utf8')).toBe('person')
  })

  it("gives the person a file the CLI made first, and drops a copy in step once the person's is gone", () => {
    const person = join(tmp, 'p2')
    const mine = join(tmp, 'm2')
    mkdirSync(person)
    mkdirSync(mine)
    writeFileSync(join(mine, '.claude.json'), '{}')
    expect(syncCopy(join(mine, '.claude.json'), join(person, '.claude.json'))).toBe('back')
    expect(readFileSync(join(person, '.claude.json'), 'utf8')).toBe('{}')
    rmSync(join(person, '.claude.json'))
    expect(syncCopy(join(mine, '.claude.json'), join(person, '.claude.json'))).toBe('none')
    expect(existsSync(join(mine, '.claude.json'))).toBe(false)
  })

  it('links a directory by junction and a file by copy, a symlink off win32', () => {
    mkdirSync(join(tmp, 'dir'))
    writeFileSync(join(tmp, 'file'), 'x')
    linkEntry(join(tmp, 'dir'), join(tmp, 'dir-link'), true)
    linkEntry(join(tmp, 'file'), join(tmp, 'file-link'), true)
    expect(lstatSync(join(tmp, 'dir-link')).isSymbolicLink()).toBe(true)
    expect(linkTargetOf(readlinkSync(join(tmp, 'dir-link')))).toBe(join(tmp, 'dir'))
    expect(lstatSync(join(tmp, 'file-link')).isFile()).toBe(true)
    if (process.platform !== 'win32') {
      linkEntry(join(tmp, 'file'), join(tmp, 'file-sym'), false)
      expect(lstatSync(join(tmp, 'file-sym')).isSymbolicLink()).toBe(true)
    }
  })

  it("reads a junction's target as the path it was made to", () => {
    expect(linkTargetOf('\\\\?\\C:\\Users\\u\\.claude\\projects\\')).toBe('C:\\Users\\u\\.claude\\projects')
    expect(linkTargetOf('/home/u/.claude/projects')).toBe('/home/u/.claude/projects')
    expect(linkTargetOf(null)).toBeNull()
  })

  it('retries a rename Windows refuses while the file is open, and throws at once elsewhere', () => {
    let tries = 0
    const busy = (): void => {
      tries++
      if (tries < 3) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    }
    renameRetry('a', 'b', 'win32', busy)
    expect(tries).toBe(3)
    tries = 0
    expect(() => renameRetry('a', 'b', 'linux', busy)).toThrow('EBUSY')
    expect(tries).toBe(1)
  })
})
