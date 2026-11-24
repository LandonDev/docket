import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { sectionOf } from '../../../../scripts/lib/docsCitations'
import { loadWorkModules, WORK_MODULES } from './modules'

/**
 * docs/agents/work.md "What each pillar answers" against the modules as they load: a row for every pillar, "yes" in
 * Health exactly where the module has `health`, and the backticked names before any "(" in Tells, Search and `@`
 * exactly its `tells` kinds, `search` kinds and `mentions` kinds. Words after a "(" name another pillar's answer.
 */
const DOC = join(__dirname, '../../../../docs/agents/work.md')

function rows(): Map<string, string[]> {
  const section = sectionOf(readFileSync(DOC, 'utf8'), 'What each pillar answers')
  if (!section) throw new Error('work.md has no "What each pillar answers" section')
  const out = new Map<string, string[]>()
  for (const line of section.split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| Pillar') || line.startsWith('|---')) continue
    const cells = line.slice(2, -2).split(' | ').map((c) => c.trim())
    out.set(cells[0]!, cells.slice(1))
  }
  return out
}

/** The module's own names a cell writes: backticked, before any "(". */
const own = (cell: string): string[] => [...cell.split('(')[0]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).sort()
const kinds = (list: readonly { kind: string }[] | undefined): string[] => (list ?? []).map((x) => x.kind).sort()

beforeAll(async () => {
  await loadWorkModules()
}, 120_000)

describe("work.md's pillar table", () => {
  it('has one row for each pillar that loads, and no other', () => {
    expect([...rows().keys()].sort()).toEqual(WORK_MODULES.map((m) => m.id).sort())
  })

  it("says what each module answers, as the module does", () => {
    const table = rows()
    const wrong: string[] = []
    for (const m of WORK_MODULES) {
      const [health, tells, search, at] = table.get(m.id) ?? []
      if (health === undefined) continue
      if (health.startsWith('yes') !== !!m.health) wrong.push(`${m.id}: Health says "${health}", the module ${m.health ? 'has' : 'has no'} health`)
      for (const [column, cell, names] of [
        ['Tells', tells!, kinds(m.tells)],
        ['Search', search!, kinds(m.search)],
        ['@', at!, kinds(m.mentions)]
      ] as const)
        if (JSON.stringify(own(cell)) !== JSON.stringify(names)) wrong.push(`${m.id}: ${column} says ${own(cell).join(', ') || 'none'}, the module ${names.join(', ') || 'none'}`)
    }
    expect(wrong, 'fix the row in docs/agents/work.md "What each pillar answers"').toEqual([])
  })
})
