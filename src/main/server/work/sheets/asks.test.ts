import { describe, expect, it } from 'vitest'
import { RULES_SET } from '@shared/work/sheets'
import { agentFormat, colourWord, FormatSchema, formatWords, heldOfPackage, nameProblem, place, ruleClash, ruleListMutation, ruleModel, ruleMutations, RuleSchema, ruleWords, where, type RuleAsk } from './asks'
import { sheetTools } from './tools'

/**
 * What a thread asks of a sheet's look and its rules, as Univer's own models and as the words he
 * reads. The models are the ones the side sheet makes: each is replayed by the real engine and
 * written into a real file in private.test.ts and host/rules.test.ts.
 */
const SHEETS = [
  { id: 's1', name: 'Budget' },
  { id: 's2', name: 'Q1 Notes' }
]
const at = (text: string) => place(text, SHEETS)
const model = (rule: RuleAsk) => ruleModel(rule, 'range' in rule && typeof rule.range === 'string' ? at(rule.range) : null, SHEETS)
const body = (rule: RuleAsk): Record<string, unknown> => {
  const m = model(rule)
  if (m.list !== 'conditional' && m.list !== 'validation') throw new Error('not a sheet rule')
  return m.list === 'conditional' ? (m.rule.rule as Record<string, unknown>) : m.rule
}
const B = 'B2:B9'

describe('where an ask lies', () => {
  it('reads the tab it names, else the first, and says the tab where there is more than one', () => {
    expect(at('B2:B9')).toEqual({ sheet: 's1', name: 'Budget', range: { startRow: 1, endRow: 8, startColumn: 1, endColumn: 1 } })
    expect(at("'Q1 Notes'!A1")).toMatchObject({ sheet: 's2', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } })
    expect(where(at("'Q1 Notes'!A1:B2"), SHEETS)).toBe("'Q1 Notes'!A1:B2")
    expect(where(at('A1:B2'), [SHEETS[0]!])).toBe('A1:B2')
    expect(() => at('Gone!A1')).toThrow('There is no sheet named Gone. Sheets: Budget, Q1 Notes.')
    expect(() => at('B2:')).toThrow('is not a range')
  })
})

describe('a format in words', () => {
  it('says each part once, in the order he would', () => {
    expect(formatWords({ bold: true, fill: '#FFF2CC' }, 'B2:B9')).toBe('Bold, yellow fill on B2:B9')
    expect(formatWords({ style: 'heading1' }, 'A1:F1')).toBe('Heading 1 style on A1:F1')
    expect(formatWords({ colour: '#C00000', italic: true, align: 'center', wrap: true }, 'A1')).toBe('Italic, red text, centred, wrapped on A1')
    expect(formatWords({ pattern: '0.00%', borders: 'outside' }, 'C2:C9')).toBe('An outside border, percent format on C2:C9')
    expect(formatWords({ pattern: '0.0"x"' }, 'C2')).toBe('Format 0.0"x" on C2')
    expect(formatWords({ colour: null, fill: null, bold: false }, 'A1')).toBe('Not bold, automatic text colour, no fill on A1')
    expect(formatWords({ clear: true }, 'A1:Z9')).toBe('Formatting cleared on A1:Z9')
    expect(formatWords({ width: 160, height: 40, family: 'Cambria', size: 14 }, 'B:B')).toBe('Cambria, 14 pt, 160 px wide, 40 px tall on B:B')
    expect(() => formatWords({}, 'A1')).toThrow('Say what to format')
  })

  it('names a colour by its nearest plain word', () => {
    expect(Object.fromEntries(['#FF0000', '#C00000', '#FFC7CE', '#FFA500', '#FFF2CC', '#FFFF00', '#00B050', '#C6EFCE', '#00B0F0', '#0070C0', '#7030A0', '#000000', '#FFFFFF', '#808080', '#7F3F00'].map((c) => [c, colourWord(c)]))).toEqual({
      '#FF0000': 'red',
      '#C00000': 'red',
      '#FFC7CE': 'pink',
      '#FFA500': 'orange',
      '#FFF2CC': 'yellow',
      '#FFFF00': 'yellow',
      '#00B050': 'green',
      '#C6EFCE': 'green',
      '#00B0F0': 'teal',
      '#0070C0': 'blue',
      '#7030A0': 'purple',
      '#000000': 'black',
      '#FFFFFF': 'white',
      '#808080': 'grey',
      '#7F3F00': 'brown'
    })
  })

  it('hands the row\'s own code a colour as a colour, and keeps the sizes apart', () => {
    expect(agentFormat({ bold: true, colour: '#C00000', fill: null, width: 160, height: 40 })).toEqual({ bold: true, colour: { hex: '#C00000' }, fill: null })
    expect(agentFormat({ width: 160 })).toEqual({})
  })

  it('refuses a key it does not know and a colour that is not a hex', () => {
    expect(FormatSchema.safeParse({ bold: true, merge: true }).success).toBe(false)
    expect(FormatSchema.safeParse({ decimals: 1 }).success).toBe(false)
    expect(FormatSchema.safeParse({ fill: 'yellow' }).success).toBe(false)
    expect(FormatSchema.safeParse({ fill: '#FFF2CC', pattern: '' }).success).toBe(true)
  })
})

