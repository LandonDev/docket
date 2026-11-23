import { readMedia, readObjects, type ChartSeries, type ChartSpec } from 'work-kit/sheet/xlsx'
import { expect, test } from 'vitest'
import { ChartsRefused, patchCharts, readCharts } from './charts'
import {
  budget,
  chart,
  CHART,
  chartsOf,
  CT,
  DRAWING,
  DRAWING_RELS,
  edit,
  expectation,
  FOOD,
  MONTHS,
  patched,
  place,
  proof,
  RENT,
  series,
  SHARE,
  SHEET,
  SHEET_RELS,
  TRAVEL,
  X,
  Y
} from './charts-testkit'
import { fixture, held, keep, names, withParts, xml } from './drawings-testkit'
import { patchPictures, readPictures } from './pictures'

const corpus = fixture('charts.xlsx')
const book = budget()
const FIRST = { changed: [SHEET, CT], added: [DRAWING, DRAWING_RELS, SHEET_RELS, CHART(1)] }
const text = (value: string) => ({ text: value })

test('the corpus reads by tab, and a list handed back as read is the same bytes', () => {
  const read = readCharts(corpus)
  expect(Object.keys(read.sheets)).toEqual(['Data', 'ChartSheet'])
  expect(read.sheets.Data.charts).toHaveLength(11)
  expect(read.sheets.ChartSheet.charts.map((c) => [c.id, c.chartsheet])).toEqual([[CHART(12), true]])
  expect(read.warnings).toEqual([])
  expect(readCharts(corpus, 'ChartSheet').sheets).toEqual({ ChartSheet: read.sheets.ChartSheet })
  expect(() => readCharts(corpus, 'Nope')).toThrow('No sheet named “Nope”.')
  const { bytes, report } = patchCharts(corpus, [edit(read.sheets.Data.charts), edit(read.sheets.ChartSheet.charts, 'ChartSheet')])
  expect(bytes).toBe(corpus)
  expect(report).toEqual({ partsChanged: [], partsAdded: [], partsRemoved: [], ids: Object.fromEntries(readObjects(corpus).charts.map((c) => [c.id, c.id])) })
  expect(patchCharts(corpus, []).bytes).toBe(corpus)
  // A sheet with no drawing and an empty list: nothing to write.
  expect(patchCharts(book, [edit([])]).bytes).toBe(book)
})

test('a first chart makes the drawing, the chart part, their links and content types, and reads back as handed in', () => {
  const spec = chart(
    'column',
    [
      series('column', 'Rent', { colour: { hex: '2F6FED' } }),
      series('column', 'Food', { colour: { scheme: 'accent2', transforms: [{ name: 'lumMod', value: 75000 }] } }),
      series('column', 'Travel')
    ],
    {
      title: text('Spending'),
      legend: 'bottom',
      axes: {
        category: { id: 'c', title: text('Month') },
        value: { id: 'v', title: text('Dollars'), numberFormat: '#,##0', min: 0, max: 1500 }
      }
    }
  )
  const { bytes, report } = patched(book, [edit([spec])], FIRST)
  expect(report.ids).toEqual({ 'new-column': CHART(1) })
  expect(xml(bytes, CT)).toContain(`<Override PartName="/${CHART(1)}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`)
  expect(xml(bytes, DRAWING_RELS)).toContain('relationships/chart" Target="../charts/chart1.xml"')
  expect(xml(bytes, DRAWING)).toContain('<xdr:cNvPr id="2" name="Chart 1"/>')

  const [read] = chartsOf(bytes)
  expect(read).toMatchObject({
    id: CHART(1),
    sheet: 'Data',
    anchor: spec.anchor,
    kind: 'column',
    grouping: 'clustered',
    groups: [{ kind: 'column', grouping: 'clustered', gapWidth: 219, overlap: -27, varyColours: false }],
    title: { text: 'Spending' },
    legend: 'bottom',
    flags: {}
  })
  expect(read.autoTitle).toBeUndefined()
  expect(read.axes.category).toMatchObject({ position: 'bottom', title: { text: 'Month' } })
  expect(read.axes.value).toMatchObject({ position: 'left', title: { text: 'Dollars' }, numberFormat: '#,##0', formatLinked: false, min: 0, max: 1500 })
  // Names, categories and values carry what the cells hold, so a viewer draws before Excel has opened the file.
  expect(read.series).toEqual([
    { kind: 'column', group: 0, index: 0, name: { ref: 'Data!$B$1', text: 'Rent' }, categories: { ref: 'Data!$A$2:$A$7', cache: MONTHS }, values: { ref: 'Data!$B$2:$B$7', cache: RENT, format: 'General' }, colour: { hex: '2F6FED' } },
    { kind: 'column', group: 0, index: 1, name: { ref: 'Data!$C$1', text: 'Food' }, categories: { ref: 'Data!$A$2:$A$7', cache: MONTHS }, values: { ref: 'Data!$C$2:$C$7', cache: FOOD, format: 'General' }, colour: { scheme: 'accent2', transforms: [{ name: 'lumMod', value: 75000 }] } },
    { kind: 'column', group: 0, index: 2, name: { ref: 'Data!$D$1', text: 'Travel' }, categories: { ref: 'Data!$A$2:$A$7', cache: MONTHS }, values: { ref: 'Data!$D$2:$D$7', cache: TRAVEL, format: 'General' } }
  ])
  // A series with no colour of its own has none written: Excel draws the theme's accent for it.
  const part = xml(bytes, CHART(1))
  expect(part.match(/<c:ser>.*?<\/c:ser>/gs)![2]).not.toContain('solidFill')
  proof('first-column', 'A clustered column chart with a title, a legend at the bottom, axis titles, a number format and bounds, on a sheet that had no drawing', bytes)

  // What the reader gives back, handed in again: nothing to write. So too the spec the canvas still holds, under its new id.
  expect(patchCharts(bytes, [edit(chartsOf(bytes))]).bytes).toBe(bytes)
  expect(patchCharts(bytes, [edit([{ ...spec, id: CHART(1) }])]).bytes).toBe(bytes)
})

