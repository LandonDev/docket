import type { ChartSpec } from 'work-kit/sheet/xlsx'
import { expect, test } from 'vitest'
import { ChartsRefused, patchCharts } from './charts'
import { CHART, chartsOf, CT, DRAWING, DRAWING_RELS, edit, patched, place, proof } from './charts-testkit'
import { fixture, withParts, xml } from './drawings-testkit'

const corpus = fixture('charts.xlsx')
const text = (value: string) => ({ text: value })
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug']

/**
 * Changes one chart of a workbook in place and holds the patch to that chart's part alone. The
 * spec handed in, handed in again over the output, writes nothing: what was written reads back
 * as what was asked.
 */
function change(n: number, mutate: (spec: ChartSpec) => void, input: Uint8Array = corpus, sheet = 'Data') {
  const list = structuredClone(chartsOf(input, sheet))
  const spec = list.find((c) => c.id === CHART(n))!
  mutate(spec)
  const { bytes } = patched(input, [edit(list, sheet)], { changed: [CHART(n)] })
  expect(patchCharts(bytes, [edit(list, sheet)]).report.partsChanged, 'the spec again').toEqual([])
  expect(patchCharts(bytes, [edit(chartsOf(bytes, sheet), sheet)]).bytes === bytes, 'the readback').toBe(true)
  const read = chartsOf(bytes, sheet).find((c) => c.id === CHART(n))!
  return { bytes, before: xml(input, CHART(n)), after: xml(bytes, CHART(n)), read, spec }
}

test('a title’s words change inside the title it has; its look, and every other byte of the part, stay', () => {
  const { before, after, read } = change(1, (c) => (c.title = text('Rent & <more>')))
  expect(after).toBe(before.replace('<a:t>Column</a:t>', '<a:t>Rent &amp; &lt;more&gt;</a:t>'))
  expect(read.title).toEqual({ text: 'Rent & <more>' })

  // Two lines are two paragraphs, each with the paragraph and run properties the title had.
  const lines = change(1, (c) => (c.title = text('One\nTwo')))
  expect(lines.after).toContain('<a:p><a:pPr><a:defRPr/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>One</a:t></a:r></a:p><a:p><a:pPr><a:defRPr/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>Two</a:t></a:r></a:p></c:rich></c:tx><c:layout/></c:title>')
  expect(lines.read.title).toEqual({ text: 'One\nTwo' })
})

test('a title removed, left to Excel, linked to a cell and put back', () => {
  const none = change(1, (c) => delete c.title)
  expect(none.after).toBe(none.before.replace(/<c:title>.*?<\/c:title>(?=<c:plotArea>)/s, '<c:autoTitleDeleted val="1"/>'))
  expect(none.read.title).toBeUndefined()
  expect(none.read.autoTitle).toBeUndefined()

  const auto = change(1, (c) => {
    delete c.title
    c.autoTitle = true
  })
  expect(auto.after).toBe(auto.before.replace(/<c:tx>.*?<\/c:tx>(?=<c:layout\/><\/c:title><c:plotArea>)/s, ''))
  expect(auto.read).toMatchObject({ autoTitle: true })

  const linked = change(1, (c) => (c.title = { ref: 'Data!$A$1' }))
  expect(linked.after).toContain('<c:title><c:tx><c:strRef><c:f>Data!$A$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Month</c:v></c:pt></c:strCache></c:strRef></c:tx><c:layout/></c:title>')
  expect(linked.read.title).toEqual({ ref: 'Data!$A$1', text: 'Month' })

  // Back onto a chart that has none: a whole title, and the deleted mark taken off.
  const back = change(1, (c) => (c.title = text('Back')), none.bytes)
  expect(back.after).toContain('<c:autoTitleDeleted val="0"/><c:plotArea>')
  expect(back.read.title).toEqual({ text: 'Back' })
  expect(back.read.autoTitle).toBeUndefined()
})

