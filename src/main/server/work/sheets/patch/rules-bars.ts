import { createHash } from 'node:crypto'
import type {
  IConditionFormattingRule,
  IValueConfig
} from '@univerjs/sheets-conditional-formatting'
import {
  applySplices,
  children,
  elementText,
  openTag,
  setNumber,
  valueOf,
  withBody,
  type ElementSpan,
  type Splice
} from './format-xml'
import { rgb } from './rules-dxf'
import { checkedFormula, formulaTag, local, RulePart, RulesRefused, tag } from './rules-xml'
import { removeAttrInTag, setAttrInTag } from './xml'

type DataBar = Extract<IConditionFormattingRule['rule'], { config: { nativeColor: string } }>
const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
const XM = 'http://schemas.microsoft.com/office/excel/2006/main'
const EXT = '{78C0D931-6437-407d-A8EE-F0AAD7539E65}'
const LINK = '{B025F937-C7B1-47D3-B67F-A62EFF666E3E}'
const ORDER = [
  'cfvo',
  'fillColor',
  'borderColor',
  'negativeFillColor',
  'negativeBorderColor',
  'axisColor',
  'extLst'
]

interface Group {
  span: ElementSpan
  rules: ElementSpan[]
  sqref?: ElementSpan
}

interface Container {
  extension: ElementSpan
  span: ElementSpan
  groups: Group[]
}

interface Change {
  range: string
  text: string
}

function threshold(p: string, value: IValueConfig) {
  // The lowest and the highest value, as the grid draws the bar. Excel's own "Automatic" (autoMin, autoMax) starts
  // a bar of positive numbers at zero, which is not what the model says (the second Excel proof read it as such).
  if (value.type === 'min' || value.type === 'max') return tag(p + 'cfvo', { type: value.type })
  const val =
    value.type === 'formula' ? checkedFormula(String(value.value), true) : String(value.value)
  return tag(p + 'cfvo', { type: value.type }, formulaTag('xm:f', val))
}

export class DataBarLinks {
  private root?: ElementSpan
  private containers: Container[] = []
  private known = new Map<string, { span: ElementSpan; group: Group }>()
  private changes = new Map<ElementSpan, Change | null>()
  private additions: Change[] = []
  private allocated = new Set<string>()

  constructor(
    private part: RulePart,
    private salt: string
  ) {
    const { xml, prefix } = part
    this.root = part.first('extLst')
    if (!this.root) return
    for (const ext of children(xml, this.root)) {
      if (ext.name !== prefix + 'ext') continue
      for (const span of children(xml, ext)) {
        if (local(span.name) !== 'conditionalFormattings') continue
        const groups: Group[] = []
        for (const group of children(xml, span)) {
          if (local(group.name) !== 'conditionalFormatting') continue
          const nodes = [...children(xml, group)]
          const rules = nodes.filter((node) => local(node.name) === 'cfRule')
          const sqref = nodes.find((node) => local(node.name) === 'sqref')
          const item = { span: group, rules, sqref }
          for (const rule of rules) {
            const id = valueOf(openTag(xml, rule), 'id')
            if (id) {
              this.known.set(id.toUpperCase(), { span: rule, group: item })
              this.allocated.add(id.toUpperCase())
            }
          }
          groups.push(item)
        }
        this.containers.push({ extension: ext, span, groups })
      }
    }
  }

  private idFor(seed: string): string {
    let counter = 0
    while (true) {
      const hash = createHash('sha256')
        .update(this.salt)
        .update(seed)
        .update(String(counter++))
        .digest('hex')
      const id =
        `{${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}}`.toUpperCase()
      if (this.allocated.has(id)) continue
      this.allocated.add(id)
      return id
    }
  }

  link(id: string): string {
    const p = this.part.prefix
    return tag(
      p + 'extLst',
      {},
      tag(p + 'ext', { uri: LINK, 'xmlns:x14': X14 }, tag('x14:id', {}, id))
    )
  }

  retain(id: string, priority: number) {
    const old = this.known.get(id.toUpperCase())
    if (!old || !old.group.sqref) return
    const { xml } = this.part
    const opening = openTag(xml, old.span)
    if (valueOf(opening, 'priority') !== undefined)
      this.changes.set(old.span, {
        range: xml.slice(old.group.sqref.openEnd, old.group.sqref.close),
        text: setNumber(opening, 'priority', priority) + xml.slice(old.span.openEnd, old.span.end)
      })
  }