const KINDS: Array<[name: string, spec: ChartSpec, expected: Partial<ChartSpec>, series: Array<Partial<ChartSeries>>]> = [
  ['column-stacked', chart('column', [series('column', 'Rent'), series('column', 'Food')], {}, 'stacked'), { kind: 'column', grouping: 'stacked', groups: [{ kind: 'column', grouping: 'stacked', gapWidth: 150, overlap: 100, varyColours: false }] }, [{}, {}]],
  ['column-percent', chart('column', [series('column', 'Rent'), series('column', 'Food')], {}, 'percent'), { kind: 'column', grouping: 'percent' }, [{}, {}]],
  ['bar-clustered', chart('bar', [series('bar', 'Rent'), series('bar', 'Food')]), { kind: 'bar', grouping: 'clustered' }, [{ kind: 'bar' }, { kind: 'bar' }]],
  ['bar-stacked', chart('bar', [series('bar', 'Rent'), series('bar', 'Food')], {}, 'stacked'), { kind: 'bar', grouping: 'stacked' }, [{}, {}]],
  ['bar-percent', chart('bar', [series('bar', 'Rent'), series('bar', 'Food')], {}, 'percent'), { kind: 'bar', grouping: 'percent' }, [{}, {}]],
  ['line', chart('line', [series('line', 'Rent'), series('line', 'Food', { marker: true, colour: { hex: 'C02080' } })]), { kind: 'line', grouping: 'standard' }, [{ line: true, marker: false }, { line: true, marker: true, colour: { hex: 'C02080' } }]],
  ['line-stacked', chart('line', [series('line', 'Rent'), series('line', 'Food')], {}, 'stacked'), { kind: 'line', grouping: 'stacked' }, [{ line: true }, { line: true }]],
  ['line-smooth', chart('line', [series('line', 'Rent', { smooth: true }), series('line', 'Food', { line: false })]), { kind: 'line' }, [{ line: true, smooth: true, marker: false }, { line: false, marker: true }]],
  ['area', chart('area', [series('area', 'Rent'), series('area', 'Food')]), { kind: 'area', grouping: 'standard' }, [{}, {}]],
  ['area-stacked', chart('area', [series('area', 'Rent'), series('area', 'Food')], {}, 'stacked'), { kind: 'area', grouping: 'stacked' }, [{}, {}]],
  ['area-percent', chart('area', [series('area', 'Rent'), series('area', 'Food')], {}, 'percent'), { kind: 'area', grouping: 'percent' }, [{}, {}]],
  ['pie', chart('pie', [series('pie', 'Share', { pointColours: { 0: { hex: '2F6FED' }, 3: { scheme: 'accent4' } } })], { legend: 'right' }), { kind: 'pie', groups: [{ kind: 'pie', grouping: 'standard', varyColours: true }] }, [{ pointColours: { 0: { hex: '2F6FED' }, 3: { scheme: 'accent4' } } }]],
  ['doughnut', chart('doughnut', [series('doughnut', 'Share')], { groups: [{ kind: 'doughnut', grouping: 'standard', holeSize: 60 }] }), { kind: 'doughnut', groups: [{ kind: 'doughnut', grouping: 'standard', holeSize: 60, varyColours: true }] }, [{}]],
  ['scatter', chart('scatter', [series('scatter', 'Y', { colour: { hex: '117A65' } })]), { kind: 'scatter' }, [{ line: false, marker: true, colour: { hex: '117A65' } }]],
  ['scatter-lines', chart('scatter', [series('scatter', 'Y', { line: true, marker: false, colour: { hex: '117A65' } })]), { kind: 'scatter' }, [{ line: true, marker: false, colour: { hex: '117A65' } }]],
  ['scatter-smooth', chart('scatter', [series('scatter', 'Y', { line: true, smooth: true })]), { kind: 'scatter' }, [{ line: true, smooth: true, marker: true }]],
  ['combo-second-axis', chart('combo', [series('column', 'Rent'), series('column', 'Food'), series('line', 'Share', { secondAxis: true, colour: { hex: 'C02080' } })], { axes: { value: { id: 'v', title: text('Dollars') }, secondValue: { id: 'w', title: text('Share'), numberFormat: '0%' } } }), { kind: 'combo', grouping: 'clustered', groups: [{ kind: 'column', grouping: 'clustered', gapWidth: 219, overlap: -27, varyColours: false }, { kind: 'line', grouping: 'standard', secondAxis: true, varyColours: false }] }, [{ kind: 'column' }, { kind: 'column' }, { kind: 'line', secondAxis: true, group: 1, colour: { hex: 'C02080' }, line: true }]],
  ['combo-area-column-line', chart('combo', [series('area', 'Travel'), series('column', 'Food'), series('line', 'Rent')]), { kind: 'combo' }, [{ kind: 'area' }, { kind: 'column' }, { kind: 'line' }]]
]