test('with no title, a chart cut to one series still has none: Excel is told the title was deleted', () => {
  const none = change(1, (c) => delete c.title)
  const one = change(1, (c) => c.series.pop(), none.bytes)
  expect(one.read.series).toHaveLength(1)
  expect(one.read.autoTitle).toBeUndefined()
  // Left to Excel on a chart of two series with no title element: the element is written so the title shows.
  const two = change(1, (c) => (c.autoTitle = true), none.bytes)
  expect(two.read).toMatchObject({ autoTitle: true })
  expect(two.read.series).toHaveLength(2)
})

test('the legend moves, goes and comes back', () => {
  const moved = change(1, (c) => (c.legend = 'bottom'))
  expect(moved.after).toBe(moved.before.replace('<c:legendPos val="r"/>', '<c:legendPos val="b"/>'))
  const gone = change(1, (c) => (c.legend = null))
  expect(gone.after).toBe(gone.before.replace(/<c:legend>.*?<\/c:legend>/s, ''))
  expect(gone.read.legend).toBeNull()
  const back = change(1, (c) => (c.legend = 'topRight'), gone.bytes)
  expect(back.after).toMatch(/<\/c:plotArea><c:legend><c:legendPos val="tr"\/>.*<\/c:legend><c:plotVisOnly val="1"\/>/s)
  expect(back.read.legend).toBe('topRight')
})

test('an axis: its title, number format, bounds, direction and hiding, each spliced where the schema has it', () => {
  const { before, after, read } = change(1, (c) => {
    c.axes.category!.title = text('Months of the year')
    delete c.axes.value!.title
    Object.assign(c.axes.value!, { numberFormat: '#,##0.0', formatLinked: false, min: 0, max: 250, reversed: true })
  })
  expect(after).toBe(
    before
      .replace('<a:t>Month</a:t>', '<a:t>Months of the year</a:t>')
      .replace(/(<c:majorGridlines\/>)<c:title>.*?<\/c:title>/s, '$1')
      .replace('<c:numFmt formatCode="General" sourceLinked="1"/>', '<c:numFmt formatCode="#,##0.0" sourceLinked="0"/>')
      .replace('<c:axId val="50010002"/><c:scaling><c:orientation val="minMax"/></c:scaling>', '<c:axId val="50010002"/><c:scaling><c:orientation val="maxMin"/><c:max val="250"/><c:min val="0"/></c:scaling>')
  )
  expect(read.axes.category?.title).toEqual({ text: 'Months of the year' })
  expect(read.axes.value).toMatchObject({ numberFormat: '#,##0.0', formatLinked: false, min: 0, max: 250, reversed: true })
  expect(read.axes.value?.title).toBeUndefined()

  // An axis with no title and no format gets each at its place; a hidden axis is marked deleted.
  const added = change(1, (c) => {
    c.axes.value!.title = text('Dollars')
    c.axes.category!.hidden = true
    c.axes.category!.numberFormat = 'mmm'
  }, change(1, (c) => delete c.axes.value!.title).bytes)
  expect(added.after).toMatch(/<c:axPos val="l"\/><c:majorGridlines\/><c:title><c:tx><c:rich><a:bodyPr rot="-5400000"[^>]*\/><a:lstStyle\/>.*<a:t>Dollars<\/a:t>.*<\/c:title><c:numFmt/s)
  expect(added.after).toContain('<c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="1"/><c:axPos val="b"/>')
  expect(added.after).toMatch(/<\/c:title><c:numFmt formatCode="mmm" sourceLinked="0"\/><c:tickLblPos val="nextTo"\/><c:crossAx val="50010002"\/>/)
  expect(added.read.axes).toMatchObject({ value: { title: { text: 'Dollars' } }, category: { hidden: true, numberFormat: 'mmm' } })
})

