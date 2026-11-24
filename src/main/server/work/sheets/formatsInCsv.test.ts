import { chmodSync, existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sharedOf } from '../files/policy'
import { previewScratch } from '../files/preview'
import { at, makeRig, type Rig } from '../files/testkit'
import { CSV_NO_WRITE, CSV_NOT_UTF8, csvRows, delimitedAsCsv, forgetCsvCaches, patchCsv, sharedCsvCache, sharedCsvReadOnly, throughCsv } from './formatsInCsv'
import { ensureCsvSheet, sharedCsvDir } from './held'
import { TcsheetBackend } from './host/backends'
import { SheetHost } from './host/host'
import { readCsv, writeCsv } from './writer'

/**
 * A .csv others can open takes an edit and the file holds it (SHT8): the patch that keeps every
 * other byte of the file, the cache that goes on after a save of ours and gives way to a
 * co-author's newer file, and the write itself through Files' door, in a dummy team library.
 */

/** The file after the sheet read from it had `cells` typed in, as a save through would write it. */
function typed(original: string, cells: Record<string, string | number | null>, drop?: { rowsFrom: number }): string {
  const wb = readCsv(original, 'workbook', 'List.csv')
  const data = wb.sheets[wb.sheetOrder[0]!]!.cellData as Record<number, Record<number, { v?: unknown; t?: number }>>
  for (const [key, v] of Object.entries(cells)) {
    const [r, c] = key.split(',').map(Number) as [number, number]
    if (v === null) delete data[r]?.[c]
    else (data[r] ??= {})[c] = typeof v === 'number' ? { v, t: 2 } : { v, t: 1 }
  }
  if (drop) for (const r of Object.keys(data).map(Number)) if (r >= drop.rowsFrom) delete data[r]
  return patchCsv(original, writeCsv(wb), writeCsv(readCsv(original, 'workbook', 'List.csv')))
}

describe('a CSV split with each field\'s own bytes', () => {
  it('keeps quotes, doubled quotes and each row\'s own line break', () => {
    const rows = csvRows('a,"b,1","say ""hi"""\r\nc,,\nlast')
    expect(rows.map((r) => r.raw)).toEqual([['a', '"b,1"', '"say ""hi"""'], ['c', '', ''], ['last']])
    expect(rows.map((r) => r.value)).toEqual([['a', 'b,1', 'say "hi"'], ['c', '', ''], ['last']])
    expect(rows.map((r) => r.eol)).toEqual(['\r\n', '\n', ''])
  })

  it('reads the rows readCsv reads: a blank line is a row, a final line break is not one more', () => {
    expect(csvRows('a\n\nb\n').map((r) => r.value)).toEqual([['a'], [''], ['b']])
    expect(csvRows('')).toEqual([])
    expect(csvRows('"two\nlines",x\n').map((r) => r.value)).toEqual([['two\nlines', 'x']])
  })
})

describe('one edit to a shared .csv is one field in the file', () => {
  it('a file nobody edited comes back byte for byte, whatever its dialect', () => {
    for (const text of ['name,amount\nAda,1.50\nBo,1e5\n', '\uFEFFname,amount\r\n"Ada",007\r\n', 'a,b\nc', 'a;b,c\n"x" ,y\n\n\n', '', 'one\n\ntwo\n', 'a,b,c\n1\n2,3\n']) expect(typed(text, {})).toBe(text)
  })

  it('changes the one field and keeps how the others were written: 1.50, 1e5, a quoted name, CRLF', () => {
    expect(typed('name,amount,rate\r\n"Ada",1.50,1e5\r\nBo, 12 ,007\r\n', { '2,0': 'Bob' })).toBe('name,amount,rate\r\n"Ada",1.50,1e5\r\nBob, 12 ,007\r\n')
    expect(typed('name,amount\nAda,1.50\n', { '1,1': 2 })).toBe('name,amount\nAda,2\n')
  })

  it('quotes a typed value that needs it, and leaves an emptied cell empty', () => {
    expect(typed('a,b\n1,2\n', { '1,0': 'x, "y"' })).toBe('a,b\n"x, ""y""",2\n')
    expect(typed('a,b\n1,2\n', { '1,1': null })).toBe('a,b\n1,\n')
  })

  it('keeps the byte-order mark, mixed line breaks and a last line with no break', () => {
    expect(typed('\uFEFFa,b\r\n1,2\n3,4', { '2,1': 5 })).toBe('\uFEFFa,b\r\n1,2\n3,5')
  })

  it('a new row takes the file\'s own line break, and the file ends as it ended', () => {
    expect(typed('a,b\r\n1,2\r\n', { '2,0': 'new' })).toBe('a,b\r\n1,2\r\nnew\r\n')
    expect(typed('a,b\n1,2', { '2,1': 'new' })).toBe('a,b\n1,2\n,new')
    expect(typed('', { '0,0': 'first' })).toBe('first\n')
  })

  it('a short row stays short until a cell past it is filled; blank lines at the end stay', () => {
    expect(typed('a,b,c\n1\n2,3\n', { '2,0': 9 })).toBe('a,b,c\n1\n9,3\n')
    expect(typed('a,b,c\n1\n2,3\n', { '1,2': 'z' })).toBe('a,b,c\n1,,z\n2,3\n')
    expect(typed('a\nb\n\n\n', { '1,0': 'c' })).toBe('a\nc\n\n\n')
  })

  it('rows he removed from the end leave the file', () => {
    expect(typed('a\nb\nc\n', {}, { rowsFrom: 1 })).toBe('a\n')
  })
})

