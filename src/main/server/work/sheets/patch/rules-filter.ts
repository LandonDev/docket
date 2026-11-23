import type { IRange } from '@univerjs/core'
import type { IAutoFilter, IFilterColumn } from '@univerjs/sheets-filter'
import { filterHiddenState, FILTER_STATE_URI } from 'work-kit/sheet/xlsx'
import {
  children,
  elementText,
  isOn,
  openTag,
  valueOf,
  withBody,
  type ElementSpan
} from './format-xml'
import { boxRef, contains, overlaps } from './format-ranges'
import { removeAttrInTag, setAttrInTag, type Box } from './xml'
import {
  OPERATORS,
  RulePart,
  RulesRefused,
  between,
  countLimit,
  extraAttrs,
  fileBoxes,
  gridBox,
  inner,
  on,
  tag,
  tagAttrs,
  xmlKey
} from './rules-xml'

export interface FilterSortState {
  ref: IRange
  conditions: readonly { ref: IRange; descending?: boolean; customList?: string }[]
  columnSort?: boolean
  caseSensitive?: boolean
  sortMethod?: 'stroke' | 'pinYin' | 'none'
}

export type SheetFilter = IAutoFilter & { sortState?: FilterSortState | null }

const FILTER_ATTRS = new Set(['ref'])
const COLUMN_ATTRS = new Set(['colId'])
const SORT_ATTRS = new Set(['ref', 'columnSort', 'caseSensitive', 'sortMethod'])
const SORT_ITEM_ATTRS = new Set(['ref', 'descending', 'customList', 'sortBy'])

function filterBox(ref: string): Box {
  const boxes = fileBoxes(ref)
  if (boxes.length !== 1) throw new RulesRefused('The worksheet filter must have one cell range.')
  return boxes[0]
}

function filterCriteria(p: string, col: IFilterColumn): string {
  if (col.colorFilters || Boolean(col.filters) === Boolean(col.customFilters))
    throw new RulesRefused(
      'Use either a value filter or a custom comparison for each filter column.'
    )
  if (col.filters) {
    const values = col.filters.filters ?? []
    if (values.some((value) => typeof value !== 'string'))
      throw new RulesRefused('Filter values must be text.')
    return tag(
      p + 'filters',
      { blank: on(col.filters.blank) },
      values.map((val) => tag(p + 'filter', { val })).join('')
    )
  }
  const custom = col.customFilters!
  const values = custom.customFilters
  if (values.length < 1 || values.length > 2)
    throw new RulesRefused('A custom filter needs one or two comparisons.')
  return tag(
    p + 'customFilters',
    { and: custom.and === 1 ? 1 : undefined },
    values
      .map(({ val, operator }) => {
        if (operator && (!OPERATORS.has(operator) || between(operator)))
          throw new RulesRefused(`Unknown filter comparison “${operator}”.`)
        if (typeof val !== 'string' && !Number.isFinite(val))
          throw new RulesRefused('A custom filter needs text or a finite number.')
        return tag(p + 'customFilter', {
          val,
          operator: operator === 'equal' ? undefined : operator
        })
      })
      .join('')
  )
}

