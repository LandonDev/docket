import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashCells } from 'work-kit/sheet/source'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import type { WorkCtx } from '../modules'
import { heldOf, storeKey } from '../sheets/held'
import { ensureSuggestionTables, SuggestionStore } from '../sheets/suggestions'
import { oneReview } from '../sheets/index'
import { GOOGLE_MIME } from './client'
import { FakeGoogle, FAKE_TOKEN_URL } from './fake'
import { ensureGoogleTables, resetGoogle, setGoogleDeps } from './google'
import { edit, googleSource, revOf, review, snapshot, suggest, unfollowAll, type GoogleSheetRef } from './grid'

/** A Google Sheet in our grid: read, his edits compared and written, an agent's suggestions accepted as one write. */
const ME = 'landon@example.com'
let fake: FakeGoogle
let ctx: WorkCtx
const ref: GoogleSheetRef = { account: ME, fileId: 'sh1', name: 'Budget' }
const set = (sheet: string, cells: Record<string, unknown>): SheetMutationJson =>
  ({ id: 'sheet.mutation.set-range-values', params: { unitId: 'u', subUnitId: sheet, cellValue: cells } }) as unknown as SheetMutationJson
const writes = () => fake.calls.filter((c) => c.endsWith('values:batchUpdate')).length
const cells = () => fake.files.get('sh1')!.sheet!.tabs[0].cells

beforeEach(() => {
  fake = new FakeGoogle().account(ME)
  fake.addSheet(ME, 'sh1', 'Budget', [{ sheetId: 0, title: 'Q1', cells: [['Item', 'Cost'], ['Rent', 1200], ['Food', 300], ['Total', '=B2+B3']] }])
  const db = new DatabaseSync(':memory:')
  ensureGoogleTables(db)
  ensureSuggestionTables(db)
  ctx = { db, host: 'env_box', dataDir: '/tmp', log: () => {}, lifeos: { jwt: async () => fake.jwt } } as unknown as WorkCtx
  setGoogleDeps({ fetch: fake.fetch, tokenUrl: FAKE_TOKEN_URL })
})
afterEach(() => {
  resetGoogle()
  unfollowAll()
})

