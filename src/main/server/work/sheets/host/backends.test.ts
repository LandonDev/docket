import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
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

  it('writes nothing over a newer workbook put at the same path, and goes on writing after its own writes', async () => {
    const base = mkdtempSync(join(tmpdir(), 'tc-tcsheet-'))
    dirs.push(base)
    const path = join(base, 'Budget.tcsheet')
    TcsheetBackend.create(path, 'Budget')
    const sheet = new TcsheetBackend(path)
    const { rev } = await sheet.load()
    expect(await sheet.append(rev, [{ by: 'owner', mutations: [] }])).toEqual({ rev: rev + 1 })
    expect(await sheet.append(rev + 1, [{ by: 'owner', mutations: [] }])).toEqual({ rev: rev + 2 })
    // OneDrive puts a co-author's newer workbook at the same path, as it does: a new file renamed over it.
    TcsheetBackend.create(join(base, 'incoming.tcsheet'), 'Budget, theirs')
    renameSync(join(base, 'incoming.tcsheet'), path)
    const theirs = readFileSync(path)
    await expect(sheet.append(rev + 2, [{ by: 'owner', mutations: [] }])).rejects.toThrow('changed on disk since this sheet was opened')
    expect(readFileSync(path).equals(theirs)).toBe(true)
  })

  it("keeps an agent's proposals by the workbook they were made over: reopened through a link that now names another, it finds none", async () => {
    const base = mkdtempSync(join(tmpdir(), 'tc-tcsheet-'))
    dirs.push(base)
    const side = join(base, 'side')
    for (const d of ['Mine', 'Other']) mkdirSync(join(base, d))
    TcsheetBackend.create(join(base, 'Mine', 'Budget.tcsheet'), 'Budget')
    TcsheetBackend.create(join(base, 'Other', 'Budget.tcsheet'), 'Payroll')
    symlinkSync(join(base, 'Mine'), join(base, 'Link'))
    const cell = { sheet: 'Sheet1', row: 1, col: 1, base: null, proposed: { v: 42 } }
    await new TcsheetBackend(join(base, 'Link', 'Budget.tcsheet'), side).addSuggestions('cs1', 'agent:box:t1', undefined, [cell])
    // After a restart the link names another folder: its workbook of the same name has no proposals of this one's.
    unlinkSync(join(base, 'Link'))
    symlinkSync(join(base, 'Other'), join(base, 'Link'))
    expect(await new TcsheetBackend(join(base, 'Link', 'Budget.tcsheet'), side).suggestions()).toEqual([])
    // The workbook they were made over still has them, by any name that reaches it.
    expect(await new TcsheetBackend(join(base, 'Mine', 'Budget.tcsheet'), side).suggestions()).toEqual([expect.objectContaining({ id: 'cs1:Sheet1:1:1' })])
  })

  it('a workbook put at the same path while the host was down does not take the old proposals: they wait only to be dropped', async () => {
    // Council r2 (Sol 2): a cold open read the replacement, then the path's proposals, and Accept could write them into it.
    const base = mkdtempSync(join(tmpdir(), 'tc-tcsheet-'))
    dirs.push(base)
    const side = join(base, 'side')
    const path = join(base, 'Budget.tcsheet')
    TcsheetBackend.create(path, 'Budget')
    const cell = { sheet: 'Sheet1', row: 1, col: 1, base: null, proposed: { v: 42 } }
    const first = new TcsheetBackend(path, side)
    await first.addSuggestions('cs1', 'agent:box:t1', undefined, [cell])
    // his own write after it keeps them his: the side file names the archive as it now stands
    const { rev } = await first.load()
    await first.append(rev, [{ by: 'owner', mutations: [] }])
    expect((await new TcsheetBackend(path, side).suggestions()).map((x) => x.state)).toEqual(['pending'])
    // the host is down; another workbook comes to stand at the same path
    TcsheetBackend.create(join(base, 'incoming.tcsheet'), 'Payroll')
    renameSync(join(base, 'incoming.tcsheet'), path)
    expect((await new TcsheetBackend(path, side).suggestions()).map((x) => x.state)).toEqual(['orphaned'])
  })
})