describe('a highlight as Univer\'s rule', () => {
  const look = { colour: '#C00000', bold: true }
  it.each([
    ['greater', 100, { subType: 'number', operator: 'greaterThan', value: 100 }, 'is greater than 100'],
    ['less', '7', { subType: 'number', operator: 'lessThan', value: 7 }, 'is less than 7'],
    ['atLeast', 1, { subType: 'number', operator: 'greaterThanOrEqual', value: 1 }, 'is at least 1'],
    ['atMost', 1, { subType: 'number', operator: 'lessThanOrEqual', value: 1 }, 'is at most 1'],
    ['equal', 5, { subType: 'number', operator: 'equal', value: 5 }, 'is 5'],
    ['notEqual', 5, { subType: 'number', operator: 'notEqual', value: 5 }, 'is not 5'],
    ['equal', 'Paid', { subType: 'text', operator: 'equal', value: 'Paid' }, 'is Paid'],
    ['contains', 'late', { subType: 'text', operator: 'containsText', value: 'late' }, 'contains "late"'],
    ['notContains', 'late', { subType: 'text', operator: 'notContainsText', value: 'late' }, 'does not contain "late"'],
    ['begins', 'Q', { subType: 'text', operator: 'beginsWith', value: 'Q' }, 'begins with "Q"'],
    ['ends', 'x', { subType: 'text', operator: 'endsWith', value: 'x' }, 'ends with "x"'],
    ['blank', undefined, { subType: 'text', operator: 'containsBlanks' }, 'is blank'],
    ['notBlank', undefined, { subType: 'text', operator: 'notContainsBlanks' }, 'is not blank'],
    ['error', undefined, { subType: 'text', operator: 'containsErrors' }, 'is an error'],
    ['duplicate', undefined, { subType: 'duplicateValues' }, 'repeats'],
    ['unique', undefined, { subType: 'uniqueValues' }, 'is the only one'],
    ['top', 3, { subType: 'rank', isBottom: false, isPercent: false, value: 3 }, 'is in the top 3'],
    ['bottom', undefined, { subType: 'rank', isBottom: true, isPercent: false, value: 10 }, 'is in the bottom 10'],
    ['aboveAverage', undefined, { subType: 'average', operator: 'greaterThan' }, 'is above average'],
    ['belowAverage', undefined, { subType: 'average', operator: 'lessThan' }, 'is below average'],
    ['formula', '$C2>$B2', { subType: 'formula', value: '=$C2>$B2' }, 'makes $C2>$B2 true']
  ] as const)('%s %s', (when, value, want, words) => {
    const rule = { kind: 'highlight', range: B, when, ...(value === undefined ? {} : { value }), look } as RuleAsk
    expect(body(rule)).toEqual({ type: 'highlightCell', style: { bl: 1, cl: { rgb: '#C00000' } }, ...want })
    expect(ruleWords(rule, B)).toBe(`Bold, red text where B2:B9 ${words}`)
  })

  it('between takes its ends in order, and every rule lies on its range and stops nothing after it', () => {
    const rule: RuleAsk = { kind: 'highlight', range: B, when: 'between', value: 9, value2: 2, look: { fill: '#FFC7CE' } }
    const m = model(rule)
    expect(m).toMatchObject({ list: 'conditional', sheet: 's1', rule: { ranges: [{ startRow: 1, endRow: 8, startColumn: 1, endColumn: 1 }], stopIfTrue: false, rule: { operator: 'between', value: [2, 9], style: { bg: { rgb: '#FFC7CE' } } } } })
    expect(ruleWords(rule, B)).toBe('Pink fill where B2:B9 is between 9 and 2')
    expect(ruleMutations('book', m)).toEqual([{ id: 'sheet.mutation.add-conditional-rule', params: { unitId: 'book', subUnitId: 's1', rule: (m as { rule: unknown }).rule } }])
  })

  it('refuses what it cannot make, as it is asked', () => {
    expect(() => model({ kind: 'highlight', range: B, when: 'greater', value: 'soon', look })).toThrow('That comparison needs a number.')
    expect(() => model({ kind: 'highlight', range: B, when: 'greater', value: 1, look: {} })).toThrow('A highlight needs a look')
    expect(() => model({ kind: 'highlight', range: B, when: 'contains', look })).toThrow('needs the text to look for')
    expect(() => model({ kind: 'highlight', range: B, when: 'formula', look })).toThrow('needs its formula')
    expect(() => model({ kind: 'highlight', range: B, when: 'between', value: 1, look })).toThrow('Between needs a number.')
  })
})

