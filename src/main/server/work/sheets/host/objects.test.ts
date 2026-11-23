import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IWorkbookData } from '@univerjs/core'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { headlessSheet, readObjectsResource } from 'work-kit/sheet/engine'
import type { ObjectChange } from 'work-kit/sheet'
import type { ChartSpec, ObjectAnchor } from 'work-kit/sheet/xlsx'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { RULES_SET } from '@shared/work/sheets'
// (the kit's objects store is not among its exports: the grid makes it; a test reaches it by its file)
import { createObjects } from '../../../../../../node_modules/work-kit/src/sheet/objects/access'
import { TcsheetBackend } from './backends'
import { SheetHost } from './host'
import { GUEST_OPS, refusal } from './live'
import { MEDIA_RESOURCE, mediaOf } from './objects'
import { writeXlsxWhole } from '../writer'
import { readMedia, readObjects } from 'work-kit/sheet/xlsx'
import type { SheetRef } from './wire'

/**
 * Charts and pictures on a sheet the service holds (a `.tcsheet` over a real file): a tab's list
 * as the canvas sends it is kept beside the engine and in every snapshot the host serves or cuts,
 * a cold host has it, rows put in by someone else carry it, a made picture's bytes travel in the
 * sheet's own snapshot, a restore brings a revision's objects back, and a guest sends none.
 */

