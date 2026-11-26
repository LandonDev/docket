import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { chainTo, entryGraph } from './entry-graph'

/**
 * Main's boot, read from source (scripts/entry-graph.ts): with Work off, nothing of Work's mount or pillars loads
 * before the first window. index.ts reaches Work's code only through work/load.ts's `import()`, which waits for the
 * first window unless Work is on here (docs/agents/launch-code-caches.md "Boot order"). The few helpers of Work's
 * folder the host itself reads are named here, so a new one is a choice made in review, never a pillar pulled in.
 */
const MAIN_ENTRY = 'src/main/index.ts'
/** Work's files the host imports statically: small helpers with no pillar under them (94 kB of source, 2026-11-26). */
const HOST_READS_OF_WORK = [
  'src/main/server/work/files/places/winDir.ts',
  'src/main/server/work/load.ts',
  'src/main/server/work/modules.ts',
  'src/main/server/work/narrowing.ts',
  'src/main/server/work/office/addin/web.ts',
  'src/main/server/work/office/carrier.ts',
  'src/main/server/work/preamble.ts',
  'src/main/server/work/scope.ts',
  'src/main/server/work/toolInput.ts'
]

describe('the main entry, read from source', () => {
  const graph = entryGraph(resolve(__dirname, '..'), MAIN_ENTRY)

  it('reaches the server and the boot read', () => {
    expect(graph.has('src/main/server/index.ts')).toBe(true)
    expect(graph.has('src/main/bootMirror.ts')).toBe(true)
    expect(graph.has('src/main/desktopBoot.ts')).toBe(true)
  })

  it('holds nothing of Work but the helpers the host reads: no mount, no pillar, behind load.ts', () => {
    const work = [...graph.keys()].filter((id) => id.startsWith('src/main/server/work/')).sort()
    const strays = work.filter((id) => !HOST_READS_OF_WORK.includes(id))
    expect(strays.map((id) => chainTo(graph, id).join(' -> '))).toEqual([])
    for (const behind of ['src/main/server/work/ctx.ts', 'src/main/server/work/files/imports.ts']) expect(graph.has(behind)).toBe(false)
  })
})
