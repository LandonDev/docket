import type { IStyleData } from '@univerjs/core'
import type {
  IConditionFormattingRule,
  IValueConfig
} from '@univerjs/sheets-conditional-formatting'
import { children, elementText, openTag, setNumber, valueOf, type ElementSpan } from './format-xml'
import { refName } from './xml'
import { DataBarLinks } from './rules-bars'
import { rgb } from './rules-dxf'
import {
  RulesRefused,
  RulePart,
  OPERATORS,
  between,
  checkedFormula,
  descendants,
  extraAttrs,
  formulaTag,
  gridBox,
  type RuleRange,
  inner,
  local,
  on,
  rangeKey,
  recordSplices,
  sqref,
  tag,
  tagAttrs
} from './rules-xml'
import { applySplices } from './format-xml'

const TEXT = new Set([
  'containsText',
  'notContainsText',
  'beginsWith',
  'endsWith',
  'containsBlanks',
  'notContainsBlanks',
  'containsErrors',
  'notContainsErrors'
])
const TEXT_WITH_VALUE = new Set(['containsText', 'notContainsText', 'beginsWith', 'endsWith'])
const PERIODS = new Set([
  'today',
  'yesterday',
  'tomorrow',
  'last7Days',
  'thisMonth',
  'lastMonth',
  'nextMonth',
  'thisWeek',
  'lastWeek',
  'nextWeek'
])
export const ICON_SETS = new Set([
  '3Arrows',
  '3ArrowsGray',
  '3Flags',
  '3TrafficLights1',
  '3TrafficLights2',
  '3Signs',
  '3Symbols',
  '3Symbols2',
  '4Arrows',
  '4ArrowsGray',
  '4RedToBlack',
  '4Rating',
  '4TrafficLights',
  '5Arrows',
  '5ArrowsGray',
  '5Rating',
  '5Quarters'
])
const CF_CHILDREN = new Set(['formula', 'colorScale', 'dataBar', 'iconSet'])
const OWNED = new Set([
  'type',
  'dxfId',
  'priority',
  'stopIfTrue',
  'aboveAverage',
  'equalAverage',
  'percent',
  'bottom',
  'operator',
  'text',
  'timePeriod',
  'rank'
])

