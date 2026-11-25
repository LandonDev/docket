import { describe, expect, it } from 'vitest'
import { formatForFile, linkNeedsHim, linkWords, type DocLink } from './saveAs'

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

describe("a linked file's words", () => {
  const time = (): string => "3:04 PM"
  const l = (over: Partial<DocLink>) => ({ state: "saved" as const, place: "Events", at: 1, ...over })
  it("say Saved to a library only once OneDrive has the bytes, and a late upload needs him", () => {
    expect(linkWords(l({}), time)).toBe("Saved to Events 3:04 PM")
    expect(linkWords(l({ upload: "uploading" }), time)).toBe("Saved, uploading to Events…")
    expect(linkWords(l({ upload: "late" }), time)).toBe("Not uploaded to Events yet")
    expect(linkWords(l({ upload: "unknown" }), time)).toBe("Saved. OneDrive uploads it to Events")
    expect(linkNeedsHim(l({ upload: "late" }))).toBe(true)
    expect(linkNeedsHim(l({ upload: "uploading" }))).toBe(false)
  })
})
