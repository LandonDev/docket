import type { ISheetDataValidationRule } from '@univerjs/core'
import { DATE_1904_OFFSET, isoSerial } from 'work-kit/sheet/xlsx'
import {
  applySplices,
  children,
  documentRoot,
  elementText,
  openTag,
  type ElementSpan
} from './format-xml'
import { overlaps } from './format-ranges'
import {
  RulesRefused,
  RulePart,
  OPERATORS,
  between,
  checkedFormula,
  type RuleRange,
  descendants,
  extraAttrs,
  fileBoxes,
  formulaTag,
  inner,
  local,
  on,
  rangeKey,
  recordSplices,
  replaceValidations,
  sqref,
  tag,
  xmlKey,
  xattr,
  xunescape
} from './rules-xml'

const TYPES = new Set(['list', 'whole', 'decimal', 'date', 'time', 'textLength', 'custom'])
const ERRORS = ['information', 'stop', 'warning']
const DV_ATTRS = [
  'type',
  'operator',
  'allowBlank',
  'showDropDown',
  'showErrorMessage',
  'showInputMessage',
  'errorStyle',
  'error',
  'errorTitle',
  'prompt',
  'promptTitle',
  'sqref'
]

export type ValidationRule = Omit<ISheetDataValidationRule, 'ranges'> & {
  ranges: readonly RuleRange[]
}

function comparisonValue(value: string, type: string, date1904: boolean): string {
  if (
    (type !== 'date' && type !== 'time') ||
    /^\s*=/.test(value) ||
    (value.trim() && Number.isFinite(Number(value)))
  )
    return checkedFormula(value, true)
  if (type === 'date') {
    const serial = isoSerial(value.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T'))
    if (serial === undefined)
      throw new RulesRefused('Use a valid date or a formula starting with =.')
    return String(serial - (date1904 ? DATE_1904_OFFSET : 0))
  }
  const match = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d(?:\.\d+)?))?(?:\s*(AM|PM))?$/i.exec(value.trim())
  if (!match) throw new RulesRefused('Use a valid time or a formula starting with =.')
  const [, hours, minutes, seconds = '0', meridian] = match
  let hour = Number(hours)
  if (meridian) {
    if (hour < 1 || hour > 12) throw new RulesRefused('Use a valid 12-hour time.')
    hour = (hour % 12) + (meridian.toUpperCase() === 'PM' ? 12 : 0)
  }
  if (hour > 23) throw new RulesRefused('Use a valid 24-hour time.')
  return String((hour * 3600 + Number(minutes) * 60 + Number(seconds)) / 86400)
}

const TEXT_LIMITS = { promptTitle: 32, errorTitle: 32, prompt: 255, error: 225 } as const

