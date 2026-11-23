import { applySplices, type Splice } from './format-xml'
import { lambdaParams, tokenize } from './formula'
import { fold, TablesRefused } from './tables-model'
import { escText, parseRef, unesc, inBox, type Box } from './xml'

export interface TableReferenceEdit {
  name: string
  next?: string
  sheetPart: string
  oldRange: Box
  /** Narrowing columns can orphan a structured reference even if the table stays. */
  dropped?: Set<string>
}

function outsideRemovedTable(
  xml: string,
  part: string,
  at: number,
  kind: string,
  edit: TableReferenceEdit
) {
  if (kind !== 'f' || part !== edit.sheetPart) return true
  const cell = /<(?:[\w.-]+:)?c\b[^>]*\br=["']([^"']+)["'][^>]*>(?:(?!<\/[^>]+>).)*$/s
  // A worksheet formula normally starts immediately after its cell's opening tag.
  const from = xml.lastIndexOf('<', at - 1)
  const ref = from >= 0 && cell.exec(xml.slice(from, at))?.[1]
  if (!ref) return true
  const { row, col } = parseRef(ref)
  return !inBox(edit.oldRange, row, col)
}

/** Replace static references. Quoted strings, LET parameters and external workbook names are separate. */
export function tableReferences(
  xml: string,
  part: string,
  location: string,
  edits: ReadonlyMap<string, TableReferenceEdit>
): string {
  const changes: Splice[] = []
  const namesToCheck = [...edits.keys()]
  const nodes =
    /<((?:[\w.-]+:)?(f|formula|formula1|formula2|definedName|calculatedColumnFormula|totalsRowFormula))(?=[\s>])(?:[^>"']|"[^"]*"|'[^']*')*?(?<!\/)>([^<]*)<\/\1\s*>/g
  for (const node of xml.matchAll(nodes)) {
    const old = unesc(node[3])
    const lower = fold(old)
    if (!namesToCheck.some((name) => lower.includes(name))) continue
    const tokens = tokenize(old)
    const params = lambdaParams(tokens)
    const replaced: Splice[] = []
    for (const [i, token] of tokens.entries()) {
      if (token.kind !== 'name') continue
      const name = fold(token.text)
      const edit = edits.get(name)
      if (!edit || params.has(name)) continue
      const previous = tokens[i - 1]
      if (previous?.kind === 'sheet' && /\[.*\]/.test(previous.text)) continue
      const following = tokens[i + 1]
      const bracket =
        following?.kind === 'bracket' && following.start === token.end ? following.text : ''
      if (bracket && edit.dropped?.size) {
        const names = [...bracket.matchAll(/\[((?:'[^\n]|[^\[\]'])*)\]/g)].map((match) =>
          fold(match[1].replace(/^@/, '').replace(/'(.)/g, '$1'))
        )
        for (const col of names)
          if (edit.dropped.has(col))
            throw new TablesRefused(
              `“${location}” refers to table column ${edit.name}[${col}]. Update that reference before changing the table.`
            )
      }
      if (
        !edit.next &&
        !edit.dropped &&
        outsideRemovedTable(xml, part, node.index, node[2], edit)
      ) {
        const context =
          node[2] === 'definedName'
            ? (/\bname=["']([^"']+)["']/.exec(node[0])?.[1] ?? location)
            : location
        throw new TablesRefused(
          `“${context}” refers to table “${edit.name}”. Remove that reference before deleting the table.`
        )
      }
      // A file names a whole table `Sales[]`; a bare `Sales` reads #NAME? in Excel, so a rename mends it.
      const whole = !bracket && previous?.kind !== 'sheet' ? '[]' : ''
      if (edit.next && (edit.next !== token.text || whole))
        replaced.push({ start: token.start, end: token.end, text: edit.next + whole })
    }
    if (!replaced.length) continue
    const at = node.index + node[0].lastIndexOf('</') - node[3].length
    changes.push({
      start: at,
      end: at + node[3].length,
      text: escText(applySplices(old, replaced))
    })
  }
  return applySplices(xml, changes)
}
