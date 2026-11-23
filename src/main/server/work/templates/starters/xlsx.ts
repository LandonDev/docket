import { makeZip } from '../zip'

/**
 * The starters' small sheet writer (docs/agents/work-templates.md "The
 * starters"). It knows only what the starter sheets use: one fixed style
 * sheet built on Excel's own cell styles (Normal, Heading 1, Heading 2,
 * Total, Input, Note, Currency, Percent) plus a date, column widths,
 * formulas, merged cells, a frozen head, pick lists and print set-up. It is
 * not a second sheet writer: the sheets pillar's own (sheets/writer.ts) is
 * not imported.
 *
 * Every colour is a theme slot with a tint, and every font is the theme's
 * heading or body font (`<scheme val="major"/>`, `minor`): no literal RGB
 * outside `xl/theme/theme1.xml`, so swapping that one part recolours the
 * whole file. Zipped through `makeZip`, so a sheet built twice is the same
 * bytes.
 */

/**
 * The cell formats a starter may ask for, by what they are for. `input…`
 * marks the few values a person sets before the sheet works (a rate, a
 * count, an invoice's number); a table's rows are plain `cell…` formats
 * with light rules. Text left of a rule is inset by one step, a number or
 * a right-set head keeps one bracket's width clear on its right (`_)`), so
 * a right-set column never runs into the next.
 */
export const CELL_STYLES = [
  'normal',
  'title',
  'section',
  'total',
  'totalCurrency',
  'totalLabel',
  'totalNumber',
  'input',
  'inputCurrency',
  'inputDate',
  'inputPercent',
  'inputMonth',
  'inputNumber',
  'note',
  'currency',
  'percent',
  'date',
  'head',
  'headRight',
  'headCenter',
  'label',
  'labelRight',
  'muted',
  'cell',
  'cellWrap',
  'cellCenter',
  'cellCurrency',
  'cellNumber',
  'cellDate',
  'inputTerms',
  'sectionRight'
] as const
export type CellStyle = (typeof CELL_STYLES)[number]

/**
 * A cell: text, a number, or a formula (no `=`) with a style; null for an
 * empty cell. A formula may carry `v`, its result as the file is written: a
 * reader with no calculator (a CSV export, a preview, the phone) shows it,
 * and Excel works every formula out again when the file opens.
 */
export type CellIn = string | number | null | { v?: string | number; f?: string; s?: CellStyle }

