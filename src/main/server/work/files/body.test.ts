import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { bodyOf } from './body'

/**
 * SharePoint's own touch (body.ts): an Office file it takes into a Teams library comes back with its columns as custom
 * XML, new properties, a [trash] and the relationships naming them, as the .docx of 2026-11-24 did; its body is the same.
 */

const DOC = '<w:document><w:body><w:p><w:r><w:t>Agenda doors</w:t></w:r></w:p></w:body></w:document>'
const docx = (doc: string, extra: Record<string, string> = {}, props = '<cp:coreProperties/>'): Uint8Array =>
  zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    '_rels/.rels': strToU8('<Relationships/>'),
    'docProps/core.xml': strToU8(props),
    'word/document.xml': strToU8(doc),
    'word/_rels/document.xml.rels': strToU8('<Relationships/>'),
    'word/styles.xml': strToU8('<w:styles/>'),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)]))
  })

describe("a file's body", () => {
  it("is the same after SharePoint's rewrite: custom XML, properties, its [trash] and the relationships naming them", () => {
    const sent = docx(DOC)
    const back = zipSync({
      '[Content_Types].xml': strToU8('<Types><Override PartName="/customXml/itemProps1.xml"/></Types>'),
      '_rels/.rels': strToU8('<Relationships/>'),
      'docProps/core.xml': strToU8('<cp:coreProperties><dcterms:modified>2026-11-24</dcterms:modified></cp:coreProperties>'),
      'docProps/custom.xml': strToU8('<Properties><property name="ContentTypeId"/></Properties>'),
      'word/document.xml': strToU8(DOC),
      'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship Target="../customXml/item1.xml"/></Relationships>'),
      'word/styles.xml': strToU8('<w:styles/>'),
      'customXml/item1.xml': strToU8('<ct:contentTypeSchema/>'),
      'customXml/itemProps1.xml': strToU8('<ds:datastoreItem/>'),
      'customXml/_rels/item1.xml.rels': strToU8('<Relationships/>'),
      '[trash]/0000.dat': strToU8('x')
    })
    expect(Buffer.compare(Buffer.from(sent), Buffer.from(back))).not.toBe(0)
    expect(bodyOf(back)).toBe(bodyOf(sent))
  })

  it("is the same for a file with no properties of its own: SharePoint links its own from the package's _rels/.rels (1.0.371)", () => {
    // Files' own blank: three parts, no docProps, no document relationships
    const blank = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), '_rels/.rels': strToU8('<Relationships><Relationship Target="word/document.xml"/></Relationships>'), 'word/document.xml': strToU8(DOC) })
    const back = zipSync({
      '[Content_Types].xml': strToU8('<Types><Override PartName="/docProps/custom.xml"/></Types>'),
      '_rels/.rels': strToU8('<Relationships><Relationship Target="word/document.xml"/><Relationship Target="docProps/custom.xml"/></Relationships>'),
      'word/document.xml': strToU8(DOC),
      'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship Target="../customXml/item1.xml"/></Relationships>'),
      'docProps/custom.xml': strToU8('<Properties/>'),
      'customXml/item1.xml': strToU8('<ct/>'),
      '[trash]/0000.dat': strToU8('x')
    })
    expect(bodyOf(back)).toBe(bodyOf(blank))
  })

  it('differs for any edit of the document, a picture added, or a style changed', () => {
    const sent = bodyOf(docx(DOC))
    expect(bodyOf(docx(DOC.replace('doors', 'gates')))).not.toBe(sent)
    expect(bodyOf(docx(DOC, { 'word/media/image1.png': 'png' }))).not.toBe(sent)
    expect(bodyOf(zipSync({ ...Object.fromEntries(Object.entries({ 'word/document.xml': DOC, 'word/styles.xml': '<w:styles><w:style/></w:styles>' }).map(([k, v]) => [k, strToU8(v)])) }))).not.toBe(bodyOf(zipSync({ 'word/document.xml': strToU8(DOC), 'word/styles.xml': strToU8('<w:styles/>') })))
  })

  it('is every byte of a file that is no package', () => {
    expect(bodyOf(strToU8('TempCode proof 1'))).not.toBe(bodyOf(strToU8('TempCode proof 2')))
    expect(bodyOf(strToU8('PK but not a zip'))).toBe(bodyOf(strToU8('PK but not a zip')))
  })
})
