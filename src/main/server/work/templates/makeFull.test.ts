import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFromShelf } from './make'
import { makeRig, window, WS, type Rig } from './testkit'

// A disk that fills while the filled file is written: half of it lands, then ENOSPC.
const disk = vi.hoisted(() => ({ full: false }))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    writeFile: async (path: string, data: Uint8Array) => {
      if (!disk.full) return real.writeFile(path, data)
      await real.writeFile(path, data.subarray(0, Math.floor(data.length / 2)))
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    }
  }
})

let rig: Rig
beforeEach(() => void (rig = makeRig()))
afterEach(() => {
  disk.full = false
  rig.close()
})

describe('a fill whose write is cut short', () => {
  it('places the template as it was, its fields named, never a file cut short', async () => {
    disk.full = true
    const made = await makeFromShelf(rig.ctx, window, { workspaceId: WS, template: 'Game report', fields: { Home: 'Central' }, today: '2026-11-23' }, { pillars: () => [] })
    const placed = made.source.at === 'file' ? made.source.path : ''
    expect(readFileSync(placed).equals(readFileSync(join(rig.starters, 'ref', 'Game report.docx')))).toBe(true)
    expect(made.unfilled).toEqual(['Home', 'Away', 'Site', 'Name', 'Date', 'Job'])
    expect(rig.logs.some((l) => l.includes('was not filled: no space left on device'))).toBe(true)
  })
})
