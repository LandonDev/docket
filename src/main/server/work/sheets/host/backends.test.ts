import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TcsheetBackend } from './backends'

/** A `.tcsheet` held open by the sheet host, reached through a folder link: its writes go to the file it read, or nowhere. */

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('a .tcsheet reached through a link', () => {
  it('writes only to the file it read: a link that came to point at another folder is refused, and the other file is left as it was', async () => {
    const base = mkdtempSync(join(tmpdir(), 'tc-tcsheet-'))
    dirs.push(base)
    for (const d of ['Mine', 'Other']) mkdirSync(join(base, d))
    TcsheetBackend.create(join(base, 'Mine', 'Budget.tcsheet'), 'Budget')
    TcsheetBackend.create(join(base, 'Other', 'Budget.tcsheet'), 'Payroll')
    symlinkSync(join(base, 'Mine'), join(base, 'Link'))
    const sheet = new TcsheetBackend(join(base, 'Link', 'Budget.tcsheet'))
    const { rev } = await sheet.load()
    expect(await sheet.append(rev, [{ by: 'owner', mutations: [] }])).toEqual({ rev: rev + 1 })
    // The link now names another folder, whose sheet of the same name is another workbook.
    unlinkSync(join(base, 'Link'))
    symlinkSync(join(base, 'Other'), join(base, 'Link'))
    const other = readFileSync(join(base, 'Other', 'Budget.tcsheet'))
    await expect(sheet.append(rev + 1, [{ by: 'owner', mutations: [] }])).rejects.toThrow('names another file than the one this sheet was opened from')
    expect(readFileSync(join(base, 'Other', 'Budget.tcsheet')).equals(other)).toBe(true)
    // The file it read kept its first write.
    expect((await new TcsheetBackend(join(base, 'Mine', 'Budget.tcsheet')).load()).rev).toBe(rev + 1)
  })
})