function sortXml(
  part: RulePart,
  sort: FilterSortState,
  box: Box,
  previous: ElementSpan | undefined
): string {
  const { prefix: p, xml } = part
  const ref = gridBox(sort.ref)
  if (!contains(box, ref) || sort.conditions.length > 64)
    throw new RulesRefused(
      'The filter sort needs a range inside the filter and at most 64 sort conditions.'
    )
  if (sort.sortMethod !== undefined && !['stroke', 'pinYin', 'none'].includes(sort.sortMethod))
    throw new RulesRefused('Unknown Excel sort method.')
  const old = previous ? [...children(xml, previous)] : []
  const advanced = old.filter((el) => el.name !== p + 'sortCondition')
  if (
    old.some(
      (el) =>
        el.name === p + 'sortCondition' &&
        (!['value', undefined].includes(valueOf(openTag(xml, el), 'sortBy')) ||
          extraAttrs(xml, el, SORT_ITEM_ATTRS) ||
          el.openEnd !== el.close)
    )
  )
    throw new RulesRefused('This Excel filter has advanced sort conditions. Change them in Excel.')
  const body =
    sort.conditions
      .map((condition) => {
        const range = gridBox(condition.ref)
        if (!contains(ref, range))
          throw new RulesRefused('A sort condition must be inside the sort range.')
        return tag(p + 'sortCondition', {
          ref: boxRef(range),
          descending: on(condition.descending),
          customList: condition.customList
        })
      })
      .join('') + advanced.map((el) => elementText(xml, el)).join('')
  const attrs =
    tagAttrs({
      ref: boxRef(ref),
      columnSort: on(sort.columnSort),
      caseSensitive: on(sort.caseSensitive),
      sortMethod: sort.sortMethod
    }) + (previous ? extraAttrs(xml, previous, SORT_ATTRS) : '')
  return body ? `<${p}sortState${attrs}>${body}</${p}sortState>` : `<${p}sortState${attrs}/>`
}

function filterXml(
  part: RulePart,
  filter: SheetFilter,
  box: Box,
  old: ElementSpan | undefined,
  sameRange: boolean
): string {
  const { prefix: p, xml } = part
  const columns = filter.filterColumns ?? []
  countLimit(columns.length, 'filter columns')
  const criteria = new Map<number, string>()
  for (const col of columns) {
    const id = col.colId - (box.c1 - 1)
    if (!Number.isInteger(col.colId) || id < 0 || id > box.c2 - box.c1)
      throw new RulesRefused('A filter column is outside the filter range.')
    if (criteria.has(id)) throw new RulesRefused('A filter column occurs twice.')
    criteria.set(id, filterCriteria(p, col))
  }
  const oldChildren = old ? [...children(xml, old)] : []
  const previousSort = oldChildren.find((el) => el.name === p + 'sortState')
  const retained: { id: number; text: string }[] = []
  for (const el of oldChildren) {
    if (el.name !== p + 'filterColumn') continue
    const id = Number(valueOf(openTag(xml, el), 'colId'))
    const oldCriteria = [...children(xml, el)]
    const base = oldCriteria.find(
      (rule) => rule.name === p + 'filters' || rule.name === p + 'customFilters'
    )
    const unmodelled =
      !base ||
      oldCriteria.length !== 1 ||
      [...children(xml, base)].some(
        (child) => child.name !== p + 'filter' && child.name !== p + 'customFilter'
      )
    const current = criteria.get(id)
    if (unmodelled) {
      if (!sameRange || current !== undefined)
        throw new RulesRefused(
          'This Excel filter has advanced criteria. Edit those criteria in Excel.'
        )
      retained.push({ id, text: elementText(xml, el) })
    } else if (current !== undefined) {
      criteria.delete(id)
      if (xmlKey(current) === xmlKey(elementText(xml, base)))
        retained.push({ id, text: elementText(xml, el) })
      else
        retained.push({
          id,
          text:
            `<${p}filterColumn colId="${id}"${extraAttrs(xml, el, COLUMN_ATTRS)}>` +
            current +
            `</${p}filterColumn>`
        })
    }
  }
  for (const [id, body] of criteria)
    retained.push({ id, text: tag(p + 'filterColumn', { colId: id }, body) })
  const sortHasExtensions =
    previousSort && [...children(xml, previousSort)].some((el) => el.name !== p + 'sortCondition')
  if (sortHasExtensions && (filter.sortState === null || !sameRange))
    throw new RulesRefused('This Excel filter sort has extension data that must stay in place.')
  const sort = filter.sortState
    ? sortXml(part, filter.sortState, box, previousSort)
    : filter.sortState === undefined && sameRange && previousSort
      ? elementText(xml, previousSort)
      : ''
  const extras = oldChildren
    .filter((el) => el.name !== p + 'filterColumn' && el.name !== p + 'sortState')
    .map((el) => elementText(xml, el))
    .join('')
  const body = retained.map(({ text }) => text).join('') + sort + extras
  const opening = `<${p}autoFilter ref="${boxRef(box)}"${old ? extraAttrs(xml, old, FILTER_ATTRS) : ''}`
  return body ? opening + '>' + body + `</${p}autoFilter>` : opening + '/>'
}

