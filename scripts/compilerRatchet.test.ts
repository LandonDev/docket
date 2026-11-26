import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The React Compiler's refusals only go down: under src/renderer/src/work (the Work performance pass, M12, key
 * `work`) and in the rest of the renderer (the idle pass, M8, key `renderer`). A refused component is not memoised
 * and renders with every render of its parent. scripts/react-compiler-ratchet.json holds each number; a slice that
 * refuses more fails here, and one that refuses fewer is told to lower it.
 */
describe.each([
  ['under work/', 'work'],
  ['in the rest of the renderer', 'renderer']
])("the React Compiler's ratchet %s", (_where, key) => {
  it('refuses no more functions than the ratchet allows', () => {
    const root = resolve(__dirname, '..')
    const run = spawnSync(process.execPath.endsWith('bun') ? process.execPath : 'bun', ['scripts/react-compiler-tally.ts', '--only', key, '--check'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 170_000,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }
    })
    expect(run.status, run.stderr || run.stdout).toBe(0)
  }, 180_000)
})
