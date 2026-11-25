import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileDocStore, fileDocName } from 'work-kit/collab-server'
import { ensureDocUid } from '../guests/fileIdent'
import { boundToFile } from './fileBound'

/** A live `.tcdoc` stores only over the file it was loaded from: a moved file is never made again at its old name. */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-filebound-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const text = { markdown: 'TempCode proof words', html: '' } as never
const state = new Uint8Array([0, 0])

async function opened(path: string): Promise<ReturnType<typeof boundToFile>> {
  await new FileDocStore().store(fileDocName(path), state, text, { path })
  ensureDocUid(path)
  const store = boundToFile(new FileDocStore())
  await store.load(fileDocName(path), { path })
  return store
}

describe('a document whose file moved', () => {
  it('stores where it was loaded while the file is there', async () => {
    const path = join(dir, 'TempCode proof.tcdoc')
    const store = await opened(path)
    await expect(store.store(fileDocName(path), state, text, { path })).resolves.toBeUndefined()
    await expect(store.store(fileDocName(path), state, text, { path })).resolves.toBeUndefined()
  })

  it('never makes the old file again: a late store after a rename is refused as not found', async () => {
    const path = join(dir, 'TempCode proof.tcdoc')
    const store = await opened(path)
    renameSync(path, join(dir, 'TempCode proof renamed.tcdoc'))
    await expect(store.store(fileDocName(path), state, text, { path })).rejects.toThrow(/not found/)
    expect(existsSync(path)).toBe(false)
  })

  it('never stores over another file put at its old name, even one of the same bytes', async () => {
    const path = join(dir, 'TempCode proof.tcdoc')
    const store = await opened(path)
    renameSync(path, join(dir, 'moved.tcdoc'))
    await new FileDocStore().store(fileDocName(path), state, text, { path })
    ensureDocUid(path)
    await expect(store.store(fileDocName(path), state, text, { path })).rejects.toThrow(/not found/)
  })

  it('makes a document loaded from no file, as before', async () => {
    const path = join(dir, 'new.tcdoc')
    const store = boundToFile(new FileDocStore())
    await store.load(fileDocName(path), { path })
    await store.store(fileDocName(path), state, text, { path })
    expect(existsSync(path)).toBe(true)
  })
})
