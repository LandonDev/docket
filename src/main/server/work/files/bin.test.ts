import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { binRefused, FOLDER_GONE, MAC_TRASH, macBin, macTrashAnswer, NOT_IN_TRASH_BIN, restoredName, moveOnto } from './bin'

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

  it('never writes over a file that took the name between the look and the move: it goes beside it as "(restored)"', async () => {
    const from = join(dir, 'Trash', 'Plan.docx')
    const to = join(dir, 'Library', 'Plan.docx')
    writeFileSync(from, 'his')
    // OneDrive syncs a file in under the name after it was seen free.
    writeFileSync(to, 'synced in')
    expect(moveOnto(from, to)).toBe(false)
    expect([readFileSync(to, 'utf8'), readFileSync(from, 'utf8')]).toEqual(['synced in', 'his'])
    // A free name takes it, and the Trash's copy goes.
    expect(moveOnto(from, join(dir, 'Library', 'Plan (restored).docx'))).toBe(true)
    expect(readFileSync(join(dir, 'Library', 'Plan (restored).docx'), 'utf8')).toBe('his')
    expect(existsSync(from)).toBe(false)
    // Where a link cannot be made (another volume) the move still happens, by rename; a folder always goes by rename.
    writeFileSync(from, 'again')
    expect(moveOnto(from, join(dir, 'Library', 'Other.docx'), () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }) })).toBe(true)
    mkdirSync(join(dir, 'Trash', 'Budgets'))
    expect(moveOnto(join(dir, 'Trash', 'Budgets'), join(dir, 'Library', 'Budgets'))).toBe(true)
    expect(existsSync(join(dir, 'Library', 'Budgets'))).toBe(true)
  })

  it('refuses where the folder it was in is gone', async () => {
    writeFileSync(join(dir, 'Trash', 'a.txt'), 'x')
    await expect(macBin().back!(join(dir, 'Trash', 'a.txt'), join(dir, 'Gone', 'a.txt'), 'op')).rejects.toThrow(FOLDER_GONE)
  })
})