test.each(KINDS)('a %s chart is written as Excel writes one and reads back as handed in', (name, spec, expected, each) => {
  const { bytes } = patched(book, [edit([spec])], FIRST)
  const [read] = chartsOf(bytes)
  expect(read).toMatchObject(expected)
  expect(read.series).toHaveLength(spec.series.length)
  // Series come back in the order handed in, each with its ranges and what the cells hold.
  for (const [k, s] of spec.series.entries()) {
    expect(read.series[k]).toMatchObject({ kind: s.kind, values: { ref: s.values.ref }, name: s.name, ...each[k] })
    expect(read.series[k].values.cache).toEqual({ Rent: RENT, Food: FOOD, Travel: TRAVEL, Share: SHARE, Y }[read.series[k].name!.text!])
    expect(read.series[k].categories?.cache).toEqual(s.kind === 'scatter' ? X : MONTHS)
  }
  proof(name, `A ${name} chart made on the budget`, bytes)
  expect(patchCharts(bytes, [edit(chartsOf(bytes))]).bytes).toBe(bytes)
  expect(patchCharts(bytes, [edit([{ ...spec, id: CHART(1) }])]).bytes).toBe(bytes)
})

test('a second axis sits on the right and crosses at the far end; bars put categories on the left', () => {
  const combo = xml(patchCharts(book, [edit([KINDS.find(([name]) => name === 'combo-second-axis')![1]])]).bytes, CHART(1))
  expect(combo.match(/<c:axPos val="\w"\/>/g)).toEqual(['<c:axPos val="b"/>', '<c:axPos val="l"/>', '<c:axPos val="b"/>', '<c:axPos val="r"/>'])
  expect(combo.match(/<c:crosses val="\w+"\/>/g)).toEqual(['autoZero', 'autoZero', 'autoZero', 'max'].map((v) => `<c:crosses val="${v}"/>`))
  expect(combo.match(/<c:delete val="\d"\/>/g)).toEqual(['0', '0', '1', '0'].map((v) => `<c:delete val="${v}"/>`))
  const read = chartsOf(patchCharts(book, [edit([KINDS.find(([name]) => name === 'combo-second-axis')![1]])]).bytes)[0]
  expect(read.axes.secondValue).toMatchObject({ position: 'right', crosses: 'max', title: { text: 'Share' }, numberFormat: '0%' })
  expect(read.axes.value).toMatchObject({ position: 'left', title: { text: 'Dollars' } })
  const bar = xml(patchCharts(book, [edit([KINDS.find(([name]) => name === 'bar-percent')![1]])]).bytes, CHART(1))
  expect(bar.match(/<c:axPos val="\w"\/>/g)).toEqual(['<c:axPos val="l"/>', '<c:axPos val="b"/>'])
  // 100% stacked: the value axis reads as percentages, as Excel writes it.
  expect(bar).toContain('<c:numFmt formatCode="0%" sourceLinked="0"/>')
})