  remove(id: string) {
    const old = this.known.get(id.toUpperCase())
    if (old) this.changes.set(old.span, null)
  }

  set(
    id: string | undefined,
    seed: string,
    range: string,
    model: DataBar,
    priority: number,
    keepThresholds: boolean,
    was?: DataBar['config']
  ) {
    const old = id && this.known.get(id.toUpperCase())
    const guid = id ?? this.idFor(seed)
    if (old) {
      const { xml } = this.part
      const bar = [...children(xml, old.span)].find((node) => local(node.name) === 'dataBar')
      if (!bar || !old.group.sqref)
        throw new RulesRefused('The linked Excel data bar has no range or settings.')
      const opening = openTag(xml, old.span)
      const text = applySplices(
        xml,
        [
          {
            start: old.span.start,
            end: old.span.openEnd,
            text:
              valueOf(opening, 'priority') === undefined
                ? opening
                : setNumber(opening, 'priority', priority)
          },
          { start: bar.start, end: bar.end, text: this.bar(model, bar, keepThresholds, was) }
        ],
        old.span.start,
        old.span.end
      )
      this.changes.set(old.span, { range, text })
    } else {
      this.additions.push({
        range,
        text: tag('x14:cfRule', { id: guid, type: 'dataBar' }, this.bar(model))
      })
    }
    return guid
  }

  private bar(
    model: DataBar,
    previous?: ElementSpan,
    keepThresholds = false,
    was?: DataBar['config']
  ): string {
    const { xml } = this.part
    const { positiveColor, nativeColor, isGradient, min, max } = model.config
    const sameColor = rgb(positiveColor) === rgb(nativeColor)
    const name = previous?.name ?? 'x14:dataBar'
    const prefix = name.slice(0, -'dataBar'.length)
    if (!previous) {
      const body =
        threshold(prefix, min) +
        threshold(prefix, max) +
        (sameColor ? '' : tag(prefix + 'negativeFillColor', { rgb: rgb(nativeColor) })) +
        tag(prefix + 'axisColor', { rgb: 'FF000000' })
      return tag(
        name,
        {
          minLength: 0,
          maxLength: 100,
          gradient: isGradient ? undefined : 0,
          negativeBarColorSameAsPositive: sameColor ? 1 : undefined
        },
        body
      )
    }
    const nodes = [...children(xml, previous)]
    const thresholds = nodes.filter((el) => local(el.name) === 'cfvo')
    if (thresholds.length !== 2)
      throw new RulesRefused('The linked Excel data bar does not have two thresholds.')
    const edits: Splice[] = []
    if (!keepThresholds) {
      for (const [index, value] of [min, max].entries()) {
        const el = thresholds[index]
        edits.push({ start: el.start, end: el.end, text: threshold(prefix, value) })
      }
    }
    const color = (key: string, value: string | undefined, create: boolean) => {
      const old = nodes.find((el) => local(el.name) === key)
      if (old) {
        const text = value ? tag(old.name, { rgb: rgb(value) }) : ''
        edits.push({ start: old.start, end: old.end, text })
      } else if (value && create) {
        const pos =
          nodes.find((el) => ORDER.indexOf(local(el.name)) > ORDER.indexOf(key))?.start ??
          previous.close
        edits.push({ start: pos, end: pos, text: tag(prefix + key, { rgb: rgb(value) }) })
      }
    }
    color('fillColor', positiveColor, false)
    color('negativeFillColor', sameColor ? undefined : nativeColor, true)
    // A border Excel drew in the bar's own colour follows the bar to its new one; a border of another colour is his.
    const follow = (key: string, old: string | undefined, next: string) => {
      const node = nodes.find((el) => local(el.name) === key)
      if (!node || !old || rgb(old) === rgb(next)) return
      if (valueOf(openTag(xml, node), 'rgb')?.toUpperCase() === rgb(old))
        edits.push({ start: node.start, end: node.end, text: tag(node.name, { rgb: rgb(next) }) })
    }
    follow('borderColor', was?.positiveColor, positiveColor)
    follow('negativeBorderColor', was?.nativeColor, nativeColor)
    let opening = openTag(xml, previous)
    opening = isGradient
      ? removeAttrInTag(opening, 'gradient')
      : setAttrInTag(opening, 'gradient', '0')
    opening = sameColor
      ? setAttrInTag(opening, 'negativeBarColorSameAsPositive', '1')
      : removeAttrInTag(opening, 'negativeBarColorSameAsPositive')
    // The worksheet's original prefix for xm:f need not be xm.
    if (!keepThresholds && !opening.includes('xmlns:xm='))
      opening = opening.replace(/>$/, ` xmlns:xm="${XM}">`)
    edits.push({ start: previous.start, end: previous.openEnd, text: opening })
    return applySplices(xml, edits, previous.start, previous.end)
  }