test('a series’ colour is set, changed and taken away where its kind keeps it', () => {
  // A bar: the fill, in a shape properties element of its own after the name.
  const bar = change(1, (c) => (c.series[1].colour = { hex: 'C02080' }))
  expect(bar.after).toBe(bar.before.replace('</c:strRef></c:tx><c:cat><c:strRef><c:f>Data!$A$2:$A$9</c:f><c:strCache><c:ptCount val="8"/><c:pt idx="0"><c:v>Jan</c:v></c:pt><c:pt idx="1"><c:v>Feb</c:v></c:pt><c:pt idx="2"><c:v>Mar</c:v></c:pt><c:pt idx="3"><c:v>Apr</c:v></c:pt><c:pt idx="4"><c:v>May</c:v></c:pt><c:pt idx="5"><c:v>Jun</c:v></c:pt><c:pt idx="6"><c:v>Jul</c:v></c:pt><c:pt idx="7"><c:v>Aug</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Data!$C$2', '</c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="C02080"/></a:solidFill></c:spPr><c:cat><c:strRef><c:f>Data!$A$2:$A$9</c:f><c:strCache><c:ptCount val="8"/><c:pt idx="0"><c:v>Jan</c:v></c:pt><c:pt idx="1"><c:v>Feb</c:v></c:pt><c:pt idx="2"><c:v>Mar</c:v></c:pt><c:pt idx="3"><c:v>Apr</c:v></c:pt><c:pt idx="4"><c:v>May</c:v></c:pt><c:pt idx="5"><c:v>Jun</c:v></c:pt><c:pt idx="6"><c:v>Jul</c:v></c:pt><c:pt idx="7"><c:v>Aug</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Data!$C$2'))
  expect(bar.read.series.map((s) => s.colour)).toEqual([undefined, { hex: 'C02080' }])
  const again = change(1, (c) => (c.series[1].colour = { scheme: 'accent3', transforms: [{ name: 'lumMod', value: 60000 }, { name: 'lumOff', value: 40000 }] }), bar.bytes)
  expect(again.after).toBe(bar.after.replace('<a:srgbClr val="C02080"/>', '<a:schemeClr val="accent3"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr>'))
  const off = change(1, (c) => delete c.series[1].colour, again.bytes)
  expect(off.after).toBe(bar.after.replace('<a:solidFill><a:srgbClr val="C02080"/></a:solidFill>', ''))
  expect(off.read.series[1].colour).toBeUndefined()

  // A line with markers: its stroke, and its markers with it.
  const line = change(3, (c) => (c.series[0].colour = { hex: '117A65' }))
  expect(line.after).toContain('</c:tx><c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="117A65"/></a:solidFill><a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:spPr><a:solidFill><a:srgbClr val="117A65"/></a:solidFill></c:spPr></c:marker>')
  expect(line.read.series[0].colour).toEqual({ hex: '117A65' })

  // A scatter: its markers. The trendlines, which the spec does not hold, stay where they were.
  const scatter = change(6, (c) => (c.series[1].colour = { hex: '884EA0' }))
  expect(scatter.after.match(/<c:trendline><c:trendlineType val="linear"\/><\/c:trendline>/g)).toHaveLength(2)
  expect(scatter.after).toContain('<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="884EA0"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="884EA0"/></a:solidFill></a:ln></c:spPr></c:marker><c:trendline>')
  expect(scatter.read.series.map((s) => s.colour)).toEqual([undefined, { hex: '884EA0' }])

  // A pie: one slice.
  const pie = change(4, (c) => (c.series[0].pointColours = { 2: { hex: 'F39C12' } }))
  expect(pie.after).toBe(pie.before.replace('</c:tx><c:dLbls>', '</c:tx><c:dPt><c:idx val="2"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="F39C12"/></a:solidFill></c:spPr></c:dPt><c:dLbls>'))
  const slice = change(4, (c) => (c.series[0].pointColours = { 2: { hex: '1F618D' }, 0: { scheme: 'accent6' } }), pie.bytes)
  expect(slice.read.series[0].pointColours).toEqual({ 0: { scheme: 'accent6' }, 2: { hex: '1F618D' } })
  expect(slice.after).toContain('<c:dPt><c:idx val="2"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="1F618D"/></a:solidFill></c:spPr></c:dPt><c:dPt><c:idx val="0"/>')
  proof('recoloured', 'Corpus charts recoloured in place: a pie slice in the pie chart', slice.bytes)
})