test('a title may be a cell’s, Excel’s own, or none; words that XML escapes and lines come back whole', () => {
  const made = (extra: Partial<ChartSpec>, list = [series('column', 'Rent')]) => patchCharts(book, [edit([chart('column', list, extra)])]).bytes
  const linked = chartsOf(made({ title: { ref: 'Data!B1' } }))[0]
  expect(linked.title).toEqual({ ref: 'Data!$B$1', text: 'Rent' })
  const auto = made({ autoTitle: true })
  expect(chartsOf(auto)[0]).toMatchObject({ autoTitle: true })
  expect(chartsOf(auto)[0].title).toBeUndefined()
  expect(xml(auto, CHART(1))).toContain('<c:autoTitleDeleted val="0"/>')
  // With one series and no title, the file says the title was deleted, or Excel would word one.
  const none = made({})
  expect(xml(none, CHART(1))).toContain('<c:chart><c:autoTitleDeleted val="1"/><c:plotArea>')
  expect(chartsOf(none)[0].autoTitle).toBeUndefined()
  const words = 'Rent & <food>, "Q1"\nsecond line\u0001'
  const odd = made({ title: text(words), legend: null })
  expect(chartsOf(odd)[0]).toMatchObject({ title: { text: 'Rent & <food>, "Q1"\nsecond line' }, legend: null })
  expect(xml(odd, CHART(1))).not.toContain('<c:legend>')
  proof('titles', 'A chart whose title is two lines with characters XML escapes, and no legend', odd)
})

test('ranges are written absolute with the sheet named, a quoted name where it must be, and several areas as one', () => {
  const sheet2 = 'xl/worksheets/sheet2.xml'
  const renamed = withParts(book, { 'xl/workbook.xml': xml(book, 'xl/workbook.xml').replace('name="Untouched"', 'name="Q1 \'Plan\' &amp; more"') })
  const name = "Q1 'Plan' & more"
  expect(xml(renamed, sheet2)).toBe(xml(book, sheet2))
  const spec = chart('column', [
    { kind: 'column', group: 0, name: { text: 'Typed <name>' }, categories: { ref: 'a2:a7' }, values: { ref: '=data!b2:B7' } },
    { kind: 'column', group: 0, values: { ref: `'Q1 ''Plan'' & more'!A1:A3` } },
    { kind: 'column', group: 0, values: { ref: '(Data!$B$2:$B$4,Data!$D$6:$D$7)' } },
    { kind: 'column', group: 0, values: { ref: 'Data!$C:$C' } },
    { kind: 'column', group: 0, values: { cache: [3, null, 5.5] }, categories: { cache: ['a', 'b', 'c'] } }
  ])
  const { bytes } = patched(renamed, [edit([spec])], FIRST)
  const read = chartsOf(bytes)[0].series
  expect(read[0]).toMatchObject({ name: { text: 'Typed <name>' }, categories: { ref: 'Data!$A$2:$A$7', cache: MONTHS }, values: { ref: 'Data!$B$2:$B$7', cache: RENT } })
  expect(read[1].values.ref).toBe(`'${name.replace(/'/g, "''")}'!$A$1:$A$3`)
  expect(read[2].values).toMatchObject({ ref: '(Data!$B$2:$B$4,Data!$D$6:$D$7)', cache: [...RENT.slice(0, 3), ...TRAVEL.slice(4)] })
  // A whole column is too many cells to read for a cache: Excel fills it.
  expect(read[3].values).toEqual({ ref: 'Data!$C:$C' })
  // No range at all: the points themselves are written.
  expect(read[4]).toMatchObject({ values: { cache: [3, null, 5.5] }, categories: { cache: ['a', 'b', 'c'] } })
  expect(read[4].values.ref).toBeUndefined()
  expect(patchCharts(bytes, [edit(chartsOf(bytes))]).bytes).toBe(bytes)
})

