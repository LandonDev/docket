import type { IDefinedNamesServiceParam } from '@univerjs/engine-formula'
import { definedNameText } from 'work-kit/sheet/xlsx'
import {
  applySplices,
  children,
  elementText,
  isOn,
  openTag,
  valueOf,
  withBody,
  type ElementSpan,
  type Splice
} from './format-xml'
import { colName, parseRef, setAttrInTag, removeAttrInTag, type Box } from './xml'
import {
  BOOK_ORDER,
  RulePart,
  RulesRefused,
  checkedFormula,
  inner,
  on,
  quotedSheet,
  tag,
  xattr,
  xstring,
  xunescape
} from './rules-xml'
import { EXCEL_NAMES, RESERVED_NAME } from './names'

export type DefinedName = Omit<IDefinedNamesServiceParam, 'id' | 'localSheetId'> & {
  id?: string
  localSheetId?: string | null
}
export type DefinedNames = readonly DefinedName[] | Readonly<Record<string, DefinedName>>
const RESERVED = RESERVED_NAME
const FILTER = '_xlnm._FilterDatabase'

export function workbookSheetIds(xml: string): string[] {
  const part = new RulePart(xml, 'workbook', BOOK_ORDER)
  const sheets = part.first('sheets')
  if (!sheets) return []
  const taken = new Set<string>()
  return [...children(xml, sheets)]
    .filter((sheet) => sheet.name === part.prefix + 'sheet')
    .map((sheet, index) => {
      let id = 'sheet' + (valueOf(openTag(xml, sheet), 'sheetId') ?? index + 1)
      while (taken.has(id)) id += '-' + (index + 1)
      taken.add(id)
      return id
    })
}

function validName(name: string) {
  if (
    typeof name !== 'string' ||
    name.length > 255 ||
    !/^[\p{L}_\\][\p{L}\p{M}\p{N}_.?\\]*$/u.test(name) ||
    EXCEL_NAMES.has(name.toLowerCase()) ||
    /^(?:R(?:\d+)?C(?:\d+)?|R|C)$/i.test(name)
  )
    throw new RulesRefused(`“${name}” is not a valid Excel defined name.`)
  if (/^[a-z]{1,3}\d+$/i.test(name)) {
    let cell = false
    try {
      parseRef(name)
      cell = true
    } catch {
      /* outside the cell grid */
    }
    if (cell) throw new RulesRefused(`“${name}” looks like an Excel cell reference.`)
  }
}

const key = (name: string, scope: number | undefined) => `${scope ?? ''}:${name.toLowerCase()}`
interface NameEntry {
  el: ElementSpan
  name: string
  scope?: number
}

export class WorkbookNames {
  private part: RulePart
  private root?: ElementSpan
  private entries: NameEntry[] = []

  constructor(xml: string) {
    this.part = new RulePart(xml, 'workbook', BOOK_ORDER)
    this.root = this.part.first('definedNames')
    if (!this.root) return
    for (const el of children(xml, this.root)) {
      if (el.name !== this.part.prefix + 'definedName') continue
      const opening = openTag(xml, el)
      const name = valueOf(opening, 'name')
      const sheet = valueOf(opening, 'localSheetId')
      if (name !== undefined)
        this.entries.push({ el, name, scope: sheet === undefined ? undefined : Number(sheet) })
    }
  }

  read(sheetIds: readonly string[]): Record<string, DefinedName> {
    const names: Record<string, DefinedName> = {}
    const { xml } = this.part
    let count = 0
    for (const entry of this.entries) {
      if (RESERVED.test(entry.name)) continue
      const id = 'name' + ++count
      const opening = openTag(xml, entry.el)
      const model: DefinedName = {
        id,
        name: entry.name,
        formulaOrRefString: definedNameText(xunescape(inner(xml, entry.el)))
      }
      const scope = entry.scope === undefined ? undefined : sheetIds[entry.scope]
      if (scope) model.localSheetId = scope
      if (isOn(valueOf(opening, 'hidden'))) model.hidden = true
      const comment = xattr(opening, 'comment')
      if (comment) model.comment = comment
      names[id] = model
    }
    return names
  }

  get date1904(): boolean {
    const props = this.part.first('workbookPr')
    return !!props && isOn(valueOf(openTag(this.part.xml, props), 'date1904'))
  }