describe('the same patch with a tab for a .tsv', () => {
  it('splits on tabs, keeps a comma as text, and words a changed field for a tab-separated file', () => {
    expect(csvRows('a, b\t"c\td"\n', '\t').map((r) => r.value)).toEqual([['a, b', 'c\td']])
    expect(delimitedAsCsv('﻿Item\tQty\n"Pear, green"\t2\nsaid "hi"\t\n', '\t')).toBe('Item,Qty\r\n"Pear, green",2\r\n"said ""hi""",')
    const original = 'Item\tQty\r\n"Pear, green"\t1.50\r\n'
    const asRead = 'Item,Qty\r\n"Pear, green",1.5\r\n'
    expect(patchCsv(original, asRead, asRead, '\t')).toBe(original)
    expect(patchCsv(original, 'Item,Qty\r\n"Pear, green",2\r\n"a, b","x\ty"\r\n', asRead, '\t')).toBe('Item\tQty\r\n"Pear, green"\t2\r\na, b\t"x\ty"\r\n')
  })
})

describe('a shared .csv saved through to its file', () => {
  let rig: Rig
  let csv: string
  let host: SheetHost
  const general = (): string => join(rig.team, 'General')
  const folder = (): string[] => readdirSync(general()).sort()
  const typedAt = (row: number, col: number, v: unknown) => ({ id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: 'sheet1', cellValue: { [row]: { [col]: { v } } } } })
  /** The cache the file opens as, made the first time as `heldOf` and `ensureCsvSheet` make it. */
  const open = (): string => {
    const sheet = sharedCsvCache(sharedCsvDir(rig.dataDir), csv)
    ensureCsvSheet({ at: 'service', ref: { tcsheet: sheet }, csv }, rig.dataDir)
    return sheet
  }
  const apply = (sheet: string, baseRev: number, mutations: unknown[]): Promise<{ rev: number } | { conflict: true; rev: number }> =>
    throughCsv(rig.ctx, sheet, () => host.apply({ tcsheet: sheet }, baseRev, mutations as never, 'owner'))

  beforeEach(() => {
    rig = makeRig()
    forgetCsvCaches()
    csv = join(general(), 'Roster.csv')
    writeFileSync(csv, 'name,hours\r\n"Ada",1.50\r\nBo,007\r\n')
    host = new SheetHost((ref) => new TcsheetBackend((ref as { tcsheet: string }).tcsheet))
    Object.assign(rig.ctx, {
      service: {
        internal: async (route: string, b: { sheet: { tcsheet: string }; rev: number; offset: number; length: number }) => {
          const op = route.split('/').pop()
          if (op === 'open') return host.open(b.sheet)
          if (op === 'snapshot') return host.snapshot(b.sheet, b.rev, b.offset, b.length)
          throw new Error(`not in this test: ${op}`)
        }
      }
    })
  })
  afterEach(() => rig.close())

  it('the file is one others can open, and its cache lies under Files\' preview scratch', () => {
    expect(sharedOf(rig.ctx, at(csv))).toBe(true)
    const sheet = open()
    expect(sheet.startsWith(join(previewScratch(rig.dataDir), 'sheets', 'csv'))).toBe(true)
    expect(existsSync(sheet)).toBe(true)
  })

  it('an edit lands in the file through Files\' door: one field changed, the file\'s mode kept, nothing left beside it', async () => {
    chmodSync(csv, 0o640)
    const before = folder()
    const sheet = open()
    expect(await apply(sheet, 0, [typedAt(2, 0, 'Bob')])).toEqual({ rev: 1 })
    expect(readFileSync(csv, 'utf8')).toBe('name,hours\r\n"Ada",1.50\r\nBob,007\r\n')
    expect(folder()).toEqual(before)
    expect(statSync(csv).mode & 0o777).toBe(0o640)
  })

  it('the cache goes on after a save of ours, so the next edit builds on the last', async () => {
    const sheet = open()
    await apply(sheet, 0, [typedAt(2, 0, 'Bob')])
    expect(sharedCsvCache(sharedCsvDir(rig.dataDir), csv)).toBe(sheet)
    expect(await apply(open(), 1, [typedAt(3, 0, 'Cy'), typedAt(3, 1, 4)])).toEqual({ rev: 2 })
    expect(readFileSync(csv, 'utf8')).toBe('name,hours\r\n"Ada",1.50\r\nBob,007\r\nCy,4\r\n')
  })

  it('a co-author\'s newer file is never written over: the edit is refused before it is made, and the file is read again', async () => {
    const sheet = open()
    await apply(sheet, 0, [typedAt(2, 0, 'Bob')])
    writeFileSync(csv, 'name,hours\r\nTheirs,9\r\n')
    utimesSync(csv, new Date(), new Date(Date.now() + 5000))
    await expect(apply(sheet, 1, [typedAt(2, 0, 'Mine')])).rejects.toThrow('Roster.csv changed in its folder, so this edit was not saved')
    expect(readFileSync(csv, 'utf8')).toBe('name,hours\r\nTheirs,9\r\n')
    expect((await host.open({ tcsheet: sheet })).rev).toBe(1)
    // the newer file opens as a cache of its own
    expect(open()).not.toBe(sheet)
  })

  it('a change that came as ours was being saved wins: the save answers a conflict and the file keeps the other writer\'s bytes', async () => {
    const sheet = open()
    // the file is replaced between the cache's write and the save
    const real = rig.ctx.service.internal
    Object.assign(rig.ctx.service, {
      internal: async (route: string, b: never) => {
        if (route.endsWith('/open')) writeFileSync(csv, 'name,hours\r\nTheirs,9,and more\r\n')
        return real(route, b)
      }
    })
    await expect(apply(sheet, 0, [typedAt(2, 0, 'Mine')])).rejects.toThrow('changed in its folder')
    expect(readFileSync(csv, 'utf8')).toBe('name,hours\r\nTheirs,9,and more\r\n')
  })

  it('a co-author\'s save while the change is made is not patched over with the cache\'s older fields', async () => {
    // Council r2 (Sol 1): the file was read after the service's wait, and the cache's 1.5 put back over the co-author's 9.50.
    const sheet = open()
    const theirs = 'name,hours\r\n"Ada",9.50\r\nBo,007\r\n'
    const made = throughCsv(rig.ctx, sheet, async () => {
      const got = await host.apply({ tcsheet: sheet }, 0, [typedAt(2, 1, 8)] as never, 'owner')
      writeFileSync(csv, theirs)
      return got
    })
    await expect(made).rejects.toThrow('changed in its folder')
    expect(readFileSync(csv, 'utf8')).toBe(theirs)
  })

  it('a suggestion changes no cell, so it never goes through to the file, even on a cache the file has moved past', async () => {
    const sheet = open()
    writeFileSync(csv, 'name,hours\r\nTheirs,9\r\n')
    utimesSync(csv, new Date(), new Date(Date.now() + 5000))
    const asked: string[] = []
    Object.assign(rig.ctx.service, { internal: async (route: string) => (asked.push(route), { rev: 0, count: 1 }) })
    const { host: hostCall } = await import('./held')
    expect(await hostCall(rig.ctx, 'cells', { sheet: { tcsheet: sheet }, cells: [{ at: 'A2', v: 'x' }], by: 'agent:h:t1', label: 'Suggested', suggest: true } as never)).toEqual({ rev: 0, count: 1 })
    expect(asked).toEqual(['/internal/sheet/cells'])
    expect(readFileSync(csv, 'utf8')).toBe('name,hours\r\nTheirs,9\r\n')
  })

  it('an edit the sheet refuses as stale is answered as it is, with nothing written', async () => {
    const sheet = open()
    await apply(sheet, 0, [typedAt(2, 0, 'Bob')])
    const text = readFileSync(csv, 'utf8')
    const got = await throughCsv(rig.ctx, sheet, async () => ({ conflict: true as const, rev: 1 }))
    expect(got).toEqual({ conflict: true, rev: 1 })
    expect(readFileSync(csv, 'utf8')).toBe(text)
  })

  it('a file that is not UTF-8, or in a folder he can only read, opens to read and takes no edit', async () => {
    writeFileSync(csv, Buffer.from([0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a]))
    expect(sharedCsvReadOnly(csv)).toBe(CSV_NOT_UTF8)
    const sheet = open()
    await expect(apply(sheet, 0, [typedAt(0, 0, 'x')])).rejects.toThrow(CSV_NOT_UTF8)
    expect([...readFileSync(csv)]).toEqual([0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a])
    const plain = join(general(), 'Plain.csv')
    writeFileSync(plain, 'a\n')
    expect(sharedCsvReadOnly(plain)).toBeNull()
    if (process.getuid?.() !== 0) {
      chmodSync(plain, 0o440)
      utimesSync(plain, new Date(), new Date(Date.now() + 9000))
      expect(sharedCsvReadOnly(plain)).toBe(CSV_NO_WRITE)
    }
  })

  it('a formula he types reaches the file as the value it gives, as a .csv keeps it', async () => {
    const sheet = open()
    await throughCsv(rig.ctx, sheet, () => host.apply({ tcsheet: sheet }, 0, [{ id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: 'sheet1', cellValue: { 1: { 2: { f: '=B2*2' } } } } }] as never, 'owner'))
    expect(readFileSync(csv, 'utf8')).toBe('name,hours\r\n"Ada",1.50,3\r\nBo,007\r\n')
  })

  it('a sheet from an earlier run is not guessed at', async () => {
    const sheet = open()
    forgetCsvCaches()
    await expect(apply(sheet, 0, [typedAt(0, 0, 'x')])).rejects.toThrow('Open the .csv again')
  })
})