test('a cache the spec carries is written as given; a formula’s cached value and a shared string are read from the cells', () => {
  const spec = chart('line', [series('line', 'Rent', { values: { ref: 'Data!$B$2:$B$7', cache: [1, 2, null, 4], format: '0.0' }, categories: { ref: 'Data!$A$2:$A$7', cache: [2019, 2020, 2021, 2022] } })])
  const [read] = chartsOf(patchCharts(book, [edit([spec])]).bytes)
  expect(read.series[0].values).toEqual({ ref: 'Data!$B$2:$B$7', cache: [1, 2, null, 4], format: '0.0' })
  // Categories that are all numbers are a number reference, as Excel writes years.
  expect(read.series[0].categories).toEqual({ ref: 'Data!$A$2:$A$7', cache: [2019, 2020, 2021, 2022], format: 'General' })
  // The corpus sheet: months are shared strings, column D is a formula with its value cached.
  const added = chart('column', [{ kind: 'column', group: 0, name: { ref: 'Data!$D$1' }, categories: { ref: 'Data!$A$2:$A$9' }, values: { ref: 'Data!$D$2:$D$9' } }], { id: 'margin' })
  const out = patchCharts(corpus, [edit([...chartsOf(corpus), added])])
  const made = chartsOf(out.bytes).at(-1)!
  expect(made.series[0].categories?.cache).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'])
  expect(made.series[0].values.cache).toEqual([40, 53, 66, 58, 71, 84, 76, 89])
  expect(made.series[0].name?.text).toBe(chartsOf(corpus)[0].series[0].name?.text === 'Sales' ? xml(corpus, 'xl/sharedStrings.xml').match(/<t[^>]*>([^<]*)<\/t>/g)![3].replace(/<[^>]+>/g, '') : '')
})

test('a chart added beside others takes a free part, relationship and shape id and leaves the others’ bytes', () => {
  const before = chartsOf(corpus)
  const spec = chart('column', [{ kind: 'column', group: 0, name: { ref: 'Data!$B$1' }, categories: { ref: 'Data!$A$2:$A$9' }, values: { ref: 'Data!$B$2:$B$9' } }], { id: 'made-here', title: text('Made here'), anchor: place(1, 40) })
  const { bytes, report } = patched(corpus, [edit([...before, spec])], { changed: [DRAWING, DRAWING_RELS, CT], added: [CHART(13)] })
  expect(report.ids['made-here']).toBe(CHART(13))
  expect(report.ids[CHART(3)]).toBe(CHART(3))
  const drawing = xml(bytes, DRAWING)
  const old = xml(corpus, DRAWING)
  // The new anchor is the last one: every anchor the drawing had is the same text before it.
  expect(drawing.startsWith(old.slice(0, old.lastIndexOf('</xdr:wsDr>')))).toBe(true)
  expect(drawing).toContain('<xdr:cNvPr id="13" name="Chart 12"/>')
  expect(xml(bytes, DRAWING_RELS)).toContain('<Relationship Id="rId12" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart13.xml"/>')
  const after = chartsOf(bytes)
  expect(after.slice(0, 11)).toEqual(before)
  expect(after[11]).toMatchObject({ id: CHART(13), title: { text: 'Made here' }, anchor: spec.anchor })
  proof('added-beside', 'A column chart added to a sheet that already draws eleven charts, and a workbook with a chart sheet', bytes)
})

test('a move or a size changes the drawing part alone', () => {
  const before = chartsOf(corpus)
  const moved = before.map((c, k) => (k === 4 ? { ...c, anchor: place(2, 50, 20) } : k === 6 ? { ...c, anchor: { kind: 'oneCell' as const, from: { column: 0, row: 60, columnOffset: 12700, rowOffset: 0 }, width: 4_000_000, height: 2_500_000 } } : c))
  const { bytes } = patched(corpus, [edit(moved)], { changed: [DRAWING] })
  expect(chartsOf(bytes)).toEqual(moved)
  expect(patchCharts(bytes, [edit(moved)]).bytes).toBe(bytes)
})

test('a chart the list leaves out goes with its part, its relationship and its content type', () => {
  const before = chartsOf(corpus)
  const { bytes } = patched(corpus, [edit(before.filter((c) => c.id !== CHART(4)))], { changed: [DRAWING, DRAWING_RELS, CT], removed: [CHART(4)] })
  expect(chartsOf(bytes)).toEqual(before.filter((c) => c.id !== CHART(4)))
  expect(xml(bytes, CT)).not.toContain('chart4.xml')
  expect(xml(bytes, DRAWING_RELS)).not.toContain('chart4.xml')
  expect(readObjects(bytes).warnings).toEqual([])
  proof('removed-one', 'The pie chart removed from a sheet of eleven charts', bytes)

  // The last charts removed: the drawing goes too, with its link from the sheet.
  const none = patched(corpus, [edit([])], {
    changed: [SHEET, CT],
    removed: [DRAWING, DRAWING_RELS, SHEET_RELS, ...before.map((c) => c.id)]
  })
  expect(xml(none.bytes, SHEET)).toBe(xml(corpus, SHEET).replace('<drawing r:id="rId1"/>', ''))
  expect(chartsOf(none.bytes, 'ChartSheet')).toEqual(chartsOf(corpus, 'ChartSheet'))
  expect(readObjects(none.bytes).warnings).toEqual([])
  proof('removed-all', 'Every chart removed from the worksheet; the chart sheet keeps its chart', none.bytes)

  // Added then removed: the file's parts are what they were.
  const made = patchCharts(book, [edit([chart('pie', [series('pie', 'Share')])])]).bytes
  const back = patched(made, [edit([])], { changed: [SHEET, CT], removed: [DRAWING, DRAWING_RELS, SHEET_RELS, CHART(1)] })
  expect(names(back.bytes).toSorted()).toEqual(names(book).toSorted())
  expect(xml(back.bytes, SHEET)).toBe(xml(book, SHEET))
  expect(xml(back.bytes, CT)).toBe(xml(book, CT))
})

