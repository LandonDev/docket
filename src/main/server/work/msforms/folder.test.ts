import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FilesListing } from '@shared/contract-work-files'
import { LIST_PAGE_MAX } from '@shared/work/files'
import { closeFilesState } from '../files/handle'
import { files } from '../files/index'
import { librariesHere } from '../files/places/libraries'
import { at, makeRig, window, WS, type Rig } from '../files/testkit'
import { formsRows } from './health'
import { ensureMsformsTables, MsformsStore } from './store'
import { FORM_A } from './testing'
import './folder'

/**
 * A library folder lists each Microsoft form made in it just before its answers workbook, across the pages of a long
 * listing; the workbook reads as the form's answers. And the form's row in Connections.
 */
describe("a library folder's Microsoft forms", () => {
  let rig: Rig
  const call = async <T,>(method: string, params: Record<string, unknown>): Promise<T> => {
    const out = await files.handle!({ id: '1', method, params: { workspaceId: WS, ...params } } as never, rig.ctx, window)
    return (out as { result: T }).result
  }
  const library = () => librariesHere(rig.ctx).find((l) => rig.team.startsWith(l.path))!
  const make = (formId: string, title: string, workbook: string | null, folder = 'General'): void => {
    const store = new MsformsStore(rig.db)
    const lib = library()
    const inside = join(rig.team, folder).slice(lib.path.length).split('/').filter(Boolean).join('/')
    store.create({ workspaceId: WS, formId, tenant: 'dummyu', sector: 'purdue', title, folder: { libraryId: lib.id, path: inside, siteUrl: 'https://dummyu.sharepoint.com/sites/Esports' }, madeBy: 'owner' })
    if (workbook) store.update(WS, formId, { workbook: { libraryId: lib.id, path: `${inside}/${workbook}`, siteUrl: 'https://dummyu.sharepoint.com/sites/Esports', uniqueId: 'u', parentId: 'p', name: workbook } })
  }
  beforeEach(() => {
    rig = makeRig()
    ensureMsformsTables(rig.db)
  })
  afterEach(() => {
    closeFilesState(rig.db)
    rig.close()
  })

  it('lists the form just before its workbook, which reads as its answers, and a form with none at the head of the files', async () => {
    writeFileSync(join(rig.team, 'General', 'Sign-ups.xlsx'), 'workbook')
    make(FORM_A, 'Spring sign-ups', 'Sign-ups.xlsx')
    make(`${FORM_A.slice(0, 40)}0002`, 'Draft survey', null)
    // another job's sector, and another folder: not listed here
    make(`${FORM_A.slice(0, 40)}0003`, 'In Events', null, 'Events')
    const got = await call<FilesListing>('work.files.list', { at: at(join(rig.team, 'General')), sort: { by: 'name', dir: 'asc' } })
    const names = got.entries.map((e) => e.name)
    const book = names.indexOf('Sign-ups.xlsx')
    expect(names[book - 1]).toBe('Spring sign-ups')
    expect(got.entries[book - 1]).toMatchObject({ kind: 'form', ref: { at: 'msform', workspaceId: WS, formId: FORM_A, tenant: 'dummyu' } })
    expect(got.entries[book]!.answersTo).toEqual({ title: 'Spring sign-ups', ref: { at: 'msform', host: rig.ctx.host, workspaceId: WS, formId: FORM_A, tenant: 'dummyu' } })
    const firstFile = got.entries.findIndex((e) => !e.folder)
    expect(names[firstFile]).toBe('Draft survey')
    expect(names).not.toContain('In Events')
    // A list of folders alone (Move to…) has none.
    const folders = await call<FilesListing>('work.files.list', { at: at(join(rig.team, 'General')), foldersOnly: true })
    expect(folders.entries.some((e) => e.kind === 'form')).toBe(false)
  })

  it('across the pages of a long listing: the form goes with its workbook\'s page, once', async () => {
    for (let i = 0; i < LIST_PAGE_MAX + 20; i++) writeFileSync(join(rig.team, 'General', `Row ${String(i).padStart(4, '0')}.txt`), 'x')
    writeFileSync(join(rig.team, 'General', 'zz Answers.xlsx'), 'workbook')
    make(FORM_A, 'Late form', 'zz Answers.xlsx')
    const sort = { by: 'name', dir: 'asc' }
    const one = await call<FilesListing>('work.files.list', { at: at(join(rig.team, 'General')), sort })
    expect(one.next).toBeTruthy()
    expect(one.entries.some((e) => e.kind === 'form')).toBe(false)
    const two = await call<FilesListing>('work.files.list', { at: at(join(rig.team, 'General')), sort, cursor: one.next })
    const names = two.entries.map((e) => e.name)
    expect(names.filter((n) => n === 'Late form')).toHaveLength(1)
    expect(names[names.indexOf('zz Answers.xlsx') - 1]).toBe('Late form')
  })
})

describe('the Microsoft Forms row in Connections', () => {
  let rig: Rig
  beforeEach(() => {
    rig = makeRig()
    ensureMsformsTables(rig.db)
  })
  afterEach(() => rig.close())

  it('is none on a host with no carrier', () => {
    expect(formsRows(rig.db, { carrier: false, signIn: true })).toEqual([])
  })

  it('says whom the last read saw, or that no form was read yet', () => {
    expect(formsRows(rig.db, { carrier: true, signIn: false })).toMatchObject([{ id: 'msforms.signIn', title: 'Microsoft Forms', state: 'working', line: 'No form read yet' }])
    const store = new MsformsStore(rig.db)
    store.create({ workspaceId: WS, formId: FORM_A, tenant: 't', sector: 'purdue', title: 'A', folder: { libraryId: 'l', path: '', siteUrl: '' }, madeBy: 'owner' })
    store.update(WS, FORM_A, { signedInAs: 'old@dummy.edu', readAt: 1 })
    const b = `${FORM_A.slice(0, 40)}0002`
    store.create({ workspaceId: WS, formId: b, tenant: 't', sector: 'purdue', title: 'B', folder: { libraryId: 'l', path: '', siteUrl: '' }, madeBy: 'owner' })
    store.update(WS, b, { signedInAs: 'lphale@dummy.edu', readAt: 2 })
    expect(formsRows(rig.db, { carrier: true, signIn: false })).toEqual([{ id: 'msforms.signIn', pillar: 'msforms', group: 'Browser', title: 'Microsoft Forms', state: 'working', line: 'Signed in as lphale@dummy.edu', personal: true }])
  })

  it("needs him when a read met Microsoft's sign-in, with the box browser's own fix", () => {
    expect(formsRows(rig.db, { carrier: true, signIn: true })).toMatchObject([{ state: 'needs-you', line: "Not signed in. Copy your Mac's logins to the box, or sign in from a thread's browser." }])
  })
})
