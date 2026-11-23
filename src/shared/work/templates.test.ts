import { describe, expect, it } from 'vitest'
import {
  askedFields,
  canvasKindOf,
  dayOf,
  excelSerial,
  fieldKey,
  fieldList,
  fieldMatches,
  fieldsOf,
  fieldValues,
  fileStem,
  filledValues,
  fillText,
  isDay,
  isFilledField,
  LEAVE_UNFILLED,
  longDate,
  madeTitle,
  parseTemplateId,
  templateFormOf,
  templateId
} from './templates'

describe('the field grammar', () => {
  it('finds fields in order, each once, as first written', () => {
    expect(fieldsOf('Dear {{Client}}, about {{Project}}. Yours, {{Name}}. Again {{Client}}.')).toEqual(['Client', 'Project', 'Name'])
  })

  it('matches names without case and without the spaces around them', () => {
    expect(fieldsOf('{{Client}} {{client}} {{ CLIENT }} {{Invoice  number}} {{invoice number}}')).toEqual(['Client', 'Invoice number'])
    expect(fieldKey('  Invoice   Number ')).toBe('invoice number')
  })

  it('takes letters, digits and spaces of any script, and nothing else', () => {
    expect(fieldsOf('{{Année 2026}} {{名前}}')).toEqual(['Année 2026', '名前'])
    expect(fieldsOf('{{a-b}} {{a_b}} {{a.b}} {{<b>}} {{}}  {{   }}')).toEqual([])
  })

  it('refuses a name over forty characters and takes one of forty', () => {
    expect(fieldsOf(`{{${'a'.repeat(41)}}}`)).toEqual([])
    expect(fieldsOf(`{{${'a'.repeat(40)}}}`)).toEqual(['a'.repeat(40)])
  })

  it('leaves a lone brace and a half-open field as words', () => {
    expect(fieldsOf('{Client} {{Client} {Client}} { {Client} } }}Client{{')).toEqual([])
    expect(fillText('a { b } {{ c', fieldValues({ c: 'x' }))).toBe('a { b } {{ c')
  })

  it('says where each field stands', () => {
    expect(fieldMatches('ab {{X}} cd')).toEqual([{ name: 'X', key: 'x', start: 3, end: 8 }])
  })

  it('asks for every field but Date, Name and Job', () => {
    expect(askedFields(['Date', 'Client', 'name', 'JOB', 'Game'])).toEqual(['Client', 'Game'])
    expect(isFilledField(' date ')).toBe(true)
    expect(isFilledField('Dated')).toBe(false)
  })
})

describe('fillText', () => {
  it('fills the same field everywhere it stands, by any spelling', () => {
    expect(fillText('{{Client}} and {{ client }}', fieldValues({ CLIENT: 'Acme' }))).toBe('Acme and Acme')
  })

  it('leaves a field with no value as written', () => {
    expect(LEAVE_UNFILLED).toBe(true)
    expect(fillText('{{Client}} at {{Site}}', fieldValues({ Client: 'Acme', Site: '  ' }))).toBe('Acme at {{Site}}')
  })

  it('writes a value as it is, braces and all, and never fills it again', () => {
    expect(fillText('{{A}} {{B}}', fieldValues({ A: '{{B}}', B: 'b' }))).toBe('{{B}} b')
  })
})

describe('the three filled without asking', () => {
  it('writes the day in the long form', () => {
    expect(longDate('2026-11-23')).toBe('November 23, 2026')
    expect(longDate('2027-01-05')).toBe('January 5, 2027')
  })

  it('refuses a day that is none', () => {
    expect(isDay('2026-02-30')).toBe(false)
    expect(isDay('23/11/2026')).toBe(false)
    expect(() => longDate('2026-13-01')).toThrow('is not a day')
  })

  it('counts a day as Excel does', () => {
    expect(excelSerial('1900-03-01')).toBe(61)
    expect(excelSerial('2026-11-23')).toBe(46349)
    expect(excelSerial('2026-11-23', true)).toBe(46349 - 1462)
  })

  it("reads a clock's day where the caller stands", () => {
    expect(dayOf(new Date(2026, 10, 3, 23, 59))).toBe('2026-11-03')
  })

  it('leaves out what he has none of', () => {
    const values = filledValues({ today: '2026-11-23', ownerName: null, job: 'Dummy Esports' })
    expect([...values]).toEqual([
      ['date', 'November 23, 2026'],
      ['job', 'Dummy Esports']
    ])
  })
})

describe("the new file's name", () => {
  const report = { name: 'Game report', fields: ['Home', 'Away', 'Site'] }

  it('is the template, then the first asked field that has a value', () => {
    expect(madeTitle(report, fieldValues({ Home: 'Central at North' }))).toBe('Game report - Central at North')
    expect(madeTitle(report, fieldValues({ Away: 'North' }))).toBe('Game report - North')
    expect(madeTitle(report, fieldValues({}))).toBe('Game report')
  })

  it("is the caller's title when one is given", () => {
    expect(madeTitle(report, fieldValues({ Home: 'Central' }), 'Friday varsity')).toBe('Friday varsity')
  })

  it('holds no character a disk refuses', () => {
    expect(fileStem(' a/b\\c:d*e?f"g<h>i|j\n. ')).toBe('a b c d e f g h i j')
    expect(madeTitle({ name: 'Invoice', fields: ['Client'] }, fieldValues({ Client: 'A/B: Co.' }))).toBe('Invoice - A B Co')
    expect(fileStem('x'.repeat(300)).length).toBe(120)
    expect(madeTitle({ name: '...', fields: [] }, new Map())).toBe('Untitled')
  })
})

describe('forms, kinds and ids', () => {
  it('knows a template by its extension', () => {
    expect(templateFormOf('Memo.docx')).toEqual({ form: 'docx', kind: 'document' })
    expect(templateFormOf('Notes.TCDOC')).toEqual({ form: 'tcdoc', kind: 'document' })
    expect(templateFormOf('Budget.xlsx')).toEqual({ form: 'xlsx', kind: 'sheet' })
    expect(templateFormOf('Log.tcsheet')).toEqual({ form: 'tcsheet', kind: 'sheet' })
    expect(templateFormOf('Pitch.pptx')).toEqual({ form: 'pptx', kind: 'deck' })
    expect(templateFormOf('notes.txt')).toBeNull()
    expect(templateFormOf('scan.pdf')).toBeNull()
  })

  it('opens a deck in the slides canvas', () => {
    expect(canvasKindOf('deck')).toBe('slides')
    expect(canvasKindOf('sheet')).toBe('sheet')
  })

  it('writes and reads an id', () => {
    expect(templateId('starter', 'unify/invoice')).toBe('starter:unify/invoice')
    expect(parseTemplateId('job:Game report: v2.docx')).toEqual({ where: 'job', key: 'Game report: v2.docx' })
    expect(parseTemplateId('Invoice')).toBeNull()
    expect(parseTemplateId('other:x')).toBeNull()
    expect(parseTemplateId('job:')).toBeNull()
  })

  it('says a list of fields in a sentence', () => {
    expect(fieldList(['Client'])).toBe('Client')
    expect(fieldList(['Client', 'Game'])).toBe('Client and Game')
    expect(fieldList(['Home', 'Away', 'Site'])).toBe('Home, Away and Site')
  })
})
