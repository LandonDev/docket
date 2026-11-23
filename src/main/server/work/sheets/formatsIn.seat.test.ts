import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { teamsAppOf, teamsKindOf } from '@shared/contract-work-office'
import { kindOfEntry } from '@shared/work/files'
import { openAs } from '../files/handle'
import { locate } from '../files/policy'
import { at, HOST, makeRig, window, WS, type Rig } from '../files/testkit'

/**
 * Where Files seats an .xls, an .ods and a .tsv (SHT8; the line in files/handle.ts `openAs` is the
 * Files build's, asked for in SEAMS.md): in the sheet kind as the file it is, in his own folder and
 * in a team library alike, so the sheet editor opens its Excel copy and no Office app stands behind
 * it. An .xlsb, which the sheet kind does not read, keeps Excel.
 */
let rig: Rig
beforeEach(() => {
  rig = makeRig()
})
afterEach(() => rig.close())

describe('Files\' table and the Office apps', () => {
  it('an .xls, an .ods and a .tsv are sheets the sheet canvas shows; an .xlsb still has no viewer', () => {
    for (const name of ['Ledger.xls', 'Ledger.ods', 'Scores.tsv']) expect(kindOfEntry(name)).toMatchObject({ kind: 'sheet', canvas: 'sheet' })
    expect(kindOfEntry('Ledger.xlsb')).toMatchObject({ kind: 'sheet', canvas: null })
  })

  it('a .tsv has no Office app behind it, as a .csv has none; an .xls opened where its app is asked for still has Excel', () => {
    expect(teamsAppOf(teamsKindOf('Scores.tsv'), 'Scores.tsv')).toBeNull()
    expect(teamsAppOf(teamsKindOf('List.csv'), 'List.csv')).toBeNull()
    expect(teamsAppOf(teamsKindOf('Ledger.xls'), 'Ledger.xls')).toBe('excel')
  })
})

describe('an .xls, .ods or .tsv, seated by Files', () => {
  it('in a team library it opens in the sheet kind as the file it is', () => {
    for (const name of ['Ledger.xls', 'Ledger.ods', 'Scores.tsv']) {
      const path = join(rig.team, 'General', name)
      writeFileSync(path, 'dummy')
      const where = locate(rig.ctx, window, WS, at(path), 'work.files.open')
      expect(where.in).toBe('library')
      expect(openAs(rig.ctx, where, name)).toEqual({ kind: 'sheet', source: { at: 'file', host: HOST, path } })
    }
  })

  it('in his own folder too; an .xlsb in a library still has Excel behind it', () => {
    const own = join(rig.folder, 'Ledger.xls')
    writeFileSync(own, 'dummy')
    expect(openAs(rig.ctx, locate(rig.ctx, window, WS, at(own), 'work.files.open'), 'Ledger.xls')).toEqual({ kind: 'sheet', source: { at: 'file', host: HOST, path: own } })
    const binary = join(rig.team, 'General', 'Ledger.xlsb')
    writeFileSync(binary, 'dummy')
    expect(openAs(rig.ctx, locate(rig.ctx, window, WS, at(binary), 'work.files.open'), 'Ledger.xlsb').source.at).toBe('microsoft')
  })
})
