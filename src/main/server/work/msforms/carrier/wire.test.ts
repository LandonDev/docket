import { describe, expect, it } from 'vitest'
import type { CarrierComputer } from '../../browser/box'
import { formsComputerOn } from './wire'

/**
 * The carrier's page-open on the box browser as the deployed host met it: a browser already running with other
 * pages, a browser not started yet (it starts with one blank page the launch navigates), and a service that started
 * again between the carrier's two lists and numbered its windows afresh. Each must answer the page the open made.
 */

type Page = { window: number; url: string; target: string; opener?: string }

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
    expect(await formsComputerOn(c).open(URL_)).toBe('t:T-new')
  })

  it('finds the blank page the launch navigated, once its address commits after the launch answered', async () => {
    const blank = { window: 1, url: 'about:blank', target: 'T-blank' }
    let looks = 0
    const c = computer({ before: [blank], launch: () => {}, after: () => (++looks < 3 ? [blank] : [{ ...blank, url: `${URL_}&view=1` }]) })
    expect(await formsComputerOn(c).open(URL_)).toBe('t:T-blank')
  })

  it('finds the page on a browser not started yet', async () => {
    const c = computer({ before: [], launch: () => {}, after: () => [{ window: 1, url: URL_, target: 'T-first' }] })
    expect(await formsComputerOn(c).open(URL_)).toBe('t:T-first')
  })

  it('finds the page when the service started again between its two lists and numbered windows afresh', async () => {
    // Before: the Outlook page is window 1. After a restart the service numbers the new page 1 and Outlook 2:
    // matched by number, window 1 looked old; matched by Chromium's own id, the new page is found.
    const outlook = { window: 1, url: 'https://outlook.office.com/mail/', target: 'T-outlook' }
    const c = computer({ before: [outlook], launch: () => {}, after: () => [{ window: 1, url: URL_, target: 'T-new' }, { ...outlook, window: 2 }] })
    expect(await formsComputerOn(c).open(URL_)).toBe('t:T-new')
  })
})

/** A stand-in that answers each observe with a page at `address`, and records every call it ran. */
function driven(pages: () => Page[]) {
  const calls: { tool: string; window: unknown }[] = []
  let reads = 0
  const c: CarrierComputer = {
    session: 'carrier-test',
    run: async (tool, args) => {
      calls.push({ tool, window: args.window })
      if (tool === 'computer_observe') {
        const n = ++reads
        return { isError: false, body: `app "Chromium" · window "Form" · 1280×800\n[${n * 10 + 1}] window "Form"\n  [${n * 10 + 2}] button "Settings"`, steps: [], shots: [] } as never
      }
      return { isError: false, body: '', steps: [], shots: [] } as never
    },
    window: () => null,
    end: async () => undefined,
    pages: async () => pages(),
    close: async () => undefined,
    fetch: async () => ({ status: 200 }),
    clear: async () => undefined
  }
  return { c, calls }
}
const press = (element: number) => [{ action: 'left_click', element }] as never

describe("the carrier's steps on the page its open made (review 16)", () => {
  it('reads and acts on that page by its target, whatever number the service gives it now', async () => {
    let now: Page[] = [{ window: 2, url: URL_, target: 'T-made' }]
    const { c, calls } = driven(() => now)
    const forms = formsComputerOn(c)
    const s = await forms.read('t:T-made')
    // the service started again and numbered the page 7
    now = [{ window: 3, url: 'https://outlook.office.com/mail/', target: 'T-other' }, { window: 7, url: URL_, target: 'T-made' }]
    const again = await forms.read('t:T-made')
    expect((await forms.act('t:T-made', again, press(22))).ok).toBe(true)
    expect(calls.map((x) => `${x.tool} ${x.window}`)).toEqual(['computer_observe #2', 'computer_observe #7', 'computer_act #7'])
    void s
  })

  it('drives no page once the one it opened is gone', async () => {
    let now: Page[] = [{ window: 2, url: URL_, target: 'T-made' }]
    const { c, calls } = driven(() => now)
    const forms = formsComputerOn(c)
    const s = await forms.read('t:T-made')
    now = [{ window: 2, url: 'https://outlook.office.com/mail/', target: 'T-other' }]
    await expect(forms.act('t:T-made', s, press(12))).rejects.toThrow('page the carrier opened')
    await expect(forms.read('t:T-made')).rejects.toThrow('page the carrier opened')
    expect(calls.filter((x) => x.tool !== 'computer_observe')).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('acts only on the read it checked: not an older read, not a read of another page, never twice', async () => {
    const now: Page[] = [{ window: 2, url: URL_, target: 'T-made' }, { window: 3, url: URL_, target: 'T-two' }]
    const { c, calls } = driven(() => now)
    const forms = formsComputerOn(c)
    const first = await forms.read('t:T-made')
    const second = await forms.read('t:T-made')
    await expect(forms.act('t:T-made', first, press(12))).rejects.toThrow('the read it checked')
    const other = await forms.read('t:T-two')
    await expect(forms.act('t:T-made', other, press(32))).rejects.toThrow('the read it checked')
    expect((await forms.act('t:T-made', second, press(22))).ok).toBe(true)
    await expect(forms.act('t:T-made', second, press(22))).rejects.toThrow('the read it checked')
    expect(calls.filter((x) => x.tool === 'computer_act')).toHaveLength(1)
  })

  it('says which page opened each window', async () => {
    const { c } = driven(() => [{ window: 1, url: URL_, target: 'T-folder' }, { window: 2, url: 'https://forms.cloud.microsoft/Pages/DesignPageV2.aspx?id=x', target: 'T-pop', opener: 'T-folder' }])
    expect(await formsComputerOn(c).windows()).toEqual([
      { id: 't:T-folder', url: URL_ },
      { id: 't:T-pop', url: 'https://forms.cloud.microsoft/Pages/DesignPageV2.aspx?id=x', opener: 't:T-folder' }
    ])
  })
})
