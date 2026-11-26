import { describe, expect, it } from 'vitest'
import { openSavedThenGate, windowGate } from './windowGate'

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

describe('the boot opening its saved windows', () => {
  it('a Dock click and a New Window held before the walls make the saved windows plus one new one, each slot once', () => {
    // windows.ts in small: the state file's slots, and a window per slot opened
    const saved = ['main', 'w2']
    const opened: string[] = []
    let fresh = 0
    const openSavedWindows = (): void => {
      for (const slot of [...saved]) opened.push(slot)
    }
    const createWindow = (): void => {
      const slot = `new${++fresh}`
      saved.push(slot)
      opened.push(slot)
    }
    // activateWindows: with no window, the saved ones come back; else one is brought forward
    const activateWindows = (): void => {
      if (opened.length === 0) openSavedWindows()
    }
    const gate = windowGate()
    gate.run(activateWindows)
    gate.run(createWindow)
    openSavedThenGate(gate, openSavedWindows)
    expect(opened).toEqual(['main', 'w2', 'new1'])
    expect(new Set(opened).size).toBe(opened.length)
  })
})