function textFormula(op: string, value: string, anchor: string) {
  const quote = (text: string) => '"' + text.replace(/"/g, '""') + '"'
  const literal = quote(value)
  const needle = quote(value.replace(/[~*?]/g, '~$&'))
  switch (op) {
    case 'containsText':
      return `NOT(ISERROR(SEARCH(${needle},${anchor})))`
    case 'notContainsText':
      return `ISERROR(SEARCH(${needle},${anchor}))`
    case 'beginsWith':
      return `LEFT(${anchor},LEN(${literal}))=${literal}`
    case 'endsWith':
      return `RIGHT(${anchor},LEN(${literal}))=${literal}`
    case 'containsBlanks':
      return `LEN(TRIM(${anchor}))=0`
    case 'notContainsBlanks':
      return `LEN(TRIM(${anchor}))>0`
    case 'containsErrors':
      return `ISERROR(${anchor})`
    default:
      return `NOT(ISERROR(${anchor}))`
  }
}

function periodFormula(period: string, anchor: string): string {
  const floor = `FLOOR(${anchor},1)`
  const rounded = `ROUNDDOWN(${anchor},0)`
  const weekday = 'WEEKDAY(TODAY())'
  switch (period) {
    case 'today':
      return `${floor}=TODAY()`
    case 'yesterday':
      return `${floor}=TODAY()-1`
    case 'tomorrow':
      return `${floor}=TODAY()+1`
    case 'last7Days':
      return `AND(TODAY()-${floor}<=6,${floor}<=TODAY())`
    case 'thisWeek':
      return `AND(TODAY()-${rounded}<=${weekday}-1,${rounded}-TODAY()<=7-${weekday})`
    case 'lastWeek':
      return `AND(TODAY()-${rounded}>=(${weekday}),TODAY()-${rounded}<(${weekday}+7))`
    case 'nextWeek':
      return `AND(${rounded}-TODAY()>(7-${weekday}),${rounded}-TODAY()<(15-${weekday}))`
    default: {
      const date =
        period === 'lastMonth'
          ? 'EDATE(TODAY(),0-1)'
          : period === 'nextMonth'
            ? 'EDATE(TODAY(),0+1)'
            : 'TODAY()'
      return `AND(MONTH(${anchor})=MONTH(${date}),YEAR(${anchor})=YEAR(${date}))`
    }
  }
}

function threshold(p: string, { type, value }: IValueConfig, gte?: boolean): string {
  if (type === 'min' || type === 'max')
    return tag(p + 'cfvo', { type, gte: gte === false ? 0 : undefined })
  let val: string | number
  if (type === 'formula' && typeof value === 'string') val = checkedFormula(value, true)
  else if (
    (type === 'num' || type === 'percent' || type === 'percentile') &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (type === 'num' || (value >= 0 && value <= 100))
  )
    val = value
  else throw new RulesRefused('This conditional format has an unsupported threshold.')
  return tag(p + 'cfvo', { type, val, gte: gte === false ? 0 : undefined })
}

interface Encoded {
  attrs: Record<string, string | number | undefined>
  body: string
}

function encodeRule(
  p: string,
  rule: IConditionFormattingRule['rule'],
  anchor: string,
  dxf: (style: IStyleData) => number | undefined
): Encoded {
  const formula = (value: string, convert = false) =>
    formulaTag(p + 'formula', checkedFormula(value, convert))
  const out: Encoded = { attrs: { type: rule.type }, body: '' }
  if (rule.type === 'highlightCell') {
    out.attrs.dxfId = dxf(rule.style)
    switch (rule.subType) {
      case 'number': {
        if (!OPERATORS.has(rule.operator))
          throw new RulesRefused('Unknown conditional comparison operator.')
        const values = Array.isArray(rule.value) ? rule.value : [rule.value]
        if (
          values.length !== (between(rule.operator) ? 2 : 1) ||
          values.some((v) => !Number.isFinite(v))
        )
          throw new RulesRefused(
            'The conditional comparison needs one finite number, or two for a between comparison.'
          )
        out.attrs.type = 'cellIs'
        out.attrs.operator = rule.operator
        out.body = values.map((v) => formula(String(v))).join('')
        break
      }
      case 'text': {
        if (rule.operator === 'equal' || rule.operator === 'notEqual') {
          out.attrs.type = 'cellIs'
          out.attrs.operator = rule.operator
          out.body = formula('"' + (rule.value ?? '').replace(/"/g, '""') + '"')
          break
        }
        if (!TEXT.has(rule.operator))
          throw new RulesRefused(
            `Excel cannot save the conditional text operator “${rule.operator}”.`
          )
        const text = rule.value ?? ''
        out.attrs.type = rule.operator
        if (TEXT_WITH_VALUE.has(rule.operator)) {
          out.attrs.operator = rule.operator === 'notContainsText' ? 'notContains' : rule.operator
          out.attrs.text = text
        } else if (text)
          throw new RulesRefused('A blank or error check cannot include search text.')
        out.body = formula(textFormula(rule.operator, text, anchor))
        break
      }
      case 'timePeriod':
        if (!PERIODS.has(rule.operator)) throw new RulesRefused('Unknown conditional date period.')
        out.attrs.type = 'timePeriod'
        out.attrs.timePeriod = rule.operator
        out.body = formula(periodFormula(rule.operator, anchor))
        break
      case 'rank':
        if (
          !Number.isInteger(rule.value) ||
          rule.value < 1 ||
          rule.value > (rule.isPercent ? 100 : 1000)
        )
          throw new RulesRefused(
            'Use a whole-number conditional rank from 1 to 100 percent or 1 to 1,000 cells.'
          )
        out.attrs.type = 'top10'
        out.attrs.rank = rule.value
        out.attrs.bottom = on(rule.isBottom)
        out.attrs.percent = on(rule.isPercent)
        break
      case 'average':
        if (
          !['greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual'].includes(
            rule.operator
          )
        )
          throw new RulesRefused('Choose above or below average for this Excel rule.')
        out.attrs.type = 'aboveAverage'
        out.attrs.aboveAverage = rule.operator.startsWith('less') ? 0 : undefined
        out.attrs.equalAverage = on(rule.operator.endsWith('OrEqual'))
        break
      case 'duplicateValues':
      case 'uniqueValues':
        out.attrs.type = rule.subType
        break
      case 'formula':
        out.attrs.type = 'expression'
        out.body = formula(rule.value, true)
        break
      default:
        throw new RulesRefused('This conditional rule kind cannot be saved in Excel.')
    }
  } else if (rule.type === 'colorScale') {
    const stops = [...rule.config].sort((a, b) => a.index - b.index)
    if (![2, 3].includes(stops.length) || stops.some((stop, i) => stop.index !== i))
      throw new RulesRefused('An Excel colour scale needs two or three indexed stops.')
    out.body = tag(
      p + 'colorScale',
      {},
      stops.map((stop) => threshold(p, stop.value)).join('') +
        stops.map((stop) => tag(p + 'color', { rgb: rgb(stop.color) })).join('')
    )
  } else if (rule.type === 'dataBar') {
    const { min, max, positiveColor } = rule.config
    out.body = tag(
      p + 'dataBar',
      { showValue: rule.isShowValue ? undefined : 0 },
      threshold(p, min) + threshold(p, max) + tag(p + 'color', { rgb: rgb(positiveColor) })
    )
  } else if (rule.type === 'iconSet') {
    const { config } = rule
    const iconSet = config[0]?.iconType
    if (
      !iconSet ||
      !ICON_SETS.has(iconSet) ||
      config.length !== Number(iconSet[0]) ||
      config.some(
        (item) =>
          item.iconType !== iconSet ||
          !['greaterThan', 'greaterThanOrEqual'].includes(item.operator)
      )
    )
      throw new RulesRefused('Choose a standard Excel icon set and one threshold per icon.')
    const reverse = config[0].iconId === String(config.length - 1)
    if (config.some((item, i) => item.iconId !== String(reverse ? config.length - 1 - i : i)))
      throw new RulesRefused(
        'Excel can save standard or reversed icons. This custom order needs an extension.'
      )
    out.body = tag(
      p + 'iconSet',
      {
        iconSet,
        showValue: rule.isShowValue ? undefined : 0,
        reverse: on(reverse),
        percent: config.every((item) => item.value.type === 'percent') ? undefined : 0
      },
      [...config]
        .reverse()
        .map((item) => threshold(p, item.value, item.operator !== 'greaterThan'))
        .join('')
    )
  } else throw new RulesRefused('This conditional rule kind cannot be saved in Excel.')
  return out
}

export type ConditionalRule = Omit<IConditionFormattingRule, 'ranges'> & {
  ranges: readonly RuleRange[]
}

interface Block {
  span: ElementSpan
  range: string
  originals: Original[]
  records: string[]
}
interface Original {
  block: Block
  span: ElementSpan
  type: string
  mapped?: IConditionFormattingRule
  payload: ElementSpan[]
  nestedExtension: boolean
  link?: string
}

function classicBlocks(
  part: RulePart,
  sheetId: string,
  models: readonly IConditionFormattingRule[]
): Block[] {
  const { xml, prefix: p } = part
  const byId = new Map(models.map((model) => [model.cfId, model]))
  let index = 0
  return part.siblings
    .filter((el) => el.name === p + 'conditionalFormatting')
    .map((span) => {
      const ref = valueOf(openTag(xml, span), 'sqref')
      const block: Block = { span, range: ref ? rangeKey(ref) : '', originals: [], records: [] }
      for (const el of children(xml, span)) {
        if (el.name !== p + 'cfRule') continue
        const id = `${sheetId}-cf${++index}`
        const opening = openTag(xml, el)
        const type = valueOf(opening, 'type') ?? ''
        const elements = [...children(xml, el)]
        const payload = elements.filter((child) => !CF_CHILDREN.has(local(child.name)))
        const core = elements.filter((child) => CF_CHILDREN.has(local(child.name)))
        const nestedExtension = core.some((child) => !descendants(xml, child, 'extLst').next().done)
        const link = payload
          .flatMap((child) => [...descendants(xml, child, 'id')])
          .map((id) => inner(xml, id).trim())[0]
        const model = byId.get(id)
        block.originals.push({
          block,
          span: el,
          type,
          mapped: model?.ranges.length ? model : undefined,
          payload,
          link,
          nestedExtension
        })
      }
      return block
    })
}

function extensions(part: RulePart) {
  const ext = part.first('extLst')
  if (!ext) return []
  return [...descendants(part.xml, ext, 'cfRule')].filter(
    (el) => el.name !== part.prefix + 'cfRule'
  )
}

function canonical(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item, key)])
    )
  if (
    typeof value === 'string' &&
    ['rgb', 'color', 'positiveColor', 'nativeColor'].includes(key) &&
    /^#?(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
  )
    return rgb(value)
  return value
}
const modelKey = (value: unknown) => JSON.stringify(canonical(value))
const signature = (range: string, model: ConditionalRule) =>
  range + '|' + modelKey({ stopIfTrue: !!model.stopIfTrue, rule: model.rule })