test('a series’ name and ranges: the range is rewritten with what its cells hold, never a stale cache', () => {
  const { after, read } = change(1, (c) => {
    c.series[0].name = text('Typed')
    // The canvas hands back the old cache beside the new range: the cells are read instead.
    c.series[0].values = { ...c.series[0].values, ref: 'Data!E2:E9' }
    c.series[1].categories = { ref: 'Data!$A$2:$A$5' }
  })
  expect(after).toContain('<c:order val="0"/><c:tx><c:v>Typed</c:v></c:tx><c:cat>')
  expect(read.series[0]).toMatchObject({ name: { text: 'Typed' }, values: { ref: 'Data!$E$2:$E$9', cache: [50, 52, 54, 56, 58, 60, 62, 64] } })
  expect(read.series[0].categories).toEqual({ ref: 'Data!$A$2:$A$9', cache: MONTHS })
  expect(read.series[1].categories).toEqual({ ref: 'Data!$A$2:$A$5', cache: MONTHS.slice(0, 4) })
  // The same range written another way is the same range: nothing to write.
  const list = structuredClone(chartsOf(corpus))
  list[0].series[0].values.ref = "='Data'!b2:B9"
  list[0].series[0].name = { ref: 'data!$B$1' }
  expect(patchCharts(corpus, [edit(list)]).bytes).toBe(corpus)
})

test('a series is added, dropped and put in another order, the others’ XML kept', () => {
  const added = change(1, (c) => c.series.push({ kind: 'column', group: 0, name: { ref: 'Data!$D$1' }, categories: { ref: 'Data!$A$2:$A$9' }, values: { ref: 'Data!$D$2:$D$9' } }))
  expect(added.read.series[2]).toMatchObject({ index: 2, name: { text: 'Profit' }, values: { cache: [40, 53, 66, 58, 71, 84, 76, 89] } })
  // The new series comes after the two the group had and before what follows them.
  expect(added.after.startsWith(added.before.slice(0, added.before.indexOf('<c:axId val="50010001"/><c:axId val="50010002"/></c:barChart>')))).toBe(true)
  expect(added.after).toMatch(/<\/c:ser><c:ser><c:idx val="2"\/><c:order val="2"\/>.*<\/c:ser><c:axId val="50010001"\/>/s)
  proof('series-added', 'A third series added in place to the corpus column chart', added.bytes)

  const dropped = change(1, (c) => c.series.shift(), added.bytes)
  expect(dropped.read.series.map((s) => [s.index, s.name?.text])).toEqual([[1, 'Cost'], [2, 'Profit']])
  expect(dropped.after.match(/<c:order val="\d"\/>/g)).toEqual(['<c:order val="0"/>', '<c:order val="1"/>'])

  const swapped = change(1, (c) => c.series.reverse())
  expect(swapped.read.series.map((s) => s.name?.text)).toEqual(['Cost', 'Sales'])
  expect(swapped.after).toBe(swapped.before.replace('<c:idx val="0"/><c:order val="0"/>', '<c:idx val="0"/><c:order val="1"/>').replace('<c:idx val="1"/><c:order val="1"/>', '<c:idx val="1"/><c:order val="0"/>'))

  // A series the canvas rebuilt with no identity is matched by its place.
  const list = structuredClone(chartsOf(corpus))
  for (const s of list[0].series) delete s.index
  expect(patchCharts(corpus, [edit(list)]).bytes).toBe(corpus)
})

