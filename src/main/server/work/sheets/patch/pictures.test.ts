import { readMedia, readObjects, type ObjectAnchor } from 'work-kit/sheet/xlsx'
import { expect, test } from 'vitest'
import { fixture, held, keep, names, parsed, withParts, xml } from './drawings-testkit'
import {
  patchPictures,
  PicturesRefused,
  readPictures,
  type PictureModel,
  type PicturesEdit
} from './pictures'

const objects = fixture('objects.xlsx')
const base = fixture('patch/base.xlsx')
const DRAWING = 'xl/drawings/drawing1.xml'
const DRAWING_RELS = 'xl/drawings/_rels/drawing1.xml.rels'
const SHEET = 'xl/worksheets/sheet1.xml'
const SHEET_RELS = 'xl/worksheets/_rels/sheet1.xml.rels'
const CT = '[Content_Types].xml'
const P1 = `${DRAWING}#1`
const P2 = `${DRAWING}#2`

const b64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'))
const PNG = b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')
const PNG2 = b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=')
const JPEG = b64(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////' +
    '////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='
)
const GIF = b64('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
/** A 1x1 24-bit bitmap: the file header, a 40-byte info header, one pixel and its row's padding. */
const BMP = (() => {
  const bytes = new Uint8Array(58)
  const view = new DataView(bytes.buffer)
  bytes.set([0x42, 0x4d])
  view.setUint32(2, 58, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, 1, true)
  view.setInt32(22, 1, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  view.setUint32(34, 4, true)
  bytes.set([0x30, 0x60, 0x90], 54)
  return bytes
})()

const cell = (column: number, row: number, columnOffset = 0, rowOffset = 0) => ({ column, row, columnOffset, rowOffset })
const at = (column: number, row: number): Extract<ObjectAnchor, { kind: 'twoCell' }> => ({
  kind: 'twoCell',
  from: cell(column, row),
  to: cell(column + 2, row + 4),
  behaviour: 'oneCell'
})
const A1 = (c: { column: number; row: number }) => String.fromCharCode(65 + c.column) + (c.row + 1)
const pictures = (bytes: Uint8Array, sheet: string) => readPictures(bytes, sheet).sheets[sheet].pictures
const edit = (sheet: string, list: PictureModel[]): PicturesEdit => ({ kind: 'pictures', sheet, pictures: list })
const fresh = (id: string, bytes: Uint8Array, anchor: ObjectAnchor = at(6, 1), more: Partial<PictureModel> = {}): PictureModel => ({
  id,
  sheet: 'Data',
  anchor,
  bytes,
  ...more
})

/** Keeps a main case's workbook for the Excel proof, when a proof folder is named. */
function proof(name: string, bytes: Uint8Array, description: string) {
  const sheets = readPictures(bytes).sheets
  const expect: Record<string, { pictures: { name?: string; from?: string; contentType: string }[] }> = {}
  for (const [sheet, { pictures }] of Object.entries(sheets))
    expect[sheet] = {
      pictures: pictures.map((p) => ({
        name: p.name,
        from: p.anchor.kind === 'absolute' ? undefined : A1(p.anchor.from),
        contentType: p.contentType
      }))
    }
  keep('PICTURES_PROOF_DIR', name, bytes, { description, expect, pictures: sheets })
}

function refused(bytes: Uint8Array, edits: PicturesEdit[], words: string | RegExp) {
  const copy = bytes.slice()
  expect(() => patchPictures(bytes, edits)).toThrow(PicturesRefused)
  expect(() => patchPictures(bytes, edits)).toThrow(words)
  expect(Buffer.from(bytes).equals(Buffer.from(copy))).toBe(true)
}

test('the corpus reads as the kit reads it, grouped by worksheet', () => {
  const read = readPictures(objects)
  expect(read.warnings).toEqual([])
  expect(Object.keys(read.sheets)).toEqual(['Objects', 'Second'])
  expect(read.sheets.Second.pictures).toEqual([])
  expect(read.sheets.Objects.pictures).toEqual(readObjects(objects).pictures)
  expect(read.sheets.Objects.pictures.map((p) => [p.id, p.part, p.contentType, p.name, p.description])).toEqual([
    [P1, 'xl/media/image2.png', 'image/png', 'Picture 1', '.lab_image.png'],
    [P2, 'xl/media/image2.png', 'image/png', 'Picture 2', '.lab_image.png']
  ])
  expect(Object.keys(readPictures(objects, 'Second').sheets)).toEqual(['Second'])
  expect(() => readPictures(objects, 'Nope')).toThrow('No worksheet named “Nope”.')
  expect(() => readPictures(fixture('charts.xlsx'), 'ChartSheet')).toThrow(PicturesRefused)
})

test('a list handed back as read is the same bytes object, with an empty report', () => {
  const list: PictureModel[] = pictures(objects, 'Objects')
  const same = patchPictures(objects, [edit('Objects', list), edit('Second', [])])
  expect(same.bytes).toBe(objects)
  expect(same.report).toEqual({ partsChanged: [], partsAdded: [], partsRemoved: [], ids: { [P1]: P1, [P2]: P2 } })
  // Its own image handed back, a name left out and the fields in another order change nothing either.
  const image = readMedia(objects, 'xl/media/image2.png')!
  const again = list.map(({ id, sheet, anchor, description }) => ({ description, anchor: { ...anchor }, sheet, id, bytes: image }))
  expect(patchPictures(objects, [edit('Objects', again)]).bytes).toBe(objects)
  expect(patchPictures(base, [edit('Data', [])]).bytes).toBe(base)
})

test('a first picture on a sheet with no drawing makes the drawing, its links, the type and the media', () => {
  const anchor = at(6, 1)
  const { bytes, report } = patchPictures(base, [
    edit('Data', [fresh('new', PNG, anchor, { name: 'Logo', description: 'The logo' })])
  ])
  held(base, bytes, report, {
    changed: [SHEET, CT],
    added: [DRAWING, DRAWING_RELS, SHEET_RELS, 'xl/media/image1.png']
  })
  expect(report.ids).toEqual({ new: P1 })
  const [picture] = pictures(bytes, 'Data')
  expect(picture).toEqual({
    id: P1,
    sheet: 'Data',
    anchor,
    part: 'xl/media/image1.png',
    contentType: 'image/png',
    name: 'Logo',
    description: 'The logo'
  })
  expect(readMedia(bytes, picture.part)).toEqual(PNG)
  expect(readObjects(bytes).warnings).toEqual([])
  expect(xml(bytes, DRAWING)).toContain(
    `<xdr:pic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      '<xdr:nvPicPr><xdr:cNvPr id="2" name="Logo" descr="The logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
      '<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
      '<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/>'
  )
  expect(xml(bytes, DRAWING_RELS)).toContain(
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>'
  )
  expect(xml(bytes, CT)).toContain('<Default Extension="png" ContentType="image/png"/>')
  proof('first-picture', bytes, 'One PNG named Logo at G2 on Data, a sheet that had no drawing.')
})

test('a picture added beside others takes a fresh shape id, relationship and media name, and the rest stays', () => {
  const before = xml(objects, DRAWING)
  const list = [...pictures(objects, 'Objects'), fresh('new', PNG2, at(2, 30))]
  const { bytes, report } = patchPictures(objects, [edit('Objects', list)])
  held(objects, bytes, report, { changed: [DRAWING, DRAWING_RELS], added: ['xl/media/image3.png'] })
  expect(report.ids).toEqual({ [P1]: P1, [P2]: P2, new: `${DRAWING}#3` })
  const text = xml(bytes, DRAWING)
  const close = before.lastIndexOf('</xdr:wsDr>')
  expect(text.startsWith(before.slice(0, close))).toBe(true)
  expect(text).toContain('<xdr:cNvPr id="5" name="Picture 3"/>')
  expect(text).toContain('<a:blip r:embed="rId3"/>')
  expect(xml(bytes, DRAWING_RELS)).toContain('Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image3.png"')
  const read = pictures(bytes, 'Objects')
  expect(read.slice(0, 2)).toEqual(pictures(objects, 'Objects'))
  expect(read[2]).toMatchObject({ part: 'xl/media/image3.png', name: 'Picture 3', anchor: at(2, 30) })
  proof('beside-others', bytes, 'A third picture at C31 on Objects beside the two that share one image and a text box.')
})

test('PNG, JPEG, GIF and BMP are known by their bytes, each with its extension and type', () => {
  for (const [image, ext, type] of [
    [PNG, 'png', 'image/png'],
    [JPEG, 'jpeg', 'image/jpeg'],
    [GIF, 'gif', 'image/gif'],
    [BMP, 'bmp', 'image/bmp']
  ] as const) {
    const part = `xl/media/image1.${ext}`
    const { bytes, report } = patchPictures(base, [edit('Data', [fresh('x', image, at(1, 1), { contentType: type })])])
    held(base, bytes, report, { changed: [SHEET, CT], added: [DRAWING, DRAWING_RELS, SHEET_RELS, part] })
    expect(xml(bytes, CT)).toContain(`<Default Extension="${ext}" ContentType="${type}"/>`)
    expect(pictures(bytes, 'Data')[0]).toMatchObject({ part, contentType: type, name: 'Picture 1' })
    expect(readMedia(bytes, part)).toEqual(image)
    proof(`format-${ext}`, bytes, `One ${ext.toUpperCase()} picture at B2 on Data.`)
  }
})

test('new pictures with the same bytes share one media part, and one relationship in one drawing', () => {
  const { bytes, report } = patchPictures(base, [
    edit('Data', [fresh('a', PNG, at(1, 1)), fresh('b', PNG, at(5, 1))]),
    edit('Untouched', [{ ...fresh('c', PNG, at(1, 1)), sheet: 'Untouched' }])
  ])
  held(base, bytes, report, {
    changed: [SHEET, 'xl/worksheets/sheet2.xml', CT],
    added: [
      DRAWING,
      DRAWING_RELS,
      SHEET_RELS,
      'xl/drawings/drawing2.xml',
      'xl/drawings/_rels/drawing2.xml.rels',
      'xl/worksheets/_rels/sheet2.xml.rels',
      'xl/media/image1.png'
    ]
  })
  expect(xml(bytes, DRAWING).match(/r:embed="rId1"/g)).toHaveLength(2)
  expect(xml(bytes, DRAWING_RELS).match(/<Relationship /g)).toHaveLength(1)
  expect(report.ids).toEqual({ a: P1, b: P2, c: 'xl/drawings/drawing2.xml#1' })
  // A new picture whose bytes the drawing already links takes that relationship.
  const image = readMedia(objects, 'xl/media/image2.png')!
  const reuse = patchPictures(objects, [edit('Objects', [...pictures(objects, 'Objects'), fresh('d', image)])])
  held(objects, reuse.bytes, reuse.report, { changed: [DRAWING] })
  expect(xml(reuse.bytes, DRAWING).match(/r:embed="rId1"/g)).toHaveLength(3)
})

test('a move or a size changes the drawing part alone, for each kind of anchor', () => {
  const [one, two] = pictures(objects, 'Objects')
  const before = xml(objects, DRAWING)
  for (const anchor of [
    { kind: 'oneCell', from: cell(2, 3, 100, 200), width: 914400, height: 457200 },
    { kind: 'absolute', x: 9525, y: 19050, width: 1_000_000, height: 500_000 },
    { kind: 'twoCell', from: cell(1, 1), to: cell(4, 9, 50, 60), behaviour: 'twoCell' },
    { kind: 'twoCell', from: cell(1, 1), to: cell(4, 9), behaviour: 'absolute' }
  ] satisfies ObjectAnchor[]) {
    const { bytes, report } = patchPictures(objects, [edit('Objects', [{ ...one, anchor }, two])])
    held(objects, bytes, report, { changed: [DRAWING] })
    expect(report.ids).toEqual({ [P1]: P1, [P2]: P2 })
    const read = pictures(bytes, 'Objects')
    expect(read[0]).toEqual({ ...one, anchor })
    expect(read[1]).toEqual(two)
    // What the anchor holds stays byte for byte, its xfrm too.
    const pic = (text: string) => text.slice(text.indexOf('<xdr:pic>'), text.indexOf('</xdr:pic>'))
    expect(pic(xml(bytes, DRAWING))).toBe(pic(before))
    if (anchor.kind === 'oneCell') proof('moved-one-cell', bytes, 'Picture 1 moved to C4 as a one-cell anchor.')
  }
})

test('a name and a description are spliced into the picture’s cNvPr, and nothing else changes', () => {
  const [one, two] = pictures(objects, 'Objects')
  const { bytes, report } = patchPictures(objects, [
    edit('Objects', [{ ...one, name: 'Lab' }, { ...two, description: undefined }])
  ])
  held(objects, bytes, report, { changed: [DRAWING] })
  const before = xml(objects, DRAWING)
  expect(xml(bytes, DRAWING)).toBe(
    before
      .replace('<xdr:cNvPr id="2" name="Picture 1" descr=".lab_image.png"/>', '<xdr:cNvPr id="2" name="Lab" descr=".lab_image.png"/>')
      .replace('<xdr:cNvPr id="3" name="Picture 2" descr=".lab_image.png">', '<xdr:cNvPr id="3" name="Picture 2">')
  )
  const read = pictures(bytes, 'Objects')
  expect(read[0]).toEqual({ ...one, name: 'Lab' })
  expect(read[1]).toEqual({ ...two, description: undefined })
  // A description added where there was none.
  const added = patchPictures(bytes, [edit('Objects', [read[0], { ...read[1], description: 'Alt text' }])])
  expect(pictures(added.bytes, 'Objects')[1].description).toBe('Alt text')
  proof('renamed', bytes, 'Picture 1 renamed Lab; Picture 2 lost its description.')
})

test('new bytes replace one picture’s image; the shared media stays while the other still uses it', () => {
  const [one, two] = pictures(objects, 'Objects')
  const { bytes, report } = patchPictures(objects, [edit('Objects', [{ ...one, bytes: JPEG, contentType: 'image/jpeg' }, two])])
  held(objects, bytes, report, { changed: [DRAWING, DRAWING_RELS, CT], added: ['xl/media/image1.jpeg'] })
  const read = pictures(bytes, 'Objects')
  expect(read[0]).toEqual({ ...one, part: 'xl/media/image1.jpeg', contentType: 'image/jpeg' })
  expect(read[1]).toEqual(two)
  expect(xml(bytes, DRAWING)).toBe(xml(objects, DRAWING).replace('r:embed="rId1"', 'r:embed="rId3"'))
  proof('replaced', bytes, 'Picture 1 shows a JPEG now; Picture 2 keeps the PNG.')

  // Both replaced: the old media and its relationship go; the in-cell picture's image1.png stays.
  const both = patchPictures(objects, [edit('Objects', [{ ...one, bytes: PNG2 }, { ...two, bytes: PNG2 }])])
  held(objects, both.bytes, both.report, {
    changed: [DRAWING, DRAWING_RELS],
    added: ['xl/media/image3.png'],
    removed: ['xl/media/image2.png']
  })
  expect(xml(both.bytes, DRAWING_RELS)).not.toContain('Id="rId1"')
  expect(pictures(both.bytes, 'Objects').map((p) => p.part)).toEqual(['xl/media/image3.png', 'xl/media/image3.png'])
})

test('removing pictures that share media: the media goes with the last, the text box and in-cell image stay', () => {
  const [, two] = pictures(objects, 'Objects')
  const first = patchPictures(objects, [edit('Objects', [two])])
  held(objects, first.bytes, first.report, { changed: [DRAWING] })
  expect(first.report.ids).toEqual({ [P2]: P1 })
  expect(pictures(first.bytes, 'Objects')).toEqual([{ ...two, id: P1 }])

  const second = patchPictures(first.bytes, [edit('Objects', [])])
  // The image and the hyperlink were the drawing's only relationships: its rels part goes.
  held(first.bytes, second.bytes, second.report, {
    changed: [DRAWING],
    removed: [DRAWING_RELS, 'xl/media/image2.png']
  })
  expect(names(second.bytes)).toContain('xl/media/image1.png')
  expect(xml(second.bytes, DRAWING)).toContain('<xdr:txBody>')
  expect(xml(second.bytes, DRAWING)).not.toContain('<xdr:pic>')
  expect(readObjects(second.bytes).warnings).toEqual([])
  proof('removed-both', second.bytes, 'No pictures on Objects; the text box stays.')
})

test('the only picture removed from a sheet leaves its parts and its XML as they were', () => {
  const added = patchPictures(base, [edit('Data', [fresh('x', PNG)])]).bytes
  const { bytes, report } = patchPictures(added, [edit('Data', [])])
  held(added, bytes, report, {
    changed: [SHEET, CT],
    removed: [DRAWING, DRAWING_RELS, SHEET_RELS, 'xl/media/image1.png']
  })
  expect(names(bytes).toSorted()).toEqual(names(base).toSorted())
  expect(xml(bytes, SHEET)).toBe(xml(base, SHEET))
  // The png Default stays declared: harmless, and PackageEdit keeps Defaults.
  expect(xml(bytes, CT)).toBe(xml(base, CT).replace('<Override', '<Default Extension="png" ContentType="image/png"/><Override'))
})

test('ids follow the final order: removals renumber, new pictures come last', () => {
  const [, two] = pictures(objects, 'Objects')
  const { bytes, report } = patchPictures(objects, [
    edit('Objects', [fresh('a', PNG, at(1, 40)), two, fresh('b', GIF, at(1, 50))])
  ])
  expect(report.ids).toEqual({ [P2]: P1, a: P2, b: `${DRAWING}#3` })
  const read = pictures(bytes, 'Objects')
  expect(read.map((p) => [p.id, p.contentType, A1((p.anchor as { from: { column: number; row: number } }).from)])).toEqual([
    [P1, 'image/png', 'G10'],
    [P2, 'image/png', 'B41'],
    [`${DRAWING}#3`, 'image/gif', 'B51']
  ])
  proof('renumbered', bytes, 'Picture 1 removed, Picture 2 kept, a PNG at B41 and a GIF at B51 added.')
})

test('refusals come in words before anything is written', () => {
  const [one, two] = pictures(objects, 'Objects')
  const list = [one, two]
  refused(objects, [edit('Nope', [])], 'No worksheet named “Nope”.')
  refused(fixture('charts.xlsx'), [edit('ChartSheet', [])], 'No worksheet named “ChartSheet”.')
  refused(objects, [edit('Objects', list), edit('Objects', list)], '“Objects” is listed twice: give one complete picture list for each tab.')
  refused(objects, [edit('Objects', [one, one])], 'The list for “Objects” names one picture twice.')
  refused(objects, [edit('Objects', [{ ...one, name: 'x'.repeat(256) }, two])], 'A picture’s name can be at most 255 characters.')
  refused(base, [edit('Data', [{ id: 'x', sheet: 'Data', anchor: at(1, 1) }])], 'A new picture needs its image.')
  refused(base, [edit('Data', [fresh('x', new Uint8Array())])], 'A new picture needs its image.')
  const huge = new Uint8Array(20 * 1024 * 1024 + 1)
  huge.set(PNG)
  refused(base, [edit('Data', [fresh('x', huge)])], 'An image can be at most 20 MB.')
  refused(base, [edit('Data', [fresh('x', new TextEncoder().encode('BM not a bitmap at all, only text'))])], 'The image is not a PNG, JPEG, GIF or BMP picture.')
  refused(base, [edit('Data', [fresh('x', PNG, at(1, 1), { contentType: 'image/jpeg' })])], 'The image is a PNG picture, not image/jpeg.')
  refused(objects, [edit('Objects', [{ ...one, bytes: GIF, contentType: 'image/png' }, two])], 'The image is a GIF picture, not image/png.')
  refused(base, [edit('Data', [fresh('x', PNG, at(1, 1), { frame: { left: 0, top: 0, width: 1, height: 1 } })])], 'A new picture cannot be placed inside a group.')
  refused(base, [edit('Data', [fresh('x', PNG, { kind: 'oneCell', from: cell(1, 1), width: 0, height: 5 })])], 'Give the object a width and a height.')
  refused(objects, [edit('Objects', [{ ...one, anchor: { ...at(1, 1), to: cell(0, 0) } }, two])], 'An object’s lower right corner must come after its upper left.')
  const many = Array.from({ length: 1_999 }, (_, i) => fresh(`n${i}`, PNG, at(1, i)))
  refused(objects, [edit('Objects', [...list, ...many])], 'A workbook can hold at most 2,000 pictures.')
  // Exactly 2,000 is allowed, and so is a list that removes as many as it adds.
  expect(patchPictures(objects, [edit('Objects', many.slice(1).concat([one, fresh('z', PNG)]))]).report.partsChanged).toContain(DRAWING)

  const locked = withParts(objects, { [SHEET]: xml(objects, SHEET).replace('<drawing ', '<sheetProtection sheet="1" objects="1"/><drawing ') })
  refused(locked, [edit('Objects', [{ ...one, name: 'Lab' }, two])], '“Objects” is protected. Unprotect the sheet in Excel before changing its charts and pictures.')
  // Handed back as read, a locked sheet's pictures cost nothing.
  expect(patchPictures(locked, [edit('Objects', pictures(locked, 'Objects'))]).bytes).toBe(locked)
})

test('a picture in a group cannot be moved, renamed, replaced, regrouped or removed, and stays as it is', () => {
  const text = xml(objects, DRAWING)
  const first = text.indexOf('<xdr:pic>')
  const end = text.indexOf('</xdr:pic>') + '</xdr:pic>'.length
  const group =
    '<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="9" name="Group 9"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr>' +
    '<xdr:grpSpPr><a:xfrm><a:off x="3657600" y="190500"/><a:ext cx="457200" cy="304800"/>' +
    '<a:chOff x="3657600" y="190500"/><a:chExt cx="457200" cy="304800"/></a:xfrm></xdr:grpSpPr>' +
    text.slice(first, end) +
    '</xdr:grpSp>'
  const grouped = withParts(objects, { [DRAWING]: text.slice(0, first) + group + text.slice(end) })
  const [one, two] = pictures(grouped, 'Objects')
  expect(one.frame).toEqual({ left: 0, top: 0, width: 1, height: 1 })
  const words = '“Picture 1” is part of a group (or sits in a drawing this editor cannot change): move or remove it in Excel.'
  for (const list of [
    [{ ...one, anchor: at(1, 1) }, two],
    [{ ...one, name: 'Lab' }, two],
    [{ ...one, bytes: PNG2 }, two],
    [{ ...one, frame: { left: 0.5, top: 0, width: 0.5, height: 1 } }, two],
    [two]
  ])
    refused(grouped, [edit('Objects', list)], words)
  expect(patchPictures(grouped, [edit('Objects', [one, two])]).bytes).toBe(grouped)
  // The picture beside the group still changes.
  const renamed = patchPictures(grouped, [edit('Objects', [one, { ...two, name: 'Free' }])])
  expect(pictures(renamed.bytes, 'Objects')[1].name).toBe('Free')
})

test('a hostile name and description are written as plain XML text; a character XML cannot carry is left out', () => {
  // Excel reads a drawing's names as plain strings (seen in Excel): `_x0041_` is seven characters
  // there, never an "A", so it is written as it is and not escaped the way a cell's text would be.
  const typed = 'Odd <&"> \u0001 name'
  const name = 'Odd <&">  name'
  const description = 'Line one\nline two\t“quoted” \' &amp;'
  const { bytes } = patchPictures(base, [edit('Data', [fresh('x', PNG, at(1, 1), { name: typed, description })])])
  parsed(xml(bytes, DRAWING))
  expect(xml(bytes, DRAWING)).toContain('name="Odd &lt;&amp;&quot;&gt;  name" descr="Line one&#10;line two&#9;“quoted” \' &amp;amp;"')
  expect(pictures(bytes, 'Data')[0]).toMatchObject({ name, description })
  // The name as typed, handed in again over the output, is the name the file has: nothing to write.
  expect(patchPictures(bytes, [edit('Data', [{ ...pictures(bytes, 'Data')[0], name: typed }])]).bytes === bytes).toBe(true)
  const [one, two] = pictures(objects, 'Objects')
  const renamed = patchPictures(objects, [edit('Objects', [{ ...one, name: 'Code _x0041_ kept', description }, two])])
  parsed(xml(renamed.bytes, DRAWING))
  expect(xml(renamed.bytes, DRAWING)).toContain('<xdr:cNvPr id="2" name="Code _x0041_ kept" descr="Line one&#10;line two&#9;“quoted” \' &amp;amp;"/>')
  expect(pictures(renamed.bytes, 'Objects')[0]).toMatchObject({ description })
  proof('hostile-name', bytes, 'A picture at B2 on Data whose name holds <&"> and had a control character.')
})

test('the same edit again on its own output, through the ids it reported, changes nothing', () => {
  const [one, two] = pictures(objects, 'Objects')
  const list: PictureModel[] = [
    { ...two, name: 'Second', anchor: { kind: 'oneCell', from: cell(1, 2), width: 914400, height: 914400 } },
    { ...one, bytes: GIF, contentType: 'image/gif' },
    fresh('new', BMP, at(3, 20), { description: 'A bitmap' })
  ]
  const first = patchPictures(objects, [edit('Objects', list)])
  const again = list.map((model) => ({ ...model, id: first.report.ids[model.id] }))
  const second = patchPictures(first.bytes, [edit('Objects', again)])
  expect(second.bytes).toBe(first.bytes)
  expect(second.report.ids).toEqual(Object.fromEntries(again.map((m) => [m.id, m.id])))
  expect(pictures(first.bytes, 'Objects').map((p) => p.contentType)).toEqual(['image/gif', 'image/png', 'image/bmp'])
})