export interface SheetIn {
  name: string
  /** column widths in characters, from A */
  cols: number[]
  /** rows from row 1; a row may be shorter than the columns */
  rows: CellIn[][]
  /** rows from the top kept in view while scrolling */
  freeze?: number
  /** the rows (from 1) a printed page repeats at its top */
  printTitles?: [number, number]
  landscape?: boolean
  /** show the grid on screen (printing never does) */
  grid?: boolean
  merges?: string[]
  /** row heights in points, by row from 1; one given here wins over the height its styles ask for */
  heights?: Record<number, number>
  /** pick lists: a range and its choices */
  lists?: { range: string; values: string[] }[]
  /**
   * The page header and footer, in Excel's own codes (`&L`, `&C`, `&R`, `&P`,
   * `&N`). The header prints from page two on: page one's own title says it
   * already. The footer prints on every page.
   */
  header?: string
  footer?: string
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml'

/** Text for an element's body; `attr` for an attribute's value, which escapes quotes too. */
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const attr = (s: string): string => esc(s).replace(/"/g, '&quot;')

/** A column's letters from 0: 0 is A, 26 is AA. */
export function colName(i: number): string {
  let out = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out
  return out
}

// ── the style sheet ───────────────────────────────────────────────────

/** Theme colour slots as Excel numbers them: 0 light 1, 1 dark 1, 2 light 2, 3 dark 2, 4 to 9 accents 1 to 6. */
const color = (theme: number, tint?: number): string => `<color theme="${theme}"${tint ? ` tint="${tint}"` : ''}/>`
const font = (o: { size: number; major?: boolean; bold?: boolean; tint?: number }): string =>
  `<font>${o.bold ? '<b/>' : ''}<sz val="${o.size}"/>${color(1, o.tint)}<name val="Calibri"/><family val="2"/><scheme val="${o.major ? 'major' : 'minor'}"/></font>`
const FONTS = [
  font({ size: 11 }), // 0 body
  font({ size: 18, major: true }), // 1 Heading 1
  font({ size: 13, major: true, bold: true }), // 2 Heading 2
  font({ size: 11, bold: true }), // 3 bold body
  font({ size: 10, tint: 0.34998626667073579 }) // 4 muted
]
const solid = (theme: number, tint: number): string => `<fill><patternFill patternType="solid"><fgColor theme="${theme}" tint="${tint}"/><bgColor indexed="64"/></patternFill></fill>`
const FILLS = [
  '<fill><patternFill patternType="none"/></fill>',
  '<fill><patternFill patternType="gray125"/></fill>',
  solid(5, 0.79998168889431442), // 2 Input: accent 2, light
  solid(7, 0.79998168889431442), // 3 Note: accent 4, light
  solid(4, 0.79998168889431442) // 4 a table's head: accent 1, light
]
const side = (tag: string, style?: string, theme?: number, tint?: number): string => (style ? `<${tag} style="${style}">${color(theme!, tint)}</${tag}>` : `<${tag}/>`)
const border = (o: { all?: [string, number, number?]; top?: [string, number, number?]; bottom?: [string, number, number?] }): string => {
  const at = (s?: [string, number, number?]): [string?, number?, number?] => s ?? o.all ?? []
  const [l, r, t, b] = [at(), at(), at(o.top), at(o.bottom)]
  return `<border>${side('left', ...l)}${side('right', ...r)}${side('top', ...t)}${side('bottom', ...b)}<diagonal/></border>`
}
const GREY: [string, number, number] = ['thin', 0, -0.34998626667073579]
const LIGHT: [string, number, number] = ['thin', 0, -0.14999847407452621]
const BORDERS = [
  border({}), // 0 none
  border({ bottom: ['thick', 4] }), // 1 Heading 1
  border({ bottom: ['thick', 4, 0.499984740745262] }), // 2 Heading 2
  border({ top: ['thin', 4], bottom: ['double', 4] }), // 3 Total
  border({ all: GREY, top: GREY, bottom: GREY }), // 4 Input and Note
  border({ bottom: ['thin', 4] }), // 5 a table's head
  border({ all: LIGHT, top: LIGHT, bottom: LIGHT }) // 6 a table's cells
]
const NUM_FMTS: Record<number, string> = {
  164: '"$"#,##0.00_);\\("$"#,##0.00\\)',
  165: 'mmm d, yyyy',
  166: '0.0%_)',
  167: 'mmmm yyyy',
  168: '#,##0_)',
  /** text set right, one bracket's width from the rule */
  169: '@_)',
  /** payment terms as a number of days that reads "Net 30" */
  170: '"Net "0'
}
/** Excel's named styles: [name, builtinId, the style's own format]. */
const NAMED: [string, number, string][] = [
  ['Normal', 0, '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>'],
  ['Heading 1', 16, '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" applyNumberFormat="0" applyFill="0" applyAlignment="0" applyProtection="0"/>'],
  ['Heading 2', 17, '<xf numFmtId="0" fontId="2" fillId="0" borderId="2" applyNumberFormat="0" applyFill="0" applyAlignment="0" applyProtection="0"/>'],
  ['Total', 25, '<xf numFmtId="0" fontId="3" fillId="0" borderId="3" applyNumberFormat="0" applyFill="0" applyAlignment="0" applyProtection="0"/>'],
  ['Input', 20, '<xf numFmtId="0" fontId="0" fillId="2" borderId="4" applyNumberFormat="0" applyAlignment="0" applyProtection="0"/>'],
  ['Note', 10, '<xf numFmtId="0" fontId="0" fillId="3" borderId="4" applyNumberFormat="0" applyFont="0" applyAlignment="0" applyProtection="0"/>'],
  ['Currency', 4, '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyFont="0" applyFill="0" applyBorder="0" applyAlignment="0" applyProtection="0"/>'],
  ['Percent', 5, '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" applyFont="0" applyFill="0" applyBorder="0" applyAlignment="0" applyProtection="0"/>']
]
const NAMED_ID = Object.fromEntries(NAMED.map(([name], i) => [name, i]))

interface Xf {
  style: string
  fmt?: number
  font?: number
  fill?: number
  border?: number
  align?: string
}
const LEFT = '<alignment horizontal="left" indent="1"/>'
const RIGHT = '<alignment horizontal="right"/>'
const CENTER = '<alignment horizontal="center"/>'
/** Each cell format: the named style it is, and what it adds. Its place in `CELL_STYLES` is the cell's `s`. */
const XFS: Record<CellStyle, Xf> = {
  normal: { style: 'Normal' },
  title: { style: 'Heading 1', font: 1, border: 1 },
  section: { style: 'Heading 2', font: 2, border: 2 },
  total: { style: 'Total', font: 3, border: 3, align: LEFT },
  totalCurrency: { style: 'Total', font: 3, border: 3, fmt: 164 },
  totalLabel: { style: 'Total', font: 3, border: 3, fmt: 169, align: RIGHT },
  totalNumber: { style: 'Total', font: 3, border: 3, fmt: 168 },
  input: { style: 'Input', fill: 2, border: 4, align: LEFT },
  inputCurrency: { style: 'Input', fill: 2, border: 4, fmt: 164 },
  inputDate: { style: 'Input', fill: 2, border: 4, fmt: 165, align: LEFT },
  inputPercent: { style: 'Input', fill: 2, border: 4, fmt: 166 },
  inputMonth: { style: 'Input', fill: 2, border: 4, fmt: 167, align: LEFT },
  inputNumber: { style: 'Input', fill: 2, border: 4, fmt: 168 },
  note: { style: 'Note', fill: 3, border: 4, align: '<alignment horizontal="left" vertical="center" wrapText="1" indent="1"/>' },
  currency: { style: 'Currency', fmt: 164 },
  percent: { style: 'Percent', fmt: 166 },
  date: { style: 'Normal', fmt: 165, align: LEFT },
  head: { style: 'Normal', font: 3, fill: 4, border: 5, align: '<alignment horizontal="left" vertical="center" indent="1"/>' },
  headRight: { style: 'Normal', font: 3, fill: 4, border: 5, fmt: 169, align: '<alignment horizontal="right" vertical="center"/>' },
  headCenter: { style: 'Normal', font: 3, fill: 4, border: 5, align: '<alignment horizontal="center" vertical="center"/>' },
  label: { style: 'Normal', font: 3 },
  labelRight: { style: 'Normal', font: 3, fmt: 169, align: RIGHT },
  muted: { style: 'Normal', font: 4 },
  cell: { style: 'Normal', border: 6, align: LEFT },
  cellWrap: { style: 'Normal', border: 6, align: '<alignment horizontal="left" wrapText="1" indent="1"/>' },
  cellCenter: { style: 'Normal', border: 6, align: CENTER },
  cellCurrency: { style: 'Currency', border: 6, fmt: 164 },
  cellNumber: { style: 'Normal', border: 6, fmt: 168 },
  cellDate: { style: 'Normal', border: 6, fmt: 165, align: LEFT },
  inputTerms: { style: 'Input', fill: 2, border: 4, fmt: 170, align: LEFT },
  sectionRight: { style: 'Heading 2', font: 2, border: 2, fmt: 169, align: RIGHT }
}
const STYLE_INDEX = new Map(CELL_STYLES.map((s, i) => [s, i]))

function cellXf(x: Xf): string {
  const fmt = x.fmt ?? 0
  const attrs = [`numFmtId="${fmt}"`, `fontId="${x.font ?? 0}"`, `fillId="${x.fill ?? 0}"`, `borderId="${x.border ?? 0}"`, `xfId="${NAMED_ID[x.style]}"`]
  if (fmt) attrs.push('applyNumberFormat="1"')
  if (x.font) attrs.push('applyFont="1"')
  if (x.fill) attrs.push('applyFill="1"')
  if (x.border) attrs.push('applyBorder="1"')
  if (x.align) attrs.push('applyAlignment="1"')
  return x.align ? `<xf ${attrs.join(' ')}>${x.align}</xf>` : `<xf ${attrs.join(' ')}/>`
}

/** The one style sheet every starter sheet carries. */
export function stylesXml(): string {
  const fmts = Object.entries(NUM_FMTS)
  return (
    `${XML}<styleSheet ${NS}>` +
    `<numFmts count="${fmts.length}">${fmts.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${attr(code)}"/>`).join('')}</numFmts>` +
    `<fonts count="${FONTS.length}">${FONTS.join('')}</fonts>` +
    `<fills count="${FILLS.length}">${FILLS.join('')}</fills>` +
    `<borders count="${BORDERS.length}">${BORDERS.join('')}</borders>` +
    `<cellStyleXfs count="${NAMED.length}">${NAMED.map(([, , xf]) => xf).join('')}</cellStyleXfs>` +
    `<cellXfs count="${CELL_STYLES.length}">${CELL_STYLES.map((s) => cellXf(XFS[s])).join('')}</cellXfs>` +
    `<cellStyles count="${NAMED.length}">${NAMED.map(([name, builtin], i) => `<cellStyle name="${name}" xfId="${i}" builtinId="${builtin}"/>`).join('')}</cellStyles>` +
    '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
    '</styleSheet>'
  )
}

// ── the theme: the one part that holds colours ────────────────────────

const srgb = (hex: string): string => `<a:srgbClr val="${hex}"/>`
const schemeFill = (mods: string): string => `<a:solidFill><a:schemeClr val="phClr">${mods}</a:schemeClr></a:solidFill>`
const line = (w: number): string => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`

/** Office's own colours; Calibri for headings and body alike (a reader without Calibri Light falls back to a serif). */
export function themeXml(): string {
  return (
    `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements>` +
    '<a:clrScheme name="Office">' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    `<a:dk2>${srgb('44546A')}</a:dk2><a:lt2>${srgb('E7E6E6')}</a:lt2>` +
    `<a:accent1>${srgb('4472C4')}</a:accent1><a:accent2>${srgb('ED7D31')}</a:accent2><a:accent3>${srgb('A5A5A5')}</a:accent3>` +
    `<a:accent4>${srgb('FFC000')}</a:accent4><a:accent5>${srgb('5B9BD5')}</a:accent5><a:accent6>${srgb('70AD47')}</a:accent6>` +
    `<a:hlink>${srgb('0563C1')}</a:hlink><a:folHlink>${srgb('954F72')}</a:folHlink>` +
    '</a:clrScheme>' +
    '<a:fontScheme name="Office">' +
    '<a:majorFont><a:latin typeface="Calibri" panose="020F0502020204030204"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Calibri" panose="020F0502020204030204"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
    '</a:fontScheme>' +
    '<a:fmtScheme name="Office"><a:fillStyleLst>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    schemeFill('<a:tint val="67000"/>') +
    schemeFill('<a:shade val="78000"/>') +
    `</a:fillStyleLst><a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>` +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>${schemeFill('<a:tint val="95000"/>')}${schemeFill('<a:shade val="90000"/>')}</a:bgFillStyleLst>` +
    '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
  )
}

// ── sheets ────────────────────────────────────────────────────────────

const ROW_HEIGHT: Partial<Record<CellStyle, number>> = { title: 30, section: 22, sectionRight: 22, head: 20, headRight: 20, headCenter: 20 }

interface Strings {
  index(text: string): number
  all: string[]
  uses: number
}
function strings(): Strings {
  const at = new Map<string, number>()
  const s: Strings = {
    all: [],
    uses: 0,
    index(text) {
      s.uses++
      let i = at.get(text)
      if (i === undefined) {
        i = s.all.length
        at.set(text, i)
        s.all.push(text)
      }
      return i
    }
  }
  return s
}

function sheetXml(sheet: SheetIn, shared: Strings, tab: number): string {
  const lastCol = Math.max(sheet.cols.length, ...sheet.rows.map((r) => r.length)) - 1
  const rows: string[] = []
  sheet.rows.forEach((row, ri) => {
    const r = ri + 1
    const cells: string[] = []
    let height = 0
    row.forEach((cell, ci) => {
      if (cell === null || cell === undefined) return
      const c: { v?: string | number; f?: string; s?: CellStyle } = typeof cell === 'object' ? cell : { v: cell }
      const style = c.s ?? 'normal'
      height = Math.max(height, ROW_HEIGHT[style] ?? 0)
      const ref = `${colName(ci)}${r}`
      const s = STYLE_INDEX.get(style)!
      const sAttr = s ? ` s="${s}"` : ''
      if (c.f !== undefined) {
        const cached = c.v === undefined ? '' : `<v>${typeof c.v === 'number' ? c.v : esc(c.v)}</v>`
        cells.push(`<c r="${ref}"${sAttr}${typeof c.v === 'string' ? ' t="str"' : ''}><f>${esc(c.f)}</f>${cached}</c>`)
      }
      else if (typeof c.v === 'number') cells.push(`<c r="${ref}"${sAttr}><v>${c.v}</v></c>`)
      else if (typeof c.v === 'string' && c.v !== '') cells.push(`<c r="${ref}"${sAttr} t="s"><v>${shared.index(c.v)}</v></c>`)
      else cells.push(`<c r="${ref}"${sAttr}/>`)
    })
    height = sheet.heights?.[r] ?? height
    if (cells.length || height) rows.push(`<row r="${r}"${height ? ` ht="${height}" customHeight="1"` : ''}>${cells.join('')}</row>`)
  })
  const freeze = sheet.freeze
    ? `<pane ySplit="${sheet.freeze}" topLeftCell="A${sheet.freeze + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sheet.freeze + 1}" sqref="A${sheet.freeze + 1}"/>`
    : '<selection activeCell="A1" sqref="A1"/>'
  const lists = sheet.lists ?? []
  return (
    `${XML}<worksheet ${NS} ${R_NS}>` +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    `<dimension ref="A1:${colName(Math.max(0, lastCol))}${Math.max(1, sheet.rows.length)}"/>` +
    `<sheetViews><sheetView${sheet.grid === false ? ' showGridLines="0"' : ''}${tab === 0 ? ' tabSelected="1"' : ''} workbookViewId="0">${freeze}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<cols>${sheet.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${rows.join('')}</sheetData>` +
    (sheet.merges?.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '') +
    (lists.length
      ? `<dataValidations count="${lists.length}">${lists.map((l) => `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${l.range}"><formula1>${esc(`"${l.values.join(',')}"`)}</formula1></dataValidation>`).join('')}</dataValidations>`
      : '') +
    '<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    `<pageSetup paperSize="1" orientation="${sheet.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>` +
    headerFooter(sheet) +
    '</worksheet>'
  )
}

/** A header from page two on (`differentFirst`, page one's header left empty), the footer on every page. */
function headerFooter(sheet: SheetIn): string {
  const footer = `<oddFooter>${esc(sheet.footer ?? '&CPage &P of &N')}</oddFooter>`
  if (!sheet.header) return `<headerFooter>${footer}</headerFooter>`
  return `<headerFooter differentFirst="1"><oddHeader>${esc(sheet.header)}</oddHeader>${footer}<firstFooter>${esc(sheet.footer ?? '&CPage &P of &N')}</firstFooter></headerFooter>`
}

const quoteSheet = (name: string): string => `'${name.replace(/'/g, "''")}'`

/** A workbook of the given sheets, as the bytes of an .xlsx. */
export function writeXlsx(sheets: readonly SheetIn[]): Uint8Array {
  if (!sheets.length) throw new Error('A workbook needs a sheet.')
  const shared = strings()
  const sheetParts = sheets.map((s, i) => sheetXml(s, shared, i))
  const n = sheets.length
  const names = sheets
    .map((s, i) => (s.printTitles ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${esc(quoteSheet(s.name))}!$${s.printTitles[0]}:$${s.printTitles[1]}</definedName>` : ''))
    .join('')
  const files: Record<string, string> = {
    '[Content_Types].xml':
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/>` +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT}.worksheet+xml"/>`).join('') +
      '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      `<Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/>` +
      `<Override PartName="/xl/sharedStrings.xml" ContentType="${CT}.sharedStrings+xml"/>` +
      '</Types>',
    '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml':
      `${XML}<workbook ${NS} ${R_NS}><workbookPr defaultThemeVersion="164011"/><bookViews><workbookView activeTab="0"/></bookViews>` +
      `<sheets>${sheets.map((s, i) => `<sheet name="${attr(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
      (names ? `<definedNames>${names}</definedNames>` : '') +
      // Every formula is worked out again when the file opens; the results written with it are for readers with no calculator.
      '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>',
    'xl/_rels/workbook.xml.rels':
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${n + 1}" Type="${REL}/theme" Target="theme/theme1.xml"/>` +
      `<Relationship Id="rId${n + 2}" Type="${REL}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId${n + 3}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
      '</Relationships>'
  }
  sheetParts.forEach((xml, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = xml))
  files['xl/theme/theme1.xml'] = themeXml()
  files['xl/styles.xml'] = stylesXml()
  files['xl/sharedStrings.xml'] =
    `${XML}<sst ${NS} count="${shared.uses}" uniqueCount="${shared.all.length}">` +
    shared.all.map((t) => `<si><t${/^\s|\s$/.test(t) ? ' xml:space="preserve"' : ''}>${esc(t)}</t></si>`).join('') +
    '</sst>'
  return makeZip(files)
}