  render() {
    if (!this.changes.size && !this.additions.length) return
    const { xml, prefix: p } = this.part
    const last = this.containers.at(-1)
    const additions = this.additions
      .map(({ range, text }) =>
        tag(
          'x14:conditionalFormatting',
          { 'xmlns:x14': X14, 'xmlns:xm': XM },
          text + tag('xm:sqref', {}, range)
        )
      )
      .join('')
    const groupEdits = this.containers.map((container) => {
      const changes: Splice[] = []
      const moved: string[] = []
      let kept = 0
      for (const group of container.groups) {
        const changesHere: Splice[] = []
        let live = 0
        for (const rule of group.rules) {
          const change = this.changes.get(rule)
          if (change === undefined) {
            live++
            continue
          }
          const oldRange = group.sqref && xml.slice(group.sqref.openEnd, group.sqref.close)
          if (change && group.rules.length === 1 && group.sqref && change.range !== oldRange) {
            live++
            const sqref = group.sqref
            changesHere.push({ start: sqref.openEnd, end: sqref.close, text: change.range })
            if (change.text !== elementText(xml, rule))
              changesHere.push({ start: rule.start, end: rule.end, text: change.text })
          } else if (change && change.range === oldRange) {
            live++
            if (change.text !== elementText(xml, rule))
              changesHere.push({ start: rule.start, end: rule.end, text: change.text })
          } else {
            if (change && group.sqref) {
              const sqref = group.sqref
              // Keep this group's namespace declarations and the container's inherited bindings.
              const newRange = withBody(openTag(xml, sqref), sqref.name, change.range)
              moved.push(
                withBody(openTag(xml, group.span), group.span.name, change.text + newRange)
              )
            }
            changesHere.push({ start: rule.start, end: rule.end, text: '' })
          }
        }
        if (!live && changesHere.length) {
          if (
            [...children(xml, group.span)].some(
              (el) => local(el.name) !== 'cfRule' && local(el.name) !== 'sqref'
            )
          )
            throw new RulesRefused(
              'This Excel extension group has extra settings and cannot be removed.'
            )
          changes.push({ start: group.span.start, end: group.span.end, text: '' })
        } else {
          kept++
          changes.push(...changesHere)
        }
      }
      return {
        container,
        changes,
        kept,
        appended: moved.join('') + (container === last ? additions : '')
      }
    })
    const extChanges: Splice[] = []
    for (const { container, changes, kept, appended } of groupEdits) {
      const { span, extension } = container
      if (appended) {
        if (span.openEnd === span.end) {
          extChanges.push({
            start: span.start,
            end: span.end,
            text: withBody(openTag(xml, span), span.name, appended)
          })
          continue
        }
        changes.push({ start: span.close, end: span.close, text: appended })
      }
      if (!changes.length) continue
      const result = applySplices(xml, changes, span.openEnd, span.close)
      if (!kept && !result.trim()) {
        const siblings = [...children(xml, extension)]
        const remove = siblings.length === 1 ? extension : span
        extChanges.push({ start: remove.start, end: remove.end, text: '' })
      } else extChanges.push(...changes)
    }
    const newExt =
      !last && additions
        ? tag(
            p + 'ext',
            { uri: EXT, 'xmlns:x14': X14 },
            tag('x14:conditionalFormattings', {}, additions)
          )
        : ''
    if (!this.root) {
      if (newExt) this.part.add('extLst', tag(p + 'extLst', {}, newExt))
    } else if (this.root.openEnd === this.root.end) {
      if (newExt)
        this.part.replace(this.root, withBody(openTag(xml, this.root), this.root.name, newExt))
    } else if (extChanges.length || newExt) {
      const body = applySplices(xml, extChanges, this.root.openEnd, this.root.close) + newExt
      this.part.replace(
        this.root,
        body.trim()
          ? openTag(xml, this.root) + body + xml.slice(this.root.close, this.root.end)
          : ''
      )
    }
  }
}
