import { describe, expect, it } from 'vitest'
import type { TeamsLibrary } from '@shared/contract-work-office'
import { appOf, cloudKey, LIVE_FORMS, liveAddress, tenantOf } from './address'

const web = 'https://purdue0.sharepoint.com/sites/RecWell/Shared%20Documents'
const library = (over: Partial<TeamsLibrary> = {}): TeamsLibrary => ({
  id: 'env_mac~team', host: 'env_mac', path: '/sync/RecWell-TeamRecWell', team: 'RecWell-TeamRecWell',
  library: null, tenant: 'Purdue University', kind: 'library', channels: [], web: null, found: true, ...over
})
const vm = library({
  id: 'env_box~team', host: 'env_box', vm: true, path: 'C:\\Sync\\RecWell - Documents', team: 'RecWell',
  kind: 'channels', channels: ['Team RecWell'], web
})

describe('the live Office file address', () => {
  it('joins the VM mount namespace and encodes each file segment once', () => {
    expect(liveAddress(vm, `${vm.path}\\Team RecWell\\FY 26\\Plan #1%.docx`))
      .toEqual({ ok: true, url: `${web}/Team%20RecWell/FY%2026/Plan%20%231%25.docx?web=1` })
    expect(liveAddress(vm, `${vm.path}\\Café 東京 %20.xlsx`))
      .toEqual({ ok: true, url: `${web}/Caf%C3%A9%20%E6%9D%B1%E4%BA%AC%20%2520.xlsx?web=1` })
  })

  it('puts OneDrive’s namespace first, then the twin’s mount, then the settings folder', () => {
    const path = '/sync/RecWell-TeamRecWell/Budget.xlsx'
    const own = 'https://purdue0.sharepoint.com/sites/RecWell/Team%20RecWell'
    const saved = 'https://purdue0.sharepoint.com/sites/RecWell/Saved Folder/?from=files#top'
    expect(liveAddress(library({ web: own }), path, { libraries: [vm] })).toEqual({ ok: true, url: `${own}/Budget.xlsx?web=1` })
    expect(liveAddress(library(), path, { libraries: [vm] })).toEqual({ ok: true, url: `${web}/Team%20RecWell/Budget.xlsx?web=1` })
    expect(liveAddress(library({ web: saved.replace('purdue0', 'old-tenant'), webSource: 'settings' }), path, { libraries: [vm] }))
      .toEqual({ ok: true, url: `${web}/Team%20RecWell/Budget.xlsx?web=1` })
    expect(liveAddress(library({ web: saved, webSource: 'settings' }), path))
      .toEqual({ ok: true, url: 'https://purdue0.sharepoint.com/sites/RecWell/Saved%20Folder/Budget.xlsx?web=1' })
  })

  it('skips a twin with no usable namespace and a personal twin from another tenant', () => {
    const path = '/sync/RecWell-TeamRecWell/Budget.xlsx'
    const other = { ...vm, id: 'env_other~team', host: 'env_other' }
    expect(liveAddress(library(), path, { libraries: [{ ...vm, web: null }, other] })).toMatchObject({ ok: true })
    const mine = library({ kind: 'mine' })
    expect(liveAddress(mine, path, { libraries: [{ ...vm, kind: 'mine', tenant: 'Another University' }] })).toEqual({
      ok: false, why: 'Add the library’s web folder address in Settings.'
    })
  })

  it.each([
    ['/:f:/s/RecWell/SomeShare', 'sharing link'],
    ['/:w:/r/sites/RecWell/Document.docx', 'sharing link'],
    ['/%3Ax%3A/s/RecWell/SomeShare', 'sharing link'],
    ['/sites/RecWell/Shared%20Documents/Forms/AllItems.aspx?id=%2FRecWell', 'view page'],
    ['/sites/RecWell/AllItems.aspx', 'view page'],
    ['/sites/RecWell/Forms/folder', 'view page']
  ])('refuses the folder link %s with one reason', (pathname, why) => {
    expect(liveAddress(library({ web: 'https://purdue0.sharepoint.com' + pathname, webSource: 'settings' }), '/sync/RecWell-TeamRecWell/Plan.docx'))
      .toEqual({ ok: false, why: `Use the library’s folder address instead of a ${why}.` })
  })

  it.each([
    '/sync/RecWell-TeamRecWell-old/Plan.docx',
    '/sync/RecWell-TeamRecWell/../Plan.docx',
    '/Sync/RecWell-TeamRecWell/Plan.docx',
    '/sync/RecWell-TeamRecWell',
    'Plan.docx'
  ])('refuses the path %s outside the mount', (path) => {
    expect(liveAddress(library({ web }), path)).toEqual({ ok: false, why: 'The file is outside its synced library.' })
  })

  it('uses Windows separators, drive boundaries and case rules for a PC mount too', () => {
    const pc = { ...vm, vm: undefined }
    expect(liveAddress(pc, 'c:\\SYNC\\RECWELL - DOCUMENTS\\General\\Plan.docx', { platform: 'win32' }))
      .toEqual({ ok: true, url: `${web}/General/Plan.docx?web=1` })
    for (const path of ['D:\\Sync\\RecWell - Documents\\Plan.docx', 'C:\\Sync\\RecWell - Documents-old\\Plan.docx', 'C:\\Sync\\RecWell - Documents\\..\\Plan.docx']) {
      expect(liveAddress(pc, path, { platform: 'win32' })).toMatchObject({ ok: false })
    }
    expect(liveAddress(library({ web }), '/sync/RecWell-TeamRecWell/Legal\\Name.docx'))
      .toEqual({ ok: true, url: `${web}/Legal%5CName.docx?web=1` })
  })

  it('reproduces the direct address for the dummy used in the OneDrive trial', () => {
    const mine = { ...vm, kind: 'mine' as const, web: 'https://purdue0-my.sharepoint.com/personal/<upn>/Documents'.replace('<upn>', 'owner_purdue_edu') }
    expect(liveAddress(mine, `${mine.path}\\TempCode proof live 1.docx`)).toEqual({
      ok: true, url: 'https://purdue0-my.sharepoint.com/personal/owner_purdue_edu/Documents/TempCode%20proof%20live%201.docx?web=1'
    })
  })
})

