import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setNativeRealpath, setNativeRealpathAsync, setRealpath } from '../../remote/fence'
import { inRequest, withRequestMemo } from '../../requestMemo'
import { primeReals } from './policy'
import { closeFilesState, filesHandle } from './handle'
import { forgetLibraries } from './places/libraries'
import { at, makeRig, phone, window, WS, type Rig } from './testkit'
import type { Caller } from '../modules'

/**
 * One request resolves each path's real spelling once (requestMemo.ts): on a mapped drive each is a round trip on the
 * share, and a look at a page of rows resolved the workspace's folder and the libraries' folder again for every row.
 * The next request resolves them anew, and the fence answers as before.
 */

let rig: Rig
let resolved: string[]
beforeEach(() => {
  rig = makeRig()
  forgetLibraries(rig.db)
  resolved = []
  setRealpath((p) => (resolved.push(p), realpathSync(p)))
})
afterEach(() => {
  setRealpath()
  closeFilesState(rig.db)
  rig.close()
})

const NAMES = Array.from({ length: 10 }, (_, i) => `Report ${i}.docx`)
const stat = (by: Caller = window) => filesHandle({ id: '1', method: 'work.files.stat', params: { workspaceId: WS, refs: NAMES.map((n) => at(join(rig.team, 'General', n))) } } as never, rig.ctx, by)
const most = (): number => {
  const m = new Map<string, number>()
  for (const p of resolved) m.set(p, (m.get(p) ?? 0) + 1)
  return Math.max(0, ...m.values())
}

describe('one request', () => {
  beforeEach(() => {
    for (const n of NAMES) writeFileSync(join(rig.team, 'General', n), 'x')
  })

  it('resolves each path once for a page of rows, where before it resolved the roots again for every row', async () => {
    await stat()
    const loose = resolved.length
    expect(most()).toBeGreaterThan(1)
    resolved = []
    await withRequestMemo(() => stat())
    expect(most()).toBe(1)
    expect(resolved.length).toBeLessThan(loose)
    // The next request asks the disk again: nothing is kept past one.
    const once = resolved.length
    resolved = []
    await withRequestMemo(() => stat())
    expect(resolved.length).toBe(once)
  })

  it('answers the fence as before: a row a key may not name is still none of its business', async () => {
    const loose = (await stat(phone)) as { result: { entries: unknown[] } }
    const held = (await withRequestMemo(() => stat(phone))) as { result: { entries: unknown[] } }
    expect(held.result.entries).toEqual(loose.result.entries)
    expect(held.result.entries.every((e) => e === null)).toBe(true)
  })
})

describe('a request on Windows', () => {
  afterEach(() => (setNativeRealpath(), setNativeRealpathAsync()))
  it('resolves the paths it names off the loop first: its checks read them and call nothing on the loop', async () => {
    let sync = 0
    let off = 0
    setNativeRealpath((p) => (sync++, p))
    setNativeRealpathAsync(async (p) => (off++, p))
    await withRequestMemo(async () => {
      await primeReals(['C:\\Work\\Dummy', 'C:\\Work\\Dummy\\Events', 'C:\\Work\\Dummy'], { platform: 'win32' })
      // The door's own check of a primed path is answered from the request (its maker never runs).
      expect(inRequest('real:C:\\Work\\Dummy\\Events', () => (sync++, 'asked again'))).toBe('C:\\Work\\Dummy\\Events')
      expect(inRequest('real:C:\\Work\\Dummy', () => (sync++, 'asked again'))).toBe('C:\\Work\\Dummy')
    })
    expect(off).toBe(2)
    expect(sync).toBe(0)
    // Elsewhere nothing is primed: the box resolves as before.
    off = 0
    await withRequestMemo(() => primeReals(['/w'], { platform: 'linux' }))
    expect(off).toBe(0)
  })
})

describe('a request served from a callback another request started', () => {
  it('keeps a memo of its own: a file made after the first request looked for it is found', async () => {
    // The J23 fault: his link to the box was opened inside a request, so every call the box sent over it ran in that
    // request's memo. Save As looked for its new file's name before making it, and the read of the file it then made
    // found "no such path" kept from that look, refused as not in a Teams folder.
    const made = join(rig.team, 'General', 'TempCode proof made later.docx')
    const entries = (got: unknown) => (got as { result: { entries: unknown[] } }).result.entries
    const statOf = () => filesHandle({ id: '1', method: 'work.files.stat', params: { workspaceId: WS, refs: [at(made)] } } as never, rig.ctx, window)
    const later = await withRequestMemo(async () => {
      expect(entries(await statOf())).toEqual([null])
      // A socket or a timer made in this request carries its context: the request it serves later is another.
      return new Promise<unknown>((done) =>
        setTimeout(() => {
          writeFileSync(made, 'x')
          done(withRequestMemo(() => statOf()))
        }, 0)
      )
    })
    expect(entries(later)[0]).not.toBeNull()
  })
})
