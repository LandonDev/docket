import { describe, expect, it } from 'vitest'
import { formatForFile } from './saveAs'

describe('the format a document made of a file is saved in at first', () => {
  it("is the file's own where the host writes it, a .doc as .docx with its line, and none for any other file", () => {
    expect(formatForFile('Plan.docx')).toEqual({ format: 'docx' })
    expect(formatForFile('Plan.ODT')).toEqual({ format: 'odt' })
    expect(formatForFile('Notes.markdown')).toEqual({ format: 'md' })
    expect(formatForFile('Practice register.doc')).toEqual({ format: 'docx', note: 'A .doc is saved as .docx' })
    expect(formatForFile('Run of show.tcdoc')).toBeNull()
    expect(formatForFile('Budget.xlsx')).toBeNull()
  })
})
