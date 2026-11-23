import { describe, expect, it } from 'vitest'
import { infoDirOf, typecheckCommands } from './typecheck'

describe('typecheck', () => {
  it('runs both tsc projects incremental, each with its own build info in the given dir, and both Swift checks', () => {
    const cmds = typecheckCommands('/g/temp-code-tsc')
    expect(cmds.filter((c) => c[1] === 'tsc').map((c) => [c[4], c[c.indexOf('--tsBuildInfoFile') + 1]])).toEqual([
      ['tsconfig.node.json', '/g/temp-code-tsc/node.tsbuildinfo'],
      ['tsconfig.web.json', '/g/temp-code-tsc/web.tsbuildinfo']
    ])
    for (const c of cmds.filter((c) => c[1] === 'tsc')) expect(c).toEqual(expect.arrayContaining(['--noEmit', '--incremental']))
    expect(cmds.map((c) => c.join(' '))).toEqual(expect.arrayContaining(['bun scripts/gen-swift-contract.ts --check', 'bun scripts/gen-swift-computer.ts --check']))
  })

  it('keeps the build info in the checkout’s git dir, or under node_modules/.cache outside git', () => {
    expect(infoDirOf('/r/.git/worktrees/w', '/w')).toBe('/r/.git/worktrees/w/temp-code-tsc')
    expect(infoDirOf(null, '/w')).toBe('/w/node_modules/.cache/temp-code-tsc')
  })
})
