import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { noisePng, planTree } from './make-pc-drive-bench'

const entriesAt = (tree: ReturnType<typeof planTree>, at: string): number => {
  const depth = at ? at.split('/').length + 1 : 1
  const under = (p: string): boolean => (at ? p.startsWith(`${at}/`) : true) && p.split('/').length === depth
  return tree.dirs.filter(under).length + tree.files.filter((f) => under(f.path)).length
}

describe('the PC drive bench tree', () => {
  it('has 300 entries at the top, 40 of them folders, and 100 at each of three levels down', () => {
    const tree = planTree()
    expect(entriesAt(tree, '')).toBe(300)
    expect(tree.dirs.filter((d) => !d.includes('/')).length).toBe(40)
    for (const at of ['A', 'A/B', 'A/B/C']) expect(entriesAt(tree, at)).toBe(100)
  })

  it('holds the three named files at their sizes, and is the same tree every time', () => {
    const tree = planTree()
    const named = Object.fromEntries(tree.files.filter((f) => !f.path.includes('/') && /^(Big|Deck|Report)\./.test(f.path)).map((f) => [f.path, f.size]))
    expect(named).toEqual({ 'Big.docx': 5 * 2 ** 20, 'Deck.pptx': 20 * 2 ** 20, 'Report.pdf': 10 * 2 ** 20 })
    expect(planTree()).toEqual(tree)
  })

  it('pads with a valid PNG of noise that does not compress', () => {
    const { png, side } = noisePng(300_000)
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(png.length).toBeGreaterThan(290_000)
    const idat = png.indexOf('IDAT')
    const len = png.readUInt32BE(idat - 4)
    expect(inflateSync(png.subarray(idat + 4, idat + 4 + len)).length).toBe(side * (side * 3 + 1))
  })
})
