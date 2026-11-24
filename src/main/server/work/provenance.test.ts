import { describe, expect, it } from 'vitest'
import { ROUTINE_UNKNOWN, routineRunUp } from './provenance'

/** The routine run a thread acts for, up its line (provenance.ts): one walk for the Outbox's grants and the Forms withhold. */
describe('the run a thread acts for', () => {
  const rows = new Map<string, { routineRunId?: string | null; parentId?: string | null; startedBy?: string | null }>([
    ['run-root', { routineRunId: 'run-1' }],
    ['child', { parentId: 'run-root' }],
    ['grandchild', { startedBy: 'child' }],
    ['his', {}],
    ['his-child', { parentId: 'his' }],
    ['orphan', { parentId: 'on-another-host' }]
  ])
  const get = (id: string) => rows.get(id) ?? null

  it("is a delegated child's and grandchild's run, by parent or starter", () => {
    expect(routineRunUp(get, 'run-root')).toBe('run-1')
    expect(routineRunUp(get, 'child')).toBe('run-1')
    expect(routineRunUp(get, 'grandchild')).toBe('run-1')
  })

  it('is none for his own threads, and unknown when the line cannot be followed', () => {
    expect(routineRunUp(get, 'his')).toBeNull()
    expect(routineRunUp(get, 'his-child')).toBeNull()
    expect(routineRunUp(get, 'orphan')).toBe(ROUTINE_UNKNOWN)
    expect(routineRunUp(get, 'not-here')).toBe(ROUTINE_UNKNOWN)
    const loop = (id: string) => ({ parentId: `${id}x` })
    expect(routineRunUp(loop, 'a')).toBe(ROUTINE_UNKNOWN)
  })
})