describe('the file’s cloud identity', () => {
  it('agrees across the trial’s direct and routed forms, host case, and equivalent escapes', () => {
    const path = '/personal/owner_purdue_edu/Documents/TempCode%20proof%20live%201.docx'
    const direct = `https://purdue0-my.sharepoint.com${path}?web=1`
    const key = 'purdue0-my.sharepoint.com/personal/owner_purdue_edu/Documents/TempCode proof live 1.docx'
    expect(cloudKey(direct)).toBe(key)
    expect(cloudKey(`https://purdue0-my.sharepoint.com/:w:/r${path}?web=1`)).toBe(key)
    expect(cloudKey(`https://PURDUE0-MY.SHAREPOINT.COM${path.replace('TempCode', '%54empCode')}/?x=2#editor`)).toBe(key)
    for (const route of ['x', 'p']) expect(cloudKey(`https://purdue0-my.sharepoint.com/:${route}:/r${path}`)).toBe(key)
    expect(cloudKey('bad url')).toBeNull()
  })

  it('leaves a GUID redirect without a path key', () => {
    expect(cloudKey('https://purdue0-my.sharepoint.com/:w:/r/personal/owner_purdue_edu/_layouts/15/Doc.aspx?sourcedoc=%7Bac1d9a30%7D&action=edit')).toBeNull()
  })

  it('takes a tenant only from the SharePoint host', () => {
    expect(tenantOf('https://purdue0-my.sharepoint.com/personal/example')).toBe('purdue0')
    expect(tenantOf('https://PURDUE0.sharepoint.com/sites/RecWell')).toBe('purdue0')
    expect(tenantOf('https://test-tenant-my.sharepoint.com/')).toBe('test-tenant')
    expect(tenantOf('https://purdue0.sharepoint.com.example.net/')).toBeNull()
    expect(tenantOf('not a URL')).toBeNull()
  })

  it('uses the four live forms and their apps', () => {
    expect(LIVE_FORMS).toEqual(['docx', 'xlsx', 'xlsm', 'pptx'])
    expect(['Plan.DOCX', 'Budget.xlsx', 'Macro.xlsm', 'Slides.pptx', 'Old.xls', 'Plan.docm', 'notes.txt'].map(appOf))
      .toEqual(['word', 'excel', 'excel', 'powerpoint', null, null, null])
  })
})

describe('cloudKey on a page that names its file in the query', () => {
  it('gives no key, so two files there never meet as one', () => {
    expect(cloudKey('https://purdue0.sharepoint.com/sites/RecWell/_layouts/15/WopiFrame.aspx?sourcedoc=%7Ba%7D')).toBeNull()
    expect(cloudKey('https://purdue0.sharepoint.com/sites/RecWell/_layouts/15/WopiFrame.aspx?sourcedoc=%7Bb%7D')).toBeNull()
    expect(cloudKey('https://onedrive.live.com/edit.aspx?resid=ABC!123')).toBeNull()
    expect(cloudKey('https://purdue0.sharepoint.com/sites/RecWell/Shared%20Documents/Team%20RecWell')).toBe('purdue0.sharepoint.com/sites/RecWell/Shared Documents/Team RecWell')
  })
})
