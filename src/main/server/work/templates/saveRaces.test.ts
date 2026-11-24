import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { moveTemplate, MOVED_UNDER, renameTemplate } from './save'
import { sharedDir } from './shelf'
import { docx, makeRig, window, WS, type Rig } from './testkit'

// What lands between this pillar's steps: an editor's save, another window's file. `links: false` is a disk with no hard links.
const hooks = vi.hoisted(() => ({ links: true, beforeLink: (_to: string): void => {}, afterLink: (_from: string): void => {}, afterCopy: (_from: string): void => {} }))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    link: async (from: string, to: string) => {
      hooks.beforeLink(to)
      if (!hooks.links) throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
      await real.link(from, to)
      hooks.afterLink(from)
    },
    copyFile: async (from: string, to: string, mode?: number) => {
      await real.copyFile(from, to, mode)
      hooks.afterCopy(from)
    }
  }
})

let rig: Rig
beforeEach(() => void (rig = makeRig()))
afterEach(() => {
  Object.assign(hooks, { links: true, beforeLink: () => {}, afterLink: () => {}, afterCopy: () => {} })
  rig.close()
})

const letter = () => join(rig.folder, 'Templates', 'Letter.docx')
/** An editor's save: a new file put in the old one's place, as Word and the document kind write. */
const saveAnew = (path: string, text: string): void => {
  unlinkSync(path)
  writeFileSync(path, docx(text))
}
const shared = (): string[] => (existsSync(sharedDir(rig.ctx)) ? readdirSync(sharedDir(rig.ctx)) : [])

describe('a move while an editor saves', () => {
  it('keeps the edit saved while the move copied, and leaves the template where it was', async () => {
    rig.put(letter(), docx('{{To}}'))
    hooks.links = false
    hooks.afterCopy = (from) => void (from === letter() && saveAnew(from, '{{To}} with his edit'))
    await expect(moveTemplate(rig.ctx, window, WS, 'job:Letter.docx', true)).rejects.toThrow(MOVED_UNDER)
    expect(readFileSync(letter()).equals(Buffer.from(docx('{{To}} with his edit')))).toBe(true)
    expect(shared()).toEqual([])
  })

  it('keeps the edit saved just after the link, and takes the link back', async () => {
    rig.put(letter(), docx('{{To}}'))
    hooks.afterLink = (from) => void (from === letter() && saveAnew(from, '{{To}} with his edit'))
    await expect(moveTemplate(rig.ctx, window, WS, 'job:Letter.docx', true)).rejects.toThrow(MOVED_UNDER)
    expect(readFileSync(letter()).equals(Buffer.from(docx('{{To}} with his edit')))).toBe(true)
    expect(shared()).toEqual([])
  })

  it('moves the file whole when nothing came between', async () => {
    rig.put(letter(), docx('{{To}}'))
    expect(await moveTemplate(rig.ctx, window, WS, 'job:Letter.docx', true)).toMatchObject({ id: 'all:Letter.docx' })
    expect(existsSync(letter())).toBe(false)
  })
})

describe('a change of case alone', () => {
  it('never replaces a file of the other case made between the look and the move, on a disk that tells them apart', async () => {
    rig.put(letter(), docx('mine'))
    const upper = join(rig.folder, 'Templates', 'LETTER.docx')
    hooks.beforeLink = (to) => void (to === upper && writeFileSync(upper, docx('another')))
    await expect(renameTemplate(rig.ctx, window, WS, 'job:Letter.docx', 'LETTER')).rejects.toThrow('A template named LETTER is already there.')
    expect(readFileSync(upper).equals(Buffer.from(docx('another')))).toBe(true)
    expect(readFileSync(letter()).equals(Buffer.from(docx('mine')))).toBe(true)
  })

  it('is one rename where nothing else holds the name', async () => {
    rig.put(letter(), docx('mine'))
    expect(await renameTemplate(rig.ctx, window, WS, 'job:Letter.docx', 'LETTER')).toMatchObject({ id: 'job:LETTER.docx' })
    expect(readdirSync(join(rig.folder, 'Templates'))).toEqual(['LETTER.docx'])
  })
})
