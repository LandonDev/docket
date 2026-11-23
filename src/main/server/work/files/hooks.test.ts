import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasSource } from '@shared/work'
import { fileMakerFor, fileMovedHooks, filePreviewerFor, registerFileMaker, registerFileMoved, registerFilePreviewer, type FileMaker } from './hooks'

/** The three registries a kind's pillar fills for Files (hooks.ts): each empty until something registers, each registration with its off. */

const offs: (() => void)[] = []
afterEach(() => {
  for (const off of offs.splice(0)) off()
})
const maker = (forms: FileMaker['forms']): FileMaker => ({ forms, blank: async () => {} })

describe('the makers', () => {
  it('answers none until a kind registers, then only for the forms it names', () => {
    expect(fileMakerFor('document', 'docx')).toBeNull()
    const docx = maker(['docx'])
    offs.push(registerFileMaker('document', docx))
    expect(fileMakerFor('document', 'docx')).toBe(docx)
    expect(fileMakerFor('document', 'tcdoc')).toBeNull()
    expect(fileMakerFor('sheet', 'docx')).toBeNull()
  })

  it('lets a later registration replace the earlier, and an old off never removes the new one', () => {
    const first = maker(['xlsx'])
    const second = maker(['xlsx', 'tcsheet'])
    const offFirst = registerFileMaker('sheet', first)
    offs.push(registerFileMaker('sheet', second))
    offFirst()
    expect(fileMakerFor('sheet', 'tcsheet')).toBe(second)
  })
})

describe('the previewers', () => {
  it('keeps one per kind and takes it back with its off', async () => {
    expect(filePreviewerFor('slides')).toBeNull()
    const off = registerFilePreviewer('slides', async (_source, { page, width }) => new Uint8Array([page, width]))
    const png = await filePreviewerFor('slides')!({ at: 'thread' }, { page: 2, width: 9 })
    expect([...png!]).toEqual([2, 9])
    off()
    expect(filePreviewerFor('slides')).toBeNull()
  })
})

describe('what is re-keyed on a rename', () => {
  it('calls every one registered, in the order they registered', () => {
    const seen: string[] = []
    const from: CanvasSource = { at: 'file', host: 'h', path: '/w/a.xlsx' }
    const to: CanvasSource = { at: 'file', host: 'h', path: '/w/b.xlsx' }
    offs.push(registerFileMoved((a, b) => void seen.push(`comments ${(a as { path: string }).path} ${(b as { path: string }).path}`)))
    offs.push(registerFileMoved(() => void seen.push('charts')))
    for (const hook of fileMovedHooks()) hook(from, to, { db: null as never, dataDir: '/data', host: 'h' })
    expect(seen).toEqual(['comments /w/a.xlsx /w/b.xlsx', 'charts'])
  })

  it('hands back a list of its own: a hook that registers another while they run does not change this run', () => {
    offs.push(registerFileMoved(() => void offs.push(registerFileMoved(() => {}))))
    const run = fileMovedHooks()
    for (const hook of run) hook({ at: 'thread' }, { at: 'thread' }, { db: null as never, dataDir: '', host: '' })
    expect(run).toHaveLength(1)
    expect(fileMovedHooks()).toHaveLength(2)
  })
})