test('a chart’s own style and colours parts go with it; a part it shares, or a workbook it embeds, stays or stops the removal', () => {
  const rels = (...targets: Array<[type: string, target: string]>) =>
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    targets.map(([type, target], k) => `<Relationship Id="rId${k + 1}" Type="${type}" Target="${target}"/>`).join('') +
    '</Relationships>'
  const STYLE = 'http://schemas.microsoft.com/office/2011/relationships/chartStyle'
  const COLORS = 'http://schemas.microsoft.com/office/2011/relationships/chartColorStyle'
  const styled = withParts(
    corpus,
    {},
    {
      'xl/charts/style1.xml': '<cs:chartStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle" id="201"/>',
      'xl/charts/colors1.xml': '<cs:colorStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle" meth="cycle" id="10"/>',
      'xl/charts/_rels/chart1.xml.rels': rels([STYLE, 'style1.xml'], [COLORS, 'colors1.xml']),
      'xl/charts/_rels/chart2.xml.rels': rels([COLORS, 'colors1.xml'])
    }
  )
  const before = chartsOf(styled)
  const { bytes } = patched(styled, [edit(before.slice(1))], {
    changed: [DRAWING, DRAWING_RELS, CT],
    removed: [CHART(1), 'xl/charts/_rels/chart1.xml.rels', 'xl/charts/style1.xml']
  })
  expect(names(bytes)).toContain('xl/charts/colors1.xml')
  const embedded = withParts(corpus, {}, {
    'xl/embeddings/Book1.xlsx': 'not a real workbook',
    'xl/charts/_rels/chart1.xml.rels': rels(['http://schemas.openxmlformats.org/officeDocument/2006/relationships/package', '../embeddings/Book1.xlsx'])
  })
  expect(() => patchCharts(embedded, [edit(chartsOf(embedded).slice(1))])).toThrow('The chart “Column” keeps other parts of the file with it: remove it in Excel.')
})

test('several tabs in one patch, each with its own drawing', () => {
  const second = 'xl/worksheets/sheet2.xml'
  const onSecond = chart('line', [series('line', 'Rent')], { id: 'b', sheet: 'Untouched' })
  const { bytes, report } = patched(book, [edit([chart('column', [series('column', 'Rent')], { id: 'a' })]), edit([onSecond], 'Untouched')], {
    changed: [SHEET, second, CT],
    added: [DRAWING, DRAWING_RELS, SHEET_RELS, CHART(1), 'xl/drawings/drawing2.xml', 'xl/drawings/_rels/drawing2.xml.rels', 'xl/worksheets/_rels/sheet2.xml.rels', CHART(2)]
  })
  expect(report.ids).toEqual({ a: CHART(1), b: CHART(2) })
  expect(chartsOf(bytes, 'Untouched')[0]).toMatchObject({ id: CHART(2), kind: 'line', sheet: 'Untouched' })
  // A range with no sheet named is on the chart's own tab.
  const own = chart('column', [{ kind: 'column', group: 0, values: { ref: 'A1:A3' } }], { sheet: 'Untouched' })
  expect(chartsOf(patchCharts(book, [edit([own], 'Untouched')]).bytes, 'Untouched')[0].series[0].values.ref).toBe('Untouched!$A$1:$A$3')
})