describe('a Google Sheet in the grid', () => {
  it('is held by the google pillar, its suggestions under google:<fileId>', () => {
    const held = heldOf({ source: { at: 'google', account: ME, fileId: 'sh1', mime: GOOGLE_MIME.sheet }, title: 'Budget' })
    expect(held).toEqual({ at: 'google', ref })
    expect(storeKey(held)).toBe('google:sh1')
  })

  it('loads as a snapshot with formulas and values, sheet ids by tab name', async () => {
    const wb = JSON.parse((await snapshot(ctx, ref, revOf(ref))).toString())
    expect(wb.sheetOrder).toEqual(['Q1'])
    expect(wb.sheets.Q1.cellData[1]).toEqual({ 0: { v: 'Rent' }, 1: { v: 1200 } })
    expect(wb.sheets.Q1.cellData[3][1].f).toBe('=B2+B3')
  })

  it('writes his edit after comparing, as one batch', async () => {
    await snapshot(ctx, ref, revOf(ref))
    const got = await edit(ctx, ref, revOf(ref), [set('Q1', { 1: { 1: { v: 1300 } }, 2: { 1: { v: 350 } } })], 'owner')
    expect(got).toEqual({ rev: 2 })
    expect(writes()).toBe(1)
    expect([cells()[1][1], cells()[2][1]]).toEqual([1300, 350])
  })

  it('refuses his edit over a cell someone changed in Google, and writes nothing', async () => {
    await snapshot(ctx, ref, revOf(ref))
    cells()[1][1] = 999
    const got = await edit(ctx, ref, revOf(ref), [set('Q1', { 1: { 1: { v: 1300 } }, 2: { 1: { v: 350 } } })], 'owner')
    expect(got).toMatchObject({ conflict: true })
    expect(writes()).toBe(0)
    expect(cells()[2][1]).toBe(300)
  })

  it('writes an accepted change set as one update, and leaves a cell changed since as a conflict', async () => {
    const { changeSet } = await suggest(ctx, ref, 'agent:env_box:t1', 'tidy', [
      { sheet: 'Q1', row: 1, col: 1, value: { v: 1250 } },
      { sheet: 'Q1', row: 2, col: 1, value: { v: 320 } },
      { sheet: 'Q1', row: 4, col: 0, value: { v: 'Note' } }
    ])
    cells()[2][1] = 310
    const done = await review(ctx, ref, { changeSet }, 'accept')
    expect(done).toEqual({ written: 2, conflicts: 1 })
    expect(writes()).toBe(1)
    expect(cells()[1][1]).toBe(1250)
    expect(cells()[4][0]).toBe('Note')
    expect(new SuggestionStore(ctx.db).open('google:sh1').map((s) => [s.row, s.state])).toEqual([[2, 'conflict']])
  })

  it('settles one review of a sheet at a time: a Reject sent while an Accept waits on Google is never undone by its write', async () => {
    const key = 'google:sh1'
    const { changeSet } = await suggest(ctx, ref, 'agent:env_box:t1', 'tidy', [{ sheet: 'Q1', row: 1, col: 1, value: { v: 1250 } }])
    // Accept, then Reject from another window before Google answers: the Reject waits for the Accept, and finds it settled.
    const accept = oneReview(key, () => review(ctx, ref, { changeSet }, 'accept'))
    const reject = oneReview(key, () => review(ctx, ref, { changeSet }, 'reject'))
    await Promise.all([accept, reject])
    expect(writes()).toBe(1)
    // Written and so accepted: never a row marked rejected whose words are in Google.
    expect(ctx.db.prepare('SELECT state FROM work_sheets_suggestions WHERE store = ? AND change_set = ?').all(key, changeSet)).toEqual([{ state: 'accepted' }])
    // Reject first, then Accept: the Accept picks after the Reject settled, and writes nothing.
    const again = await suggest(ctx, ref, 'agent:env_box:t1', 'tidy', [{ sheet: 'Q1', row: 2, col: 1, value: { v: 999 } }])
    await Promise.all([oneReview(key, () => review(ctx, ref, { changeSet: again.changeSet }, 'reject')), oneReview(key, () => review(ctx, ref, { changeSet: again.changeSet }, 'accept'))])
    expect(writes()).toBe(1)
    expect(cells()[2][1]).toBe(300)
    // Two Accepts at once write the rows once.
    const twice = await suggest(ctx, ref, 'agent:env_box:t1', 'tidy', [{ sheet: 'Q1', row: 4, col: 0, value: { v: 'Note' } }])
    const both = await Promise.all([oneReview(key, () => review(ctx, ref, { changeSet: twice.changeSet }, 'accept')), oneReview(key, () => review(ctx, ref, { changeSet: twice.changeSet }, 'accept'))])
    expect(both.map((b) => b.written)).toEqual([1, 0])
    expect(writes()).toBe(2)
  })

  it("writes an approved cell only where it stood: a row inserted above, or a tab replaced under its title, makes it a conflict", async () => {
    cells().push(['Misc', null], ['Spare', null])
    // Misc's cost (B6) is blank, and he approves 80 there.
    const { changeSet } = await suggest(ctx, ref, 'agent:env_box:t1', 'tidy', [{ sheet: 'Q1', row: 4, col: 1, value: { v: 80 } }])
    // A co-author inserts a row with a blank cost above Misc: the cell at that address is still blank, but it is Extra's.
    cells().splice(4, 0, ['Extra', null])
    expect(await review(ctx, ref, { changeSet }, 'accept')).toEqual({ written: 0, conflicts: 1 })
    expect(writes()).toBe(0)
    // A tab of the same title made again, its cells alike: another tab.
    const again = await suggest(ctx, ref, 'agent:env_box:t1', 'tidy', [{ sheet: 'Q1', row: 5, col: 1, value: { v: 80 } }])
    fake.files.get('sh1')!.sheet!.tabs[0] = { ...fake.files.get('sh1')!.sheet!.tabs[0]!, sheetId: 77 }
    expect(await review(ctx, ref, { changeSet: again.changeSet }, 'accept')).toEqual({ written: 0, conflicts: 1 })
    expect(writes()).toBe(0)
    // Where it stood, with an edit elsewhere in its column since: written.
    const third = await suggest(ctx, ref, 'agent:env_box:t1', 'tidy', [{ sheet: 'Q1', row: 5, col: 1, value: { v: 80 } }])
    cells()[1]![1] = 1250
    expect(await review(ctx, ref, { changeSet: third.changeSet }, 'accept')).toEqual({ written: 1, conflicts: 0 })
    expect(cells()[5]).toEqual(['Misc', 80])
  })

  it('gives each suggestion its own id, two in the same millisecond on the same cell included', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    try {
      const a = await suggest(ctx, ref, 'agent:env_box:t1', 'tidy', [{ sheet: 'Q1', row: 1, col: 1, value: { v: 1 } }])
      const b = await suggest(ctx, ref, 'agent:env_box:t1', 'tidy', [{ sheet: 'Q1', row: 1, col: 1, value: { v: 2 } }])
      expect(a.changeSet).not.toBe(b.changeSet)
      const rows = ctx.db.prepare('SELECT change_set, proposed, state FROM work_sheets_suggestions WHERE store = ?').all('google:sh1') as { change_set: string; proposed: string; state: string }[]
      expect(rows.map((r) => [r.change_set === a.changeSet ? 'a' : 'b', r.proposed, r.state]).sort()).toEqual([['a', '{"v":1}', 'rejected'], ['b', '{"v":2}', 'pending']])
    } finally {
      now.mockRestore()
    }
  })

  it('is a SheetSource: reads with a hash, writes against it, refuses a stale base', async () => {
    const src = googleSource(ctx, ref)
    expect(src.capabilities.formulas).toBe('store')
    const block = await src.read({ sheet: 'Q1', startRow: 1, startColumn: 1, endRow: 2, endColumn: 1 })
    expect(block.cells).toEqual([[{ v: 1200 }], [{ v: 300 }]])
    const at = [
      { sheet: 'Q1', row: 1, column: 1, cell: { v: 1 } },
      { sheet: 'Q1', row: 2, column: 1, cell: { v: 2 } }
    ]
    await expect(src.write(at, hashCells([{ v: 0 }, { v: 0 }]))).resolves.toBe('conflict')
    await expect(src.write(at, block.hash)).resolves.toBe('ok')
    expect([cells()[1][1], cells()[2][1]]).toEqual([1, 2])
  })
})
