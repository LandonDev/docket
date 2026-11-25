import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chainTo, entryGraph } from './entry-graph'

/**
 * What a Work view's own chunk may not carry (the Work performance pass, docs/agents/work-perf.md "Code that loads
 * only where it is used"): a library only one part of the view draws with sits behind that part's own chunk, so the
 * view's first open does not wait on it. Read from source, as scripts/entryGraph.test.ts reads the first paint.
 */
const root = resolve(__dirname, '..')
const reaches = (entry: string, part: string): string[] => {
  const graph = entryGraph(root, entry)
  return [...graph.keys()].filter((id) => id.includes(part)).slice(0, 1).map((id) => chainTo(graph, id).join('\n  → '))
}

describe('the window reads the orchestration rules as plain values', () => {
  it('neither reader of them in the first paint reaches the schemas (src/shared/rules.ts and its zod)', () => {
    for (const entry of ['src/renderer/src/lib/tcserver/rules.ts', 'src/renderer/src/lib/reviewScope.ts']) {
      const graph = entryGraph(root, entry)
      expect(graph.has('src/shared/rulesValues.ts'), entry).toBe(true)
      expect(graph.has('src/shared/rules.ts'), entry).toBe(false)
    }
  })
})

describe("the first paint's computer step words", () => {
  it('reach the plain values, never the protocol\'s or the confirmations\' schemas', () => {
    const graph = entryGraph(root, 'src/renderer/src/surfaces/computerShots.ts')
    expect(graph.has('src/shared/computer/protocolValues.ts')).toBe(true)
    for (const schema of ['src/shared/computer/protocol.ts', 'src/shared/computer/confirmSchema.ts', 'src/shared/computer/descriptions.ts']) expect(graph.has(schema), schema).toBe(false)
  })
})

describe("a view's own chunk", () => {
  it("Connections holds none of Work's settings page: its sign-in dialog loads on the press", () => {
    expect(reaches('src/renderer/src/work/connections/ConnectionsPage.tsx', 'src/renderer/src/work/shell/settings.tsx')).toEqual([])
  })

  it('Money holds no chart library: the year\'s chart is a chunk of its own', () => {
    expect(reaches('src/renderer/src/work/money/MoneyView.tsx', 'node_modules/recharts')).toEqual([])
    // and the chunk that does draw it is reached only by a dynamic import
    expect(reaches('src/renderer/src/work/money/MonthBars.tsx', 'node_modules/recharts').length).toBe(1)
  })
})
