import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IMPORT_REFUSED } from '@shared/work/sheets'
import { inspect } from './jobs'

const CORPUS = join(__dirname, 'harness', 'corpus')
let dir: string
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'tc-refusal-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A dummy workbook written for the test, under a "TempCode proof" name. */
const put = (bytes: Uint8Array): string => {
  const path = join(dir, 'TempCode proof refused.xlsx')
  writeFileSync(path, bytes)
  return path
}
const reason = (path: string): string | undefined => inspect(path).readOnly

describe('a workbook the importer refuses', () => {
  it('names a password by the file itself: an OLE file where a zip should be', () => {
    const ole = new Uint8Array(1024)
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    expect(reason(put(ole))).toBe(`${IMPORT_REFUSED}it has a password`)
  })

  it('names a binary workbook (.xlsb) by its xl/workbook.bin', () => {
    expect(reason(put(zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'xl/workbook.bin': new Uint8Array([1, 2, 3]) })))).toBe(`${IMPORT_REFUSED}it is a binary workbook (.xlsb)`)
  })

  it('names Strict Open XML by its namespace', () => {
    const parts = unzipSync(new Uint8Array(readFileSync(join(CORPUS, 'formulas.xlsx'))))
    // Strict's namespaces, and a workbook the importer cannot read for them
    parts['xl/workbook.xml'] = strToU8(strFromU8(parts['xl/workbook.xml']!).replace(/http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main/g, 'http://purl.oclc.org/ooxml/spreadsheetml/main').replace(/<sheets>[\s\S]*<\/sheets>/, '<sheets/>'))
    expect(reason(put(zipSync(parts)))).toBe(`${IMPORT_REFUSED}it is saved as Strict Open XML`)
  })

  it('passes any other reason on, for the window to say as a workbook it could not read', () => {
    expect(reason(put(strToU8('not a workbook at all, and long enough to be read as one: '.repeat(4))))).toBe(`${IMPORT_REFUSED}not a zip package`)
  })

  it('leaves a workbook it reads alone', () => {
    expect(reason(join(CORPUS, 'formulas.xlsx'))).toBeUndefined()
  })
})
