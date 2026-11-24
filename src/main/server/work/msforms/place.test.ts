import { describe, expect, it } from 'vitest'
import { folderPageOf } from './place'

/** The folder's page the carrier opens to press Create or upload, for a Team library and for his OneDrive. */
describe("a folder's page", () => {
  it("is the library's AllItems view on a Team site", () => {
    const folder = { libraryId: 'lib', path: 'Sport Programs/Esports', siteUrl: 'https://dummyu.sharepoint.com/sites/RecWell', label: 'RecWell' }
    expect(folderPageOf(folder, 'https://dummyu.sharepoint.com/sites/RecWell/Shared Documents/')).toBe(
      'https://dummyu.sharepoint.com/sites/RecWell/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FRecWell%2FShared%20Documents%2FSport%20Programs%2FEsports'
    )
  })

  it("is OneDrive's own folder page on a personal site, where AllItems.aspx answers 404 (P5)", () => {
    const folder = { libraryId: 'mine', path: 'TempCode proof', siteUrl: 'https://dummyu-my.sharepoint.com/personal/someone_dummyu_edu', label: 'My files' }
    expect(folderPageOf(folder, 'https://dummyu-my.sharepoint.com/personal/someone_dummyu_edu/Documents/')).toBe(
      'https://dummyu-my.sharepoint.com/personal/someone_dummyu_edu/_layouts/15/onedrive.aspx?id=%2Fpersonal%2Fsomeone_dummyu_edu%2FDocuments%2FTempCode%20proof'
    )
  })
})
