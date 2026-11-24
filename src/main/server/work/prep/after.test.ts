import { describe, expect, it } from 'vitest'
import { PREP_UNANSWERED_MAX, type PrepSuggestion } from '@shared/contract-work-prep'
import { rewriteTasks } from './after'

describe('a rewrite and the filing keys LifeOS never answered', () => {
  it('keeps the newest unanswered suggestion when the ones set aside are at their limit', () => {
    const old: PrepSuggestion[] = Array.from({ length: PREP_UNANSWERED_MAX }, (_, i) => ({ id: `s${i + 1}`, title: `Old ${i + 1}`, state: 'proposed', tried: true }))
    const fresh: PrepSuggestion = { id: `s${PREP_UNANSWERED_MAX + 1}`, title: 'Book bus', state: 'proposed', tried: true }
    // a rewrite that leaves the newest out
    const out = rewriteTasks([{ title: 'Send roster' }], [fresh], PREP_UNANSWERED_MAX + 1, [], old)
    expect(out.unanswered).toHaveLength(PREP_UNANSWERED_MAX)
    expect(out.unanswered.at(-1)).toEqual(fresh)
    // suggested again unchanged, it comes back with its id
    const back = rewriteTasks([{ title: 'Book bus' }], out.tasks, out.suggestionSeq, [], out.unanswered)
    expect(back.tasks[0]!.id).toBe(fresh.id)
  })
})