export function readSort(part: RulePart, filter: ElementSpan): FilterSortState | undefined {
  const { xml, prefix: p } = part
  const state = [...children(xml, filter)].find((node) => node.name === p + 'sortState')
  if (!state) return undefined
  const opening = openTag(xml, state)
  const asRange = (ref: string): IRange => {
    const box = filterBox(ref)
    return {
      startRow: box.r1 - 1,
      endRow: box.r2 - 1,
      startColumn: box.c1 - 1,
      endColumn: box.c2 - 1
    }
  }
  const ref = valueOf(opening, 'ref')
  if (!ref) return undefined
  const conditions: FilterSortState['conditions'][number][] = []
  for (const node of children(xml, state)) {
    if (node.name !== p + 'sortCondition') continue
    const tag = openTag(xml, node)
    const range = valueOf(tag, 'ref')
    if (!range || !['value', undefined].includes(valueOf(tag, 'sortBy'))) return undefined
    const condition: FilterSortState['conditions'][number] = { ref: asRange(range) }
    if (isOn(valueOf(tag, 'descending'))) condition.descending = true
    const list = valueOf(tag, 'customList')
    if (list !== undefined) condition.customList = list
    conditions.push(condition)
  }
  const result: FilterSortState = { ref: asRange(ref), conditions }
  if (isOn(valueOf(opening, 'caseSensitive'))) result.caseSensitive = true
  if (isOn(valueOf(opening, 'columnSort'))) result.columnSort = true
  const method = valueOf(opening, 'sortMethod')
  if (method === 'stroke' || method === 'pinYin' || method === 'none') result.sortMethod = method
  return result
}

function filterRows(rows: readonly number[], range: Box | undefined) {
  for (const row of rows) {
    if (!range || !Number.isInteger(row) || row < range.r1 || row >= range.r2)
      throw new RulesRefused(
        'A hidden filter row must be inside the filter range below its header.'
      )
  }
  return [...new Set(rows)].sort((a, b) => a - b)
}

function filteredRows(
  part: RulePart,
  hidden: readonly number[],
  previous: readonly number[]
): number[] {
  if (!hidden.length && !previous.length) return []
  const { xml, prefix: p, changes } = part
  const data = part.first('sheetData')
  if (!data) throw new RulesRefused('The worksheet is missing its sheet data.')
  const wasOurs = new Set(previous.map((r) => r + 1))
  const wanted = hidden.map((r) => r + 1)
  const lastChanged = Math.max(
    wanted.at(-1) ?? 0,
    previous.length ? previous[previous.length - 1] + 1 : 0
  )
  const owned: number[] = []
  let cursor = 0
  const insert = (before: number, at: number) => {
    const text: string[] = []
    while (cursor < wanted.length && wanted[cursor] < before) {
      const row = wanted[cursor++]
      text.push(tag(p + 'row', { r: row, hidden: 1 }))
      owned.push(row - 1)
    }
    if (!text.length) return
    if (data.openEnd === data.end)
      part.replace(data, withBody(openTag(xml, data), data.name, text.join('')))
    else changes.push({ start: at, end: at, text: text.join('') })
  }
  let last = 0
  let end = data.close
  for (const row of children(xml, data)) {
    if (row.name !== p + 'row') {
      end = row.start
      break
    }
    const opening = openTag(xml, row)
    const number = Number(valueOf(opening, 'r') ?? last + 1)
    last = number
    insert(number, row.start)
    if (number > lastChanged) return owned
    const hide = wanted[cursor] === number
    const old = isOn(valueOf(opening, 'hidden'))
    const ours = wasOurs.has(number)
    let updated = opening
    if (hide) {
      cursor++
      if (!old || ours) owned.push(number - 1)
      if (!old) updated = setAttrInTag(opening, 'hidden', '1')
    } else if (ours && old) updated = removeAttrInTag(opening, 'hidden')
    if (updated !== opening) changes.push({ start: row.start, end: row.openEnd, text: updated })
  }
  insert(lastChanged + 1, end)
  return owned
}

