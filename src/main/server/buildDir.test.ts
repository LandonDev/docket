import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveBuildDir } from './build'

const home = process.env.HOME
let top = ''
afterEach(() => {
  process.env.HOME = home
  if (top) rmSync(top, { recursive: true, force: true })
})

describe('resolveBuildDir', () => {
  it('finds its build worktree again when ~/.temp-code is a link to ~/.docket', async () => {
    top = realpathSync(mkdtempSync(join(tmpdir(), 'build-dir-')))
    mkdirSync(join(top, '.docket'))
    symlinkSync('.docket', join(top, '.temp-code'))
    process.env.HOME = top
    const repo = join(top, 'repo')
    const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    mkdirSync(repo)
    git('init', '-q', '-b', 'main')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one')
    git('branch', 'other')
    const project = { cwd: repo, branch: 'main' }

    const first = await resolveBuildDir(project, 'other')
    expect(first.cwd).toBe(join(top, '.temp-code', 'builds', 'repo-other'))
    // git records the real path, under .docket; the second build reuses the worktree rather than adding it again.
    expect(git('worktree', 'list')).toContain(join(top, '.docket', 'builds', 'repo-other'))
    await expect(resolveBuildDir(project, 'other')).resolves.toEqual(first)
  })
})