describe('a scale, a bar, a list, a check, a name and the filter', () => {
  it('a colour scale of two or three colours, lowest first', () => {
    expect(body({ kind: 'scale', range: B, colours: ['#f8696b', '#63be7b'] })).toEqual({ type: 'colorScale', config: [{ index: 0, color: '#F8696B', value: { type: 'min' } }, { index: 1, color: '#63BE7B', value: { type: 'max' } }] })
    expect((body({ kind: 'scale', range: B, colours: ['#F8696B', '#FFEB84', '#63BE7B'] }).config as { value: unknown }[])[1]!.value).toEqual({ type: 'percentile', value: 50 })
    expect(ruleWords({ kind: 'scale', range: B, colours: ['#F8696B', '#63BE7B'] }, B)).toBe('A colour scale, red to green, on B2:B9')
  })

  it('a data bar in one colour both ways, with its value shown', () => {
    expect(body({ kind: 'bar', range: B, colour: '#638EC6' })).toEqual({ type: 'dataBar', isShowValue: true, config: { min: { type: 'min' }, max: { type: 'max' }, isGradient: false, positiveColor: '#638EC6', nativeColor: '#638EC6' } })
    expect(ruleWords({ kind: 'bar', range: B, colour: '#638EC6' }, B)).toBe('Blue data bars on B2:B9')
  })

  it('a list of typed items, or from a range; a bad value is refused in Excel as its own dialog sets it', () => {
    const typed = body({ kind: 'list', range: B, items: [' Open', 'Done '], message: 'Pick a status' })
    expect(typed).toMatchObject({ type: 'list', formula1: 'Open,Done', allowBlank: true, showErrorMessage: true, errorStyle: 1, error: 'Pick a status', ranges: [{ startRow: 1, endRow: 8, startColumn: 1, endColumn: 1 }] })
    expect(body({ kind: 'list', range: B, from: "'Q1 Notes'!A2:A9" })).toMatchObject({ type: 'list', formula1: "='Q1 Notes'!$A$2:$A$9" })
    expect(ruleWords({ kind: 'list', range: B, items: ['a', 'b', 'c', 'd', 'e'] }, B)).toBe('A list (a, b, c, d, …) on B2:B9')
    expect(ruleWords({ kind: 'list', range: B, from: 'D2:D9' }, B)).toBe('A list from D2:D9 on B2:B9')
    expect(() => model({ kind: 'list', range: B })).toThrow('`items` or `from`, one of them')
    expect(() => model({ kind: 'list', range: B, items: ['a'], from: 'D2:D9' })).toThrow('one of them')
    expect(() => model({ kind: 'list', range: B, items: ['a, b'] })).toThrow('cannot hold a comma')
    expect(() => model({ kind: 'list', range: B, items: Array.from({ length: 60 }, (_, i) => `item ${i}`) })).toThrow('at most 255 characters')
  })

  it('a check of a number, a date or a length', () => {
    expect(body({ kind: 'check', range: B, of: 'whole', when: 'between', value: 1, value2: 21 })).toMatchObject({ type: 'whole', operator: 'between', formula1: '1', formula2: '21' })
    expect(body({ kind: 'check', range: B, of: 'decimal', when: 'atLeast', value: 0.5 })).toMatchObject({ type: 'decimal', operator: 'greaterThanOrEqual', formula1: '0.5' })
    expect(body({ kind: 'check', range: B, of: 'date', when: 'greater', value: '2026-01-31' })).toMatchObject({ type: 'date', operator: 'greaterThan', formula1: '2026-01-31' })
    expect(body({ kind: 'check', range: B, of: 'length', when: 'atMost', value: 40 })).toMatchObject({ type: 'textLength', operator: 'lessThanOrEqual', formula1: '40' })
    expect(body({ kind: 'custom', range: B, formula: 'ISNUMBER(B2)' })).toMatchObject({ type: 'custom', formula1: '=ISNUMBER(B2)' })
    expect(ruleWords({ kind: 'check', range: B, of: 'whole', when: 'between', value: 1, value2: 21 }, B)).toBe('B2:B9 takes only a whole number that is between 1 and 21')
    expect(() => model({ kind: 'check', range: B, of: 'whole', when: 'between', value: 1 })).toThrow('Between needs `value2`.')
    expect(() => model({ kind: 'check', range: B, of: 'whole', when: 'equal', value: 1.5 })).toThrow('takes a whole number')
    expect(() => model({ kind: 'check', range: B, of: 'date', when: 'equal', value: '31/01/2026' })).toThrow('A date is written 2026-01-31.')
  })

  it('a name for a range is kept with its tab and fixed; a formula stays a formula; a tab\'s own name names its sheet', () => {
    expect(model({ kind: 'name', name: 'Budgeted', refersTo: 'B2:B9' })).toMatchObject({ list: 'names', rule: { name: 'Budgeted', formulaOrRefString: 'Budget!$B$2:$B$9' } })
    expect(model({ kind: 'name', name: 'Rate', refersTo: '=0.08' })).toMatchObject({ rule: { formulaOrRefString: '=0.08' } })
    const local = model({ kind: 'name', name: 'Notes', refersTo: "'Q1 Notes'!A1", scope: 'Q1 Notes' })
    expect(local).toMatchObject({ rule: { formulaOrRefString: "'Q1 Notes'!$A$1", localSheetId: 's2' } })
    expect(ruleMutations('book', local)[0]).toMatchObject({ id: 'formula.mutation.set-defined-name', params: { unitId: 'book', name: 'Notes', localSheetId: 's2' } })
    expect(() => model({ kind: 'name', name: 'Notes', refersTo: 'A1', scope: 'Gone' })).toThrow('There is no sheet named Gone.')
    expect(ruleWords({ kind: 'name', name: 'Budgeted', refersTo: 'B2:B9' }, '')).toBe('The name Budgeted for B2:B9')
  })

  it('a name follows Excel\'s grammar', () => {
    for (const ok of ['Budget', '_x', '\\rate', 'Q1.total', 'Größe', 'A1B', 'ABCD1']) expect(nameProblem(ok), ok).toBeNull()
    for (const bad of ['1st', 'two words', 'a-b', 'A1', 'xfd1048576', 'R1C1', 'r', 'C', 'RC', 'x'.repeat(256)]) expect(nameProblem(bad), bad).not.toBeNull()
    // the names Excel keeps for itself, by the writer's own list
    for (const kept of ['TRUE', 'false', 'Print_Area', 'print_titles', 'Criteria', '_FilterDatabase', '_xlnm.Print_Area', '_XLNM.anything']) expect(nameProblem(kept), kept).toBe(`${kept} is a name Excel keeps for itself: pick another name.`)
    expect(() => model({ kind: 'name', name: 'A1', refersTo: 'B2' })).toThrow('A1 reads as a cell')
  })

  it('the filter is laid on a range or taken off', () => {
    const on = ruleModel({ kind: 'filter', range: 'A1:F40' }, at('A1:F40'), SHEETS)
    expect(ruleMutations('book', on)).toEqual([{ id: 'sheet.mutation.set-filter-range', params: { unitId: 'book', subUnitId: 's1', range: { startRow: 0, endRow: 39, startColumn: 0, endColumn: 5 } } }])
    const off = ruleModel({ kind: 'filter', range: null }, null, SHEETS)
    expect(ruleMutations('book', off)).toEqual([{ id: 'sheet.mutation.remove-filter', params: { unitId: 'book', subUnitId: 's1' } }])
    expect(ruleWords({ kind: 'filter', range: 'A1:F40' }, 'A1:F40')).toBe('A filter on A1:F40')
    expect(ruleWords({ kind: 'filter', range: null }, '')).toBe('The filter taken off')
  })

  it('the filter taken off names its tab: the first when none is said, and no tab that is not there', () => {
    const off = ruleModel({ kind: 'filter', range: null, sheet: 'Q1 Notes' }, null, SHEETS)
    expect(off).toEqual({ list: 'filter', sheet: 's2', filter: null })
    expect(ruleMutations('book', off)).toEqual([{ id: 'sheet.mutation.remove-filter', params: { unitId: 'book', subUnitId: 's2' } }])
    expect(() => ruleModel({ kind: 'filter', range: null, sheet: 'Gone' }, null, SHEETS)).toThrow('There is no sheet named Gone.')
    expect(ruleWords({ kind: 'filter', range: null, sheet: 'Q1 Notes' }, 'Q1 Notes')).toBe('The filter taken off Q1 Notes')
  })

  it('top and bottom take a whole number from 1 to 1,000, as the file does', () => {
    expect(body({ kind: 'highlight', range: B, when: 'top', value: 5, look: { bold: true } })).toMatchObject({ subType: 'rank', value: 5, isBottom: false })
    for (const value of [2.5, 0, 5000]) expect(() => model({ kind: 'highlight', range: B, when: 'bottom', value, look: { bold: true } }), String(value)).toThrow('Top and bottom take a whole number from 1 to 1,000.')
  })

  it('a width or a height past what an Excel file keeps is refused as it is asked', () => {
    expect(FormatSchema.safeParse({ width: 1790, height: 545 }).success).toBe(true)
    expect(FormatSchema.safeParse({ width: 1791 }).success).toBe(false)
    expect(FormatSchema.safeParse({ height: 546 }).success).toBe(false)
  })
})