test('grouping, gap, overlap, hole and vary colours change in the group they belong to', () => {
  const stacked = change(1, (c) => {
    c.grouping = 'stacked'
    c.groups[0].grouping = 'stacked'
  })
  expect(stacked.after).toBe(stacked.before.replace('<c:grouping val="clustered"/>', '<c:grouping val="stacked"/>').replace('<c:axId val="50010001"/><c:axId val="50010002"/></c:barChart>', '<c:overlap val="100"/><c:axId val="50010001"/><c:axId val="50010002"/></c:barChart>'))
  expect(stacked.read).toMatchObject({ grouping: 'stacked', groups: [{ overlap: 100 }] })
  // Back to side by side: bars that stop stacking no longer sit one on another.
  const clustered = change(1, (c) => {
    c.grouping = 'clustered'
    c.groups[0].grouping = 'clustered'
  }, stacked.bytes)
  expect(clustered.after).toContain('<c:overlap val="-27"/>')
  const percent = change(7, (c) => (c.groups[0].grouping = 'percent'))
  expect(percent.after).toBe(percent.before.replace('<c:grouping val="standard"/>', '<c:grouping val="percentStacked"/>'))

  const gap = change(1, (c) => Object.assign(c.groups[0], { gapWidth: 80, overlap: 10, varyColours: true }))
  expect(gap.after).toBe(gap.before.replace('<c:grouping val="clustered"/>', '<c:grouping val="clustered"/><c:varyColors val="1"/>').replace('<c:axId val="50010001"/><c:axId val="50010002"/></c:barChart>', '<c:gapWidth val="80"/><c:overlap val="10"/><c:axId val="50010001"/><c:axId val="50010002"/></c:barChart>'))
  expect(gap.read.groups[0]).toMatchObject({ gapWidth: 80, overlap: 10, varyColours: true })
  const hole = change(5, (c) => (c.groups[0].holeSize = 70))
  expect(hole.after).toBe(hole.before.replace('<c:holeSize val="50"/>', '<c:holeSize val="70"/>'))
})

test('a line or scatter series: markers, its line and smoothing', () => {
  const line = change(3, (c) => Object.assign(c.series[0], { marker: false, smooth: true }))
  expect(line.after).toContain('<c:marker><c:symbol val="none"/></c:marker>')
  expect(line.after).toMatch(/<\/c:val><c:smooth val="1"\/><\/c:ser>/)
  expect(line.read.series[0]).toMatchObject({ marker: false, smooth: true, line: true })
  const dots = change(3, (c) => (c.series[1].line = false))
  expect(dots.after).toContain('<c:spPr><a:ln w="28575" cap="rnd"><a:noFill/><a:round/></a:ln></c:spPr>')
  expect(dots.read.series[1]).toMatchObject({ line: false, marker: true })
  const joined = change(3, (c) => Object.assign(c.series[1], { line: true, colour: { hex: '2F6FED' } }), dots.bytes)
  expect(joined.read.series[1]).toMatchObject({ line: true, colour: { hex: '2F6FED' } })
  const scatter = change(6, (c) => Object.assign(c.series[0], { line: false, marker: true }))
  expect(scatter.read.series[0]).toMatchObject({ line: false, marker: true })
  expect(scatter.after.match(/<c:trendline>/g)).toHaveLength(2)
})

