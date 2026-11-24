import { describe, expect, it } from 'vitest'
import { screenOfObservation } from '@shared/computer/outward'
import { docIdOf, libraryRootOf, pullWorkbook } from './pull'
import { Page, type FormsComputer } from './steps'
import { CarrierStop, type PullAsk } from './types'

/** The pull (pull.ts): the workbook bound by the document id of the Excel window Forms opened, its place checked before and after the wait (review 3, P1). */

const DOC = '58e96313-70b2-4743-8a68-7cc1e71fb62d'
const SITE = 'https://purdue0.sharepoint.com/sites/RecWell'
const RESULTS = screenOfObservation('app "Chromium" · window "Forms" · 1280×800\n[1] group "1 responses"\n[2] button "Open results in Excel"\n[3] button "Open results in Excel"', { bundleId: 'org.chromium.Chromium', name: 'Chromium' })!

function rig(o: { paths: string[]; excel?: string | null; uniqueId?: string | null }) {
  const windows: { id: string; url: string }[] = [{ id: '#1', url: 'https://forms.cloud.microsoft/Pages/DesignPageV2.aspx?analysis=true' }]
  let n = 0
  const computer: FormsComputer = {
    open: async (url) => (windows.push({ id: `#${windows.length + 1}`, url }), `#${windows.length}`),
    read: async () => RESULTS,
    act: async () => {
      if (o.excel !== null) windows.push({ id: '#9', url: o.excel ?? `${SITE}/_layouts/15/Doc.aspx?sourcedoc=%7B${DOC.toUpperCase()}%7D&file=TempCode%20proof%20make.xlsx&action=edit` })
      return { ok: true }
    },
    windows: async () => windows,
    close: async () => {},
    wait: async () => {},
    fetch: async (_w, url, f) => {
      if (url.includes('GetFolderByServerRelativeUrl')) return { status: 200, json: { UniqueId: 'parent-1' } }
      if (f?.bytes) return { status: 200, bytes: new Uint8Array([1, 2, 3]) }
      // each read of the file's facts takes the next path the test lists; the last stays
      const path = o.paths[Math.min(n++, o.paths.length - 1)]!
      return { status: 200, json: { UniqueId: DOC, Name: 'TempCode proof make.xlsx', ServerRelativeUrl: path, TimeLastModified: '2026-11-24T20:23:11Z' } }
    }
  }
  const ask: PullAsk = { siteUrl: SITE, folderServerPath: '/sites/RecWell/Shared Documents/TempCode proof folder', uniqueId: o.uniqueId ?? null, name: 'TempCode proof make.xlsx', lastModified: null }
  const run = () => pullWorkbook({ computer, mount: 0, openResponses: async () => new Page(computer, '#1', 'pull', 'F1'), timing: { still: 0, noMove: 0, every: 0 } }, 'F1', ask)
  return { run }
}

describe('the pull', () => {
  it('reads the document id from Excel for the web’s address, and a library’s root from a folder', () => {
    expect(docIdOf(`${SITE}/_layouts/15/Doc.aspx?sourcedoc={58E96313-70B2-4743-8A68-7CC1E71FB62D}&file=x.xlsx`)).toBe(DOC)
    expect(docIdOf(`${SITE}/_layouts/15/Doc.aspx?sourcedoc=%7B58E96313-70B2-4743-8A68-7CC1E71FB62D%7D`)).toBe(DOC)
    expect(docIdOf(`${SITE}/_layouts/15/Doc.aspx?file=x.xlsx`)).toBeNull()
    expect(libraryRootOf('/sites/RecWell/Shared Documents/TempCode proof folder')).toBe('/sites/RecWell/Shared Documents')
  })

  it("binds the workbook Forms opened, at the Team library's root or in the folder", async () => {
    const atRoot = await rig({ paths: ['/sites/RecWell/Shared Documents/TempCode proof make.xlsx'] }).run()
    expect(atRoot).toMatchObject({ workbook: { uniqueId: DOC, parentId: 'parent-1', serverPath: '/sites/RecWell/Shared Documents/TempCode proof make.xlsx' } })
    expect(await rig({ paths: ['/sites/RecWell/Shared Documents/TempCode proof folder/TempCode proof make.xlsx'] }).run()).toMatchObject({ workbook: { uniqueId: DOC } })
  })

  it('stops with no Excel window, a window that names no document, another form’s workbook, or a move during the wait', async () => {
    await expect(rig({ paths: ['/sites/RecWell/Shared Documents/x.xlsx'], excel: null }).run()).rejects.toThrow('Excel for the web did not open the workbook')
    await expect(rig({ paths: ['/sites/RecWell/Shared Documents/x.xlsx'], excel: `${SITE}/_layouts/15/Doc.aspx?file=x.xlsx` }).run()).rejects.toThrow('named no document')
    await expect(rig({ paths: ['/sites/RecWell/Shared Documents/x.xlsx'], uniqueId: 'fce429aa-7efc-4bac-93c5-6219e85183f4' }).run()).rejects.toThrow('not the one this form keeps')
    const moved = rig({ paths: ['/sites/RecWell/Shared Documents/TempCode proof make.xlsx', '/sites/RecWell/Shared Documents/Other/TempCode proof make.xlsx'] }).run()
    await expect(moved).rejects.toBeInstanceOf(CarrierStop)
    await expect(rig({ paths: ['/sites/Other/Shared Documents/TempCode proof make.xlsx'] }).run()).rejects.toThrow('it was moved or is another file')
  })
})