describe('a rule against what the sheet already holds', () => {
  const held = { names: [{ name: 'Rate' }, { name: 'Local', scope: 's2' }], filters: { s1: { startRow: 0, endRow: 27, startColumn: 0, endColumn: 3 } }, validations: { s1: [{ startRow: 1, endRow: 4, startColumn: 2, endColumn: 2 }] } }
  const clash = (rule: RuleAsk) => ruleClash(model(rule), held, SHEETS)
  it('a name already there in its scope is refused, whatever its case; the same name in another scope is not', () => {
    expect(clash({ kind: 'name', name: 'rate', refersTo: '=0.1' })).toBe("The name rate is already there: change it in the sheet's Rules.")
    expect(clash({ kind: 'name', name: 'Local', refersTo: 'A1', scope: 'Q1 Notes' })).toContain('already there')
    expect(clash({ kind: 'name', name: 'Local', refersTo: 'A1' })).toBeNull()
    expect(clash({ kind: 'name', name: 'Rate', refersTo: 'A1', scope: 'Q1 Notes' })).toBeNull()
  })

  it('a filter is laid only where none is, and taken off only where one is', () => {
    expect(clash({ kind: 'filter', range: 'A1:F40' })).toBe('Budget already has a filter on A1:D28: take it off first.')
    expect(clash({ kind: 'filter', range: "'Q1 Notes'!A1:F40" })).toBeNull()
    expect(clash({ kind: 'filter', range: null })).toBeNull()
    expect(clash({ kind: 'filter', range: null, sheet: 'Q1 Notes' })).toBe('Q1 Notes has no filter.')
  })

  it('a validation is not laid over cells that have one', () => {
    expect(clash({ kind: 'list', range: 'C2:C9', items: ['a'] })).toBe("C2:C5 already has a validation: change it in the sheet's Rules.")
    expect(clash({ kind: 'check', range: 'C6:C9', of: 'whole', when: 'greater', value: 1 })).toBeNull()
    expect(clash({ kind: 'list', range: "'Q1 Notes'!C2:C9", items: ['a'] })).toBeNull()
  })

  it('a conditional format is always added: it stacks', () => {
    expect(clash({ kind: 'bar', range: 'C2:C9', colour: '#638EC6' })).toBeNull()
  })

  it("an opened Excel file's rules read the same way", () => {
    const got = heldOfPackage({
      conditional: {},
      validation: { s1: [{ uid: 'v', ranges: [{ startRow: 1, endRow: 4, startColumn: 2, endColumn: 2, rangeType: 0 }] }] },
      names: [{ id: 'n1', name: 'Rate', formulaOrRefString: '=0.1' }, { id: 'n2', name: 'Local', formulaOrRefString: 'x', localSheetId: 's2' }, { id: 'n3', name: 'All', formulaOrRefString: 'x', localSheetId: 'AllDefaultWorkbook' }],
      filter: { s1: { ref: { startRow: 0, endRow: 27, startColumn: 0, endColumn: 3 } }, s2: null }
    } as never)
    expect(got).toEqual({ names: [{ name: 'Rate' }, { name: 'Local', scope: 's2' }, { name: 'All' }], filters: held.filters, validations: held.validations })
  })
})

