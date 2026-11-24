import { describe, expect, it } from 'vitest'
import type { CarrierComputer } from '../../browser/box'
import { formsComputerOn } from './wire'

/**
 * The carrier's page-open on the box browser as the deployed host met it: a browser already running with other
 * pages, a browser not started yet (it starts with one blank page the launch navigates), and a service that started
 * again between the carrier's two lists and numbered its windows afresh. Each must answer the page the open made.
 */

type Page = { window: number; url: string; target: string }

/** A stand-in for the box browser's carrier session: `pages` answers what the script says at each look. */
function computer(script: { before: Page[]; launch(): void; after: () => Page[] }): CarrierComputer {
  let launched = false
  return {
    session: 'carrier-test',
    run: async (tool) => {
      if (tool === 'computer_apps') {
        launched = true
        script.launch()
      }
      return { isError: false, body: '', steps: [], shots: [] } as never
    },
    window: () => null,
    end: async () => undefined,
    pages: async () => (launched ? script.after() : script.before),
    close: async () => undefined,
    fetch: async () => ({ status: 200 }),
    clear: async () => undefined
  }
}

const URL_ = 'https://purdue0.sharepoint.com/sites/RecWell/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FRecWell%2FShared%20Documents%2FEsports'

describe("the carrier's page-open", () => {
  it('finds the new page on a browser already running with other pages', async () => {
    const outlook = { window: 1, url: 'https://outlook.office.com/mail/', target: 'T-outlook' }
    const c = computer({ before: [outlook], launch: () => {}, after: () => [outlook, { window: 2, url: URL_, target: 'T-new' }] })
    expect(await formsComputerOn(c).open(URL_)).toBe('#2')
  })

  it('finds the blank page the launch navigated, once its address commits after the launch answered', async () => {
    const blank = { window: 1, url: 'about:blank', target: 'T-blank' }
    let looks = 0
    const c = computer({ before: [blank], launch: () => {}, after: () => (++looks < 3 ? [blank] : [{ ...blank, url: `${URL_}&view=1` }]) })
    expect(await formsComputerOn(c).open(URL_)).toBe('#1')
  })

  it('finds the page on a browser not started yet', async () => {
    const c = computer({ before: [], launch: () => {}, after: () => [{ window: 1, url: URL_, target: 'T-first' }] })
    expect(await formsComputerOn(c).open(URL_)).toBe('#1')
  })

  it('finds the page when the service started again between its two lists and numbered windows afresh', async () => {
    // Before: the Outlook page is window 1. After a restart the service numbers the new page 1 and Outlook 2:
    // matched by number, window 1 looked old; matched by Chromium's own id, the new page is found.
    const outlook = { window: 1, url: 'https://outlook.office.com/mail/', target: 'T-outlook' }
    const c = computer({ before: [outlook], launch: () => {}, after: () => [{ window: 1, url: URL_, target: 'T-new' }, { ...outlook, window: 2 }] })
    expect(await formsComputerOn(c).open(URL_)).toBe('#1')
  })
})
