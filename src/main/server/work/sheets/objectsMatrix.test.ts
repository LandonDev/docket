import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { headlessSheet } from 'work-kit/sheet/engine'
import { importXlsx, readMedia, readObjects, type ChartSpec } from 'work-kit/sheet/xlsx'
import type { ObjectChange } from 'work-kit/sheet'
import { SHEET_ROW, type SheetMutationJson } from '@shared/contract-work-sheets'
import { isObjectList, latestRules, RULES_SET } from '@shared/work/sheets'
// (the kit's objects store is not among its exports: the grid makes it; a test reaches it by its file)
import { createObjects } from '../../../../../node_modules/work-kit/src/sheet/objects/access'
import { MadePictures, objectListOf, rekeyed } from '../../../../renderer/src/work/sheets/objects'
import { ensurePackageTables, PackageStore } from './packages'
import { budget, chart, place, series } from './patch/charts-testkit'
import { localJobs } from './workerClient'

/**
 * Charts and pictures in an opened Excel file, end to end, every part the real one:
 *
 *   1. the kit's own objects store makes the change on a headless Univer (`createObjects`, which the
 *      grid's layer and row call), and tells it as the canvas hears it;
 *   2. the canvas maps it to the tab's whole list (objects.ts `objectListOf`, as sync.ts sends it);
 *   3. the package store saves it into a real .xlsx (`PackageStore.edit`: the chart and picture writers);
 *   4. the file's own parts hold it (`readObjects`), and so does a cold import, which is what a grid
 *      opening the file again draws; the ids the save answers are taken by the store, so the next save
 *      names the same parts.
 */
