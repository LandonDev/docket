import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renameTemplate } from './save'
import { docx, makeRig, window, WS, type Rig } from './testkit'

// A disk with no hard links (a share, some FAT volumes): `link` answers EXDEV and the rename falls back to a copy.
const onLink = vi.hoisted(() => ({ before: (_to: string): void => {} }))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    link: async (_from: string, to: string) => {
      onLink.before(to)
      throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
    }
  }
})

let rig: Rig
beforeEach(() => void (rig = makeRig()))
afterEach(() => {
  onLink.before = () => {}
  rig.close()
})

describe('rename on a disk with no hard links', () => {
  it('copies to the new name and takes the old one away', async () => {
    rig.put(join(rig.folder, 'Templates', 'Letter.docx'), docx('{{To}}'))
    const t = await renameTemplate(rig.ctx, window, WS, 'job:Letter.docx', 'Assignor letter')
    expect(t.id).toBe('job:Assignor letter.docx')
    expect(existsSync(join(rig.folder, 'Templates', 'Letter.docx'))).toBe(false)
  })

  it('never writes over a file that took the name between the look and the copy', async () => {
    rig.put(join(rig.folder, 'Templates', 'Letter.docx'), docx('{{To}}'))
    const taken = join(rig.folder, 'Templates', 'Memo.docx')
    onLink.before = (to) => writeFileSync(to, 'another template')
    await expect(renameTemplate(rig.ctx, window, WS, 'job:Letter.docx', 'Memo')).rejects.toThrow('A template named Memo is already there.')
    expect(readFileSync(taken, 'utf8')).toBe('another template')
    expect(existsSync(join(rig.folder, 'Templates', 'Letter.docx'))).toBe(true)
  })
})
