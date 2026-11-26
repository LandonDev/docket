import { describe, expect, it } from 'vitest'
import { windowGate } from './windowGate'

describe('the window gate', () => {
  it('holds a Dock click or New Window made before the walls are up, then runs each once, in order', () => {
    const gate = windowGate()
    const made: string[] = []
    gate.run(() => made.push('dock click'))
    gate.run(() => made.push('new window'))
    expect(made).toEqual([])
    gate.open()
    expect(made).toEqual(['dock click', 'new window'])
    gate.open()
    expect(made).toEqual(['dock click', 'new window'])
    gate.run(() => made.push('later'))
    expect(made).toEqual(['dock click', 'new window', 'later'])
  })
})