const scratch = mkdtempSync(join(tmpdir(), 'sheet-objects-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const hosts: SheetHost[] = []
afterEach(() => {
  for (const h of hosts.splice(0)) h.close()
})
const U = 'workbook'
const S = 'sheet1'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
let n = 0
function store(): { ref: SheetRef; host: () => SheetHost } {
  const path = join(scratch, `${++n}.tcsheet`)
  TcsheetBackend.create(path, 'Budget')
  return {
    ref: { tcsheet: path },
    host: () => {
      const h = new SheetHost(() => new TcsheetBackend(path))
      hosts.push(h)
      return h
    }
  }
}

const at = (row: number): ObjectAnchor => ({ kind: 'oneCell', from: { column: 3, row, columnOffset: 0, rowOffset: 0 }, width: 4572000, height: 2743200 })
const chart = (row = 2, title = 'Spending'): ChartSpec => ({
  id: 'chart-ab12cd34',
  sheet: 'Sheet1',
  anchor: at(row),
  kind: 'column',
  grouping: 'clustered',
  groups: [{ kind: 'column', grouping: 'clustered' }],
  title: { text: title },
  legend: null,
  axes: {},
  series: [{ kind: 'column', group: 0, values: { ref: 'Sheet1!$B$2:$B$7' } }],
  flags: {}
})
const charts = (list: ChartSpec[]): SheetMutationJson => ({ id: RULES_SET, params: { unitId: U, kind: 'charts', subUnitId: S, list } })
const picture = (row: number, data?: string) => ({ id: 'picture-1', sheet: 'Sheet1', anchor: at(row), part: 'media:pic1', contentType: 'image/png', name: 'Logo', ...(data ? { data } : {}) })
const pictures = (list: unknown[]): SheetMutationJson => ({ id: RULES_SET, params: { unitId: U, kind: 'pictures', subUnitId: S, list } })

const snapshotOf = async (host: SheetHost, ref: SheetRef) => JSON.parse((await host.snapshotJson(ref)).json) as IWorkbookData
const objectsOf = async (host: SheetHost, ref: SheetRef) => readObjectsResource(await snapshotOf(host, ref))
const apply = async (host: SheetHost, ref: SheetRef, mutations: SheetMutationJson[], by = 'owner'): Promise<number> => {
  const got = await host.apply(ref, (await host.open(ref)).rev, mutations, by)
  if ('conflict' in got) throw new Error('conflict')
  return got.rev
}

describe('charts and pictures on a sheet the service holds', () => {
  it('keeps a tab\'s chart list beside the engine and in the snapshot it serves, through a cold load', async () => {
    const s = store()
    const host = s.host()
    await apply(host, s.ref, [charts([chart()])])
    expect((await objectsOf(host, s.ref))?.charts).toEqual([chart()])
    // A cold host reads the file again: the op log replays it.
    expect((await objectsOf(s.host(), s.ref))?.charts).toEqual([chart()])
    // A second change replaces the tab's list; an empty list takes them all away.
    await apply(host, s.ref, [charts([chart(2, 'Rent')])])
    expect((await objectsOf(s.host(), s.ref))?.charts.map((c) => c.title?.text)).toEqual(['Rent'])
    await apply(host, s.ref, [charts([])])
    expect(await objectsOf(s.host(), s.ref)).toBeNull()
    // Each is a revision of its own, said as an opened Excel file says it.
    expect((await host.history(s.ref)).revisions.slice(0, 3).map((r) => r.label)).toEqual(['Chart', 'Chart', 'Chart'])
  })

  it('the canvas catches up from the op the list rides in', async () => {
    const s = store()
    const host = s.host()
    const rev = (await host.open(s.ref)).rev
    await apply(host, s.ref, [charts([chart()])])
    const since = await host.since(s.ref, rev)
    expect('ops' in since && since.ops.flatMap((op) => op.mutations)).toEqual([charts([chart()])])
  })

  it('rows someone else puts in or takes out carry the charts; the owner\'s own grid sends its own list after its rows', async () => {
    const s = store()
    const host = s.host()
    await apply(host, s.ref, [charts([chart(4)])])
    // An agent's (or another editor's) row put in above the chart, as the grid's mutation.
    const insert: SheetMutationJson = { id: 'sheet.mutation.insert-row', params: { unitId: U, subUnitId: S, range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 25 } } }
    await apply(host, s.ref, [insert], 'agent:local:t1')
    const moved = (await objectsOf(s.host(), s.ref))!.charts[0]!
    expect(moved.anchor.kind === 'oneCell' && moved.anchor.from.row).toBe(6)
    expect(moved.series[0]!.values.ref).toBe('Sheet1!$B$4:$B$9')
    // The owner's grid: its rows, then the list as its own grid holds it (the truth, laid after the move).
    const remove: SheetMutationJson = { id: 'sheet.mutation.remove-rows', params: { unitId: U, subUnitId: S, range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 25 } } }
    await apply(host, s.ref, [remove, charts([chart(4)])])
    expect((await objectsOf(s.host(), s.ref))!.charts).toEqual([chart(4)])
  })

  it('follows the rows the kit\'s own grid moves its objects by: the host and the grid agree', async () => {
    const s = store()
    const host = s.host()
    const book = await snapshotOf(host, s.ref)
    const grid = headlessSheet('univer', book)
    const held = createObjects(grid.api, () => false, {})
    held.access.edits(true)
    const told: ObjectChange[] = []
    held.access.onChange((change) => told.push(change))
    held.access.add({ chart: chart(4) })
    await apply(host, s.ref, [charts(held.access.list().charts)])
    // Rows put in by someone else land on this grid as ops from elsewhere; the kit follows them, and so does the host.
    const insert: SheetMutationJson = { id: 'sheet.mutation.insert-row', params: { unitId: grid.workbook.getId(), subUnitId: S, range: { startRow: 1, endRow: 3, startColumn: 0, endColumn: 25 } } }
    grid.api.syncExecuteCommand(insert.id, insert.params as object, { fromCollab: true })
    expect(told.at(-1)?.cause).toBe('cells')
    await apply(host, s.ref, [{ ...insert, params: { ...(insert.params as object), unitId: U } }], 'agent:local:t1')
    expect((await objectsOf(s.host(), s.ref))!.charts).toEqual(held.access.list().charts)
    grid.dispose()
  })

  it('keeps a made picture\'s bytes in the sheet\'s own snapshot, by its part, and only while it is drawn', async () => {
    const s = store()
    const host = s.host()
    await apply(host, s.ref, [pictures([picture(2, PNG.toString('base64'))])])
    const cold = await snapshotOf(s.host(), s.ref)
    // The list keeps the part, never the bytes; the bytes ride beside it.
    expect(readObjectsResource(cold)?.pictures).toEqual([picture(2)])
    expect(Buffer.from(mediaOf(cold).get('media:pic1')!.data, 'base64').equals(PNG)).toBe(true)
    expect(mediaOf(cold).get('media:pic1')!.type).toBe('image/png')
    // Moved: no bytes sent again, and they stay.
    await apply(host, s.ref, [pictures([picture(5)])])
    expect(mediaOf(await snapshotOf(s.host(), s.ref)).has('media:pic1')).toBe(true)
    // Taken out: the snapshot no longer carries them.
    await apply(host, s.ref, [pictures([])])
    expect((await snapshotOf(s.host(), s.ref)).resources?.some((r) => r.name === MEDIA_RESOURCE)).toBe(false)
  })

  it('refuses in words a picture that is no picture, one too large, and a part the grid does not give', async () => {
    const s = store()
    const host = s.host()
    await expect(apply(host, s.ref, [pictures([picture(2, Buffer.from('not a picture').toString('base64'))])])).rejects.toThrow('That picture is not a PNG, JPEG, GIF or BMP.')
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])
    await expect(apply(host, s.ref, [pictures([picture(2, big.toString('base64'))])])).rejects.toThrow('A picture can be at most 5 MB here.')
    await expect(apply(host, s.ref, [pictures([{ ...picture(2, PNG.toString('base64')), part: '../../etc/passwd' }])])).rejects.toThrow('A picture made here carries its bytes under its own part.')
    expect(await objectsOf(s.host(), s.ref)).toBeNull()
  })

  it('a restore brings a revision\'s charts and pictures back, a removed picture with its bytes', async () => {
    const s = store()
    const host = s.host()
    const kept = await apply(host, s.ref, [charts([chart(2, 'Spending')]), pictures([picture(3, PNG.toString('base64'))])])
    await apply(host, s.ref, [charts([chart(9, 'Changed')])])
    await apply(host, s.ref, [pictures([])])
    await host.restore(s.ref, kept, 'owner')
    const back = await snapshotOf(s.host(), s.ref)
    expect(readObjectsResource(back)?.charts).toEqual([chart(2, 'Spending')])
    expect(readObjectsResource(back)?.pictures).toEqual([picture(3)])
    expect(Buffer.from(mediaOf(back).get('media:pic1')!.data, 'base64').equals(PNG)).toBe(true)
  })

  it('a guest sends no chart or picture: the live route refuses the list, and lets an editor\'s through', () => {
    expect(GUEST_OPS.has(RULES_SET)).toBe(false)
    expect(refusal([charts([chart()])], 'edit', true)).toBe('a guest cannot tempcode.sheet.rules')
    expect(refusal([pictures([picture(2, PNG.toString('base64'))])], 'edit', true)).toBe('a guest cannot tempcode.sheet.rules')
    expect(refusal([charts([chart()])], 'edit', false)).toBeNull()
  })

  it('the Excel export writes them as real charts and pictures, a made picture from the bytes the sheet keeps, and says what it leaves out', async () => {
    const s = store()
    const host = s.host()
    await apply(host, s.ref, [charts([chart()]), pictures([picture(3, PNG.toString('base64')), { ...picture(6), id: 'picture-2', part: 'media:gone' }])])
    const { bytes, left } = writeXlsxWhole(await snapshotOf(host, s.ref))
    const file = readObjects(bytes)
    expect(file.charts.map((c) => [c.sheet, c.kind, c.title?.text])).toEqual([['Sheet1', 'column', 'Spending']])
    expect(file.pictures).toHaveLength(1)
    expect(Buffer.from(readMedia(bytes, file.pictures[0]!.part)!).equals(PNG)).toBe(true)
    // the picture whose image the sheet does not keep is said, not written
    expect(left).toEqual([{ what: 'pictures', sheet: 'Sheet1', why: 'A picture whose image this sheet does not keep is left out.' }])
  })
})
