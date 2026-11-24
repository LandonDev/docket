import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setWatchLimitsForTests, treeIgnored, watchStats, watchTree, type TreeEventKind, type TreeWatcher } from './treewatch'

const made: string[] = []
const open: TreeWatcher[] = []
afterEach(async () => {
  for (const w of open.splice(0)) await w.close()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  setWatchLimitsForTests(null)
})

function tree(paths: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'tc-treewatch-'))
  made.push(root)
  for (const p of paths) {
    const abs = join(root, p)
    if (p.endsWith('/')) mkdirSync(abs, { recursive: true })
    else {
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, 'x\n')
    }
  }
  return root
}

/** The tree's folder watches once the walk stops growing. */
async function settled(root: string): Promise<{ held: number; partial: boolean }> {
  let last = -1
  for (;;) {
    await new Promise((r) => setTimeout(r, 50))
    const share = watchStats().roots.find((r) => r.root === root) ?? { held: 0, partial: false }
    if (share.held === last) return share
    last = share.held
  }
}

function watch(root: string, dirs = false): { events: [TreeEventKind, string][]; w: TreeWatcher } {
  const events: [TreeEventKind, string][] = []
  const w = watchTree(root, { dirs, onEvent: (kind, abs) => events.push([kind, abs.slice(root.length + 1)]) })
  open.push(w)
  return { events, w }
}

describe('treeIgnored', () => {
  it('skips build and VCS folders at any depth and the agents\' worktrees', () => {
    expect(treeIgnored('/r', '/r/src/a.ts')).toBe(false)
    expect(treeIgnored('/r', '/r/a/node_modules/x')).toBe(true)
    expect(treeIgnored('/r', '/r/.git/HEAD')).toBe(true)
    expect(treeIgnored('/r', '/r/.claude/worktrees/w1/src/a.ts')).toBe(true)
    expect(treeIgnored('/r', '/r/.claude/settings.json')).toBe(false)
    expect(treeIgnored('/r', '/r/worktrees/a')).toBe(false)
    expect(treeIgnored('/r', '/r/out/main.js')).toBe(true)
  })
})

describe.runIf(process.platform === 'linux')('the Linux tree watcher', () => {
  it('watches folders, never files, and leaves out ignored folders, nested repos, worktrees and links', async () => {
    const root = tree([
      'src/a.ts',
      'src/b.ts',
      'src/deep/c.ts',
      'node_modules/pkg/index.js',
      '.git/HEAD',
      '.claude/settings.json',
      '.claude/worktrees/w1/.git',
      '.claude/worktrees/w1/src/a.ts',
      'vendor/clone/.git/HEAD',
      'vendor/clone/lib/x.ts',
      'out/main.js'
    ])
    symlinkSync(join(root, 'src'), join(root, 'linked'))
    watch(root)
    // root, src, src/deep, .claude, vendor: five folders whatever the file count
    expect((await settled(root)).held).toBe(5)
    expect(watchStats().held).toBeGreaterThanOrEqual(5)
  })

  it('tells a new file, a write, an atomic replace and a delete, and a new folder\'s files', async () => {
    const root = tree(['src/a.ts'])
    const { events } = watch(root, true)
    await settled(root)
    writeFileSync(join(root, 'src/new.ts'), 'n\n')
    await vi.waitFor(() => expect(events).toContainEqual(['created', 'src/new.ts']))
    writeFileSync(join(root, 'src/a.ts'), 'changed\n')
    await vi.waitFor(() => expect(events).toContainEqual(['changed', 'src/a.ts']))
    writeFileSync(join(root, 'src/a.ts.tmp'), 'replaced\n')
    renameSync(join(root, 'src/a.ts.tmp'), join(root, 'src/a.ts'))
    await vi.waitFor(() => expect(events.filter(([k, p]) => k === 'changed' && p === 'src/a.ts').length).toBeGreaterThanOrEqual(2))
    unlinkSync(join(root, 'src/new.ts'))
    await vi.waitFor(() => expect(events).toContainEqual(['deleted', 'src/new.ts']))
    mkdirSync(join(root, 'src/fresh'))
    await vi.waitFor(() => expect(events).toContainEqual(['created', 'src/fresh']))
    await settled(root)
    writeFileSync(join(root, 'src/fresh/f.ts'), 'f\n')
    await vi.waitFor(() => expect(events).toContainEqual(['created', 'src/fresh/f.ts']))
    // An ignored folder made later stays unwatched.
    mkdirSync(join(root, 'node_modules/x'), { recursive: true })
    writeFileSync(join(root, 'node_modules/x/i.js'), 'i\n')
    await new Promise((r) => setTimeout(r, 150))
    expect(events.some(([, p]) => p.startsWith('node_modules'))).toBe(false)
  })

  it('stops at the ceiling, says so once, and gives every watch back on close', async () => {
    const lines: string[] = []
    setWatchLimitsForTests({ ceiling: watchStats().held + 3, log: (line) => lines.push(line) })
    const root = tree(['a/1', 'b/1', 'c/1', 'd/1', 'e/1'])
    const before = watchStats().held
    const { w } = watch(root)
    const share = await settled(root)
    expect(share).toMatchObject({ held: 3, partial: true })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[treewatch\] ceiling of \d+ watched folders reached: .* is watched in part \(3 folders\)$/)
    await w.close()
    expect(watchStats().held).toBe(before)
    expect(watchStats().roots.some((r) => r.root === root)).toBe(false)
  })

  it('a deleted folder gives back its watches', async () => {
    const root = tree(['a/b/c/x'])
    watch(root)
    expect((await settled(root)).held).toBe(4)
    rmSync(join(root, 'a'), { recursive: true })
    await vi.waitFor(() => expect(watchStats().roots.find((r) => r.root === root)?.held).toBe(1))
  })
})
