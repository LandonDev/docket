// XML spans for format edits. Walk only the current element's children and keep their source offsets.
import { attr, parseAttrs, removeAttrInTag, setAttrInTag, unesc } from './xml'

export class FormatRefused extends Error {
  override name = 'FormatRefused'
}

export interface ElementSpan {
  name: string
  start: number
  openEnd: number
  close: number
  end: number
}

export interface Splice {
  start: number
  end: number
  text: string
}

// Skip markup that can contain '<' and allow '>' inside quoted attribute values.
const markup =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([^\s/>!?]+)(?:[^<>"']|"[^"]*"|'[^']*')*>/g

export function documentRoot(xml: string): ElementSpan | undefined {
  const token = new RegExp(markup)
  let match: RegExpExecArray | null
  while ((match = token.exec(xml))) {
    const name = match[2]
    if (!name) continue
    const openEnd = token.lastIndex
    if (xml[openEnd - 2] === '/')
      return { name, start: match.index, openEnd, close: openEnd, end: openEnd }
    // Step over the whitespace, comments and processing instructions after the root.
    let end = xml.length
    while (end > openEnd) {
      while (/\s/.test(xml[end - 1])) end--
      if (xml.startsWith('-->', end - 3)) end = xml.lastIndexOf('<!--', end - 3)
      else if (xml.startsWith('?>', end - 2)) end = xml.lastIndexOf('<?', end - 2)
      else break
    }
    const close = xml.lastIndexOf('</' + name, end - 1)
    if (close < openEnd || !/^\s*>$/.test(xml.slice(close + name.length + 2, end)))
      throw new Error('Unclosed XML root ' + name)
    return { name, start: match.index, openEnd, close, end }
  }
  return undefined
}

export function* elements(
  xml: string,
  from = 0,
  to = xml.length,
  opaque?: string
): Generator<ElementSpan> {
  const token = new RegExp(markup)
  token.lastIndex = from
  let depth = 0
  let start = 0
  let openEnd = 0
  let name = ''
  let match: RegExpExecArray | null
  // Starting the search at 'to' would scan the rest of the part once per row.
  while (token.lastIndex < to) {
    const next = xml.indexOf('<', token.lastIndex)
    if (next < 0 || next >= to) break
    token.lastIndex = next
    match = token.exec(xml)
    if (!match || match.index >= to) break
    const tag = match[2]
    if (!tag) continue
    if (match[1]) {
      if (--depth === 0) yield { name, start, openEnd, close: match.index, end: token.lastIndex }
      continue
    }
    const empty = xml[token.lastIndex - 2] === '/'
    if (depth === 0) {
      name = tag
      start = match.index
      openEnd = token.lastIndex
      if (empty) yield { name, start, openEnd, close: openEnd, end: openEnd }
      // A worksheet's sheetData cannot nest. Find its end without walking every row here.
      else if (tag === opaque) {
        const closeTag = new RegExp(
          '<!--[\\s\\S]*?-->|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|<\\?[\\s\\S]*?\\?>|(</' +
            tag.replace(/[.]/g, '\\.') +
            '\\s*>)',
          'g'
        )
        closeTag.lastIndex = openEnd
        let end: RegExpExecArray | null
        while ((end = closeTag.exec(xml)) && !end[1]) {
          /* skip comments and other literal text */
        }
        if (!end || end.index >= to) throw new Error('Unclosed XML element ' + tag)
        token.lastIndex = closeTag.lastIndex
        yield { name, start, openEnd, close: end.index, end: token.lastIndex }
        continue
      }
    }
    if (!empty) depth++
  }
  if (depth !== 0) throw new Error('Unclosed XML element ' + name)
}

export const children = (xml: string, parent: ElementSpan) =>
  elements(xml, parent.openEnd, parent.close)
export const openTag = (xml: string, el: ElementSpan) => xml.slice(el.start, el.openEnd)
export const elementText = (xml: string, el: ElementSpan) => xml.slice(el.start, el.end)
export const valueOf = (tag: string, name: string) => {
  const value = attr(parseAttrs(tag), name)
  return value === undefined ? undefined : unesc(value)
}

export function applySplices(xml: string, changes: Splice[], start = 0, end = xml.length): string {
  if (!changes.length) return xml.slice(start, end)
  changes.sort((a, b) => a.start - b.start || a.end - b.end)
  const out: string[] = []
  for (const change of changes) {
    if (change.start < start) throw new Error('Overlapping XML edits')
    out.push(xml.slice(start, change.start), change.text)
    start = change.end
  }
  out.push(xml.slice(start, end))
  return out.join('')
}

export function withBody(tag: string, name: string, body: string): string {
  if (tag.endsWith('/>') && !body) return tag
  return tag.replace(/\/>$/, '>') + body + `</${name}>`
}

export function insertionPoint(
  parent: ElementSpan,
  siblings: ElementSpan[],
  name: string,
  order: readonly string[],
  prefix: string
): number {
  const index = order.indexOf(name)
  return (
    siblings.find(
      (el) => el.name.startsWith(prefix) && order.indexOf(el.name.slice(prefix.length)) > index
    )?.start ?? parent.close
  )
}

export const isOn = (attr: string | undefined) => attr === '1' || attr === 'true'

export function setNumber(tag: string, name: string, number: number): string {
  const old = valueOf(tag, name)
  return old !== undefined && Number(old) === number ? tag : setAttrInTag(tag, name, String(number))
}

export function setSize(tag: string, name: string, flag: string, size: number | null): string {
  if (size === null) return removeAttrInTag(removeAttrInTag(tag, name), flag)
  const sized = setNumber(tag, name, size)
  return isOn(valueOf(tag, flag)) ? sized : setAttrInTag(sized, flag, '1')
}
