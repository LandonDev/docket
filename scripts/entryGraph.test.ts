import { describe, expect, it } from 'vitest'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { entryLeak } from './check-bundle-size'
import { chainTo, entryGraph, keptImports, RENDERER_ENTRY } from './entry-graph'

/**
 * The first paint's rules, held on the source (scripts/entry-graph.ts): what
 * `bun run check:bundle` judges on the built chunks, a thread that never
 * builds can break without knowing. This reads the same lists.
 */
/** A module of Work's by name (workSwitch.ts, useWorkMentions.ts), not a workspace's or a working mark's. */
const WORK_GLUE = /\/(use)?work(?!space|ing|tree)[^/]*$/i
/** Their source, 21.8 kB on 2026-11-23, with room for a row or two. */
const WORK_GLUE_BYTES = 26_000

describe('the renderer entry, read from source', () => {
  const root = resolve(__dirname, '..')
  const graph = entryGraph(root)

  it('reaches the first paint and stops at a dynamic import', () => {
    expect(graph.has(RENDERER_ENTRY)).toBe(true)
    expect(graph.has('src/renderer/src/App.tsx')).toBe(true)
    expect(graph.has('src/renderer/src/surfaces/chunks.ts')).toBe(true)
    // behind `import()` in surfaces/chunks.ts
    expect(graph.has('src/renderer/src/surfaces/SettingsView.tsx')).toBe(false)
  })

  it('holds no lazy surface and nothing of Work', () => {
    const leaks = [...graph.keys()].filter((id) => entryLeak(id) !== null).map((id) => chainTo(graph, id).join('\n  → '))
    expect(leaks, 'each chain runs from the entry to a module that must not be in the first paint; cut it with `import type`, a lazy chunk (surfaces/chunks.ts) or a leaf file').toEqual([])
  })

  // Tonight's builds each passed `check:bundle` alone and together took the closure 2.5 kB over (2026-11-23): what
  // of Work the first paint may hold is its registry rows (the switch, the ports a key or menu row opens a pillar
  // through), named here, and small. A pillar's view, store, keys table or icons goes in a lazy chunk; a new row
  // goes on this list with its reason in .temp-code/plans/round3/SEAMS.md "first-paint".
  it("holds of Work its registry rows alone, and keeps them small", () => {
    const glue = [...graph.keys()].filter((id) => id.startsWith('src/') && WORK_GLUE.test(id)).sort()
    expect(glue).toEqual([
      'src/renderer/src/chrome/useWorkMentions.ts',
      'src/renderer/src/lib/workPlaces.ts',
      'src/renderer/src/lib/workSearchPort.ts',
      'src/renderer/src/lib/workSwitch.ts'
    ])
    const bytes = glue.reduce((sum, id) => sum + statSync(resolve(root, id)).size, 0)
    expect(bytes, 'the Work rows the first paint carries grew past their room: move what is not a row into a lazy chunk').toBeLessThanOrEqual(WORK_GLUE_BYTES)
  })
})

describe('keptImports', () => {
  const kept = (text: string): string[] => keptImports('a.tsx', text)

  it('keeps an import a value reads', () => {
    expect(kept(`import { a } from './a'\nexport const b = a + 1`)).toEqual(['./a'])
    expect(kept(`import A from './a'\nexport const b = <A />`)).toEqual(['./a'])
    expect(kept(`import * as ns from './a'\nexport const b = ns.x`)).toEqual(['./a'])
    expect(kept(`import { Base } from './a'\nexport class B extends Base {}`)).toEqual(['./a'])
    expect(kept(`import './side.css'\nimport './side'`)).toEqual(['./side.css', './side'])
    expect(kept(`import { a } from './a'\nexport { a }`)).toEqual(['./a'])
    expect(kept(`import { a } from './a'\nexport const o = { a }`)).toEqual(['./a'])
  })

  it('drops an import only types read', () => {
    expect(kept(`import type { A } from './a'\nexport const b: A = 1`)).toEqual([])
    expect(kept(`import { type A } from './a'\nexport const b: A = 1`)).toEqual([])
    expect(kept(`import { A } from './a'\nexport const b: A | null = null`)).toEqual([])
    expect(kept(`import { A } from './a'\nexport const b = {} as A`)).toEqual([])
    expect(kept(`import { a } from './a'\nexport type B = typeof a`)).toEqual([])
    expect(kept(`import { A } from './a'\nexport interface B extends A {}`)).toEqual([])
    expect(kept(`import { A } from './a'\nexport class B implements A {}`)).toEqual([])
    expect(kept(`import { a } from './a'\nexport const o = { a: 1 }; export const p = o.a`)).toEqual([])
  })

  it('follows a re-export and not a type-only one, and never a dynamic import', () => {
    expect(kept(`export * from './a'\nexport { b } from './b'`)).toEqual(['./a', './b'])
    expect(kept(`export type { A } from './a'\nexport { type B } from './b'`)).toEqual([])
    expect(kept(`export const load = () => import('./lazy')`)).toEqual([])
  })
})