test('what cannot be written is refused in words, and nothing is written', () => {
  const one = [series('column', 'Rent')]
  const refused = (input: Uint8Array, edits: Parameters<typeof patchCharts>[1], words: string | RegExp) => {
    expect(() => patchCharts(input, edits)).toThrow(ChartsRefused)
    expect(() => patchCharts(input, edits)).toThrow(words)
  }
  refused(book, [edit([], 'Nope')], 'No sheet named “Nope”.')
  refused(book, [edit([]), edit([])], 'Give one complete chart list for “Data”.')
  refused(book, [edit([chart('column', one), chart('column', one)])], 'repeats a chart')
  refused(book, [edit([chart('column', [])])], 'Give a chart on “Data” at least one series.')
  refused(book, [edit([chart('column', Array.from({ length: 256 }, () => series('column', 'Rent')))])], 'at most 255 series')
  refused(book, [edit([chart('column', [series('column', 'Rent', { values: {} })], { title: text('Rent') })])], 'Give every series of the chart “Rent” a range of values.')
  refused(book, [edit([chart('column', [series('column', 'Rent', { values: { ref: '[1]Sheet1!$A$1:$A$3' } })])])], 'is not a cell range in this workbook')
  refused(book, [edit([chart('column', [series('column', 'Rent', { values: { ref: 'Existing' } })])])], '“Existing” in a chart on “Data” is not a cell range in this workbook.')
  refused(book, [edit([chart('column', [series('column', 'Rent', { values: { ref: 'Gone!$A$1:$A$3' } })])])], 'is not a cell range')
  refused(book, [edit([chart('column', [series('column', 'Rent', { name: { ref: 'OFFSET(Data!$A$1,1,1)' } })])])], 'is not a cell range')
  refused(book, [edit([chart('combo', [series('pie', 'Share'), series('column', 'Rent')])])], 'Excel cannot draw a pie and another kind in one chart.')
  refused(book, [edit([chart('combo', [series('bar', 'Food'), series('line', 'Rent')])])], 'Excel cannot draw bars and another kind in one chart.')
  refused(book, [edit([chart('combo', [series('scatter', 'Y'), series('line', 'Rent')])])], 'Excel cannot draw a scatter and another kind in one chart.')
  refused(book, [edit([chart('column', [series('column', 'Rent', { colour: { hex: 'red' } })])])], 'A colour in a chart on “Data” is not one Excel can read.')
  refused(book, [edit([chart('column', [series('column', 'Rent', { colour: { scheme: 'accent9' } })])])], 'colour')
  refused(book, [edit([chart('column', [series('column', 'Rent', { colour: { hex: 'AABBCC', transforms: [{ name: 'evil"/><x', value: 1 }] } })])])], 'colour')
  refused(book, [edit([chart('column', one, { groups: [{ kind: 'column', grouping: 'clustered', gapWidth: 900 }] })])], 'outside what Excel takes')
  refused(book, [edit([chart('column', one, { axes: { value: { id: 'v', min: 5, max: 5 } } })])], 'smallest value')
  refused(book, [edit([chart('other', one, { otherKind: 'radar' })])], 'This editor cannot make a radar chart: make it in Excel.')
  refused(book, [edit([chart('column', one, { frame: { left: 0, top: 0, width: 1, height: 1 } })])], 'cannot be made inside a group')
  refused(book, [edit([chart('column', one, { anchor: { ...place(), to: { column: 2, row: 0, columnOffset: 0, rowOffset: 0 } } })])], 'lower right corner')
  refused(book, [edit([chart('column', one, { legend: 'middle' as never })])], 'legend')
  refused(corpus, [edit([...chartsOf(corpus, 'ChartSheet'), chart('column', one, { sheet: 'ChartSheet' })], 'ChartSheet')], '“ChartSheet” is a chart sheet and holds one chart')
  refused(corpus, [edit([], 'ChartSheet')], '“ChartSheet” is a chart sheet: remove the sheet itself in Excel.')
  refused(corpus, [edit(chartsOf(corpus, 'ChartSheet').map((c) => ({ ...c, anchor: place() })), 'ChartSheet')], 'it has no place to move to')

  const locked = withParts(book, { [SHEET]: xml(book, SHEET).replace('</sheetData>', '</sheetData><sheetProtection sheet="1" objects="1" scenarios="1"/>') })
  refused(locked, [edit([chart('column', one)])], '“Data” is protected. Unprotect the sheet in Excel before changing its charts and pictures.')
  // A locked sheet's list handed back as it is asks nothing of the lock.
  expect(patchCharts(locked, [edit([])]).bytes).toBe(locked)

  const many = Array.from({ length: 490 }, (_, k) => chart('column', one, { id: 'n' + k }))
  refused(corpus, [edit([...chartsOf(corpus), ...many])], 'Save at most 500 charts per workbook.')
})

