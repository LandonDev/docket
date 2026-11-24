import { readFileSync } from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'

/**
 * A document file's words as markdown, for the makers: a Word file through work-kit's reader (as the formats pillar
 * imports it and prep reads his notes), a `.tcdoc` from the markdown it keeps beside its state on every save
 * (`preview.md`). The caller has already placed the path in the caller's reach.
 */
export async function markdownOfFile(path: string): Promise<string> {
  if (/\.tcdoc$/i.test(path)) {
    const got = unzipSync(new Uint8Array(readFileSync(path)), { filter: (f) => f.name === 'preview.md' })['preview.md']
    return got ? strFromU8(got) : ''
  }
  if (/\.docx$/i.test(path)) {
    const [{ readDocx }, { writeMarkdown }] = await Promise.all([import('work-kit/formats/docx'), import('work-kit/formats/markdown')])
    return writeMarkdown(readDocx(new Uint8Array(readFileSync(path))).blocks)
  }
  throw new Error('A form is made from a Word document (.docx) or a TempCode document (.tcdoc).')
}
