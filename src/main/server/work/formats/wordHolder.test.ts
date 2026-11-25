import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { TeamsLibrary } from '@shared/contract-work-office'
import { ensureFilesTables } from '../files/tables'
import { renderPlaceHere, wordCheckRefusal, wordHolderOf, type WordHolder } from './wordHolder'

/** Check in Word on a Teams Word file: only the computer that holds it, in a tenant it is signed in to (decision 17). */
const lib = (over: Partial<TeamsLibrary>): TeamsLibrary =>
  ({ id: 'l', host: 'env_box', path: '', team: 'RecWell', library: null, tenant: 'Purdue University', kind: 'channels', channels: [], web: null, found: true, ...over }) as TeamsLibrary

const VM_LIBS = [
  lib({ path: 'C:\\Users\\tcuser\\Purdue University\\RecWell - Documents', vm: true }),
  lib({ path: 'C:\\Users\\tcuser\\OneDrive - Purdue University', kind: 'mine', vm: true })
]
const MAC_LIBS = [
  lib({ host: 'env_mac', path: '/Users/him/Library/CloudStorage/OneDrive-SharedLibraries-PurdueUniversity/RecWell - Documents' }),
  lib({ host: 'env_mac', path: '/Users/him/Library/CloudStorage/OneDrive-PurdueUniversity', kind: 'mine' })
]
const inVm: WordHolder = { host: 'env_box', vm: true, path: 'C:\\Users\\tcuser\\Purdue University\\RecWell - Documents\\Plan.docx' }
const onMac: WordHolder = { host: 'env_mac', vm: false, path: '/Users/him/Library/CloudStorage/OneDrive-SharedLibraries-PurdueUniversity/RecWell - Documents/Plan.docx' }

describe('who may draw a Teams Word file in Word', () => {
  it('the Windows VM, for a file of a VM library, in a tenant the VM is signed in to', () => {
    expect(wordCheckRefusal(inVm, { host: 'env_box', place: 'vm' }, VM_LIBS)).toBeNull()
    // The tenant is matched as OneDrive spells it, whatever the case.
    expect(wordCheckRefusal(inVm, { host: 'env_box', place: 'vm' }, [VM_LIBS[0]!, lib({ ...VM_LIBS[1], tenant: 'purdue university' })])).toBeNull()
  })

  it('his Mac, for a file of its own library: the holder is the renderer', () => {
    expect(wordCheckRefusal(onMac, { host: 'env_mac', place: 'mac' }, MAC_LIBS)).toBeNull()
  })

  it('never another host, and never a renderer that is not the holder: the box and its VM are two computers', () => {
    expect(wordCheckRefusal(onMac, { host: 'env_box', place: 'vm' }, VM_LIBS)).toBe('held by another host')
    expect(wordCheckRefusal({ ...onMac, host: 'env_box' }, { host: 'env_box', place: 'vm' }, MAC_LIBS)).toMatch(/not this host's/)
    expect(wordCheckRefusal({ ...inVm, host: 'env_mac' }, { host: 'env_mac', place: 'mac' }, VM_LIBS)).toMatch(/does not draw with/)
  })

  it('never a file in no listed library, of no known tenant, or in a tenant the holder is not signed in to', () => {
    expect(wordCheckRefusal(null, { host: 'env_box', place: 'vm' }, VM_LIBS)).toBe('not a Word file of a library')
    expect(wordCheckRefusal({ ...inVm, path: 'C:\\Users\\tcuser\\Desktop\\Plan.docx' }, { host: 'env_box', place: 'vm' }, VM_LIBS)).toBe('in no library the holder lists')
    expect(wordCheckRefusal(inVm, { host: 'env_box', place: 'vm' }, [lib({ ...VM_LIBS[0], tenant: null }), VM_LIBS[1]!])).toBe('in a library of no known tenant')
    expect(wordCheckRefusal(inVm, { host: 'env_box', place: 'vm' }, [VM_LIBS[0]!, lib({ ...VM_LIBS[1], tenant: 'Hypixel Inc' })])).toBe('the holder is not signed in to Purdue University')
    // His own OneDrive of that tenant on another computer is not a sign-in on this one.
    expect(wordCheckRefusal(inVm, { host: 'env_box', place: 'vm' }, [VM_LIBS[0]!, lib({ ...VM_LIBS[1], vm: undefined })])).toMatch(/not signed in/)
  })

  it("reads the holder from the Word file's record for a kept document, and from the path for a .docx here", () => {
    const db = new DatabaseSync(':memory:')
    ensureFilesTables(db)
    db.prepare(`INSERT INTO work_files_word (workspace_id, host, path, vm, name, version, doc, at) VALUES ('w1', 'env_box', ?, 1, 'Plan.docx', 'v1', '/data/word/Plan.tcdoc', 1)`).run(inVm.path)
    const ctx = { db, host: 'env_box' }
    expect(wordHolderOf(ctx, { at: 'file', host: 'env_box', path: '/data/word/Plan.tcdoc' })).toEqual(inVm)
    expect(wordHolderOf(ctx, { at: 'file', host: 'env_box', path: '/data/word/Other.tcdoc' })).toBeNull()
    expect(wordHolderOf(ctx, { at: 'file', host: 'env_mac', path: '/data/word/Plan.tcdoc' })).toBeNull()
    expect(wordHolderOf(ctx, { at: 'file', host: 'env_box', path: '/srv/Plan.docx' })).toEqual({ host: 'env_box', vm: false, path: '/srv/Plan.docx' })
    expect(wordHolderOf(ctx, { at: 'file', host: 'env_box', path: '/srv/Plan.xlsx' })).toBeNull()
  })

  it("names this host's renderer by its system", () => {
    expect([renderPlaceHere('darwin'), renderPlaceHere('win32'), renderPlaceHere('linux')]).toEqual(['mac', 'windows', 'vm'])
  })
})
