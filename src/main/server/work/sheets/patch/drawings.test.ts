import { readObjects, type ObjectAnchor } from 'work-kit/sheet/xlsx'
import { expect, test } from 'vitest'
import { anchorMoved, anchorXml, checkedAnchor, ObjectsRefused, PackageEdit, Rels, sameAnchor, SheetDrawing } from './drawings'
import { fixture, held, names, parsed, withParts, xml } from './drawings-testkit'

const charts = fixture('charts.xlsx')
const objects = fixture('objects.xlsx')
const base = fixture('patch/base.xlsx')
const DRAWING = 'xl/drawings/drawing1.xml'
const CT = '[Content_Types].xml'
const cell = (column: number, row: number, columnOffset = 0, rowOffset = 0) => ({ column, row, columnOffset, rowOffset })
const twoCell: ObjectAnchor = { kind: 'twoCell', from: cell(1, 2), to: cell(6, 14, 9525, 19050), behaviour: 'twoCell' }
const shape = (p: string, id: number) =>
  `<${p}sp macro="" textlink=""><${p}nvSpPr><${p}cNvPr id="${id}" name="Box ${id}"/><${p}cNvSpPr/></${p}nvSpPr><${p}spPr/></${p}sp>`

function open(bytes: Uint8Array, sheet: string) {
  const edit = new PackageEdit(bytes)
  return { edit, drawing: new SheetDrawing(edit, edit.tab(sheet)!) }
}

test('every corpus chart and picture is owned by one anchor, placed where the reader places it', () => {
  for (const [bytes, sheets] of [
    [charts, ['Data', 'ChartSheet']],
    [objects, ['Objects']]
  ] as const) {
    const read = readObjects(bytes)
    expect(read.warnings).toEqual([])
    for (const sheet of sheets) {
      const { drawing } = open(bytes, sheet)
      const mine = [...read.charts, ...read.pictures].filter((o) => o.sheet === sheet)
      expect(mine.length).toBeGreaterThan(0)
      for (const object of mine) {
        const type = 'part' in object ? 'picture' : 'chart'
        const slot = drawing.slotOf(type, object.id, object.anchor)
        expect(slot?.anchor, object.id).toEqual(object.anchor)
        // Its place a cell to the right is no longer the reader's: not owned.
        const moved = structuredClone(object.anchor)
        if (moved.kind === 'absolute') moved.x += 9525
        else moved.from.columnOffset += 9525
        expect(drawing.slotOf(type, object.id, moved)).toBeUndefined()
        expect(drawing.slotOf(type, object.id, object.anchor, { left: 0, top: 0, width: 1, height: 1 })).toBeUndefined()
      }
    }
  }
  // The text box beside the two pictures is an anchor no object owns.
  expect(open(objects, 'Objects').drawing.slots.map((slot) => slot.refs.length)).toEqual([1, 1, 0])
})

test('an anchor is written per kind, and one with a field out of range is refused', () => {
  const body = shape('xdr:', 2)
  expect(anchorXml('xdr:', twoCell, body)).toBe(
    '<xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
      '<xdr:to><xdr:col>6</xdr:col><xdr:colOff>9525</xdr:colOff><xdr:row>14</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:to>' +
      body +
      '<xdr:clientData/></xdr:twoCellAnchor>'
  )
  expect(anchorXml('', { ...twoCell, behaviour: 'oneCell' }, '')).toMatch(/^<twoCellAnchor editAs="oneCell"><from>/)
  expect(anchorXml('xdr:', { kind: 'oneCell', from: cell(0, 0), width: 914400, height: 457200 }, '')).toContain(
    '</xdr:from><xdr:ext cx="914400" cy="457200"/><xdr:clientData/></xdr:oneCellAnchor>'
  )
  expect(anchorXml('xdr:', { kind: 'absolute', x: -5, y: 10, width: 1, height: 1 }, '')).toContain(
    '<xdr:absoluteAnchor><xdr:pos x="-5" y="10"/><xdr:ext cx="1" cy="1"/>'
  )
  for (const bad of [
    undefined,
    { ...twoCell, from: cell(16_384, 0) },
    { ...twoCell, from: cell(0, 1_048_576) },
    { ...twoCell, from: cell(0.5, 0) },
    { ...twoCell, to: cell(0, 14) },
    { ...twoCell, behaviour: 'sideways' },
    { kind: 'oneCell', from: cell(0, 0), width: 0, height: 5 },
    { kind: 'absolute', x: Number.NaN, y: 0, width: 5, height: 5 },
    { kind: 'floating' }
  ])
    expect(() => checkedAnchor(bad as ObjectAnchor)).toThrow(ObjectsRefused)
  // Extra fields and key order do not make two anchors differ.
  expect(sameAnchor(twoCell, { behaviour: 'twoCell', to: twoCell.to, from: { ...twoCell.from }, kind: 'twoCell' })).toBe(true)
  expect(anchorMoved({ behaviour: 'twoCell', to: twoCell.to, from: { ...twoCell.from }, kind: 'twoCell' }, twoCell)).toBe(false)
  expect(anchorMoved({ ...twoCell, to: cell(7, 14) }, twoCell)).toBe(true)
  // The file's own anchor is taken as it is, however odd: handed back, it has not moved; a new place is checked.
  const odd: ObjectAnchor = { ...twoCell, to: cell(0, 0) }
  expect(anchorMoved(structuredClone(odd), odd)).toBe(false)
  expect(anchorMoved(twoCell, odd)).toBe(true)
  expect(() => anchorMoved(odd, twoCell)).toThrow('An object’s lower right corner must come after its upper left.')
})

