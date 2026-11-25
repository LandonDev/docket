import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { bodyOf, bodyOfAsync } from './body'

/** The body hash made off the loop (`bodyOfAsync`) is the one made on it (`bodyOf`), for a package and for plain bytes. */
describe('the body hash off the loop', () => {
  it('is the same hash as on the loop, SharePoint\'s parts left out alike', async () => {
    const doc = zipSync({ 'word/document.xml': strToU8('<w:document>hello</w:document>'), 'docProps/core.xml': strToU8('<cp/>'), '[Content_Types].xml': strToU8('<Types/>') })
    const touched = zipSync({ 'word/document.xml': strToU8('<w:document>hello</w:document>'), 'docProps/core.xml': strToU8('<cp>SharePoint</cp>'), 'customXml/item1.xml': strToU8('<x/>') })
    expect(await bodyOfAsync(doc)).toBe(bodyOf(doc))
    expect(await bodyOfAsync(touched)).toBe(bodyOf(doc))
    const text = Buffer.from('plain text')
    expect(await bodyOfAsync(text)).toBe(bodyOf(text))
    // Bytes that only begin like a package are their own body.
    const fake = Buffer.from('PKnot a zip')
    expect(await bodyOfAsync(fake)).toBe(bodyOf(fake))
  })
})
