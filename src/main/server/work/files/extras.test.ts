import { describe, expect, it } from 'vitest'
import type { FileEntry } from '@shared/work/files'
import { placeExtras } from './extras'
import type { FolderExtra } from './hooks'

/** A pillar's rows in a page of a library folder: before the file each names, else at the head of the first page's files. */
const file = (name: string): FileEntry => ({ key: `k:${name}`, ref: { at: 'file', host: 'h', path: `/lib/${name}` }, folder: null, name, kind: 'sheet' })
const dir = (name: string): FileEntry => ({ key: `k:${name}`, ref: null, folder: { at: 'file', host: 'h', path: `/lib/${name}` }, name, kind: 'folder' })
const form = (title: string, before: string | null): FolderExtra => {
  const ref = { at: 'msform' as const, host: 'h', workspaceId: 'w1', formId: `${title}-id`, tenant: 't' }
  return { entry: { key: `msform:${title}`, ref, folder: null, name: title, kind: 'form' }, before, ...(before ? { answersTo: { title, ref } } : {}) }
}
const names = (entries: FileEntry[]): string[] => entries.map((e) => e.name)

describe('rows a pillar adds to a folder', () => {
  it('go just before the file each names, which takes its words, on the page that holds it', () => {
    const page = [dir('Events'), file('Budget.xlsx'), file('Sign-ups.xlsx'), file('Zeta.xlsx')]
    const got = placeExtras(page, [form('Sign-ups', 'sign-ups.XLSX')], { first: true, inFolder: () => true })
    expect(names(got)).toEqual(['Events', 'Budget.xlsx', 'Sign-ups', 'Sign-ups.xlsx', 'Zeta.xlsx'])
    expect(got[3]!.answersTo?.title).toBe('Sign-ups')
    expect(got[1]!.answersTo).toBeUndefined()
  })

  it('wait for the page that holds their file, and never show twice', () => {
    const extras = [form('Sign-ups', 'Sign-ups.xlsx')]
    const one = placeExtras([file('A.xlsx'), file('B.xlsx')], extras, { first: true, inFolder: () => true })
    const two = placeExtras([file('Sign-ups.xlsx'), file('Z.xlsx')], extras, { first: false, inFolder: () => true })
    expect(names(one)).toEqual(['A.xlsx', 'B.xlsx'])
    expect(names(two)).toEqual(['Sign-ups', 'Sign-ups.xlsx', 'Z.xlsx'])
  })

  it('with no file, or one the folder does not hold, go at the head of the first page\'s files', () => {
    const extras = [form('Draft', null), form('Moved', 'Gone.xlsx')]
    const first = placeExtras([dir('Events'), file('A.xlsx')], extras, { first: true, inFolder: (n) => n !== 'Gone.xlsx' })
    expect(names(first)).toEqual(['Events', 'Draft', 'Moved', 'A.xlsx'])
    expect(names(placeExtras([file('B.xlsx')], extras, { first: false, inFolder: () => false }))).toEqual(['B.xlsx'])
    expect(names(placeExtras([dir('Events')], extras, { first: true, inFolder: () => false }))).toEqual(['Events', 'Draft', 'Moved'])
  })
})