test('what the spec does not hold stays through a change: labels, a trendline, text properties, extensions', () => {
  const rich = withParts(corpus, {
    [CHART(1)]: xml(corpus, CHART(1))
      .replace('</c:tx><c:cat>', '</c:tx><c:spPr><a:gradFill><a:gsLst/></a:gradFill><a:ln w="12700"><a:prstDash val="dash"/></a:ln></c:spPr><c:dLbls><c:showVal val="1"/></c:dLbls><c:trendline><c:trendlineType val="linear"/></c:trendline><c:cat>')
      .replace('<c:layout/></c:title><c:plotArea>', '<c:layout/><c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="2000" b="1"/></a:pPr><a:endParaRPr/></a:p></c:txPr></c:title><c:plotArea>')
      .replace('</c:chartSpace>', '<c:extLst><c:ext uri="{781A3756-C4B2-4CAC-9D66-4F8BD8637D16}"><x:kept xmlns:x="urn:kept"/></c:ext></c:extLst></c:chartSpace>')
  })
  const { before, after, read } = change(1, (c) => {
    c.title = text('Kept')
    c.series[0].colour = { hex: '2F6FED' }
    c.series[0].values = { ref: 'Data!$E$2:$E$9' }
    c.legend = 'top'
  }, rich)
  // The gradient gives way to the colour asked for; the dashed outline beside it stays.
  expect(after).toContain('<c:spPr><a:solidFill><a:srgbClr val="2F6FED"/></a:solidFill><a:ln w="12700"><a:prstDash val="dash"/></a:ln></c:spPr><c:dLbls><c:showVal val="1"/></c:dLbls><c:trendline><c:trendlineType val="linear"/></c:trendline><c:cat>')
  for (const kept of ['<c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="2000" b="1"/></a:pPr><a:endParaRPr/></a:p></c:txPr></c:title>', '<x:kept xmlns:x="urn:kept"/>', '<c:printSettings>'])
    expect(after.split(kept)).toHaveLength(before.split(kept).length)
  expect(read).toMatchObject({ title: { text: 'Kept' }, legend: 'top', series: [{ colour: { hex: '2F6FED' }, values: { ref: 'Data!$E$2:$E$9' } }, {}] })
})

test('a change of kind writes the plot area afresh and keeps the rest of the part', () => {
  const line = change(1, (c) => {
    c.kind = 'line'
    c.grouping = 'standard'
    c.groups = [{ kind: 'line', grouping: 'standard' }]
    for (const s of c.series) Object.assign(s, { kind: 'line', line: true, marker: false })
  })
  const head = line.before.slice(0, line.before.indexOf('<c:barChart>'))
  const tail = line.before.slice(line.before.indexOf('</c:plotArea>'))
  expect(line.after.startsWith(head + '<c:lineChart>')).toBe(true)
  expect(line.after.endsWith(tail)).toBe(true)
  expect(line.read).toMatchObject({ kind: 'line', grouping: 'standard', title: { text: 'Column' }, legend: 'right' })
  // Names, ranges and the caches the file had come through the spec.
  expect(line.read.series).toMatchObject(chartsOf(corpus)[0].series.map((s) => ({ name: s.name, categories: s.categories, values: s.values, kind: 'line', line: true, marker: false })))
  // The axes' titles are the spec's too.
  expect(line.read.axes).toMatchObject({ category: { title: { text: 'Month' } }, value: { title: { text: 'Value' } } })
  proof('kind-changed', 'The corpus column chart turned into a line chart in place', line.bytes)

  const bar = change(1, (c) => {
    c.kind = 'bar'
    c.groups[0].kind = 'bar'
    for (const s of c.series) s.kind = 'bar'
  })
  expect(bar.read).toMatchObject({ kind: 'bar', axes: { category: { position: 'left' }, value: { position: 'bottom' } } })

  const doughnut = change(4, (c) => {
    c.kind = 'doughnut'
    c.groups = [{ kind: 'doughnut', grouping: 'standard' }]
    c.series[0].kind = 'doughnut'
  })
  expect(doughnut.read).toMatchObject({ kind: 'doughnut', groups: [{ holeSize: 75, varyColours: true }] })
  expect(doughnut.after).not.toMatch(/<c:(cat|val)Ax>/)

  // One series of a column chart moved onto a second axis as a line: a combo.
  const combo = change(1, (c) => {
    c.kind = 'combo'
    c.groups.push({ kind: 'line', grouping: 'standard', secondAxis: true })
    Object.assign(c.series[1], { kind: 'line', group: 1, secondAxis: true })
  })
  expect(combo.read).toMatchObject({ kind: 'combo', groups: [{ kind: 'column' }, { kind: 'line', secondAxis: true }], series: [{ kind: 'column' }, { kind: 'line', secondAxis: true }] })
  expect(combo.read.axes.secondValue).toMatchObject({ position: 'right', crosses: 'max' })

  // What is drawn is what is written: a series' own kind decides, whatever the groups still say.
  const drawn = change(1, (c) => {
    for (const s of c.series) s.kind = 'area'
  })
  expect(drawn.read).toMatchObject({ kind: 'area', groups: [{ kind: 'area' }] })
})