function filterState(part: RulePart, filtered: readonly number[], owned: readonly number[]) {
  const { xml, prefix: p } = part
  const ext = part.first('extLst')
  const state =
    ext &&
    [...children(xml, ext)].find(
      (el) => el.name === p + 'ext' && valueOf(openTag(xml, el), 'uri') === FILTER_STATE_URI
    )
  // The empty marker still distinguishes a live filter with no filtered rows from a legacy filter.
  const record = tag(
    p + 'ext',
    { uri: FILTER_STATE_URI },
    tag('tc:filterState', {
      'xmlns:tc': 'urn:tempcode:spreadsheet-filter-state',
      filtered: filtered.join(' '),
      owned: owned.join(' ')
    })
  )
  return { ext, state, record }
}

function writeFilterState(
  part: RulePart,
  live: boolean,
  filtered: readonly number[],
  owned: readonly number[]
) {
  const { ext, state, record } = filterState(part, filtered, owned)
  const { xml, prefix: p } = part
  if (state && ext) {
    if (live) part.replace(state, record)
    else if (
      inner(xml, ext)
        .slice(0, state.start - ext.openEnd)
        .trim() ||
      xml.slice(state.end, ext.close).trim()
    )
      part.replace(state, '')
    else part.replace(ext, '')
  } else if (live && ext) {
    if (ext.openEnd === ext.end) part.replace(ext, withBody(openTag(xml, ext), ext.name, record))
    else part.changes.push({ start: ext.close, end: ext.close, text: record })
  } else if (live) part.add('extLst', tag(p + 'extLst', {}, record))
}

export function filter(
  part: RulePart,
  model: SheetFilter | null,
  tableRanges: () => Box[],
  previousFilteredOut?: readonly number[]
): Box | undefined {
  const { xml, prefix: p } = part
  const old = part.first('autoFilter')
  const oldRef = old && valueOf(openTag(xml, old), 'ref')
  const previous = oldRef ? filterBox(oldRef) : undefined
  const range = model ? gridBox(model.ref) : previous
  if (range && tableRanges().some((table) => overlaps(table, range)))
    throw new RulesRefused(
      'This filter overlaps an Excel table. Change the table’s filter in Excel.'
    )
  if (model && range) {
    const sameRange = !!previous && boxRef(previous) === boxRef(range)
    const text = filterXml(part, model, range, old, sameRange)
    if (old) {
      const original = elementText(xml, old)
      if (xmlKey(original) !== xmlKey(text)) part.replace(old, text)
    } else part.add('autoFilter', text)
  } else if (old) {
    if (
      [...children(xml, old)].some(
        (el) =>
          el.name === p + 'extLst' ||
          (el.name === p + 'sortState' &&
            [...children(xml, el)].some((child) => child.name === p + 'extLst')) ||
          (el.name === p + 'filterColumn' &&
            [...children(xml, el)].some((child) => child.name === p + 'extLst'))
      )
    )
      throw new RulesRefused('This filter has Excel extension data and cannot be removed here.')
    part.replace(old, '')
  }
  const stored = part.first('extLst')
  const oldState = stored && filterHiddenState(elementText(xml, stored))
  const previousRows = filterRows(oldState?.owned ?? previousFilteredOut ?? [], previous)
  const hidden = filterRows(model?.cachedFilteredOut ?? [], range)
  const owned = filteredRows(part, hidden, previousRows)
  // Keep a native filter with no hidden rows byte-stable until this writer actually needs state.
  if (oldState || hidden.length || previousRows.length || (model && !old))
    writeFilterState(part, model !== null, hidden, owned)
  return model ? range : undefined
}
