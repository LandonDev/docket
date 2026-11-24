import { realpathSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FilesPlaces } from '@shared/contract-work-files'
import type { ClientRequest } from '@shared/contract'
import { setRealpath } from '../../../remote/fence'
import { closeFilesState, filesHandle } from '../../files/handle'
import { forgetLibraries } from '../../files/places/libraries'
import { HOST, makeRig, window, WS, type Rig } from '../../files/testkit'
import { libraryOf, librariesOf } from './library'
import { driveOf, driveUp, probeDrive, setDriveLook } from './reach'

/** A folder he added on `J:`, a network drive. Windows' native realpath answers its share; the VPN may be down. */
const J = 'J:\\Esports'
let rig: Rig
let asked: string[]
const native = (path: string): string => {
  if (!/^j:/i.test(path)) return realpathSync(path)
  asked.push(path)
  return `\\\\files\\esports${path.slice(2)}`
}
const addJ = (): void => void rig.db.prepare(`INSERT OR REPLACE INTO work_office_files (key, value) VALUES ('roots', ?)`).run(JSON.stringify([{ folder: J }]))

beforeEach(() => {
  rig = makeRig()
  asked = []
  setRealpath(native)
  addJ()
})
afterEach(() => {
  setRealpath()
  setDriveLook()
  closeFilesState(rig.db)
  rig.close()
})

describe('a folder on a network drive', () => {
  it('names the drive or share a path lies on, and nothing for the system drive or a path of this disk', () => {
    expect(driveOf('J:\\Esports', 'C:')).toBe('J:')
    expect(driveOf('j:/x', 'C:')).toBe('J:')
    expect(driveOf('\\\\Files\\Esports\\x', 'C:')).toBe('\\\\files\\esports')
    expect(driveOf('C:\\Users', 'C:')).toBeNull()
    expect(driveOf('/Users/tc', 'C:')).toBeNull()
    expect(driveOf('\\\\?\\C:\\x', 'C:')).toBeNull()
  })

  it('keeps its drive spelling in the libraries while the drive is there', async () => {
    setDriveLook(async () => ({}))
    expect(await probeDrive(J)).toBe(true)
    const lib = librariesOf(rig.db, HOST).find((l) => l.kind === 'folder')
    expect(lib).toMatchObject({ path: J, kind: 'folder' })
    expect(lib?.away).toBeUndefined()
  })

  it('is listed as not reachable when the drive is gone, and never touched while it is', async () => {
    setDriveLook(() => new Promise(() => {}))
    expect(await probeDrive(J, 20)).toBe(false)
    expect(driveUp(J)).toBe(false)
    const lib = librariesOf(rig.db, HOST).find((l) => l.kind === 'folder')
    expect(lib).toMatchObject({ path: J, away: true })
    expect(libraryOf([lib!], `${J}\\Budget.xlsx`)).toBeNull()
    expect(asked).toEqual([])
  })

  it('a listing of a folder on a gone drive says the drive is not reachable now, at once, and never looks at it', async () => {
    setDriveLook(() => new Promise(() => {}))
    expect(await probeDrive(J, 20)).toBe(false)
    // As on the PC: a J:\ path on any other platform is the Windows VM's, read another way.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const started = Date.now()
    const listed = filesHandle({ id: 'x', method: 'work.files.list', params: { workspaceId: WS, at: { at: 'file', host: HOST, path: J } } } as ClientRequest, rig.ctx, window).finally(() => Object.defineProperty(process, 'platform', platform))
    await expect(listed).rejects.toThrow(/^J: is not reachable now\.$/)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(asked).toEqual([])
  })

  it("answers the Files view's places within the probe's deadline, the place not reachable", async () => {
    setDriveLook(() => new Promise(() => {}))
    forgetLibraries(rig.db)
    const started = Date.now()
    const got = (await filesHandle({ id: 'x', method: 'work.files.places', params: { workspaceId: WS } } as ClientRequest, rig.ctx, window)) as { result: FilesPlaces }
    expect(Date.now() - started).toBeLessThan(3_000)
    const place = got.result.places.find((p) => p.root.at === 'file' && p.root.path === J)
    expect(place?.state).toEqual({ state: 'unreachable' })
    expect(asked).toEqual([])
  })
})