test('a radar, a 3D and a pivot chart keep their kind here; their words still change', () => {
  const radar = change(8, (c) => {
    c.title = text('Still a radar')
    c.legend = 'left'
  })
  expect(radar.read).toMatchObject({ kind: 'other', otherKind: 'radar', title: { text: 'Still a radar' }, legend: 'left' })
  const list = structuredClone(chartsOf(corpus))
  Object.assign(list[7], { kind: 'line', otherKind: undefined, groups: [{ kind: 'line', grouping: 'standard' }] })
  expect(() => patchCharts(corpus, [edit(list)])).toThrow('The chart “Radar” is a kind this editor does not draw: change its kind and its series in Excel.')

  const deep = withParts(corpus, { [CHART(1)]: xml(corpus, CHART(1)).replace('<c:barChart>', '<c:bar3DChart>').replace('</c:barChart>', '</c:bar3DChart>') })
  expect(chartsOf(deep)[0].flags).toEqual({ threeD: true })
  expect(change(1, (c) => (c.title = text('Flat words')), deep).read.title).toEqual({ text: 'Flat words' })
  expect(change(1, (c) => (c.series[0].colour = { hex: '2F6FED' }), deep).read.series[0].colour).toEqual({ hex: '2F6FED' })
  const turned = structuredClone(chartsOf(deep))
  turned[0].groups[0].grouping = 'stacked'
  expect(() => patchCharts(deep, [edit(turned)])).toThrow('The chart “Column” is a 3D chart: change its kind and its series in Excel.')

  const pivot = withParts(corpus, { [CHART(1)]: xml(corpus, CHART(1)).replace('<c:chart>', '<c:pivotSource><c:name>[b.xlsx]Sheet1!PivotTable1</c:name><c:fmtId val="0"/></c:pivotSource><c:chart>') })
  const kind = structuredClone(chartsOf(pivot))
  Object.assign(kind[0], { kind: 'line', groups: [{ kind: 'line', grouping: 'standard' }] })
  for (const s of kind[0].series) s.kind = 'line'
  expect(() => patchCharts(pivot, [edit(kind)])).toThrow('The chart “Column” is a pivot chart: change its kind and its series in Excel.')
})

test('a chart sheet’s chart changes in place', () => {
  const { read } = change(12, (c) => {
    c.title = text('On its own sheet')
    c.series[0].colour = { hex: '2F6FED' }
  }, corpus, 'ChartSheet')
  expect(read).toMatchObject({ chartsheet: true, title: { text: 'On its own sheet' }, series: [{ colour: { hex: '2F6FED' } }, {}] })
  const locked = withParts(corpus, { 'xl/chartsheets/sheet1.xml': xml(corpus, 'xl/chartsheets/sheet1.xml').replace('<sheetViews>', '<sheetProtection content="1" objects="1"/><sheetViews>') })
  const list = structuredClone(chartsOf(locked, 'ChartSheet'))
  list[0].title = text('No')
  expect(() => patchCharts(locked, [edit(list, 'ChartSheet')])).toThrow('“ChartSheet” is protected.')
})

test('a part that binds the chart namespace as its default is changed under its own names', () => {
  const plain = withParts(corpus, { [CHART(1)]: xml(corpus, CHART(1)).replace(/<(\/?)c:/g, '<$1').replace('xmlns:c=', 'xmlns=') })
  expect(chartsOf(plain)[0]).toEqual(chartsOf(corpus)[0])
  const { after, read } = change(1, (c) => {
    c.title = text('Plain')
    c.legend = null
    c.series[0].colour = { hex: 'C02080' }
    c.series.push({ kind: 'column', group: 0, values: { ref: 'Data!$D$2:$D$9' } })
    c.axes.value!.numberFormat = '0.00'
  }, plain)
  expect(after).not.toContain('<c:')
  expect(after).toContain('<spPr><a:solidFill><a:srgbClr val="C02080"/></a:solidFill></spPr>')
  expect(read).toMatchObject({ title: { text: 'Plain' }, legend: null, series: [{ colour: { hex: 'C02080' } }, {}, { values: { ref: 'Data!$D$2:$D$9' } }], axes: { value: { numberFormat: '0.00' } } })
})

