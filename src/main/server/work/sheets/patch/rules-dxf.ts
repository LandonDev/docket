import type { IStyleData } from '@univerjs/core'
import { children, elementText, openTag, setNumber, withBody } from './format-xml'
import { RulesRefused, RulePart, STYLE_ORDER, tag, xmlKey } from './rules-xml'

const BORDER = [
  '',
  'thin',
  'hair',
  'dotted',
  'dashed',
  'dashDot',
  'dashDotDot',
  'double',
  'medium',
  'mediumDashed',
  'mediumDashDot',
  'mediumDashDotDot',
  'slantDashDot',
  'thick'
]

export function rgb(color: unknown): string {
  if (typeof color !== 'string' || !/^#?(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color))
    throw new RulesRefused('Use an RGB colour for this conditional format.')
  let out = color.replace(/^#/, '').toUpperCase()
  if (out.length === 3) out = out.replace(/./g, '$&$&')
  return out.length === 6 ? 'FF' + out : out
}

function differential(p: string, style: IStyleData): string {
  const allowed = new Set(['ff', 'fs', 'bl', 'it', 'ul', 'st', 'cl', 'bg', 'bd'])
  if (Object.entries(style).some(([key, value]) => value != null && !allowed.has(key)))
    throw new RulesRefused(
      'This conditional rule uses a style Excel cannot save through this editor.'
    )
  const flag = (name: string, value: number | undefined) =>
    value === undefined ? '' : tag(p + name, { val: value ? undefined : '0' })
  const color = (name: string, value: unknown) => tag(p + name, { rgb: rgb(value) })
  let font = flag('b', style.bl) + flag('i', style.it) + flag('strike', style.st?.s)
  if (style.ul?.s !== undefined) font += tag(p + 'u', { val: style.ul.s ? undefined : 'none' })
  if (style.fs !== undefined) {
    if (!Number.isFinite(style.fs) || style.fs < 1 || style.fs > 409)
      throw new RulesRefused('Use a conditional font size from 1 to 409 points.')
    font += tag(p + 'sz', { val: style.fs })
  }
  if (style.cl) font += color('color', style.cl.rgb)
  if (style.ff) font += tag(p + 'name', { val: style.ff })
  const fill = style.bg
    ? tag(p + 'fill', {}, tag(p + 'patternFill', {}, color('bgColor', style.bg.rgb)))
    : ''

  const edges = style.bd ?? {}
  const sides = {
    l: 'left',
    r: 'right',
    t: 'top',
    b: 'bottom',
    tl_br: 'diagonal',
    bl_tr: 'diagonal'
  } as const
  if (Object.entries(edges).some(([key, value]) => value && !(key in sides)))
    throw new RulesRefused('This conditional border has an edge Excel cannot save.')
  let border = ''
  for (const key of ['l', 'r', 't', 'b'] as const) {
    const edge = edges[key]
    if (!edge) continue
    if (edge.s === 0) border += tag(p + sides[key], { style: 'none' })
    else {
      if (!BORDER[edge.s]) throw new RulesRefused('Unknown conditional border line style.')
      border += tag(
        p + sides[key],
        { style: BORDER[edge.s] },
        color('color', edge.cl?.rgb ?? '#000000')
      )
    }
  }
  const down = edges.tl_br,
    up = edges.bl_tr
  const diagonal = down ?? up
  if (
    down &&
    up &&
    (down.s !== up.s || rgb(down.cl?.rgb ?? '#000000') !== rgb(up.cl?.rgb ?? '#000000'))
  )
    throw new RulesRefused('Excel uses one line style and colour for both diagonal borders.')
  if (diagonal) {
    if (!BORDER[diagonal.s])
      throw new RulesRefused('Use a visible line style for the diagonal border.')
    border += tag(
      p + 'diagonal',
      { style: BORDER[diagonal.s] },
      color('color', diagonal.cl?.rgb ?? '#000000')
    )
  }
  const body =
    (font ? tag(p + 'font', {}, font) : '') +
    fill +
    (border
      ? tag(
          p + 'border',
          { diagonalDown: down ? 1 : undefined, diagonalUp: up ? 1 : undefined },
          border
        )
      : '')
  return body ? tag(p + 'dxf', {}, body) : ''
}

function dxfKey(xml: string): string {
  return xmlKey(xml, (name, attrs) => {
    const color = attrs.get('rgb')
    if (color) attrs.set('rgb', rgb(color))
    if (Number(attrs.get('tint')) === 0) attrs.delete('tint')
    if (['b', 'i', 'strike'].includes(name) && ['1', 'true'].includes(attrs.get('val') ?? ''))
      attrs.delete('val')
    if (name === 'u' && attrs.get('val') === 'single') attrs.delete('val')
    if (name === 'patternFill' && attrs.get('patternType') === 'solid') attrs.delete('patternType')
    for (const key of ['diagonalUp', 'diagonalDown'])
      if (attrs.get(key) === 'true') attrs.set(key, '1')
  })
}

export class DifferentialStyles {
  private part: RulePart
  private records = new Map<string, number>()
  private added: string[] = []
  private count = 0

  constructor(xml: string) {
    this.part = new RulePart(xml, 'styleSheet', STYLE_ORDER)
    const root = this.part.first('dxfs')
    if (!root) return
    for (const el of children(xml, root)) {
      if (el.name !== this.part.prefix + 'dxf') continue
      const key = dxfKey(elementText(xml, el))
      if (!this.records.has(key)) this.records.set(key, this.count)
      this.count++
    }
  }

  get appends() {
    return this.added.length
  }

  intern(style: IStyleData): number | undefined {
    const record = differential(this.part.prefix, style)
    if (!record) return undefined
    const key = dxfKey(record)
    const old = this.records.get(key)
    if (old !== undefined) return old
    const id = this.count + this.added.length
    this.records.set(key, id)
    this.added.push(record)
    return id
  }

  render(): string {
    if (!this.added.length) return this.part.xml
    const part = new RulePart(this.part.xml, 'styleSheet', STYLE_ORDER)
    const { xml, prefix: p } = part
    const root = part.first('dxfs')
    const count = this.count + this.added.length
    const nodes = this.added.join('')
    if (!root) part.add('dxfs', tag(p + 'dxfs', { count }, nodes))
    else {
      const opening = setNumber(openTag(xml, root), 'count', count)
      if (root.openEnd === root.end) part.replace(root, withBody(opening, root.name, nodes))
      else
        part.replace(
          root,
          opening + xml.slice(root.openEnd, root.close) + nodes + xml.slice(root.close, root.end)
        )
    }
    return part.render()
  }
}