test('a move rewrites one anchor’s place and keeps what it holds; the kit reads the new place', () => {
  const { edit, drawing } = open(charts, 'Data')
  const before = readObjects(charts).charts.filter((c) => c.sheet === 'Data')
  const one: ObjectAnchor = { kind: 'oneCell', from: cell(3, 40, 100, 200), width: 3_000_000, height: 2_000_000 }
  drawing.move(drawing.slotOf('chart', before[0].id, before[0].anchor)!, one)
  drawing.move(drawing.slotOf('chart', before[1].id, before[1].anchor)!, { ...twoCell, behaviour: 'absolute' })
  // A move to where it already is changes nothing.
  drawing.move(drawing.slotOf('chart', before[2].id, before[2].anchor)!, before[2].anchor)
  drawing.flush()
  const { bytes, report } = edit.finish()
  held(charts, bytes, report, { changed: [DRAWING] })
  const after = readObjects(bytes).charts.filter((c) => c.sheet === 'Data')
  expect(after[0].anchor).toEqual(one)
  expect(after[1].anchor).toEqual({ ...twoCell, behaviour: 'absolute' })
  expect(after.slice(2).map((c) => c.anchor)).toEqual(before.slice(2).map((c) => c.anchor))
  expect(after.map((c) => ({ ...c, anchor: 0 }))).toEqual(before.map((c) => ({ ...c, anchor: 0 })))
  const text = xml(bytes, DRAWING)
  expect(text).toContain('<xdr:twoCellAnchor editAs="absolute"><xdr:from><xdr:col>1</xdr:col>')
  expect(text).toContain('<xdr:cNvPr id="2" name="Chart 1"/>')
})

test('a first anchor makes the drawing part, its link from the sheet and its content type', () => {
  const { edit, drawing } = open(base, 'Data')
  expect(drawing.path).toBeUndefined()
  drawing.guard()
  drawing.add(twoCell, shape(drawing.prefix, drawing.shape('Box').id))
  drawing.flush()
  const { bytes, report } = edit.finish()
  held(base, bytes, report, {
    changed: ['xl/worksheets/sheet1.xml', CT],
    added: [DRAWING, 'xl/worksheets/_rels/sheet1.xml.rels']
  })
  expect(xml(bytes, 'xl/worksheets/sheet1.xml')).toMatch(/<\/sheetData>.*<drawing xmlns:r="[^"]+" r:id="rId1"\/><\/worksheet>$/s)
  expect(xml(bytes, 'xl/worksheets/_rels/sheet1.xml.rels')).toContain(
    'Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"'
  )
  expect(xml(bytes, CT)).toContain(
    '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
  )
  expect(parsed(xml(bytes, DRAWING)).getElementsByTagName('xdr:twoCellAnchor')).toHaveLength(1)

  // A second anchor on the same sheet goes into the drawing it now has, with a shape id of its own.
  const again = open(bytes, 'Data')
  const next = again.drawing.shape('Box')
  expect(next).toEqual({ id: 3, name: 'Box 1' })
  again.drawing.add(twoCell, shape('xdr:', next.id))
  again.drawing.flush()
  const second = again.edit.finish()
  held(bytes, second.bytes, second.report, { changed: [DRAWING] })
  expect(parsed(xml(second.bytes, DRAWING)).getElementsByTagName('xdr:twoCellAnchor')).toHaveLength(2)

  // The last anchors removed: the drawing goes, with its link and its declaration, and the file is as it was.
  const last = open(second.bytes, 'Data')
  for (const slot of last.drawing.slots) last.drawing.remove(slot)
  last.drawing.flush()
  const gone = last.edit.finish()
  held(second.bytes, gone.bytes, gone.report, {
    changed: ['xl/worksheets/sheet1.xml', CT],
    removed: [DRAWING, 'xl/worksheets/_rels/sheet1.xml.rels']
  })
  expect(names(gone.bytes).toSorted()).toEqual(names(base).toSorted())
  expect(xml(gone.bytes, 'xl/worksheets/sheet1.xml')).toBe(xml(base, 'xl/worksheets/sheet1.xml'))
  expect(xml(gone.bytes, CT)).toBe(xml(base, CT))
})

