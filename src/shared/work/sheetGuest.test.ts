import { describe, expect, it } from 'vitest'
import { cutFix, guestCells, typedCells } from './sheetGuest'

const SET = 'sheet.mutation.set-range-values'
const set = (cellValue: Record<string, unknown>) => ({ id: SET, params: { unitId: 'u', subUnitId: 's', cellValue } })

describe('a page\'s cell write, cut to what the sheet keeps', () => {
  it('a guest\'s cut is the same cut the second time: what the page sends is what the service commits', () => {
    const made = [set({ 0: { 0: { v: 'a', t: 1, p: { body: {} }, custom: { x: 1 }, s: { bl: 1, k1: 1, long: 'x'.repeat(300) } }, 1: { f: '=_xlfn.XLOOKUP(1,A:A,B:B)' } }, '-1': { 0: { v: 1 } } })]
    const once = guestCells(made)
    expect(guestCells(once)).toEqual(once)
    expect(once[0].params.cellValue).toEqual({ 0: { 0: { v: 'a', t: 1, s: { bl: 1 } }, 1: { f: '=XLOOKUP(1,A:A,B:B)' } } })
  })

  it('a value with no type takes the grid\'s, and one with a type or a formula is left', () => {
    const m = set({ 2: { 3: { v: '6' }, 4: { v: 6, t: 2 }, 5: { f: '=A1', v: 1 }, 6: null, 7: { v: null } } })
    const typed = typedCells(m, (sheet, row, column) => (sheet === 's' && row === 2 && column === 3 ? 1 : null))
    expect(typed.params.cellValue).toEqual({ 2: { 3: { v: '6', t: 1 }, 4: { v: 6, t: 2 }, 5: { f: '=A1', v: 1 }, 6: null, 7: { v: null } } })
    // Nothing to type: the mutation itself comes back.
    expect(typedCells(typed, () => 1)).toBe(typed)
  })

  it('the grid lays only the cells the cut changed, with the dropped keys cleared', () => {
    const made = set({ 0: { 0: { p: { body: { dataStream: 'hi\r\n' } }, s: 'x1' }, 1: { v: 1, t: 2 } }, 1: { 0: null } })
    const sent = set({ 0: { 0: { v: 'hi', t: 1, s: 'x1' }, 1: { v: 1, t: 2 } }, 1: { 0: null } })
    expect(cutFix(made, sent)?.params.cellValue).toEqual({ 0: { 0: { p: null, v: 'hi', t: 1, s: 'x1' } } })
    expect(cutFix(made, made)).toBeNull()
    expect(cutFix(sent, set({ 0: { 0: { v: 'hi', t: 1, s: 'x1' }, 1: { v: 1, t: 2 } }, 1: { 0: null } }))).toBeNull()
    expect(cutFix({ id: 'sheet.mutation.insert-row', params: {} }, { id: 'sheet.mutation.insert-row', params: { a: 1 } })).toBeNull()
  })
})
