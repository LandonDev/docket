import {
  applySplices,
  children,
  documentRoot,
  elementText,
  openTag,
  setNumber,
  setSize,
  valueOf,
  withBody,
  type ElementSpan,
  type Splice
} from './format-xml'
import { removeAttrInTag } from './xml'

export interface ColumnStyle {
  from: number
  to: number
  style: number
}

export function columnStyleAt(cols: ColumnStyle[], col: number): number {
  let lo = 0,
    hi = cols.length
  while (lo < hi) {
    const i = (lo + hi) >>> 1
    const range = cols[i]
    if (col < range.from) hi = i
    else if (col > range.to) lo = i + 1
    else return range.style
  }
  return 0
}

/** Edit the small column groups independently of the sheetData scan. */
export class FormatColumns {
  private groups: { source?: ElementSpan; xml: string }[]
  private styleSnapshot?: ColumnStyle[]

  constructor(
    xml: string,
    groups: ElementSpan[],
    private prefix: string,
    private defaultWidth: number
  ) {
    const P = prefix
    this.groups = groups.map((source) => {
      const changes: Splice[] = []
      for (const el of children(xml, source)) {
        if (el.name !== P + 'col') continue
        const tag = openTag(xml, el)
        if (valueOf(tag, 'width') === undefined)
          changes.push({ start: el.start, end: el.openEnd, text: this.withWidth(tag) })
      }
      return { source, xml: applySplices(xml, changes, source.start, source.end) }
    })
    if (!this.groups.length) this.groups.push({ xml: `<${P}cols/>` })
  }

  private withWidth(tag: string) {
    return valueOf(tag, 'width') === undefined
      ? setNumber(removeAttrInTag(tag, 'customWidth'), 'width', this.defaultWidth)
      : tag
  }

  styles(): ColumnStyle[] {
    if (!this.styleSnapshot) {
      this.styleSnapshot = []
      for (const { xml } of this.groups) {
        const root = documentRoot(xml)
        if (!root) continue
        for (const el of children(xml, root)) {
          if (el.name !== this.prefix + 'col') continue
          const tag = openTag(xml, el)
          const style = valueOf(tag, 'style')
          if (style !== undefined)
            this.styleSnapshot.push({
              from: Number(valueOf(tag, 'min')),
              to: Number(valueOf(tag, 'max')),
              style: Number(style)
            })
        }
      }
    }
    return this.styleSnapshot
  }

  setStyle(from: number, to: number, style: (old: number) => number) {
    this.edit(from, to, (tag) => {
      const old = Number(valueOf(tag, 'style') ?? 0)
      const next = style(old)
      return next === old ? tag : setNumber(tag, 'style', next)
    })
    this.styleSnapshot = undefined
  }

  setWidth(from: number, to: number, size: number | null) {
    this.edit(from, to, (tag) => {
      if (
        size === null &&
        Number(valueOf(tag, 'width')) === this.defaultWidth &&
        valueOf(tag, 'customWidth') === undefined
      )
        return tag
      return setSize(tag, 'width', 'customWidth', size)
    })
  }

  private edit(from: number, to: number, update: (tag: string) => string) {
    const P = this.prefix
    const emptyCol = `<${P}col/>`
    const bounds = (tag: string, min: number, max: number) =>
      setNumber(setNumber(tag, 'min', min), 'max', max)
    const newCol = (min: number, max: number) => {
      const changed = update(emptyCol)
      return changed === emptyCol ? '' : this.withWidth(bounds(changed, min, max))
    }
    let next = from
    for (const [index, group] of this.groups.entries()) {
      const xml = group.xml || `<${P}cols/>`
      const span = documentRoot(xml)!
      const edits: Splice[] = []
      let remaining = 0
      for (const col of children(xml, span)) {
        if (col.name !== P + 'col') continue
        remaining++
        if (next > to) continue
        const tag = openTag(xml, col)
        const min = Number(valueOf(tag, 'min')),
          max = Number(valueOf(tag, 'max'))
        if (max < next) continue
        if (next < min) {
          const text = newCol(next, Math.min(to, min - 1))
          if (text) {
            edits.push({ start: col.start, end: col.start, text })
            remaining++
          }
          next = min
        }
        if (next > to) break
        const start = Math.max(next, min),
          end = Math.min(to, max)
        const updated = update(tag)
        if (updated !== tag && this.withWidth(updated) !== tag) {
          const body = xml.slice(col.openEnd, col.end)
          const pieces: string[] = []
          if (min < start) pieces.push(bounds(tag, min, start - 1) + body)
          const hasOtherAttrs = /\s(?!min\s*=|max\s*=)[^\s=/>]+\s*=/.test(updated)
          if (hasOtherAttrs || body) pieces.push(this.withWidth(bounds(updated, start, end)) + body)
          if (end < max) pieces.push(bounds(tag, end + 1, max) + body)
          edits.push({ start: col.start, end: col.end, text: pieces.join('') })
          remaining += pieces.length - 1
        }
        next = end + 1
      }
      if (index === this.groups.length - 1 && next <= to) {
        const text = newCol(next, to)
        if (text) {
          edits.push({ start: span.close, end: span.close, text })
          remaining++
        }
      }
      if (!edits.length) continue
      if (!remaining && !applySplices(xml, edits, span.openEnd, span.close).trim()) group.xml = ''
      else if (span.openEnd === span.end)
        group.xml = withBody(openTag(xml, span), span.name, edits.map((edit) => edit.text).join(''))
      else group.xml = applySplices(xml, edits)
    }
  }

  render(xml: string, changes: Splice[], insert: (name: string, text: string) => void) {
    for (const { source, xml: updated } of this.groups) {
      if (source) {
        if (updated !== elementText(xml, source))
          changes.push({ start: source.start, end: source.end, text: updated })
      } else if (updated && updated !== `<${this.prefix}cols/>`) {
        insert('cols', updated)
      }
    }
  }
}
