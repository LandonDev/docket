import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { IUniverInstanceService } from '@univerjs/core'
import { headlessSheet } from 'work-kit/sheet/engine'
import { importXlsx, readMedia, readObjects, type ChartSpec } from 'work-kit/sheet/xlsx'
import type { ObjectChange } from 'work-kit/sheet'
import { SHEET_ROW, type SheetMutationJson } from '@shared/contract-work-sheets'
import { isObjectList, latestRules, RULES_SET } from '@shared/work/sheets'
// (the kit's objects store is not among its exports: the grid makes it; a test reaches it by its file)
import { createObjects } from '../../../../../node_modules/work-kit/src/sheet/objects/access'
import { FileIds, MadePictures, objectListOf, pictureAdded } from '../../../../renderer/src/work/sheets/objects'
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
 *      opening the file again draws; the ids the save answers are kept beside the grid's own (`FileIds`),
 *      so the next save names the same parts and the grid's Undo still names its own.
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
  // Undo keeps one history a unit, read from the unit in focus, as the grid's is.
  grid.univer.__getInjector().get(IUniverInstanceService).focusUnit(grid.workbook.getId())
  const held = createObjects(grid.api, () => false, { initial: objects })
  held.access.edits(true)
  const made = new MadePictures()
  const told: ObjectChange[] = []
  held.access.onChange((change) => {
    made.take(change)
    // (as sync.ts `object` does: a picture put back is new to the file)
    pictureAdded(change, names, sentMedia, made, () => undefined)
    told.push(change)
  })
  const sheetId = (name: string) => workbook.sheetOrder.find((id) => workbook.sheets[id]?.name === name)
  // The file's names for what this grid made: the grid keeps its own (sync.ts `rekey`, `FileIds`).
  const names = new FileIds()
  const sentMedia = new Set<string>()
  /** What the canvas sends for the changes since the last save: each the tab's whole list, once a tab, under the file's names. */
  const sent = (): SheetMutationJson[] =>
    latestRules(told.splice(0).flatMap((change) => objectListOf(change, held.access.list(), sheetId, (part) => (sentMedia.has(part) ? undefined : made.get(part)?.bytes)) ?? [])).map((m) => names.out(m))
  const save = async (rev?: number) => {
    const mutations = sent()
    expect(mutations.length).toBeGreaterThan(0)
    expect(mutations.every(isObjectList)).toBe(true)
    const got = await store.edit(path, rev ?? (await store.open(path)).rev, mutations, 'owner')
    if ('conflict' in got) throw new Error('conflict')
    for (const m of mutations) for (const x of (m.params as { list: { part?: string; data?: string }[] }).list) if (x.data && x.part) sentMedia.add(x.part)
    if (got.ids) names.take(held.access.list(), got.ids)
    return got
  }
  const file = () => readObjects(new Uint8Array(readFileSync(path)))
  const cold = () => importXlsx(new Uint8Array(readFileSync(path))).objects
  return { path, store, grid, objects: held.access, told, sent, save, file, cold, names, sentMedia }
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
    // The grid keeps its own id (its Undo names the chart by it); the next save names it as the file does, so it
    // changes that chart and makes no second one.
    expect(s.objects.list().charts.map((c) => c.id)).toEqual(['chart-ab12cd34'])
    s.objects.set('chart-ab12cd34', { title: { text: 'Spent' } })
    expect((s.sent()[0]!.params as { list: { id: string }[] }).list.map((c) => c.id)).toEqual([written.id])
    expect(s.cold().charts.map((c) => [c.id, c.title?.text])).toEqual([[written.id, 'Spending']])
    expect(s.store.history(s.path)[0]).toMatchObject({ label: 'Chart', by: 'owner' })
  })

  it('takes a saved chart back with the grid\'s own Undo, and the file loses it too', async () => {
    // Council r1 (Sol 10): the save renamed the chart on the grid, and Undo, naming the old id, left it in the workbook.
    const s = await opened()
    s.objects.add({ chart: made() })
    await s.save()
    expect(s.file().charts).toHaveLength(1)
    await s.grid.api.undo()
    expect(s.objects.list().charts).toEqual([])
    await s.save()
    expect(s.file().charts).toEqual([])
    // and Redo makes it again, under a name of the file's
    await s.grid.api.redo()
    expect(s.objects.list().charts.map((c) => c.id)).toEqual(['chart-ab12cd34'])
    await s.save()
    expect(s.file().charts).toHaveLength(1)
  })

  it('refuses a chart list made over another one saved since: the first editor\'s chart is never taken out', async () => {
    // Council r1 (Sol 12): two windows added charts on one tab from one revision, and the second list removed the first's chart.
    const a = await opened()
    const base = (await a.store.open(a.path)).rev
    a.objects.add({ chart: made('chart-aaaa1111') })
    const first = a.sent()
    expect(await a.store.edit(a.path, base, first, 'owner')).toMatchObject({ rev: base + 1 })
    // the other window's list, made on the same revision: its own chart alone on that tab
    const second = { ...first[0]!, params: { ...(first[0]!.params as object), list: [made('chart-bbbb2222')] } }
    expect(await a.store.edit(a.path, base, [second], 'owner')).toEqual({ conflict: true, rev: base + 1 })
    expect(a.file().charts.map((c) => c.title?.text)).toEqual(['Spending'])
  })

  it('changes a chart in place, moves it, and takes it out', async () => {
    const s = await opened()
    s.objects.add({ chart: made() })
    await s.save()
    const id = s.objects.list().charts[0]!.id
    const part = s.file().charts[0]!.id
    s.objects.set(id, { title: { text: 'Rent and food' }, legend: 'right' })
    s.objects.move(id, place(2, 10))
    const got = await s.save()
    // Changed in place: the same part, nothing new to name.
    expect(got.ids).toBeUndefined()
    expect(s.file().charts).toHaveLength(1)
    expect(s.file().charts[0]).toMatchObject({ id: part, title: { text: 'Rent and food' }, legend: 'right', anchor: { from: { column: 2, row: 10 } } })
    s.objects.remove(id)
    await s.save()
    expect(s.file().charts).toEqual([])
    expect(s.cold().charts).toEqual([])
  })

  it('makes a picture again with Redo after its Undo was saved: it goes as new, with its bytes', async () => {
    // Council r2 (Sol 8): the grid remembered it had sent the bytes, and the file refused a new picture without them.
    const s = await opened()
    s.objects.add({ picture: { bytes: PNG, type: 'image/png', name: 'Logo' } })
    await s.save()
    expect(s.file().pictures).toHaveLength(1)
    await s.grid.api.undo()
    await s.save()
    expect(s.file().pictures).toEqual([])
    await s.grid.api.redo()
    await s.save()
    const [picture] = s.file().pictures
    expect(picture).toMatchObject({ name: 'Logo', contentType: 'image/png' })
    expect(readMedia(new Uint8Array(readFileSync(s.path)), picture!.part)).toEqual(PNG)
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
    for (const x of (list[0]!.params as { list: { part: string }[] }).list) s.sentMedia.add(x.part)
    s.names.take(s.objects.list(), got.ids!)
    // The grid keeps its own id and part (it draws from the bytes made here).
    expect(s.objects.list().pictures.map((p) => p.id)).toEqual([id])
    // Moved after: the list names the file's picture and part and sends no bytes; the file keeps one picture.
    s.objects.move(id, place(3, 3))
    const again = s.sent()
    expect((again[0]!.params as { list: { id: string; part: string }[] }).list.map((p) => [p.id, p.part])).toEqual([[picture.id, picture.part]])
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