describe('a rule for an opened Excel file: the whole list it leaves', () => {
  const held = { conditional: { s1: [{ cfId: 'old' }] }, validation: { s1: [{ uid: 'old' }] }, names: [{ id: 'name1', name: 'Budgeted', formulaOrRefString: 'Budget!$B$2' }, { id: 'name2', name: 'budgeted', formulaOrRefString: 'x', localSheetId: 's2' }], filter: {}, tables: {} }
  it('a new conditional format wins first; a validation goes last; the other sheets\' lists are not sent', () => {
    const cf = ruleListMutation(model({ kind: 'bar', range: B, colour: '#638EC6' }), held)
    expect(cf.id).toBe(RULES_SET)
    expect((cf.params as { kind: string; subUnitId: string; list: { cfId: string }[] }).list.map((r) => r.cfId === 'old')).toEqual([false, true])
    const dv = ruleListMutation(model({ kind: 'list', range: "'Q1 Notes'!A1", items: ['a'] }), held)
    expect(dv.params).toMatchObject({ kind: 'validation', subUnitId: 's2' })
    expect((dv.params as { list: unknown[] }).list).toHaveLength(1)
  })

  it('a name said again in the same scope replaces the old one, whatever its case, and leaves the other scope\'s', () => {
    const names = ruleListMutation(model({ kind: 'name', name: 'BUDGETED', refersTo: 'B2:B9' }), held).params as { kind: string; list: { name: string; localSheetId?: string }[] }
    expect(names.kind).toBe('names')
    expect(names.list.map((n) => [n.name, n.localSheetId])).toEqual([
      ['budgeted', 's2'],
      ['BUDGETED', undefined]
    ])
  })

  it('the filter is its range, or null', () => {
    expect(ruleListMutation(ruleModel({ kind: 'filter', range: 'A1:F40' }, at('A1:F40'), SHEETS), held).params).toEqual({ kind: 'filter', subUnitId: 's1', list: { ref: { startRow: 0, endRow: 39, startColumn: 0, endColumn: 5 } } })
    expect(ruleListMutation(ruleModel({ kind: 'filter', range: null }, null, SHEETS), held).params).toEqual({ kind: 'filter', subUnitId: 's1', list: null })
  })
})

describe('the tools a thread formats and rules a sheet with', () => {
  it('each says itself in under 400 bytes', () => {
    for (const tool of sheetTools) expect(Buffer.byteLength(tool.description), tool.name).toBeLessThan(400)
    expect(sheetTools.map((t) => t.name)).toEqual(['sheet_read', 'sheet_write', 'sheet_suggest', 'sheet_format', 'sheet_rule', 'sheet_create'])
  })

  it('take one rule of a known kind and nothing else', () => {
    expect(RuleSchema.safeParse({ kind: 'highlight', range: 'B2:B9', when: 'greater', value: 100, look: { colour: '#C00000' } }).success).toBe(true)
    expect(RuleSchema.safeParse({ kind: 'pivot', range: 'B2:B9' }).success).toBe(false)
    expect(RuleSchema.safeParse({ kind: 'highlight', range: 'B2:B9', when: 'sometimes', look: {} }).success).toBe(false)
    expect(RuleSchema.safeParse({ kind: 'highlight', range: 'B2:B9', when: 'greater', value: 1, look: { glow: true } }).success).toBe(false)
  })
})
