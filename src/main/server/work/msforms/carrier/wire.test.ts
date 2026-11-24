import { describe, expect, it } from 'vitest'
import type { CarrierComputer } from '../../browser/box'
import { formsComputerOn } from './wire'

/** The carrier's computer on the box browser: which window an open takes (P1, 2026-11-24). */

function fakeComputer(pages: { window: number; url: string }[], launch: (url: string) => void): CarrierComputer {
  return {
    session: 'tc-carrier-test',
    run: async (tool, args) => {
      if (tool === 'computer_apps') launch((args.open as string[])[0]!)
      return { steps: [], shots: [], body: 'ok', isError: false }
    },
    window: () => null,
    end: async () => {},
    pages: async () => pages.map((p) => ({ ...p })),
    close: async () => {},
    fetch: async () => ({ status: 200 }),
    clear: async () => {}
  }
}

describe('formsComputerOn', () => {
  it('takes the new window an open made', async () => {
    const pages = [{ window: 1, url: 'https://purdue0.sharepoint.com/x' }]
    const c = formsComputerOn(fakeComputer(pages, (url) => pages.push({ window: 2, url })))
    expect(await c.open('https://purdue0.sharepoint.com/y')).toBe('#2')
  })

  it("takes the blank page the launch navigated, once its address has moved off about:blank", async () => {
    const pages = [{ window: 1, url: 'about:blank' }]
    // the box browser starts with one blank page, and a launch uses it; the address commits a moment later
    const c = formsComputerOn(fakeComputer(pages, (url) => void setTimeout(() => (pages[0]!.url = url), 300)))
    expect(await c.open('https://purdue0.sharepoint.com/y')).toBe('#1')
  })
})
