import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { FileEntry } from '@shared/work/files'
import { ensureGuestTables, fileLinkId, guestsPresentIn, setGuestsPresent, whoWords } from '../guests/store'
import type { WorkCtx } from '../modules'
import { withPresent } from './present'

const file = (path: string, more: Partial<FileEntry> = {}): FileEntry => ({ name: path.split('/').pop()!, kind: 'document', ref: { at: 'file', host: 'env_box', path }, ...more }) as FileEntry

describe('a Files row says which guest is in the file', () => {
  const db = new DatabaseSync(':memory:')
  ensureGuestTables(db)
  const ctx = { db, host: 'env_box' } as unknown as WorkCtx
  const link = (path: string, name: string, open: number) => ({ source: { at: 'file', id: fileLinkId(path) }, name, open })

  it('says one guest by name, two by both, more by a count', () => {
    expect(whoWords(['Dana Lee'])).toBe('Dana Lee')
    expect(whoWords(['Dana Lee', 'Sam Ito'])).toBe('Dana Lee and Sam Ito')
    expect(whoWords(['Dana Lee', 'Sam Ito', 'Kim Park', 'Jo Reed'])).toBe('Dana Lee and 3 others')
    expect(whoWords([])).toBe('')
  })

  it('a document or sheet of ours with a guest in it reads "<name> is in it"; one with nobody in it, another host\'s, a folder and a Word file say nothing', () => {
    setGuestsPresent(db, [link('/work/Plan.tcdoc', 'Dana Lee', 1), link('/work/Budget.tcsheet', 'Sam Ito', 2), link('/work/Budget.tcsheet', 'Kim Park', 1), link('/work/Quiet.tcdoc', 'Jo Reed', 0), { source: { at: 'lifeos', id: 'kdoc1' }, name: 'Avery', open: 3 }])
    const rows = withPresent(ctx, [
      file('/work/Plan.tcdoc'),
      file('/work/Budget.tcsheet', { kind: 'sheet' }),
      file('/work/Quiet.tcdoc'),
      { ...file('/work/Plan.tcdoc'), ref: { at: 'file', host: 'env_mac', path: '/work/Plan.tcdoc' } } as FileEntry,
      file('/work/Trips', { kind: 'folder', folder: { at: 'file', host: 'env_box', path: '/work/Trips' } }),
      file('/work/Letter.docx')
    ])
    expect(rows.map((r) => r.state)).toEqual([{ is: 'present', who: 'Dana Lee' }, { is: 'present', who: 'Sam Ito and Kim Park' }, undefined, undefined, undefined, undefined])
    expect(guestsPresentIn(db, '/work/Plan.tcdoc')).toBe('Dana Lee')
  })

  it('a row that already shows a state keeps it (one state a row), and when nobody is in anything the list is handed back as it came', () => {
    setGuestsPresent(db, [link('/work/Plan.tcdoc', 'Dana Lee', 1)])
    const waiting = file('/work/Plan.tcdoc', { state: { is: 'suggestions', count: 2 } })
    expect(withPresent(ctx, [waiting])[0]!.state).toEqual({ is: 'suggestions', count: 2 })
    setGuestsPresent(db, [])
    const list = [file('/work/Plan.tcdoc')]
    expect(withPresent(ctx, list)).toBe(list)
  })
})
