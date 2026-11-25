import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setRealpath } from '../../remote/fence'
import { withRequestMemo } from '../../requestMemo'
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
