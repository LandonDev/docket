import { describe, expect, it } from 'vitest'
import { revealView } from './more'
import type { Window } from './window'

/**
 * A /ui page whose job column draws a little after the rail press: no More row at first, then the fold, closed;
 * pressing it shows Files under it. The walk must find the fold once it is drawn, not only on its first look.
 */
function column(drawnAfter: number) {
  let looks = 0
  let open = false
  let presses = 0
  const page = {
    centre: async (selector: string, text?: string) => {
      looks++
      if (looks <= drawnAfter) return null
      if (selector.includes('data-more-fold')) return open ? null : { x: 10, y: 190 }
      return text === 'Files' && open ? { x: 10, y: 220 } : null
    },
    click: async () => {
      presses++
      open = true
    },
    until: async (label: string, ms: number, test: () => unknown) => {
      const end = Date.now() + ms
      while (Date.now() < end) if (await test()) return
      throw new Error(`Timed out waiting for ${label}`)
    }
  }
  return { page: page as unknown as Window, presses: () => presses }
}

describe('revealView', () => {
  it('opens the More fold once the column has drawn it, then finds the view under it', async () => {
    const c = column(5)
    await revealView(c.page, 'button', 'Files')
    expect(c.presses()).toBe(1)
  })

  it('presses nothing when the view is already there', async () => {
    const c = column(0)
    await c.page.click({ x: 0, y: 0 })
    await revealView(c.page, 'button', 'Files')
    expect(c.presses()).toBe(1)
  })
})