const scratch = mkdtempSync(join(tmpdir(), 'sheets-objects-matrix-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))

let n = 0
async function opened(bytes: Uint8Array = budget()) {
  const path = join(scratch, `${++n}.xlsx`)
  writeFileSync(path, bytes)
  const db = new DatabaseSync(':memory:')
  ensurePackageTables(db)
  const store = new PackageStore(db, await localJobs(), join(scratch, `files-${n}`), () => null)
  await store.open(path)
  const { workbook, objects } = importXlsx(new Uint8Array(readFileSync(path)))
  const grid = headlessSheet('univer', workbook)
  const held = createObjects(grid.api, () => false, { initial: objects })
  held.access.edits(true)
  const made = new MadePictures()
  const told: ObjectChange[] = []
  held.access.onChange((change) => {
    made.take(change)
    told.push(change)
  })
  const sheetId = (name: string) => workbook.sheetOrder.find((id) => workbook.sheets[id]?.name === name)
  /** What the canvas sends for the changes since the last save: each the tab's whole list, once a tab. */
  const sent = (): SheetMutationJson[] => latestRules(told.splice(0).flatMap((change) => objectListOf(change, held.access.list(), sheetId, (part) => made.get(part)?.bytes) ?? []))
  const save = async () => {
    const mutations = sent()
    expect(mutations.length).toBeGreaterThan(0)
    expect(mutations.every(isObjectList)).toBe(true)
    const got = await store.edit(path, (await store.open(path)).rev, mutations, 'owner')
    if ('conflict' in got) throw new Error('conflict')
    // The canvas takes the file's ids (sync.ts `rekey`).
    if (got.ids) {
      made.rename(held.access.list(), got.ids)
      held.access.apply(rekeyed(held.access.list(), got.ids))
    }
    return got
  }
  const file = () => readObjects(new Uint8Array(readFileSync(path)))
  const cold = () => importXlsx(new Uint8Array(readFileSync(path))).objects
  return { path, store, objects: held.access, told, sent, save, file, cold }
}

const made = (id = 'chart-ab12cd34'): ChartSpec => ({ ...chart('column', [series('column', 'Rent'), series('column', 'Food')], { title: { text: 'Spending' }, legend: 'bottom' }), id, name: 'Chart 1' })

describe('charts and pictures in an opened Excel file', () => {
  it('lists Insert → Chart and Picture, and changing them, for an opened Excel file', () => {
    for (const control of ['chart', 'picture', 'objects'] as const) expect(SHEET_ROW.package).toContain(control)
  })

  it('writes a chart made on the grid as a real chart, and the grid takes the file\'s id', async () => {
    const s = await opened()
    expect(s.objects.add({ chart: made() })).toBe('chart-ab12cd34')
    const got = await s.save()
    const [written] = s.file().charts
    expect(written).toMatchObject({ sheet: 'Data', kind: 'column', title: { text: 'Spending' }, legend: 'bottom' })
    expect(written.id).toMatch(/^xl\/charts\/chart\d+\.xml$/)
    expect(written.series.map((x) => x.values.ref)).toEqual(['Data!$B$2:$B$7', 'Data!$C$2:$C$7'])
    expect(got.ids).toEqual({ 'chart-ab12cd34': { id: written.id } })
    // The grid now names it as the file does, so the next save changes that chart and makes no second one.
    expect(s.objects.list().charts.map((c) => c.id)).toEqual([written.id])
    expect(s.cold().charts.map((c) => [c.id, c.title?.text])).toEqual([[written.id, 'Spending']])
    expect(s.store.history(s.path)[0]).toMatchObject({ label: 'Chart', by: 'owner' })
  })

  it('changes a chart in place, moves it, and takes it out', async () => {
    const s = await opened()
    s.objects.add({ chart: made() })
    await s.save()
    const id = s.objects.list().charts[0]!.id
    s.objects.set(id, { title: { text: 'Rent and food' }, legend: 'right' })
    s.objects.move(id, place(2, 10))
    const got = await s.save()
    // Changed in place: the same part, nothing new to name.
    expect(got.ids).toBeUndefined()
    expect(s.file().charts).toHaveLength(1)
    expect(s.file().charts[0]).toMatchObject({ id, title: { text: 'Rent and food' }, legend: 'right', anchor: { from: { column: 2, row: 10 } } })
    s.objects.remove(id)
    await s.save()
    expect(s.file().charts).toEqual([])
    expect(s.cold().charts).toEqual([])
  })

  it('writes a picture made on the grid with its bytes once, and keeps it by the file\'s part after', async () => {
    const s = await opened()
    const id = s.objects.add({ picture: { bytes: PNG, type: 'image/png', name: 'Logo' } })!
    expect(id).toMatch(/^picture-/)
    const list = s.sent()
    // The made picture rides with its bytes; nothing else does.
    expect((list[0]!.params as { list: { data?: string }[] }).list[0]!.data).toBe(Buffer.from(PNG).toString('base64'))
    const got = await s.store.edit(s.path, (await s.store.open(s.path)).rev, list, 'owner')
    if ('conflict' in got) throw new Error('conflict')
    const [picture] = s.file().pictures
    expect(picture).toMatchObject({ sheet: 'Data', name: 'Logo', contentType: 'image/png' })
    expect(readMedia(new Uint8Array(readFileSync(s.path)), picture.part)).toEqual(PNG)
    expect(got.ids).toEqual({ [id]: { id: picture.id, part: picture.part } })
    expect(s.store.history(s.path)[0]!.label).toBe('Picture')
    // The op log keeps the list without the bytes: they are in the file and its kept copy.
    expect(JSON.stringify(s.store.history(s.path))).not.toContain(Buffer.from(PNG).toString('base64'))
    s.objects.apply(rekeyed(s.objects.list(), got.ids!))
    expect(s.objects.list().pictures.map((p) => [p.id, p.part])).toEqual([[picture.id, picture.part]])
    // Moved after: the list names the file's part and sends no bytes; the file keeps one picture.
    s.objects.move(picture.id, place(3, 3))
    const again = s.sent()
    expect((again[0]!.params as { list: { data?: string }[] }).list[0]!.data).toBeUndefined()
    await s.store.edit(s.path, (await s.store.open(s.path)).rev, again, 'owner')
    expect(s.file().pictures.map((p) => [p.id, p.anchor.kind === 'twoCell' ? p.anchor.from.column : -1])).toEqual([[picture.id, 3]])
    expect(s.cold().pictures).toHaveLength(1)
  })

  it('refuses in words what the writer cannot make, and writes nothing', async () => {
    const s = await opened()
    const before = readFileSync(s.path)
    s.objects.add({ chart: { ...made(), series: [{ ...series('column', 'Rent'), values: { ref: '[Other.xlsx]Data!$B$2:$B$7' } }] } })
    await expect(s.save()).rejects.toThrow(/is not a cell range in this workbook/)
    expect(readFileSync(s.path).equals(before)).toBe(true)
    expect(s.store.history(s.path)).toHaveLength(1)
  })

  it('sends nothing for a change that only follows the cells: the structural writer moves the file\'s drawings', () => {
    const change: ObjectChange = { kind: 'set', object: { chart: made() }, cause: 'cells' }
    expect(objectListOf(change, { charts: [made()], pictures: [], warnings: [] }, () => 'sheet-1', () => undefined)).toBeNull()
    const own = objectListOf({ ...change, cause: undefined } as ObjectChange, { charts: [made()], pictures: [], warnings: [] }, () => 'sheet-1', () => undefined)
    expect(own).toEqual({ id: RULES_SET, params: { kind: 'charts', subUnitId: 'sheet-1', list: [made()] } })
  })
})
