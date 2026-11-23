import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { RULES_SET, type RulesSetParams } from '@shared/work/sheets'
import { parseA1, rangeName, sheetRef, type A1Range } from './a1'
import type { AgentFormat } from './compose'
import type { RulesHeld } from './host/wire'
import type { PackageRules } from './jobs'
import { EXCEL_NAMES, RESERVED_NAME } from './patch/names'

/**
 * What a thread asks of a sheet's look and its rules (sheet_format, sheet_rule), in plain shapes a
 * model can fill: a format over a range; one rule (a highlight, a colour scale, a data bar, a
 * list, a check, a name, the filter). Here each becomes Univer's own model, the one the side
 * sheet makes and every store keeps, and the words he reads beside a suggestion ("Bold, yellow
 * fill on B2:B9"). No Univer code is loaded: the models are plain data.
 */

/** The most cells one format is laid on. */
export const FORMAT_MAX_CELLS = 20_000

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const range = z.string().min(2).max(300)
const amount = z.union([z.number(), z.string().max(2000)])

export const FormatSchema = z
  .object({
    bold: z.boolean(),
    italic: z.boolean(),
    underline: z.boolean(),
    strike: z.boolean(),
    colour: hex.nullable().describe('Text colour, #RRGGBB; null is automatic.'),
    fill: hex.nullable().describe('Cell fill, #RRGGBB; null is none.'),
    family: z.string().min(1).max(100),
    size: z.number().min(1).max(409).describe('Points.'),
    align: z.enum(['left', 'center', 'right']).nullable(),
    vertical: z.enum(['top', 'middle', 'bottom']).nullable(),
    wrap: z.boolean(),
    borders: z.enum(['all', 'outside', 'bottom', 'top', 'topDoubleBottom', 'none']),
    pattern: z.string().max(255).describe('An Excel number format: 0.00%, #,##0.00, m/d/yyyy; "" is General.'),
    style: z.enum(['normal', 'heading1', 'heading2', 'total', 'input', 'note', 'good', 'bad', 'neutral', 'currency', 'percent', 'comma']).describe('A named cell style.'),
    clear: z.literal(true).describe('Back to no formatting.'),
    // (Excel's own limits: a column of 255 characters, a row of 409 points)
    width: z.number().int().min(8).max(1790).describe("The range's columns, px each."),
    height: z.number().int().min(4).max(545).describe("The range's rows, px each.")
  })
  .partial()
  .strict()
export type FormatAsk = z.infer<typeof FormatSchema>

const look = z.object({ bold: z.boolean(), italic: z.boolean(), colour: hex, fill: hex }).partial().strict()
const WHEN = ['greater', 'less', 'atLeast', 'atMost', 'equal', 'notEqual', 'between', 'notBetween'] as const
const message = z.string().max(255).optional().describe('What he reads when a value is refused.')

export const RuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('highlight'),
    range,
    when: z.enum([...WHEN, 'contains', 'notContains', 'begins', 'ends', 'duplicate', 'unique', 'blank', 'notBlank', 'error', 'top', 'bottom', 'aboveAverage', 'belowAverage', 'formula']),
    value: amount.optional().describe('The number, text or formula compared with; for top and bottom, how many.'),
    value2: z.number().optional().describe('The upper end of between.'),
    look
  }),
  z.object({ kind: z.literal('scale'), range, colours: z.array(hex).min(2).max(3).describe('Lowest to highest.') }),
  z.object({ kind: z.literal('bar'), range, colour: hex }),
  z.object({ kind: z.literal('list'), range, items: z.array(z.string().min(1).max(200)).min(1).max(100).optional(), from: range.optional().describe('A range holding the allowed values, in place of items.'), message }),
  z.object({ kind: z.literal('check'), range, of: z.enum(['whole', 'decimal', 'date', 'length']), when: z.enum(WHEN), value: amount, value2: amount.optional(), message }),
  z.object({ kind: z.literal('custom'), range, formula: z.string().min(2).max(2000), message }),
  z.object({ kind: z.literal('name'), name: z.string().min(1).max(255), refersTo: z.string().min(1).max(2000).describe("A range ('Q1'!B2:B9) or a formula."), scope: z.string().max(200).optional().describe("A tab's name, for a name that tab alone knows.") }),
  z.object({ kind: z.literal('filter'), range: range.nullable().describe('The table with its header row; null takes the filter off.'), sheet: z.string().max(200).optional().describe("With null: the tab whose filter goes; the first when left out.") })
])
export type RuleAsk = z.infer<typeof RuleSchema>

