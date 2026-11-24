import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { binRefused, FOLDER_GONE, MAC_TRASH, macBin, macTrashAnswer, NOT_IN_TRASH_BIN, restoredName } from './bin'

/** The Mac's bin (bin.ts): the Trash's answer read, its refusal said, and Put back by path on a scratch folder. */

describe("the Mac's Trash", () => {
  it('asks Foundation from AppleScriptObjC, never JXA, whose out-parameters crash osascript', () => {
    expect(MAC_TRASH[0]).toBe('use framework "Foundation"')
    expect(MAC_TRASH.join('\n')).toContain('trashItemAtURL:')
    expect(MAC_TRASH.join('\n')).not.toContain('ObjC.import')
  })

  it('reads where the thing lies, a Trash that did not say, and a refusal', () => {
    expect(macTrashAnswer('OK:/Users/a/.Trash/Plan.docx\n')).toEqual({ at: '/Users/a/.Trash/Plan.docx' })
    expect(macTrashAnswer('OK:')).toEqual({ at: null })
    expect(macTrashAnswer('NO:The volume has no Trash.')).toEqual({ refused: 'The volume has no Trash.' })
  })

  it('says a refusal as a plain sentence: the thing was left where it is', () => {
    expect(binRefused('Plan.docx', 'Trash', new Error('Command failed: osascript … execution error: The volume has no Trash. (-1728)')).message).toBe('Plan.docx could not go to the Trash, so it was left where it is: The volume has no Trash.')
    expect(binRefused('Plan.docx', 'Trash', new Error('')).message).toBe('Plan.docx could not go to the Trash, so it was left where it is.')
  })

  it('names a thing put back beside one of its name as freeName does', () => {
    expect(restoredName('notes.txt', 1)).toBe('notes (restored).txt')
    expect(restoredName('notes.txt', 2)).toBe('notes (restored) 2.txt')
    expect(restoredName('Budgets', 1)).toBe('Budgets (restored)')
  })
})

describe('Put back from the Trash by path', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-bin-'))
    mkdirSync(join(dir, 'Trash'))
    mkdirSync(join(dir, 'Library'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('goes back where it was, beside a new one as "(restored)", and never twice', async () => {
    const bin = macBin()
    writeFileSync(join(dir, 'Trash', 'Plan.docx'), 'word')
    expect(await bin.back!(join(dir, 'Trash', 'Plan.docx'), join(dir, 'Library', 'Plan.docx'), 'op')).toBe(join(dir, 'Library', 'Plan.docx'))
    expect(readFileSync(join(dir, 'Library', 'Plan.docx'), 'utf8')).toBe('word')
    writeFileSync(join(dir, 'Trash', 'Plan.docx'), 'older')
    expect(await bin.back!(join(dir, 'Trash', 'Plan.docx'), join(dir, 'Library', 'Plan.docx'), 'op')).toBe(join(dir, 'Library', 'Plan (restored).docx'))
    expect(readFileSync(join(dir, 'Library', 'Plan.docx'), 'utf8')).toBe('word')
    await expect(bin.back!(join(dir, 'Trash', 'Plan.docx'), join(dir, 'Library', 'Plan.docx'), 'op')).rejects.toThrow(NOT_IN_TRASH_BIN)
  })

  it('refuses where the folder it was in is gone', async () => {
    writeFileSync(join(dir, 'Trash', 'a.txt'), 'x')
    await expect(macBin().back!(join(dir, 'Trash', 'a.txt'), join(dir, 'Gone', 'a.txt'), 'op')).rejects.toThrow(FOLDER_GONE)
  })
})
