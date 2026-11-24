import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { librariesOf, rootsOf, setRoots, setupLedger } from '../office/files/library'
import { addSetupFolders, removeSetupFolders } from './setupFolders'
import { HOST, makeRig, type Rig } from './testkit'

let rig: Rig
beforeEach(() => (rig = makeRig()))
afterEach(() => rig.close())

describe('the folders setup adds', () => {
  it('adds each picked folder to the list, marked as setup\'s, and lists it as a folder place', () => {
    const drive = join(rig.base, 'J')
    mkdirSync(drive)
    expect(addSetupFolders(rig.db, [drive, drive])).toEqual([drive])
    expect(rootsOf(rig.db)).toEqual([{ folder: drive }])
    expect(setupLedger(rig.db)).toEqual([drive])
    expect(librariesOf(rig.db, HOST).find((l) => l.path === drive)).toMatchObject({ kind: 'folder', found: false })
  })

  it('removes exactly what the ledger marks: a folder that was there before stays', () => {
    const before = join(rig.base, 'Before')
    const drive = join(rig.base, 'J')
    setRoots(rig.db, [{ folder: before, web: 'https://x.sharepoint.com/a' }])
    // Setup picks one already listed too: it is his, and stays his.
    expect(addSetupFolders(rig.db, [before, drive])).toEqual([drive])
    expect(removeSetupFolders(rig.db)).toEqual([drive])
    expect(rootsOf(rig.db)).toEqual([{ folder: before, web: 'https://x.sharepoint.com/a' }])
    expect(setupLedger(rig.db)).toEqual([])
    expect(removeSetupFolders(rig.db)).toEqual([])
  })

  it('forgets a folder he removed by hand, so a later Add folder… of it is his', () => {
    const drive = join(rig.base, 'J')
    addSetupFolders(rig.db, [drive])
    setRoots(rig.db, [])
    expect(setupLedger(rig.db)).toEqual([])
    setRoots(rig.db, [{ folder: drive }])
    expect(removeSetupFolders(rig.db)).toEqual([])
    expect(rootsOf(rig.db)).toEqual([{ folder: drive }])
  })
})