function withOriginalLength(part: RulePart, original: Original, encoded: Encoded) {
  if (original.type !== 'dataBar' || encoded.attrs.type !== 'dataBar') return
  const bar = [...children(part.xml, original.span)].find((el) => local(el.name) === 'dataBar')
  if (!bar) return
  const extra = extraAttrs(part.xml, bar, new Set(['showValue']))
  if (extra) encoded.body = encoded.body.replace('>', () => extra + '>')
}

export function conditional(
  part: RulePart,
  sheetId: string,
  rules: readonly ConditionalRule[],
  models: readonly IConditionFormattingRule[],
  dxf: (style: IStyleData) => number | undefined,
  addedRule: () => void
) {
  const { xml, prefix: p } = part
  const blocks = classicBlocks(part, sheetId, models)
  const all = blocks.flatMap((block) => block.originals)
  const mapped = all.filter(
    (entry): entry is Original & { mapped: IConditionFormattingRule } => !!entry.mapped
  )
  const byId = new Map(mapped.map((entry) => [entry.mapped.cfId, entry]))
  const byRange = new Map<string, Block>()
  for (const block of blocks) if (!byRange.has(block.range)) byRange.set(block.range, block)
  const keys = new Map<string, Original[]>()
  const keyOf = new Map<Original, string>()
  for (const entry of mapped) {
    const key = signature(entry.block.range, entry.mapped)
    const same = keys.get(key) ?? []
    same.push(entry)
    keys.set(key, same)
    keyOf.set(entry, key)
  }
  const used = new Set<Original>()
  type Item = {
    model: ConditionalRule
    range: string
    key: string
    original?: Original
    exact?: boolean
  }
  const submitted: Item[] = rules.map((model) => {
    const range = sqref(model.ranges)
    return { model, range, key: signature(range, model) }
  })
  // Reserve exact matches before assigning changed IDs. A newly inserted rule can shift the
  // importer's positional IDs, so a stale ID cannot take a rule still present by value.
  for (const item of submitted) {
    const original = byId.get(item.model.cfId)
    if (original && !used.has(original) && keyOf.get(original) === item.key) {
      item.original = original
      item.exact = true
      used.add(original)
    }
  }
  for (const item of submitted) {
    if (item.original) continue
    const matching = keys.get(item.key)
    let exact: Original | undefined
    while ((exact = matching?.pop()) && used.has(exact)) {
      /* skip reserved records */
    }
    if (exact) {
      item.original = exact
      item.exact = true
      used.add(exact)
    }
  }
  for (const item of submitted) {
    if (item.original) continue
    const original = byId.get(item.model.cfId)
    if (original && !used.has(original)) {
      item.original = original
      used.add(original)
    } else addedRule()
  }

  const mappedIds = new Set(byId.keys())
  const sourceOrder = models.filter(({ cfId }) => mappedIds.has(cfId))
  if (
    submitted.length === sourceOrder.length &&
    submitted.every(
      ({ exact, original }, index) => exact && original?.mapped === sourceOrder[index]
    )
  )
    return

  const ext = extensions(part)
  const linkedIds = new Set(all.map((entry) => entry.link?.toUpperCase()).filter(Boolean))
  const reserved = new Set([
    ...all
      .filter((entry) => !entry.mapped)
      .map((entry) => Number(valueOf(openTag(xml, entry.span), 'priority'))),
    ...ext
      .filter((el) => !linkedIds.has(valueOf(openTag(xml, el), 'id')?.toUpperCase()))
      .map((el) => Number(valueOf(openTag(xml, el), 'priority')))
  ])
  const links = new DataBarLinks(part, sheetId)
  const generated = new Map<string, string[]>()
  let priority = 0
  for (const { model, range, key, original, exact } of submitted) {
    const oldPriority =
      original && exact ? Number(valueOf(openTag(xml, original.span), 'priority')) : 0
    if (oldPriority > priority && !reserved.has(oldPriority)) priority = oldPriority
    else
      while (reserved.has(++priority)) {
        /* leave unmodelled rules' priorities in place */
      }
    let text: string
    if (original && exact) {
      if (original.link) links.retain(original.link, priority)
      text =
        setNumber(openTag(xml, original.span), 'priority', priority) +
        xml.slice(original.span.openEnd, original.span.end)
    } else {
      const first = gridBox(model.ranges[0])
      const prior = original?.mapped?.rule
      const encoded = encodeRule(p, model.rule, refName(first.r1, first.c1), (style) => {
        if (
          original &&
          prior?.type === 'highlightCell' &&
          modelKey(prior.style) === modelKey(style)
        ) {
          const previous = valueOf(openTag(xml, original.span), 'dxfId')
          if (previous !== undefined) return Number(previous)
        }
        return dxf(style)
      })
      encoded.attrs.stopIfTrue = on(model.stopIfTrue)
      if (original) {
        if (original.nestedExtension)
          throw new RulesRefused('This rule has nested Excel extension data. Change it in Excel.')
        withOriginalLength(part, original, encoded)
      }
      let payload = original?.payload.map((node) => elementText(xml, node)).join('') ?? ''
      if (
        model.rule.type === 'dataBar' &&
        (original?.link ||
          !model.rule.config.isGradient ||
          rgb(model.rule.config.positiveColor) !== rgb(model.rule.config.nativeColor))
      ) {
        const keepThresholds =
          prior?.type === 'dataBar' &&
          modelKey([prior.config.min, prior.config.max]) ===
            modelKey([model.rule.config.min, model.rule.config.max])
        const originalLink = original?.type === 'dataBar' ? original.link : undefined
        if (original?.link && !originalLink)
          throw new RulesRefused('This Excel extension rule cannot change kind here.')
        const id = links.set(
          originalLink,
          model.cfId + key,
          range,
          model.rule,
          priority,
          keepThresholds,
          prior?.type === 'dataBar' ? prior.config : undefined
        )
        if (!originalLink) payload += links.link(id)
      } else if (original?.link) {
        if (original.type !== 'dataBar')
          throw new RulesRefused('This Excel extension rule cannot change here.')
        links.remove(original.link)
        payload = original.payload
          .filter(
            (node) =>
              ![...descendants(xml, node, 'id')].some(
                (id) => inner(xml, id).trim() === original.link
              )
          )
          .map((node) => elementText(xml, node))
          .join('')
      }
      const own = { ...encoded.attrs, priority }
      const opening = `<${p}cfRule${tagAttrs(own)}${original ? extraAttrs(xml, original.span, OWNED) : ''}`
      const body = encoded.body + payload
      text = body ? opening + '>' + body + `</${p}cfRule>` : opening + '/>'
    }
    const block =
      (original?.block.range === range ? original.block : undefined) ?? byRange.get(range)
    if (block) block.records.push(text)
    else {
      const entries = generated.get(range) ?? []
      entries.push(text)
      generated.set(range, entries)
    }
  }
  for (const entry of mapped) {
    if (used.has(entry)) continue
    if (entry.type === 'dataBar' && entry.link) links.remove(entry.link)
    else if (entry.link || entry.payload.length || entry.nestedExtension)
      throw new RulesRefused(
        'This conditional rule has Excel extension data. Keep the rule and its extension together.'
      )
  }
  for (const block of blocks) {
    const slots = block.originals.filter((entry) => entry.mapped).map((entry) => entry.span)
    if (!slots.length && !block.records.length) continue
    const extras = [...children(xml, block.span)].filter((el) => el.name !== p + 'cfRule')
    if (!block.records.length && slots.length === block.originals.length) {
      if (extras.length)
        throw new RulesRefused(
          'This conditional formatting block has Excel extension data and cannot be removed.'
        )
      part.replace(block.span, '')
    } else {
      const changes = recordSplices(xml, slots, block.records, extras[0]?.start ?? block.span.close)
      if (changes.length)
        part.replace(block.span, applySplices(xml, changes, block.span.start, block.span.end))
    }
  }
  links.render()
  if (generated.size)
    part.add(
      'conditionalFormatting',
      [...generated]
        .map(([range, records]) =>
          tag(p + 'conditionalFormatting', { sqref: range }, records.join(''))
        )
        .join('')
    )
}
