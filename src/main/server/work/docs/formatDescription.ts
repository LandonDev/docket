import { DOCUMENT_FRAGMENT } from 'work-kit/collab'
import { readBlocks, styleOfBlock } from 'work-kit/collab-server'
import { NORMAL, readPage, resolveStyle } from 'work-kit/editor/page'
import { paraOf } from 'work-kit/editor/para'
import { flattenBlocks, formatWords, paraWords } from 'work-kit/formats/diff'
import { parseColour, resolveColour } from 'work-kit/format/theme'

type Doc = Parameters<typeof readPage>[0] & { getXmlFragment(name: string): Parameters<typeof readBlocks>[0] }

function snippet(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean)
  return words.length ? words.slice(0, 6).join(' ') + (words.length > 6 ? '…' : '') : 'Empty paragraph'
}

export function documentStyleLines(doc: Doc): string[] {
  const page = readPage(doc)
  if (!page) return ['This document has no styles of its own yet.']
  const { setup, theme } = page
  const margin = setup.margins
  const lines = [
    `Theme ${theme.name}. Heading font ${theme.fonts.heading}. Body font ${theme.fonts.body}.`,
    `Page ${setup.paper}, ${setup.orientation}, ${setup.columns} ${setup.columns === 1 ? 'column' : 'columns'}. Margins ${margin.top} pt top, ${margin.right} pt right, ${margin.bottom} pt bottom, ${margin.left} pt left.`,
    `Header ${setup.header ? 'on' : 'off'}, footer ${setup.footer ? 'on' : 'off'}, ${setup.differentFirst ? 'different first page' : 'same setup on the first page'}.`,
    'Named styles:'
  ]
  for (const name of Object.keys(page.styles)) {
    const style = resolveStyle(page.styles, name)
    const font = style.fontFamily ?? theme.fonts.body
    const weight = style.bold ? 'bold' : 'regular'
    const colour = style.color ? parseColour(style.color) : undefined
    const ink = colour ? resolveColour(colour, theme) + ('theme' in colour ? ` (${style.color})` : '') : 'automatic colour'
    const detail = [font, `${style.fontSize ?? 11} pt`, weight, ...(style.italic ? ['italic'] : []), ...(style.underline ? ['underlined'] : []),
      ink, `${style.lineSpacing ?? 1.4} lines`, `${style.spaceBefore ?? 0} pt before`, `${style.spaceAfter ?? 0} pt after`]
    lines.push(`- ${name}: ${detail.join(', ')}.`)
  }
  const blocks: string[] = []
  for (const block of flattenBlocks(readBlocks(doc.getXmlFragment(DOCUMENT_FRAGMENT)))) {
    const name = styleOfBlock(block) ?? NORMAL
    const { style: _style, ...para } = paraOf(block)
    const changed = paraWords({}, para)
    if (block.props.textAlignment && block.props.textAlignment !== 'left') changed.push(`Aligned ${String(block.props.textAlignment)}`)
    const runs = (block.table?.flat(2) ?? block.runs).map((run) => ({
      ...run, styles: Object.fromEntries(Object.entries(run.styles ?? {}).filter(([, value]) => value && value !== 'default'))
    }))
    if (runs.some((run) => Object.keys(run.styles).length)) changed.push(...formatWords(runs.map((run) => ({ ...run, styles: {} })), runs))
    if (name !== NORMAL || changed.length) blocks.push(`- ${snippet(block.text)}: ${[name, ...new Set(changed)].join(', ')}.`)
  }
  if (blocks.length) lines.push('Formatted blocks:', ...blocks)
  return lines
}
