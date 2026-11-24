import { describe, expect, it } from 'vitest'
import type { CarrierComputer } from '../../browser/box'
import { formsComputerOn } from './wire'

/** The carrier's computer on the box browser: which window an open takes (P1, 2026-11-24). */

const calls: { tool: string; args: Record<string, unknown> }[] = []
function fakeComputer(pages: { window: number; url: string }[], launch: (url: string) => void, fail = false): CarrierComputer {
  return {
    session: 'tc-carrier-test',
    run: async (tool, args) => {
      calls.push({ tool, args })
      if (tool === 'computer_apps') launch((args.open as string[])[0]!)
      return fail ? { steps: [], shots: [], body: 'answer: Zorble-7Q from dummy1@example.test', isError: true } : { steps: [], shots: [], body: 'ok', isError: false }
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

  it('asks for no picture of a page it reads or acts on, and says no word of the page when it fails (review 21)', async () => {
    calls.length = 0
    const c = formsComputerOn(fakeComputer([{ window: 1, url: 'https://forms.cloud.microsoft/x' }], () => {}, true))
    await expect(c.read('#1')).rejects.toThrow(/^The box browser could not read the page\.$/)
    const acted = await c.act('#1', { elements: new Map() } as never, [{ action: 'left_click', element: 3 } as never])
    expect(acted).toEqual({ ok: false })
    await c.act('#1', { elements: new Map() } as never, [{ action: 'left_click', element: 3 } as never, { action: 'key', element: 3, text: 'Tab' } as never])
    expect(calls.map((x) => [x.tool, x.args.screenshot])).toEqual([
      ['computer_observe', false],
      ['computer_act', false],
      ['computer_batch', false]
    ])
  })
})
