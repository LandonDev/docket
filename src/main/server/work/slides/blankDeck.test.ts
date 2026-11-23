import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterAll, describe, expect, it } from 'vitest'
import { DECK_THEMES, themeEdit } from '@shared/work/deckThemes'
import { SlideOpSchema } from '@shared/contract-work-slides'
import { fileMakerFor } from '../files/hooks'
import { BLANK_DECK } from './blankDeck'
import './index'

/** The blank deck Files makes through the deck kind's maker, and the themes a deck can be given. */
const dir = mkdtempSync(join(tmpdir(), 'tc-blank-deck-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('a new deck made in Files', () => {
  it('is a .pptx of one slide on the Title Slide layout, 16:9, with PowerPoint\'s own layouts', async () => {
    const zip = await JSZip.loadAsync(BLANK_DECK)
    const pres = await zip.file('ppt/presentation.xml')!.async('string')
    expect(pres).toContain('<p:sldSz cx="12192000" cy="6858000"')
    expect(pres.match(/<p:sldId /g)).toHaveLength(1)
    const layouts = await Promise.all(Object.keys(zip.files).filter((k) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(k)).map((k) => zip.file(k)!.async('string')))
    const names = layouts.map((xml) => /<p:cSld name="([^"]+)"/.exec(xml)![1]).sort()
    expect(names).toEqual(['Blank', 'Comparison', 'Content with Caption', 'Picture with Caption', 'Section Header', 'Title Only', 'Title Slide', 'Title and Content', 'Title and Vertical Text', 'Two Content', 'Vertical Title and Text'].sort())
    expect(await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')).toContain('slideLayout1.xml')
  })

  it('is written by the kind\'s maker where Files says, as a .pptx only, and never over a file', async () => {
    const maker = fileMakerFor('slides', 'pptx')!
    expect(maker.forms).toEqual(['pptx'])
    expect(fileMakerFor('slides', 'docx')).toBeNull()
    const path = join(dir, 'Untitled deck.pptx')
    await maker.blank({ form: 'pptx', path, title: 'Untitled deck' })
    expect(readFileSync(path).equals(BLANK_DECK)).toBe(true)
    await expect(maker.blank({ form: 'pptx', path, title: 'Untitled deck' })).rejects.toThrow()
    const other = join(dir, 'x.docx')
    await expect(maker.blank({ form: 'docx', path: other, title: 'x' })).rejects.toThrow('A deck is made as a .pptx')
    expect(existsSync(other)).toBe(false)
    writeFileSync(join(dir, 'keep.txt'), 'x')
  })
})

describe('the themes a deck can be given', () => {
  it('are whole themes, each a `theme` edit the deck tool takes', () => {
    expect(DECK_THEMES.map((t) => t.name)).toEqual(['Office', 'TempCode', 'Office 2007\u20132010', 'Greyscale'])
    for (const theme of DECK_THEMES) {
      expect(Object.keys(theme.colours).sort()).toEqual(['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'dk1', 'dk2', 'folHlink', 'hlink', 'lt1', 'lt2'])
      expect(Object.values(theme.colours).every((hex) => /^[0-9A-F]{6}$/.test(hex))).toBe(true)
      expect(SlideOpSchema.safeParse(themeEdit(theme)).success).toBe(true)
    }
  })
})