type Box = { startRow: number; endRow: number; startColumn: number; endColumn: number }
export interface Placed {
  /** the sheet's id */
  sheet: string
  /** the tab's name */
  name: string
  range: Box
}

/** Where an A1 range lies: the tab it names, else the first. */
export function place(text: string, sheets: readonly { id: string; name: string }[]): Placed {
  const r = parseA1(text)
  if (!r) throw new Error(`${text} is not a range: write it like B2:B9 or 'Q1 Budget'!B2:B9.`)
  const sheet = r.sheet === undefined ? sheets[0] : sheets.find((s) => s.name === r.sheet)
  if (!sheet) throw new Error(r.sheet === undefined ? 'The workbook has no sheets.' : `There is no sheet named ${r.sheet}. Sheets: ${sheets.map((s) => s.name).join(', ')}.`)
  const { sheet: _tab, ...box } = r as A1Range
  return { sheet: sheet.id, name: sheet.name, range: box }
}

/** A range as he reads it: with its tab, where the workbook has more than one. */
export const where = (at: Placed, sheets: readonly { id: string; name: string }[]): string => rangeName(at.range, sheets.length > 1 ? at.name : undefined)

/** A colour by its nearest plain name: what "yellow fill" says of #FFF2CC. */
export function colourWord(colour: string): string {
  const n = Number.parseInt(colour.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const light = (max + min) / 2
  const spread = max - min
  if (spread < 0.08) return light > 0.92 ? 'white' : light < 0.15 ? 'black' : 'grey'
  const hue = (60 * (max === r ? ((g - b) / spread) % 6 : max === g ? (b - r) / spread + 2 : (r - g) / spread + 4) + 360) % 360
  if (hue < 15 || hue >= 345) return light > 0.8 ? 'pink' : 'red'
  if (hue < 40) return light < 0.35 ? 'brown' : 'orange'
  if (hue < 70) return 'yellow'
  if (hue < 165) return 'green'
  if (hue < 200) return 'teal'
  if (hue < 260) return 'blue'
  if (hue < 300) return 'purple'
  return 'pink'
}

const PATTERNS: Record<string, string> = { '': 'General', '0.00%': 'percent', '0%': 'percent', '#,##0.00': 'number', '"$"#,##0.00': 'currency', 'm/d/yyyy': 'date', 'h:mm AM/PM': 'time', '@': 'plain text' }
const STYLES: Record<string, string> = { normal: 'Normal', heading1: 'Heading 1', heading2: 'Heading 2', total: 'Total', input: 'Input', note: 'Note', good: 'Good', bad: 'Bad', neutral: 'Neutral', currency: 'Currency', percent: 'Percent', comma: 'Comma' }
const BORDERS: Record<string, string> = { all: 'all borders', outside: 'an outside border', bottom: 'a bottom border', top: 'a top border', topDoubleBottom: 'a top and double bottom border', none: 'no borders' }
const upper = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** A format in the words he reads: "Bold, yellow fill on B2:B9". */
export function formatWords(f: FormatAsk, on: string): string {
  const parts: string[] = []
  if (f.clear) parts.push('formatting cleared')
  if (f.style) parts.push(`${STYLES[f.style]} style`)
  if (f.bold !== undefined) parts.push(f.bold ? 'bold' : 'not bold')
  if (f.italic !== undefined) parts.push(f.italic ? 'italic' : 'not italic')
  if (f.underline !== undefined) parts.push(f.underline ? 'underlined' : 'not underlined')
  if (f.strike !== undefined) parts.push(f.strike ? 'struck through' : 'not struck through')
  if (f.family) parts.push(f.family)
  if (f.size) parts.push(`${f.size} pt`)
  if (f.colour !== undefined) parts.push(f.colour === null ? 'automatic text colour' : `${colourWord(f.colour)} text`)
  if (f.fill !== undefined) parts.push(f.fill === null ? 'no fill' : `${colourWord(f.fill)} fill`)
  if (f.align !== undefined) parts.push(f.align === null ? 'default alignment' : f.align === 'center' ? 'centred' : `${f.align} aligned`)
  if (f.vertical !== undefined) parts.push(f.vertical === null ? 'default vertical alignment' : `${f.vertical} aligned`)
  if (f.wrap !== undefined) parts.push(f.wrap ? 'wrapped' : 'not wrapped')
  if (f.borders) parts.push(BORDERS[f.borders]!)
  if (f.pattern !== undefined) parts.push(PATTERNS[f.pattern] ? `${PATTERNS[f.pattern]} format` : `format ${f.pattern}`)
  if (f.width) parts.push(`${f.width} px wide`)
  if (f.height) parts.push(`${f.height} px tall`)
  if (!parts.length) throw new Error('Say what to format: bold, a fill, a number format, a border…')
  return `${upper(parts.join(', '))} on ${on}`
}

/** The part of a format ask the row's own code lays (the sizes go beside it). */
export function agentFormat(f: FormatAsk): AgentFormat {
  const { width: _w, height: _h, colour, fill, ...rest } = f
  return { ...rest, ...(colour !== undefined ? { colour: colour === null ? null : { hex: colour } } : {}), ...(fill !== undefined ? { fill: fill === null ? null : { hex: fill } } : {}) } as AgentFormat
}

const LOOK_WORDS = (l: { bold?: boolean; italic?: boolean; colour?: string; fill?: string }): string => {
  const parts = [l.bold ? 'bold' : '', l.italic ? 'italic' : '', l.colour ? `${colourWord(l.colour)} text` : '', l.fill ? `${colourWord(l.fill)} fill` : ''].filter(Boolean)
  return parts.length ? parts.join(', ') : 'highlight'
}
const WHEN_WORDS: Record<(typeof WHEN)[number], string> = { greater: 'is greater than', less: 'is less than', atLeast: 'is at least', atMost: 'is at most', equal: 'is', notEqual: 'is not', between: 'is between', notBetween: 'is not between' }
const OPERATOR: Record<(typeof WHEN)[number], string> = { greater: 'greaterThan', less: 'lessThan', atLeast: 'greaterThanOrEqual', atMost: 'lessThanOrEqual', equal: 'equal', notEqual: 'notEqual', between: 'between', notBetween: 'notBetween' }
const isWhen = (w: string): w is (typeof WHEN)[number] => (WHEN as readonly string[]).includes(w)

/** A rule in the words he reads: "Red text where B2:B9 is greater than 100". */
export function ruleWords(rule: RuleAsk, on: string): string {
  switch (rule.kind) {
    case 'highlight': {
      const how = upper(LOOK_WORDS(rule.look))
      const w = rule.when
      if (isWhen(w)) return `${how} where ${on} ${WHEN_WORDS[w]} ${rule.value}${w === 'between' || w === 'notBetween' ? ` and ${rule.value2}` : ''}`
      const tail: Record<string, string> = {
        contains: `contains "${rule.value}"`,
        notContains: `does not contain "${rule.value}"`,
        begins: `begins with "${rule.value}"`,
        ends: `ends with "${rule.value}"`,
        duplicate: 'repeats',
        unique: 'is the only one',
        blank: 'is blank',
        notBlank: 'is not blank',
        error: 'is an error',
        top: `is in the top ${rule.value ?? 10}`,
        bottom: `is in the bottom ${rule.value ?? 10}`,
        aboveAverage: 'is above average',
        belowAverage: 'is below average',
        formula: `makes ${rule.value} true`
      }
      return `${how} where ${on} ${tail[w]}`
    }
    case 'scale':
      return `A colour scale, ${rule.colours.map(colourWord).join(' to ')}, on ${on}`
    case 'bar':
      return `${upper(colourWord(rule.colour))} data bars on ${on}`
    case 'list':
      return rule.from ? `A list from ${rule.from} on ${on}` : `A list (${rule.items!.slice(0, 4).join(', ')}${rule.items!.length > 4 ? ', …' : ''}) on ${on}`
    case 'check': {
      const what = { whole: 'a whole number', decimal: 'a number', date: 'a date', length: 'text whose length' }[rule.of]
      return `${on} takes only ${what} that ${WHEN_WORDS[rule.when]} ${rule.value}${rule.when === 'between' || rule.when === 'notBetween' ? ` and ${rule.value2}` : ''}`
    }
    case 'custom':
      return `${on} takes only what makes ${rule.formula} true`
    case 'name':
      return `The name ${rule.name} for ${rule.refersTo}${rule.scope ? ` on ${rule.scope}` : ''}`
    case 'filter':
      return rule.range === null ? `The filter taken off${on ? ` ${on}` : ''}` : `A filter on ${on}`
  }
}

const formulaOf = (text: string): string => (text.startsWith('=') ? text : `=${text}`)
const styleOf = (l: { bold?: boolean; italic?: boolean; colour?: string; fill?: string }): Record<string, unknown> => ({
  ...(l.bold ? { bl: 1 } : {}),
  ...(l.italic ? { it: 1 } : {}),
  ...(l.colour ? { cl: { rgb: l.colour.toUpperCase() } } : {}),
  ...(l.fill ? { bg: { rgb: l.fill.toUpperCase() } } : {})
})
const number = (v: unknown, what: string): number => {
  const n = typeof v === 'number' ? v : Number(v)
  if (v === undefined || v === '' || !Number.isFinite(n)) throw new Error(`${what} needs a number.`)
  return n
}

/** Excel's grammar for a name: a letter, an underscore or a backslash first; letters, digits, dots and underscores; no cell's address. */
export function nameProblem(name: string): string | null {
  if (name.length > 255) return 'A name is at most 255 characters.'
  if (!/^[\p{L}_\\][\p{L}\p{M}\p{N}_.]*$/u.test(name)) return 'A name starts with a letter or an underscore and holds letters, digits, dots and underscores, with no spaces.'
  if (/^[A-Za-z]{1,3}\d{1,7}$/.test(name) || /^[Rr]\d*[Cc]\d*$/.test(name) || /^[RrCc]$/.test(name)) return `${name} reads as a cell: pick another name.`
  // (the writer's own list: what passes here is a name the file takes)
  if (RESERVED_NAME.test(name) || EXCEL_NAMES.has(name.toLowerCase())) return `${name} is a name Excel keeps for itself: pick another name.`
  return null
}

/** One rule to add, as Univer's model, with the sheet it is laid on (none for a workbook's name). */
export type RuleModel =
  | { list: 'conditional'; sheet: string; rule: Record<string, unknown> & { cfId: string } }
  | { list: 'validation'; sheet: string; rule: Record<string, unknown> & { uid: string } }
  | { list: 'names'; rule: { id: string; name: string; formulaOrRefString: string; localSheetId?: string } }
  | { list: 'filter'; sheet: string; filter: { ref: Box } | null }

const id = (): string => randomUUID().replace(/-/g, '').slice(0, 12)

/** A rule ask as Univer's model. `at` is where its range lies (absent for a name, and for the filter taken off, which names the first sheet). */
export function ruleModel(rule: RuleAsk, at: Placed | null, sheets: readonly { id: string; name: string }[]): RuleModel {
  const ranges = at ? [{ ...at.range }] : []
  const cf = (body: Record<string, unknown>): RuleModel => ({ list: 'conditional', sheet: at!.sheet, rule: { cfId: id(), ranges, stopIfTrue: false, rule: body } })
  const dv = (body: Record<string, unknown>, said?: string): RuleModel => ({
    list: 'validation',
    sheet: at!.sheet,
    // Excel's own dialog turns the error on: a value outside the rule is refused, in his words when he gave some.
    rule: { uid: id(), ranges, allowBlank: true, showErrorMessage: true, errorStyle: 1, ...(said ? { error: said } : {}), ...body }
  })
  switch (rule.kind) {
    case 'highlight': {
      const style = styleOf(rule.look)
      if (!Object.keys(style).length) throw new Error('A highlight needs a look: bold, italic, a text colour or a fill.')
      const hl = (body: Record<string, unknown>): RuleModel => cf({ type: 'highlightCell', style, ...body })
      const w = rule.when
      if (isWhen(w)) {
        // A comparison with text is a text rule: Excel's "is" and "is not".
        if ((w === 'equal' || w === 'notEqual') && typeof rule.value === 'string' && !Number.isFinite(Number(rule.value))) return hl({ subType: 'text', operator: w, value: rule.value })
        if (w === 'between' || w === 'notBetween') return hl({ subType: 'number', operator: w, value: [number(rule.value, 'Between'), number(rule.value2, 'Between')].sort((a, b) => a - b) })
        return hl({ subType: 'number', operator: OPERATOR[w], value: number(rule.value, 'That comparison') })
      }
      const text = (operator: string): RuleModel => {
        if (typeof rule.value !== 'string' && typeof rule.value !== 'number') throw new Error('That rule needs the text to look for.')
        return hl({ subType: 'text', operator, value: String(rule.value) })
      }
      switch (w) {
        case 'contains':
          return text('containsText')
        case 'notContains':
          return text('notContainsText')
        case 'begins':
          return text('beginsWith')
        case 'ends':
          return text('endsWith')
        case 'blank':
          return hl({ subType: 'text', operator: 'containsBlanks' })
        case 'notBlank':
          return hl({ subType: 'text', operator: 'notContainsBlanks' })
        case 'error':
          return hl({ subType: 'text', operator: 'containsErrors' })
        case 'duplicate':
          return hl({ subType: 'duplicateValues' })
        case 'unique':
          return hl({ subType: 'uniqueValues' })
        case 'top':
        case 'bottom': {
          const count = rule.value === undefined ? 10 : number(rule.value, 'Top and bottom')
          if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('Top and bottom take a whole number from 1 to 1,000.')
          return hl({ subType: 'rank', isBottom: w === 'bottom', isPercent: false, value: count })
        }
        case 'aboveAverage':
          return hl({ subType: 'average', operator: 'greaterThan' })
        case 'belowAverage':
          return hl({ subType: 'average', operator: 'lessThan' })
        default:
          if (typeof rule.value !== 'string' || rule.value.length < 2) throw new Error('A formula rule needs its formula as `value`.')
          return hl({ subType: 'formula', value: formulaOf(rule.value) })
      }
    }
    case 'scale': {
      const [low, mid, high] = rule.colours.length === 3 ? rule.colours : [rule.colours[0], undefined, rule.colours[1]]
      const stops = [{ color: low, value: { type: 'min' } }, ...(mid ? [{ color: mid, value: { type: 'percentile', value: 50 } }] : []), { color: high, value: { type: 'max' } }]
      return cf({ type: 'colorScale', config: stops.map((stop, index) => ({ index, color: stop.color!.toUpperCase(), value: stop.value })) })
    }
    case 'bar':
      // Solid, as the side sheet makes one (a bar that fades to white hides light text on a dark grid), and one colour for both ways.
      return cf({ type: 'dataBar', isShowValue: true, config: { min: { type: 'min' }, max: { type: 'max' }, isGradient: false, positiveColor: rule.colour.toUpperCase(), nativeColor: rule.colour.toUpperCase() } })
    case 'list': {
      if (!rule.items === !rule.from) throw new Error('A list takes `items` or `from`, one of them.')
      if (rule.from) {
        const src = place(rule.from, sheets)
        const ref = `${sheetRef(src.name)}!${abs(src.range)}`
        return dv({ type: 'list', formula1: `=${ref}` }, rule.message)
      }
      const items = rule.items!.map((item) => item.trim())
      if (items.some((item) => item.includes(','))) throw new Error('A list item cannot hold a comma: put the values in cells and pass `from`.')
      if (items.join(',').length > 255) throw new Error('A typed list is at most 255 characters in all: put the values in cells and pass `from`.')
      return dv({ type: 'list', formula1: items.join(',') }, rule.message)
    }
    case 'check': {
      const type = { whole: 'whole', decimal: 'decimal', date: 'date', length: 'textLength' }[rule.of]
      const two = rule.when === 'between' || rule.when === 'notBetween'
      if (two && rule.value2 === undefined) throw new Error('Between needs `value2`.')
      const one = (v: unknown): string => {
        if (rule.of === 'date') {
          if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new Error('A date is written 2026-01-31.')
          return v
        }
        const n = number(v, 'That check')
        if (rule.of !== 'decimal' && !Number.isInteger(n)) throw new Error('That check takes a whole number.')
        return String(n)
      }
      return dv({ type, operator: OPERATOR[rule.when], formula1: one(rule.value), ...(two ? { formula2: one(rule.value2) } : {}) }, rule.message)
    }
    case 'custom':
      return dv({ type: 'custom', formula1: formulaOf(rule.formula) }, rule.message)
    case 'name': {
      const problem = nameProblem(rule.name)
      if (problem) throw new Error(problem)
      const scope = rule.scope === undefined ? undefined : sheets.find((s) => s.name === rule.scope)
      if (rule.scope !== undefined && !scope) throw new Error(`There is no sheet named ${rule.scope}.`)
      // A plain range is written with its tab, as Excel keeps a name; anything else is a formula.
      const ref = parseA1(rule.refersTo)
      const target = ref ? place(rule.refersTo, sheets) : null
      const refers = target ? `${sheetRef(target.name)}!${abs(target.range)}` : formulaOf(rule.refersTo)
      return { list: 'names', rule: { id: id(), name: rule.name, formulaOrRefString: refers, ...(scope ? { localSheetId: scope.id } : {}) } }
    }
    case 'filter': {
      if (at) return { list: 'filter', sheet: at.sheet, filter: { ref: { ...at.range } } }
      const tab = rule.sheet === undefined ? sheets[0] : sheets.find((x) => x.name === rule.sheet)
      if (!tab) throw new Error(rule.sheet === undefined ? 'The workbook has no sheets.' : `There is no sheet named ${rule.sheet}.`)
      return { list: 'filter', sheet: tab.id, filter: null }
    }
  }
}

const overlaps = (a: Box, b: Box): boolean => a.startRow <= b.endRow && b.startRow <= a.endRow && a.startColumn <= b.endColumn && b.startColumn <= a.endColumn

/**
 * Why a rule cannot be added to the sheet as it stands, or null: a name already there in its scope, a
 * filter where one is laid (or none where one is to go), a validation over cells that have one. An
 * agent adds; changing what is there is his, in the side sheet, so nothing of his is replaced unseen.
 */
export function ruleClash(model: RuleModel, held: RulesHeld, sheets: readonly { id: string; name: string }[]): string | null {
  const SIDE = "change it in the sheet's Rules"
  if (model.list === 'names') {
    const scope = model.rule.localSheetId
    const taken = held.names.some((n) => n.name.toLowerCase() === model.rule.name.toLowerCase() && (n.scope ?? undefined) === scope)
    return taken ? `The name ${model.rule.name} is already there: ${SIDE}.` : null
  }
  if (model.list === 'filter') {
    const has = held.filters[model.sheet]
    const tab = sheets.find((x) => x.id === model.sheet)?.name ?? 'That sheet'
    if (model.filter && has) return `${tab} already has a filter on ${rangeName(has)}: take it off first.`
    if (!model.filter && !has) return `${tab} has no filter.`
    return null
  }
  if (model.list === 'validation') {
    const mine = (model.rule.ranges ?? []) as Box[]
    const hit = (held.validations[model.sheet] ?? []).find((r) => mine.some((m) => overlaps(m, r)))
    return hit ? `${rangeName(hit)} already has a validation: ${SIDE}.` : null
  }
  return null
}

/** A package's rules as the checks read them (the same shape the service's host answers). */
export function heldOfPackage(rules: PackageRules): RulesHeld {
  const box = (r: Box): Box => ({ startRow: r.startRow, endRow: r.endRow, startColumn: r.startColumn, endColumn: r.endColumn })
  return {
    names: (rules.names as { name?: string; localSheetId?: string }[]).filter((n) => typeof n.name === 'string').map((n) => ({ name: n.name!, ...(n.localSheetId && n.localSheetId !== 'AllDefaultWorkbook' ? { scope: n.localSheetId } : {}) })),
    filters: Object.fromEntries(Object.entries(rules.filter).flatMap(([id, f]) => ((f as { ref?: Box } | null)?.ref ? [[id, box((f as { ref: Box }).ref)]] : []))),
    validations: Object.fromEntries(Object.entries(rules.validation).map(([id, list]) => [id, (list as { ranges?: Box[] }[]).flatMap((rule) => (rule.ranges ?? []).map(box))]))
  }
}

/** `$B$2:$B$9`: a name's range does not move with the cell that reads it. */
function abs(box: Box): string {
  const cell = (row: number, col: number): string => rangeName({ startRow: row, endRow: row, startColumn: col, endColumn: col }).replace(/^([A-Z]+)(\d+)$/, '$$$1$$$2')
  const head = cell(box.startRow, box.startColumn)
  return box.startRow === box.endRow && box.startColumn === box.endColumn ? head : `${head}:${cell(box.endRow, box.endColumn)}`
}

/** The mutations that add a rule to a sheet the service holds: the grid's own, which its engine replays. */
export function ruleMutations(unit: string, model: RuleModel): SheetMutationJson[] {
  switch (model.list) {
    case 'conditional':
      return [{ id: 'sheet.mutation.add-conditional-rule', params: { unitId: unit, subUnitId: model.sheet, rule: model.rule } }]
    case 'validation':
      return [{ id: 'data-validation.mutation.addRule', params: { unitId: unit, subUnitId: model.sheet, rule: model.rule } }]
    case 'names':
      return [{ id: 'formula.mutation.set-defined-name', params: { unitId: unit, ...model.rule } }]
    case 'filter':
      return model.filter ? [{ id: 'sheet.mutation.set-filter-range', params: { unitId: unit, subUnitId: model.sheet, range: model.filter.ref } }] : [{ id: 'sheet.mutation.remove-filter', params: { unitId: unit, subUnitId: model.sheet } }]
  }
}

/** The same rule for an opened Excel file: the whole list it leaves, the file's rules with this one added (`RULES_SET`). */
export function ruleListMutation(model: RuleModel, held: PackageRules): SheetMutationJson {
  const set = (params: RulesSetParams): SheetMutationJson => ({ id: RULES_SET, params })
  switch (model.list) {
    case 'conditional':
      // A new rule wins first, as one made in the side sheet does.
      return set({ kind: 'conditional', subUnitId: model.sheet, list: [model.rule, ...(held.conditional[model.sheet] ?? [])] })
    case 'validation':
      return set({ kind: 'validation', subUnitId: model.sheet, list: [...(held.validation[model.sheet] ?? []), model.rule] })
    case 'names': {
      const scope = model.rule.localSheetId
      const same = (n: { name?: string; localSheetId?: string }): boolean => n.name?.toLowerCase() === model.rule.name.toLowerCase() && (n.localSheetId || undefined) === scope
      // The same name in the same scope is replaced: a name is said once.
      return set({ kind: 'names', list: [...(held.names as { name?: string; localSheetId?: string }[]).filter((n) => !same(n)), model.rule] })
    }
    case 'filter':
      return set({ kind: 'filter', subUnitId: model.sheet, list: model.filter })
  }
}
