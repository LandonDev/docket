import { ANSWERS_TABLE } from '@shared/work/msforms'
import { makeZip } from '../../templates/zip'

/**
 * A made-up answers workbook of the shape Forms writes (the trial's, trial-raw.md §5): one sheet
 * holding the table `OfficeForms.Table`, Forms' five columns first (times as date serials), then a
 * column a question. For tests alone: every answer in one is made up.
 */

export interface TestAnswer {
  id: number
  /** Excel serials */
  start: number
  end: number
  email: string
  name: string
  answers: string[]
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const colName = (i: number): string => {
  let n = i + 1
  let out = ''
  while (n > 0) {
    const m = (n - 1) % 26
    out = String.fromCharCode(65 + m) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** A serial for a wall time, as Excel keeps one. */
export const serialOf = (iso: string): number => Date.parse(`${iso}Z`) / 86_400_000 + 25569

export function formsWorkbook(questions: readonly string[], answers: readonly TestAnswer[], o: { table?: string } = {}): Uint8Array {
  const headers = ['Id', 'Start time', 'Completion time', 'Email', 'Name', ...questions]
  const text = (ref: string, s: string) => `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(s)}</t></is></c>`
  const num = (ref: string, v: number, style?: number) => `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${v}</v></c>`
  const rows = [
    `<row r="1">${headers.map((h, i) => text(`${colName(i)}1`, h)).join('')}</row>`,
    ...answers.map((a, n) => {
      const r = n + 2
      const cells = [num(`A${r}`, a.id), num(`B${r}`, a.start, 1), num(`C${r}`, a.end, 1), text(`D${r}`, a.email), text(`E${r}`, a.name), ...a.answers.map((v, i) => text(`${colName(5 + i)}${r}`, v))]
      return `<row r="${r}">${cells.join('')}</row>`
    })
  ]
  const ref = `A1:${colName(headers.length - 1)}${answers.length + 1}`
  const name = o.table ?? ANSWERS_TABLE
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  return makeZip({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${main}"><numFmts count="1"><numFmt numFmtId="164" formatCode="m/d/yy h:mm:ss"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${main}" xmlns:r="${rel}"><dimension ref="${ref}"/><sheetData>${rows.join('')}</sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`,
    'xl/worksheets/_rels/sheet1.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/table" Target="../tables/table1.xml"/></Relationships>`,
    'xl/tables/table1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="${main}" id="1" name="${esc(name)}" displayName="${esc(name)}" ref="${ref}" totalsRowShown="0"><autoFilter ref="${ref}"/><tableColumns count="${headers.length}">${headers.map((h, i) => `<tableColumn id="${i + 1}" name="${esc(h)}"/>`).join('')}</tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`
  })
}

/** `n` made-up answers to the given questions, Ids 1..n, a minute apart from 24 November 2026 at 9:00. */
export function madeUpAnswers(n: number, answer: (i: number) => string[]): TestAnswer[] {
  const t0 = serialOf('2026-11-24T09:00:00')
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, start: t0 + i / 1440, end: t0 + (i + 0.5) / 1440, email: `dummy${i + 1}@example.test`, name: `Dummy Person ${i + 1}`, answers: answer(i) }))
}