test('a chart in a group, or drawn twice from one part, is handed back freely but not moved, changed or removed here', () => {
  const drawing = xml(corpus, DRAWING)
  const frame = /<xdr:graphicFrame macro="">.*?<\/xdr:graphicFrame>/s.exec(drawing)![0]
  const grouped = withParts(corpus, {
    [DRAWING]: drawing.replace(frame, `<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="90" name="Group"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr><xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/><a:chOff x="0" y="0"/><a:chExt cx="100" cy="100"/></a:xfrm></xdr:grpSpPr>${frame}</xdr:grpSp>`)
  })
  const list = chartsOf(grouped)
  expect(list[0].frame).toBeDefined()
  expect(patchCharts(grouped, [edit(list)]).bytes).toBe(grouped)
  const held = 'The chart “Column” is part of a group, or sits in a drawing this editor cannot change: move, size or remove it in Excel.'
  expect(() => patchCharts(grouped, [edit([{ ...list[0], anchor: place() }, ...list.slice(1)])])).toThrow(held)
  expect(() => patchCharts(grouped, [edit(list.slice(1))])).toThrow(held)
  // Its words may still change: the chart part is its own.
  const retitled = patchCharts(grouped, [edit([{ ...list[0], title: text('Still mine') }, ...list.slice(1)])])
  expect(retitled.report.partsChanged).toEqual([CHART(1)])

  const twice = withParts(corpus, { [DRAWING]: drawing.replace('r:id="rId2"', 'r:id="rId1"') })
  const both = chartsOf(twice)
  expect(both.slice(0, 2).map((c) => c.id)).toEqual([CHART(1), CHART(1) + '#2'])
  expect(patchCharts(twice, [edit(both)]).bytes).toBe(twice)
  expect(() => patchCharts(twice, [edit([{ ...both[0], title: text('Both') }, ...both.slice(1)])])).toThrow('The chart “Column” is drawn in more than one place: change it in Excel.')
  expect(() => patchCharts(twice, [edit(both.slice(1))])).toThrow('is part of a group, or sits in a drawing')
})

test('a chart and a picture share one drawing: each writer leaves the other’s anchor and parts alone', () => {
  const png = readMedia(fixture('objects.xlsx'), 'xl/media/image2.png')!
  const spec = chart('column', [series('column', 'Rent'), series('column', 'Food')], { title: text('Budget') })
  const charted = patchCharts(book, [edit([spec])]).bytes
  const pictured = patchPictures(charted, [
    { kind: 'pictures', sheet: 'Data', pictures: [{ id: 'logo', sheet: 'Data', anchor: place(9, 18, 4), name: 'Logo', bytes: png }] }
  ])
  held(charted, pictured.bytes, pictured.report, { changed: [DRAWING, DRAWING_RELS, CT], added: ['xl/media/image1.png'] })
  expect(xml(pictured.bytes, CHART(1))).toBe(xml(charted, CHART(1)))
  expect(chartsOf(pictured.bytes)).toEqual(chartsOf(charted))
  const [picture] = readPictures(pictured.bytes, 'Data').sheets.Data.pictures
  expect(picture).toMatchObject({ id: `${DRAWING}#1`, name: 'Logo', part: 'xl/media/image1.png' })
  keep('CHARTS_PROOF_DIR', 'chart-and-picture', pictured.bytes, {
    description: 'A column chart and a PNG on one sheet, the chart written first and the picture after it into the same drawing',
    expect: { Data: { ...expectation(pictured.bytes).Data, pictures: [{ name: 'Logo', from: 'J19', contentType: 'image/png' }] }, Untouched: { charts: [] } }
  })

  // The chart retitled and moved beside the picture: the picture's anchor is the same bytes.
  const list = structuredClone(chartsOf(pictured.bytes))
  Object.assign(list[0], { title: text('Budget, moved'), anchor: place(1, 30) })
  const moved = patched(pictured.bytes, [edit(list)], { changed: [DRAWING, CHART(1)] })
  const anchor = (bytes: Uint8Array) => /<xdr:twoCellAnchor>(?:(?!<\/xdr:twoCellAnchor>).)*<xdr:pic .*?<\/xdr:twoCellAnchor>/s.exec(xml(bytes, DRAWING))![0]
  expect(anchor(moved.bytes)).toBe(anchor(pictured.bytes))
  // The chart removed: the drawing stays for the picture; then the picture too, and the drawing goes.
  const alone = patched(moved.bytes, [edit([])], { changed: [DRAWING, DRAWING_RELS, CT], removed: [CHART(1)] })
  expect(readPictures(alone.bytes, 'Data').sheets.Data.pictures).toHaveLength(1)
  const empty = patchPictures(alone.bytes, [{ kind: 'pictures', sheet: 'Data', pictures: [] }])
  expect(names(empty.bytes).toSorted()).toEqual(names(book).toSorted())
})
