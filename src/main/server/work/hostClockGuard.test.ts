import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { dayOf, hisZone, timeIn, workClock } from './clock'

const WORK = import.meta.dirname
const SKIP = new Set(['fixture', 'fixtures', '__fixtures__', 'proof', 'proofs'])
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (SKIP.has(e.name) ? [] : files(join(dir, e.name))) : /(?<!\.test)\.[cm]?tsx?$/.test(e.name) ? [join(dir, e.name)] : []
  )

const localMethods = new Set(['toLocaleTimeString', 'toLocaleDateString', 'toTimeString', 'toDateString', 'getHours', 'getMinutes', 'getDate', 'getDay', 'getMonth', 'getFullYear', 'toLocaleString'])

const allowed: { file: string; call: RegExp; reason: string }[] = [
  { file: 'clock.ts', call: /^Intl\.DateTimeFormat\(\)$/, reason: 'Discover the host zone for the last fallback' },
  { file: 'files/write.ts', call: /^most\.toLocaleString\('en'\)$/, reason: 'Folder item limit' },
  { file: 'google/grid.ts', call: /^GOOGLE_MAX_CELLS\.toLocaleString\('en-US'\)$/, reason: 'Google cell limit' },
  { file: 'office/excel.ts', call: /^EXCEL_MAX_CELLS\.toLocaleString\('en-US'\)$/, reason: 'Excel read cell limit' },
  { file: 'office/tools.ts', call: /^EXCEL_MAX_CELLS\.toLocaleString\('en-US'\)$/, reason: 'Excel read and write cell limits' },
  { file: 'sheets/compose.ts', call: /^FORMAT_MAX_CELLS\.toLocaleString\('en'\)$/, reason: 'Format cell limit' },
  { file: 'sheets/excelWaits.ts', call: /^n\.toLocaleString\('en-US'\)$/, reason: 'Count of unsupported changes' },
  { file: 'sheets/host/guest.ts', call: /^(ROWS|COLUMNS|GUEST_CELLS_MAX|AUTO_ROWS_MAX|GUEST_SPAN_MAX)\.toLocaleString\('en'\)$/, reason: 'Guest sheet size and edit limits' },
  { file: 'sheets/host/host.ts', call: /^READ_MAX_CELLS\.toLocaleString\('en'\)$/, reason: 'Sheet read cell limit' },
  { file: 'sheets/host/live.ts', call: /^(AUTO_ROWS_MAX|FORMULA_MAX|CELL_TEXT_MAX)\.toLocaleString\('en'\)$/, reason: 'Live row and cell text limits' },
  { file: 'sheets/jobs.ts', call: /^READ_MAX_CELLS\.toLocaleString\('en'\)$/, reason: 'Sheet job read cell limit' },
  { file: 'sheets/patch/charts-model.ts', call: /^MAX_POINTS\.toLocaleString\('en-US'\)$/, reason: 'Chart point limit' },
  { file: 'sheets/preview.ts', call: /^(to|count)\.toLocaleString\('en-US'\)$/, reason: 'Print page counts' },
  { file: 'sheets/previewFacts.ts', call: /^value\.toLocaleString\('en-US'\)$/, reason: 'Numeric preview facts' },
  { file: 'sheets/tools.ts', call: /^FORMAT_MAX_CELLS\.toLocaleString\('en'\)$/, reason: 'Agent format cell limit' }
]

const hasZone = (arg: ts.Expression | undefined): boolean => !!arg && ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => {
  if (ts.isShorthandPropertyAssignment(p)) return p.name.text === 'timeZone'
  if (!ts.isPropertyAssignment(p) || (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name))) return false
  return p.name.text === 'timeZone' && p.initializer.getText() !== 'undefined'
})

function needsZone(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return false
  const member = node.expression
  if (!ts.isPropertyAccessExpression(member) && !ts.isElementAccessExpression(member)) return false
  const name = ts.isPropertyAccessExpression(member) ? member.name.text : ts.isStringLiteral(member.argumentExpression) ? member.argumentExpression.text : ''
  if (name === 'DateTimeFormat' && member.expression.getText() === 'Intl') return !hasZone(node.arguments?.[1])
  return localMethods.has(name)
}

describe('the Work host clock', () => {
  it("uses the owner's cached zone for dates and named times on an Eastern host", () => {
    const clock = workClock('America/New_York')
    const ctx = { clock }
    const morning = Date.UTC(2026, 10, 24, 14)
    const midnight = Date.UTC(2026, 10, 24, 5, 30)
    expect(timeIn(hisZone(ctx), morning, 'named')).toBe('9:00 AM Eastern')
    clock.set('desktop', 'America/Denver')
    expect(hisZone(ctx)).toBe('America/Denver')
    clock.set('lifeos', 'America/Chicago')
    expect(timeIn(hisZone(ctx), morning, 'named')).toBe('8:00 AM Central')
    expect(dayOf(hisZone(ctx), midnight)).toBe('2026-11-23')
    clock.set('lifeos', 'Invalid/Place')
    expect(hisZone(ctx)).toBe('America/Denver')
    clock.set('desktop', null)
    expect(dayOf(hisZone(ctx), midnight)).toBe('2026-11-24')
  })

  it('requires explicit zones for dates and keeps the exceptions current', () => {
    const hits: string[] = []
    const used = new Set<(typeof allowed)[number]>()
    for (const path of [...files(WORK), join(WORK, '../../../shared/work/clock.ts')]) {
      const file = relative(WORK, path)
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if (needsZone(node)) {
          const call = node.getText(source)
          const entry = allowed.find((a) => a.file === file && a.call.test(call))
          if (entry) used.add(entry)
          else hits.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${call}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    for (const a of allowed) if (!used.has(a)) hits.push(`Unused exception: ${a.file}: ${a.reason} (${a.call})`)
    expect(hits).toEqual([])
  })
})
