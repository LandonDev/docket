import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileDocStore } from 'work-kit/collab-server'
import { TcsheetBackend } from '../sheets/host/backends'
import { readZip } from '../sheets/patch/zip'
import { blankOf, formIn, notOffered, offersIn, templateExts, templateRefused } from './make'

/** What New makes where, as pure rules, and the blank files it ships (docs/agents/work-files.md "New, rename, move and copy"). */

const none = (): boolean => false
const blank = (form: 'docx' | 'xlsx' | 'pptx' | 'tcdoc' | 'tcsheet'): { path: string; bytes: Uint8Array } => {
  const path = (blankOf(form) as { from: string }).from
  return { path, bytes: new Uint8Array(readFileSync(path)) }
}

describe('the form follows the place', () => {
  it("keeps our own forms in the workspace's folder and Office's in a library", () => {
    expect((['document', 'sheet', 'deck', 'text', 'folder'] as const).map((k) => formIn({ kind: 'folder' }, k))).toEqual(['tcdoc', 'tcsheet', 'pptx', 'md', null])
    expect((['document', 'sheet', 'deck', 'text', 'folder'] as const).map((k) => formIn({ kind: 'teams' }, k))).toEqual(['docx', 'xlsx', 'pptx', 'txt', null])
    expect(formIn({ kind: 'onedrive' }, 'document')).toBe('docx')
    expect(formIn({ kind: 'recent' }, 'document')).toBeNull()
  })

  it('takes a template of a form the kind opens as itself there', () => {
    expect(templateExts({ kind: 'folder' }, 'document')).toEqual(['tcdoc', 'docx'])
    expect(templateExts({ kind: 'teams' }, 'document')).toEqual(['docx'])
    expect(templateRefused({ kind: 'teams' }, 'sheet', 'Plan.tcsheet')).toBe('Plan.tcsheet cannot start a sheet here. Pick a .xlsx file.')
  })
})

describe('what New offers', () => {
  it('offers only what opens ready to edit in the place', () => {
    expect(offersIn({ kind: 'folder' }, none)).toEqual(['document', 'sheet', 'deck', 'text', 'folder'])
    expect(offersIn({ kind: 'teams' }, none)).toEqual(['text', 'folder'])
    expect(offersIn({ kind: 'onedrive' }, none, true)).toEqual(['sheet', 'text', 'folder'])
    expect(offersIn({ kind: 'teams' }, (kind, form) => (kind === 'document' && form === 'docx') || (kind === 'slides' && form === 'pptx'))).toEqual(['document', 'deck', 'text', 'folder'])
    expect(offersIn({ kind: 'teams' }, (kind, form) => kind === 'sheet' && form === 'xlsx')).toEqual(['sheet', 'text', 'folder'])
    // A maker of our own forms does not make a library offer the kind.
    expect(offersIn({ kind: 'teams' }, (_kind, form) => form === 'tcdoc' || form === 'tcsheet')).toEqual(['text', 'folder'])
    expect(offersIn({ kind: 'teams', vm: true }, () => true, true)).toEqual([])
    // In the VM where its helper makes things: a folder and a text file, an Office file where a maker writes it, and never for this host's Excel.
    expect(offersIn({ kind: 'teams', vm: true, can: ['make'] }, () => false, true)).toEqual(['text', 'folder'])
    expect(offersIn({ kind: 'teams', vm: true, can: ['make'] }, (kind, form) => kind === 'document' && form === 'docx')).toEqual(['document', 'text', 'folder'])
    expect(offersIn({ kind: 'recent' }, () => true)).toEqual([])
  })

  it('says in one sentence why a kind is not offered', () => {
    expect(notOffered({ name: 'Esports Staff' }, 'document')).toBe("A document cannot be made in Esports Staff yet. Make it in Word, or in your workspace's folder.")
    expect(notOffered({ name: 'Esports Staff', vm: true }, 'text')).toBe('Files in the Windows VM cannot be changed from here yet. Open it there.')
    expect(notOffered({ name: 'Esports Staff', vm: true, can: ['make'] }, 'deck')).toBe("A deck cannot be made in Esports Staff yet. Make it in PowerPoint, or in your workspace's folder.")
  })
})

describe('the blank files', () => {
  it('are whole Office files, each with its main part', () => {
    const parts = (form: 'docx' | 'xlsx' | 'pptx'): string[] => readZip(blank(form).bytes).entries.map((e) => e.name)
    expect(parts('docx')).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']))
    expect(parts('xlsx')).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']))
    expect(parts('pptx')).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/slides/slide1.xml']))
    expect(blankOf('md')).toEqual(new Uint8Array(0))
    expect(blankOf('txt')).toEqual(new Uint8Array(0))
  })

  it('open with the code that reads our own documents and sheets', async () => {
    expect((await new FileDocStore().load('blank', { path: blank('tcdoc').path })).state).not.toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'tc-blank-'))
    try {
      const copy = join(dir, 'Untitled sheet.tcsheet')
      writeFileSync(copy, blank('tcsheet').bytes)
      const sheet = await new TcsheetBackend(copy).load()
      expect(sheet).toMatchObject({ title: 'Untitled sheet', rev: 0 })
      expect(Object.keys(sheet.snapshot.sheets ?? {})).toEqual(['sheet1'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
