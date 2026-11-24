import { mkdirSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFromShelf } from './make'
import { saveTemplate } from './save'
import { docx, HOST, makeRig, window, WS, type Rig } from './testkit'

// A disk that fills while the filled file is written: half of it lands, then ENOSPC.
const disk = vi.hoisted(() => ({ full: false, beforeMkdir: (_dir: string): void => {} }))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    mkdir: async (dir: string, options?: Parameters<typeof real.mkdir>[1]) => {
      disk.beforeMkdir(dir)
      return real.mkdir(dir, options)
    },
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
  disk.beforeMkdir = () => {}
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

describe('a link moved while a make or a save runs', () => {
  /** Templates/Waiver.docx links to a file of the job; at the first wait the link is turned to a file outside it. */
  const setUp = (): { waiver: Buffer; turn: () => void } => {
    const inJob = rig.put(join(rig.folder, 'Forms', 'Waiver.docx'), docx('Waiver for {{Player}}'))
    const secret = rig.put(join(rig.outside, 'Secret.docx'), docx('Account {{Number}}'))
    mkdirSync(join(rig.folder, 'Templates'), { recursive: true })
    const link = join(rig.folder, 'Templates', 'Waiver.docx')
    symlinkSync(inJob, link)
    let done = false
    return {
      waiver: readFileSync(inJob),
      turn: () => {
        if (done) return
        done = true
        unlinkSync(link)
        symlinkSync(secret, link)
      }
    }
  }

  it('makes from the file the shelf admitted, never the one the link leads to after', async () => {
    const { turn } = setUp()
    disk.beforeMkdir = turn
    const made = await makeFromShelf(rig.ctx, window, { workspaceId: WS, template: 'job:Waiver.docx', fields: { Player: 'Sam' }, today: '2026-11-23' }, { pillars: () => [] })
    const text = readFileSync(made.source.at === 'file' ? made.source.path : '').toString('latin1')
    expect(made.unfilled).not.toContain('Number')
    expect(text.includes('Account')).toBe(false)
  })

  it('saves the file the checks judged, never the one the link leads to after', async () => {
    const { waiver, turn } = setUp()
    disk.beforeMkdir = turn
    const saved = await saveTemplate(rig.ctx, window, { workspaceId: WS, source: { at: 'file', host: HOST, path: join(rig.folder, 'Templates', 'Waiver.docx') }, name: 'Waiver copy' }, { pillars: () => [] })
    expect(readFileSync(join(rig.folder, 'Templates', 'Waiver copy.docx')).equals(waiver)).toBe(true)
    expect(saved.fields).toEqual(['Player'])
  })
})
