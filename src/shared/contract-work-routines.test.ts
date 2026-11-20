import { describe, expect, it } from 'vitest'
import { PLAY_TAKES, PlaysRequestSchemas, STARTER_PLAYS, playInputsProblem } from './contract-work-routines'
import type { ContextChip } from './work'

const mail: ContextChip = { kind: 'mail', label: 'Assignment', ref: { at: 'lifeos', table: 'mailThreads', id: 'm1' } }
const doc: ContextChip = { kind: 'doc', label: 'Brief', ref: { at: 'item', id: 'i1' } }

describe('a play’s inputs', () => {
  it('fill it only when each thing it takes is there once and nothing else is', () => {
    expect(playInputsProblem([], {})).toBeNull()
    expect(playInputsProblem(['mail'], { chips: [mail] })).toBeNull()
    expect(playInputsProblem(['file', 'text'], { chips: [doc], text: 'Due Friday' })).toBeNull()
    expect(playInputsProblem(['mail'], { chips: [mail, mail] })).toBe('it takes one mail')
    expect(playInputsProblem(['text'], { text: '   ' })).toBe('it takes a line of text')
    expect(playInputsProblem([], { chips: [mail] })).toBe('it takes no mail')
    expect(playInputsProblem([], { date: '2026-11-20' })).toBe('it takes no date')
  })

  it('are the takes in one order, each once', () => {
    const save = PlaysRequestSchemas.find((s) => s.shape.method.value === 'work.routines.playSave')!
    const parsed = save.parse({ method: 'work.routines.playSave', id: '1', params: { workspaceId: 'w', name: 'x', instructions: 'y', takes: ['text', 'mail', 'mail'] } }) as { params: { takes: string[] } }
    expect(parsed.params.takes).toEqual(['mail', 'text'])
  })
})

describe('the starters', () => {
  it('each have a key of their sector, a name used once in it, and takes a play can have', () => {
    const keys = new Set<string>()
    for (const [sector, starters] of Object.entries(STARTER_PLAYS)) {
      expect(new Set(starters.map((s) => s.name)).size).toBe(starters.length)
      for (const s of starters) {
        expect(s.key.startsWith(`${sector}.`)).toBe(true)
        expect(keys.has(s.key)).toBe(false)
        keys.add(s.key)
        expect(s.takes.every((t) => PLAY_TAKES.includes(t))).toBe(true)
        expect(s.instructions.length).toBeLessThan(1000)
      }
    }
    expect(Object.keys(STARTER_PLAYS).sort()).toEqual(['cosmic', 'hypixel', 'life', 'purdue', 'ref', 'unify'])
  })

  it('never ask a thread to send: they draft and leave the press to him', () => {
    for (const s of Object.values(STARTER_PLAYS).flat()) expect(s.instructions).not.toMatch(/\bsend (it|the)|\bpost it\b/i)
  })
})
