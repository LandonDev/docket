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

  it("differs when only a link's target changed, or anything in the package SharePoint was never seen to write", () => {
    const link = (target: string): Uint8Array =>
      docx(DOC, { 'word/_rels/document.xml.rels': `<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/></Relationships>` })
    expect(bodyOf(link('https://example.com/TempCode-proof-b'))).not.toBe(bodyOf(link('https://example.com/TempCode-proof-a')))
    // a title in the properties, a part's content type, the document's own properties
    expect(bodyOf(docx(DOC, {}, '<cp:coreProperties><dc:title>TempCode proof</dc:title></cp:coreProperties>'))).not.toBe(bodyOf(docx(DOC)))
    expect(bodyOf(docx(DOC, { '[Content_Types].xml': '<Types><Override PartName="/word/styles.xml" ContentType="a"/></Types>' }))).not.toBe(bodyOf(docx(DOC, { '[Content_Types].xml': '<Types><Override PartName="/word/styles.xml" ContentType="b"/></Types>' })))
    expect(bodyOf(docx(DOC, { 'docProps/app.xml': '<Properties><Company>TempCode proof</Company></Properties>' }))).not.toBe(bodyOf(docx(DOC, { 'docProps/app.xml': '<Properties/>' })))
  })

  it("is the same when only a save's bookkeeping in the properties moved, or the same entries are written another way", () => {
    const props = (when: string, who: string): string => `<cp:coreProperties><dc:title>Plan</dc:title><cp:lastModifiedBy>${who}</cp:lastModifiedBy><cp:revision>${when.length}</cp:revision><dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified></cp:coreProperties>`
    expect(bodyOf(docx(DOC, {}, props('2026-11-24T10:00:00Z', 'A')))).toBe(bodyOf(docx(DOC, {}, props('2026-11-25T10:00:00.5Z', 'SharePoint'))))
    const rels = (xml: string): Uint8Array => docx(DOC, { 'word/_rels/document.xml.rels': xml })
    expect(bodyOf(rels(`<Relationships><Relationship Id="rId1" Type="t" Target="styles.xml"/></Relationships>`))).toBe(bodyOf(rels(`<?xml version="1.0"?>\n<Relationships xmlns="x"><Relationship Target='styles.xml' Type='t' Id='rId1'></Relationship></Relationships>`)))
  })

  it('is every byte of a file that is no package', () => {
    expect(bodyOf(strToU8('TempCode proof 1'))).not.toBe(bodyOf(strToU8('TempCode proof 2')))
    expect(bodyOf(strToU8('PK but not a zip'))).toBe(bodyOf(strToU8('PK but not a zip')))
  })
})
