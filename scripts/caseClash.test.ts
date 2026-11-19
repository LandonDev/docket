import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Two tracked paths equal but for case are one file on the Mac's disk (and on
 * Windows'). So are two modules an import names alike: `SentChips.tsx` beside
 * `sentChips.ts` built on the box and broke the 1.0.350 build on the Mac,
 * where `./SentChips` found the `.ts` file first. A script's name is compared
 * without its extension, as an import names it. Every group is named so the
 * rename is plain.
 */
const SCRIPT = /\.(?:d\.)?[cm]?[jt]sx?$/
export function caseClashes(paths: readonly string[]): string[][] {
  const byFolded = new Map<string, string[]>()
  for (const path of paths) {
    // A folder that differs only in case clashes too: compare every prefix.
    const parts = path.split('/')
    for (let i = 1; i <= parts.length; i++) {
      // The file itself as an import names it: its folder and its name with no script extension.
      const prefix = i === parts.length ? parts.join('/').replace(SCRIPT, '') : parts.slice(0, i).join('/')
      const key = prefix.toLowerCase()
      const seen = byFolded.get(key) ?? []
      if (!seen.includes(prefix)) byFolded.set(key, [...seen, prefix])
    }
  }
  return [...byFolded.values()].filter((names) => names.length > 1)
}

describe('tracked paths', () => {
  it('finds files, script modules and folders equal but for case', () => {
    expect(caseClashes(['a/SentChips.tsx', 'a/sentChips.ts', 'a/x.ts'])).toEqual([['a/SentChips', 'a/sentChips']])
    expect(caseClashes(['a/Chips.md', 'a/chips.md'])).toEqual([['a/Chips.md', 'a/chips.md']])
    // One name in one case, whatever its extensions, is not a clash.
    expect(caseClashes(['a/chips.ts', 'a/chips.test.ts', 'a/Chips.md', 'a/SentChips.tsx', 'a/sentChipsOf.ts'])).toEqual([])
    expect(caseClashes(['Work/a.ts', 'work/b.ts'])).toEqual([['Work', 'work']])
  })

  it('never differ only in case, so the Mac and Windows checkouts hold every file', () => {
    const root = resolve(__dirname, '..')
    const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
    expect(paths.length).toBeGreaterThan(100)
    expect(caseClashes(paths), 'each group is one path on a disk that ignores case; rename one of them').toEqual([])
  })
})