  replace(names: DefinedNames, sheetIds: readonly string[]): string {
    const models = Array.isArray(names) ? (names as readonly DefinedName[]) : Object.values(names)
    const incoming = new Map<string, { model: DefinedName; scope?: number; file: string }>()
    for (const model of models) {
      if (RESERVED.test(model.name))
        throw new RulesRefused(
          `“${model.name}” is reserved by Excel and cannot be edited as a defined name.`
        )
      validName(model.name)
      const scope =
        !model.localSheetId || model.localSheetId === 'AllDefaultWorkbook'
          ? undefined
          : sheetIds.indexOf(model.localSheetId)
      if (scope === -1)
        throw new RulesRefused(
          `The defined name “${model.name}” refers to an unknown worksheet scope.`
        )
      const id = key(model.name, scope)
      if (incoming.has(id))
        throw new RulesRefused(`The defined name “${model.name}” is duplicated in the same scope.`)
      incoming.set(id, { model, scope, file: checkedFormula(model.formulaOrRefString, true) })
    }
    const changes: Splice[] = []
    const { xml, prefix: p } = this.part
    for (const old of this.entries) {
      if (RESERVED.test(old.name)) continue
      const id = key(old.name, old.scope)
      const edit = incoming.get(id)
      let text = ''
      if (edit) {
        incoming.delete(id)
        const { model, file } = edit
        const originalTag = openTag(xml, old.el)
        let opening = originalTag
        if (model.name !== old.name) opening = setAttrInTag(opening, 'name', model.name)
        if (model.hidden !== undefined && isOn(valueOf(opening, 'hidden')) !== model.hidden)
          opening = model.hidden
            ? setAttrInTag(opening, 'hidden', '1')
            : removeAttrInTag(opening, 'hidden')
        if (model.comment !== undefined && (xattr(opening, 'comment') ?? '') !== model.comment) {
          opening = removeAttrInTag(opening, 'comment')
          if (model.comment)
            opening = opening.replace(
              /(\/?>)$/,
              (end) => ` comment="${xstring(model.comment!)}"${end}`
            )
        }
        const originalText = inner(xml, old.el)
        // The importer strips these prefixes. Preserve the exact source formula if the model did not change.
        const plain = (value: string) => value.replace(/_xl(?:fn|ws|pm)\./g, '')
        const prior = xunescape(originalText)
        if (file === prior || plain(prior) === model.formulaOrRefString.replace(/^=/, ''))
          text = opening + xml.slice(old.el.openEnd, old.el.end)
        else if (old.el.openEnd === old.el.end) text = withBody(opening, old.el.name, xstring(file))
        else text = opening + xstring(file) + xml.slice(old.el.close, old.el.end)
      }
      if (text !== elementText(xml, old.el))
        changes.push({ start: old.el.start, end: old.el.end, text })
    }
    const added = [...incoming.values()]
      .map(({ model, scope, file }) =>
        tag(
          p + 'definedName',
          {
            name: model.name,
            localSheetId: scope,
            hidden: on(model.hidden),
            comment: model.comment || undefined
          },
          xstring(file)
        )
      )
      .join('')
    return this.finish(changes, added)
  }

  filter(sheet: string, scope: number, box: Box | undefined): string {
    const { xml, prefix: p } = this.part
    const changes: Splice[] = []
    const known = this.entries.filter(
      (entry) => entry.name.toLowerCase() === FILTER.toLowerCase() && entry.scope === scope
    )
    const ref =
      box && `${quotedSheet(sheet)}!$${colName(box.c1)}$${box.r1}:$${colName(box.c2)}$${box.r2}`
    const first = known[0]
    let added = ''
    if (first && ref) {
      const opening = openTag(xml, first.el)
      const hidden = isOn(valueOf(opening, 'hidden'))
        ? opening
        : setAttrInTag(opening, 'hidden', '1')
      const source = xunescape(inner(xml, first.el))
      const direct = `${sheet}!${ref.slice(ref.lastIndexOf('!') + 1)}`
      if ((source !== ref && source !== direct) || hidden !== opening) {
        const text =
          first.el.openEnd === first.el.end
            ? withBody(hidden, first.el.name, xstring(ref))
            : hidden + xstring(ref) + xml.slice(first.el.close, first.el.end)
        changes.push({ start: first.el.start, end: first.el.end, text })
      }
    } else if (ref) {
      added = tag(p + 'definedName', { name: FILTER, localSheetId: scope, hidden: 1 }, xstring(ref))
    }
    for (const { el } of known.slice(ref ? 1 : 0))
      changes.push({ start: el.start, end: el.end, text: '' })
    return this.finish(changes, added)
  }

  private finish(changes: Splice[], added: string): string {
    const { xml, prefix: p } = this.part
    const root = this.root
    if (!changes.length && !added) return xml
    if (!root) this.part.add('definedNames', tag(p + 'definedNames', {}, added))
    else if (root.openEnd === root.end)
      this.part.replace(root, withBody(openTag(xml, root), root.name, added))
    else {
      const body = applySplices(xml, changes, root.openEnd, root.close) + added
      this.part.replace(
        root,
        body.trim() ? openTag(xml, root) + body + xml.slice(root.close, root.end) : ''
      )
    }
    return this.part.render()
  }
}