function validationXml(
  p: string,
  model: ValidationRule,
  range: string,
  date1904: boolean,
  newRule = false
): string {
  for (const field of Object.keys(TEXT_LIMITS) as (keyof typeof TEXT_LIMITS)[]) {
    if ((model[field]?.length ?? 0) > TEXT_LIMITS[field]) {
      const label = {
        promptTitle: 'prompt title',
        errorTitle: 'error title',
        prompt: 'prompt',
        error: 'error message'
      }[field]
      throw new RulesRefused(
        `A validation ${label} may contain at most ${TEXT_LIMITS[field]} characters.`
      )
    }
  }
  const { type } = model
  if (!TYPES.has(type))
    throw new RulesRefused(`Excel cannot save the validation kind “${type}” here.`)
  const first = model.formula1
  if (typeof first !== 'string')
    throw new RulesRefused('The validation needs a list, formula or value.')
  let f1: string
  if (type === 'list' && !first.startsWith('=')) {
    const quoted = first.replace(/"/g, '""')
    if (quoted.length > 255)
      throw new RulesRefused(
        'An inline validation list may contain at most 255 characters. Use a range or name for a longer list.'
      )
    if (/\r|\n/.test(quoted))
      throw new RulesRefused('A validation list with line breaks needs a range or name.')
    f1 = '"' + quoted + '"'
  } else f1 = comparisonValue(first, type, date1904)
  const isComparison = type !== 'list' && type !== 'custom'
  const operator = model.operator ?? 'between'
  if (isComparison && !OPERATORS.has(operator))
    throw new RulesRefused(`Unknown validation comparison operator “${operator}”.`)
  const needTwo = isComparison && between(operator)
  if (needTwo && model.formula2 === undefined)
    throw new RulesRefused('A between validation needs two formulas or values.')
  if (!needTwo && model.formula2 !== undefined)
    throw new RulesRefused('Only a between validation can have a second formula or value.')
  const f2 =
    model.formula2 === undefined ? undefined : comparisonValue(model.formula2, type, date1904)
  const errorStyle = ERRORS[model.errorStyle ?? 1]
  if (!errorStyle)
    throw new RulesRefused('Use stop, warning or information for the validation error style.')
  return tag(
    p + 'dataValidation',
    {
      type,
      operator: isComparison && operator !== 'between' ? operator : undefined,
      allowBlank: on(model.allowBlank),
      showDropDown: type === 'list' && model.showDropDown === false ? 1 : undefined,
      showErrorMessage:
        model.showErrorMessage === undefined ? on(newRule) : Number(model.showErrorMessage),
      showInputMessage: on(model.showInputMessage),
      errorStyle: errorStyle === 'stop' ? undefined : errorStyle,
      error: model.error || undefined,
      errorTitle: model.errorTitle || undefined,
      prompt: model.prompt || undefined,
      promptTitle: model.promptTitle || undefined,
      sqref: range
    },
    formulaTag(p + 'formula1', f1) + (f2 === undefined ? '' : formulaTag(p + 'formula2', f2))
  )
}

function dvKey(xml: string): string {
  return xmlKey(xml, (name, attrs) => {
    if (name !== 'dataValidation') return
    for (const key of attrs.keys()) if (!DV_ATTRS.includes(key)) attrs.delete(key)
    if (attrs.get('operator') === 'between') attrs.delete('operator')
    if (attrs.get('errorStyle') === 'stop') attrs.delete('errorStyle')
    for (const key of ['allowBlank', 'showDropDown', 'showErrorMessage', 'showInputMessage']) {
      if (attrs.get(key) === 'true') attrs.set(key, '1')
      if (attrs.get(key) === '0' || attrs.get(key) === 'false') attrs.delete(key)
    }
    const ref = attrs.get('sqref')
    if (ref) attrs.set('sqref', rangeKey(ref))
  })
}

function sourceValidation(xml: string, el: ElementSpan) {
  const opening = openTag(xml, el)
  const attrs = Object.fromEntries(DV_ATTRS.map((key) => [key, xattr(opening, key)]))
  let body = ''
  for (const span of children(xml, el)) {
    const name = local(span.name)
    if (name === 'formula1' || name === 'formula2') {
      const formula = [...descendants(xml, span, 'f')][0] ?? span
      body += formulaTag(name, xunescape(inner(xml, formula)))
    }
    if (name === 'sqref' && !attrs.sqref) attrs.sqref = inner(xml, span).trim()
  }
  if (attrs.type && TYPES.has(attrs.type) && attrs.sqref)
    return {
      range: rangeKey(attrs.sqref),
      type: attrs.type,
      key: dvKey(tag('dataValidation', attrs, body))
    }
  return undefined
}

function replaceValidation(xml: string, el: ElementSpan, encoded: string): string {
  const node = documentRoot(encoded)!
  const original = [...children(xml, el)]
  const owned = (child: ElementSpan) => ['formula1', 'formula2'].includes(local(child.name))
  const slots = original.filter(owned)
  const formulas = [...children(encoded, node)].map((child) => elementText(encoded, child))
  const at = slots.at(-1)?.end ?? el.openEnd
  const opening = openTag(encoded, node).slice(0, -1) + extraAttrs(xml, el, new Set(DV_ATTRS)) + '>'
  if (el.openEnd === el.end) return opening + formulas.join('') + `</${el.name}>`
  const changes = recordSplices(xml, slots, formulas, at)
  return opening + applySplices(xml, changes, el.openEnd, el.close) + xml.slice(el.close, el.end)
}

export function validation(
  part: RulePart,
  sheetId: string,
  rules: readonly ValidationRule[],
  date1904: boolean,
  addedRule: () => void
) {
  const { xml, prefix: p } = part
  const root = part.first('dataValidations')
  const ext = part.first('extLst')
  const extensionRules = ext
    ? [...descendants(xml, ext, 'dataValidation')]
        .map((el) => sourceValidation(xml, el))
        .filter((el) => el !== undefined)
    : []
  const extensionBoxes = extensionRules.flatMap((rule) => fileBoxes(rule.range))
  const extensionKeys = new Map<string, number>()
  for (const rule of extensionRules)
    extensionKeys.set(rule.key, (extensionKeys.get(rule.key) ?? 0) + 1)

  const slots: ElementSpan[] = []
  const original = new Map<string, ElementSpan[]>()
  const byId = new Map<string, { el: ElementSpan; range: string; type: string; key: string }>()
  let index = 0
  if (root)
    for (const el of children(xml, root)) {
      if (el.name !== p + 'dataValidation') continue
      const id = `${sheetId}-dv${++index}`
      const source = sourceValidation(xml, el)
      // Preserve unrestricted and unmodelled validators such as prompt-only cells.
      if (!source) continue
      slots.push(el)
      byId.set(id, { el, ...source })
      const same = original.get(source.key) ?? []
      same.push(el)
      original.set(source.key, same)
    }
  const submitted = rules.map((model) => {
    const range = sqref(model.ranges)
    const encoded = validationXml(p, model, range, date1904)
    const withDefault =
      model.showErrorMessage === undefined
        ? validationXml(p, model, range, date1904, true)
        : encoded
    return {
      model,
      range,
      encoded,
      key: dvKey(encoded),
      withDefault,
      defaultKey: dvKey(withDefault)
    }
  })
  const used = new Set<ElementSpan>()
  const keepExact = new Set(submitted.flatMap(({ key, defaultKey }) => [key, defaultKey]))
  const records: string[] = []
  for (const { model, range, encoded, key, withDefault, defaultKey } of submitted) {
    const exact = original.get(key)?.shift() ?? original.get(defaultKey)?.shift()
    if (exact) {
      used.add(exact)
      records.push(elementText(xml, exact))
    } else if (extensionKeys.get(key)) extensionKeys.set(key, extensionKeys.get(key)! - 1)
    else {
      if (fileBoxes(range).some((box) => extensionBoxes.some((other) => overlaps(box, other))))
        throw new RulesRefused(
          'This edit overlaps an Excel extension validation. Edit that validation in Excel.'
        )
      const existing = byId.get(model.uid)
      if (existing && !used.has(existing.el) && !keepExact.has(existing.key)) {
        used.add(existing.el)
        records.push(replaceValidation(xml, existing.el, encoded))
      } else {
        addedRule()
        records.push(withDefault)
      }
    }
  }
  for (const slot of slots) {
    if (
      !used.has(slot) &&
      [...children(xml, slot)].some(
        (child) => !['formula1', 'formula2'].includes(local(child.name))
      )
    )
      throw new RulesRefused(
        'This validation has Excel extension data that cannot be removed here.'
      )
  }
  if (!root && records.length)
    part.add(
      'dataValidations',
      tag(p + 'dataValidations', { count: records.length }, records.join(''))
    )
  else if (root && (records.length || slots.length)) replaceValidations(part, root, slots, records)
}