test('an anchor removed beside others leaves the drawing and the other anchors’ bytes', () => {
  const { edit, drawing } = open(objects, 'Objects')
  const text = xml(objects, DRAWING)
  drawing.remove(drawing.slots[0])
  drawing.flush()
  const { bytes, report } = edit.finish()
  held(objects, bytes, report, { changed: [DRAWING] })
  const first = text.indexOf('<xdr:twoCellAnchor')
  expect(xml(bytes, DRAWING) === text.slice(0, first) + text.slice(text.indexOf('<xdr:twoCellAnchor', first + 1))).toBe(true)
})

test('relationships take the lowest free id, and a part with none left goes', () => {
  const edit = new PackageEdit(objects)
  const rels = new Rels(edit, DRAWING)
  expect(rels.list.map((rel) => [rel.id, rel.target, rel.external])).toEqual([
    ['rId1', 'xl/media/image2.png', false],
    ['rId2', 'https://example.com/img', true]
  ])
  expect(rels.add('chart', 'xl/charts/chart1.xml')).toBe('rId3')
  rels.drop('rId1')
  expect(rels.add('image', 'xl/media/image9.png')).toBe('rId4')
  rels.flush()
  const text = edit.text(rels.path)
  expect(text).not.toContain('Id="rId1"')
  expect(text).toContain('<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/img" TargetMode="External"/>')
  expect(text).toContain('<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>')
  expect(edit.referenced('xl/media/image2.png', new Set())).toBe(false)
  expect(edit.referenced('xl/media/image1.png', new Set())).toBe(true)
  expect(edit.referenced('xl/media/image1.png', new Set(['xl/richData/_rels/richValueRel.xml.rels']))).toBe(false)

  const empty = new PackageEdit(objects)
  const all = new Rels(empty, DRAWING)
  all.drop('rId1')
  all.drop('rId2')
  all.flush()
  expect(empty.finish().report.partsRemoved).toEqual([all.path])
})

test('a part name is free only when no part has it and none is declared under it; media take a Default', () => {
  const declared = withParts(base, {
    [CT]: xml(base, CT).replace('</Types>', '<Override PartName="/xl/charts/Chart1.xml" ContentType="x/y"/></Types>')
  })
  const edit = new PackageEdit(declared)
  expect(edit.free('xl/charts/chart', '.xml')).toBe('xl/charts/chart2.xml')
  expect(edit.free('xl/charts/chart', '.xml')).toBe('xl/charts/chart3.xml')
  edit.add('xl/media/image1.png', new Uint8Array([1]), { default: 'image/png' })
  edit.add('xl/media/image2.xml', new Uint8Array([2]), { default: 'image/svg+xml' })
  edit.add('xl/charts/chart2.xml', '<a/>', { override: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml' })
  const { bytes, report } = edit.finish()
  expect(report.partsAdded).toEqual(['xl/media/image1.png', 'xl/media/image2.xml', 'xl/charts/chart2.xml'])
  const types = xml(bytes, CT)
  expect(types).toContain('<Default Extension="png" ContentType="image/png"/><Override')
  // `xml` already means application/xml here, so the part says its own type.
  expect(types).toContain('<Override PartName="/xl/media/image2.xml" ContentType="image/svg+xml"/>')
  expect(types).toContain('<Override PartName="/xl/charts/chart2.xml"')
  parsed(types)
})

test('a locked sheet, a drawing the file lacks and a drawing in another namespace are refused in words', () => {
  const sheet = 'xl/worksheets/sheet1.xml'
  const protect = (attrs: string) =>
    withParts(base, { [sheet]: xml(base, sheet).replace('</sheetData>', `</sheetData><sheetProtection ${attrs}/>`) })
  expect(() => open(protect('sheet="1" objects="1"'), 'Data').drawing.guard()).toThrow(/protected/)
  // Protected, with Edit objects allowed: Excel lets him change them, so do we.
  expect(() => open(protect('sheet="1"'), 'Data').drawing.guard()).not.toThrow()

  const lost = withParts(objects, {
    'xl/worksheets/_rels/sheet1.xml.rels': xml(objects, 'xl/worksheets/_rels/sheet1.xml.rels').replace('drawing1.xml', 'drawing9.xml')
  })
  expect(() => open(lost, 'Objects').drawing.guard()).toThrow('“Objects” names a drawing the file does not have.')

  const strict = withParts(objects, {
    [DRAWING]: xml(objects, DRAWING).replace('http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing', 'http://purl.oclc.org/ooxml/drawingml/spreadsheetDrawing')
  })
  const { drawing } = open(strict, 'Objects')
  expect(() => drawing.guard()).toThrow(ObjectsRefused)
  expect(drawing.slotOf('picture', `${DRAWING}#1`, drawing.slots[0].anchor!)).toBeUndefined()
})