test('a chartEx part, and a part in Strict Open XML, move and go but are not changed here', () => {
  const CX = 'http://schemas.microsoft.com/office/drawing/2014/chartex'
  const drawing = xml(corpus, DRAWING)
  const waterfall = withParts(corpus, {
    [CHART(1)]: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cx:chartSpace xmlns:cx="${CX}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><cx:chart><cx:title><cx:tx><cx:txData><cx:v>Fall</cx:v></cx:txData></cx:tx></cx:title><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="waterfall"/></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>`,
    [DRAWING]: drawing.replace('<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>', `<cx:chart xmlns:cx="${CX}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>`),
    [DRAWING_RELS]: xml(corpus, DRAWING_RELS).replace('relationships/chart" Target="../charts/chart1.xml"', 'relationships/chartEx" Target="../charts/chart1.xml"').replace('http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartEx', 'http://schemas.microsoft.com/office/2014/relationships/chartEx')
  })
  const list = chartsOf(waterfall)
  expect(list[0]).toMatchObject({ id: CHART(1), kind: 'other', otherKind: 'waterfall' })
  expect(patchCharts(waterfall, [edit(list)]).bytes).toBe(waterfall)
  const words = structuredClone(list)
  words[0].legend = 'top'
  expect(() => patchCharts(waterfall, [edit(words)])).toThrow(ChartsRefused)
  expect(() => patchCharts(waterfall, [edit(words)])).toThrow('is written in a way this editor cannot change: change it in Excel.')
  const moved = structuredClone(list)
  moved[0].anchor = place(0, 70)
  expect(chartsOf(patched(waterfall, [edit(moved)], { changed: [DRAWING] }).bytes)[0].anchor).toEqual(place(0, 70))
  patched(waterfall, [edit(list.slice(1))], { changed: [DRAWING, DRAWING_RELS, CT], removed: [CHART(1)] })

  const strict = withParts(corpus, { [CHART(1)]: xml(corpus, CHART(1)).replace('http://schemas.openxmlformats.org/drawingml/2006/chart', 'http://purl.oclc.org/ooxml/drawingml/chart') })
  const strictList = structuredClone(chartsOf(strict))
  expect(patchCharts(strict, [edit(strictList)]).bytes).toBe(strict)
  strictList[0].title = text('No')
  expect(() => patchCharts(strict, [edit(strictList)])).toThrow('The chart “No” is written in a way this editor cannot change: change it in Excel.')
})

test('every corpus chart takes a new title and a recoloured first series, and reads back as asked', () => {
  const list = structuredClone(chartsOf(corpus))
  for (const [k, spec] of list.entries()) {
    spec.title = text(`Chart ${k + 1}`)
    // A stock chart's first series draws neither line nor marker: there is nothing to colour.
    if (spec.kind !== 'pie' && spec.kind !== 'doughnut' && spec.otherKind !== 'stock') spec.series[0].colour = { hex: '2F6FED' }
  }
  const { bytes } = patched(corpus, [edit(list)], { changed: list.map((c) => c.id) })
  const read = chartsOf(bytes)
  expect(read.map((c) => c.title?.text)).toEqual(list.map((c) => c.title?.text))
  for (const [k, spec] of list.entries()) expect(read[k].series[0].colour, spec.id).toEqual(spec.series[0].colour)
  expect(patchCharts(bytes, [edit(list)]).bytes === bytes).toBe(true)
  proof('all-retitled', 'Every chart of the corpus sheet given a new title and its first series recoloured in place (radar and stock included)', bytes)
})
