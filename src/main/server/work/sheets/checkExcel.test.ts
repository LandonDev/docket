import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import type { Readiness } from '@shared/contract-work-formats'
import type { CanvasItem } from '@shared/work'
import { convertersOf, JobRunner } from '../formats/jobs'
import { statePath } from '../formats/tools'
import type { Caller, WorkCtx } from '../modules'
import { OfficeError, type RenderAsk, type RenderDone } from '../office/carrier'
import { FakeOffice } from '../office/fake'
import { officeConverters, pairName, RENDER_PAIRS, RENDER_PROVEN, type RenderDeps, type RenderPlace } from '../office/render'
import { blankWorkbook } from './host/backends'
import type { Sheets } from './held'

/**
 * "Check in Excel" (checkExcel.ts) through the real conversion runner and the office pillar's own converters,
 * over that pillar's fake Office: the only stand-in is the app that draws. Which workbooks go, who may press,
 * what each state of Excel answers, and what is kept and where.
 */

/** A sheet the Work service holds, as its `open` and `snapshot` answer it. */
const service = vi.hoisted(() => ({ book: null as unknown }))
vi.mock('./held', async (original) => {
  const held = await original<typeof import('./held')>()
  return {
    ...held,
    host: async (_ctx: unknown, op: string) => {
      const data = Buffer.from(JSON.stringify(service.book))
      return op === 'open' ? { rev: 1 } : { data: data.toString('base64'), size: data.length }
    }
  }
})
const { checkInExcel, excelReach, NEEDS_PRESS } = await import('./checkExcel')
const { previewsDir, readSheetPreview } = await import('./preview')

const CORPUS = join(import.meta.dirname, 'harness/corpus')
const ALL = new Set(RENDER_PAIRS.map(pairName))
const EVERYWHERE: Record<RenderPlace, ReadonlySet<string>> = { mac: ALL, windows: ALL, vm: ALL }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-check-excel-'))
  mkdirSync(join(dir, 'files'))
  mkdirSync(join(dir, 'work-tools'), { recursive: true })
  // An empty toolchain: an Office pair needs no tool on disk.
  writeFileSync(statePath(dir), JSON.stringify({ platform: 'linux-x64', at: 1, tools: {} }))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** The fake Office, drawing: a render writes a three-page PDF and keeps what it was handed. */
class DrawingExcel extends FakeOffice {
  readonly renders: (RenderAsk & { bytes: Buffer })[] = []
  running = true
  fail: OfficeError | null = null
  async apps() {
    return (await super.apps()).map((a) => ({ ...a, running: this.running }))
  }
  async render(ask: RenderAsk): Promise<RenderDone> {
    this.renders.push({ ...ask, bytes: readFileSync(ask.input) })
    if (this.fail) throw this.fail
    const doc = await PDFDocument.create()
    for (let i = 0; i < 3; i++) doc.addPage([612, 792])
    writeFileSync(ask.output, await doc.save())
    return { pages: 3 }
  }
}

interface Vm {
  state: string
  woken: number
}

function world(place: RenderPlace | null, opts: { vm?: Vm; proven?: Record<RenderPlace, ReadonlySet<string>> } = {}) {
  const excel = new DrawingExcel()
  const vm = opts.vm ?? { state: 'awake', woken: 0 }
  const deps: RenderDeps = {
    place: () => place,
    carrier: () => excel,
    vm: {
      state: () => ({ state: vm.state, cannot: null }),
      office: () => ({ installed: true, licensed: true }),
      wake: async () => {
        vm.woken++
        vm.state = 'awake'
      }
    },
    proven: opts.proven ?? EVERYWHERE,
    touchMs: 10
  }
  const runner = new JobRunner({ host: 'env_test', dataDir: dir, converters: convertersOf([{ id: 'office', ensure() {}, convert: officeConverters(deps) }]), log: () => {}, links: () => [] })
  const asked: boolean[] = []
  // No library, no chart of ours: every read of the database answers nothing.
  const db = { prepare: () => ({ all: () => [], get: () => undefined }) }
  const ctx = { dataDir: dir, host: 'env_test', db, convert: (job: never) => runner.convert(job) } as unknown as WorkCtx
  const s = { ctx, packages: { open: async () => ({ rev: 3 }), fileAt: (p: string) => p } } as unknown as Sheets
  const ask = (shared: boolean): Promise<Readiness> => (asked.push(shared), runner.readiness('xlsx', 'pdf+excel', shared))
  return { excel, vm, s, ctx, ask, asked }
}

const itemOf = (path: string, host = 'env_test'): CanvasItem => ({ id: 'item1', sessionId: 'thread1', kind: 'sheet', title: path.split('/').pop()!, source: { at: 'file', host, path } }) as unknown as CanvasItem
const book = (name: string, as = name): string => {
  const path = join(dir, 'files', as)
  copyFileSync(join(CORPUS, name), path)
  return path
}
/** Every file under the data folder but the toolchain's own state, as paths inside it. */
const tree = (): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .filter((p) => !p.startsWith('work-tools') && !p.startsWith('files'))

const owner: Caller = { kind: 'local', caps: [] }
const phone: Caller = { kind: 'remote', caps: ['read', 'operate', 'approve'] }

describe('Excel in reach', () => {
  it('draws the workbook with Excel in the awake VM: a copy goes, the whole PDF comes back and is read by range', async () => {
    const w = world('vm')
    const path = book('formulas.xlsx')
    const item = itemOf(path)
    expect(await excelReach(w.s, item, owner, w.ask)).toEqual({ app: 'excel', state: 'ready' })
    const got = await checkInExcel(w.s, item, owner, undefined, w.ask)
    expect(got).toMatchObject({ kind: 'paged', pages: 3, drawnBy: 'excel' })
    if (!('rev' in got)) throw new Error('a picture')
    expect(w.excel.renders).toHaveLength(1)
    const ask = w.excel.renders[0]
    // Excel itself, to a PDF, started hidden in the VM; what it opens is a copy in the job's own folder with the file's bytes.
    expect(ask).toMatchObject({ app: 'excel', to: 'pdf', start: true })
    expect(ask.input).not.toBe(path)
    expect(ask.bytes.equals(readFileSync(path))).toBe(true)
    const pdf = Buffer.from(readSheetPreview(w.ctx, item, { rev: got.rev, offset: 0, length: got.size }).data, 'base64')
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(3)
    // Kept beside Preview's other renders, and nothing else left behind: no scratch, no copy of the workbook.
    expect(tree().sort()).toEqual([`work-files/previews/sheets/${got.rev}.json`, `work-files/previews/sheets/${got.rev}.pdf`])
    expect(existsSync(previewsDir(dir))).toBe(true)
  })

  it('answers the kept picture for the same workbook and asks Excel again once the workbook changes', async () => {
    const w = world('vm')
    const path = book('formulas.xlsx')
    const first = await checkInExcel(w.s, itemOf(path), owner, undefined, w.ask)
    const again = await checkInExcel(w.s, itemOf(path), owner, undefined, w.ask)
    expect(again).toEqual(first)
    expect(w.excel.renders).toHaveLength(1)
    copyFileSync(join(CORPUS, 'formats.xlsx'), path)
    const changed = await checkInExcel(w.s, itemOf(path), owner, undefined, w.ask)
    expect(w.excel.renders).toHaveLength(2)
    expect('rev' in changed && 'rev' in first && changed.rev !== first.rev).toBe(true)
  })

  it('says what the Excel file leaves out, as the Excel format does: a sheet of ours without what the model writer cannot hold', async () => {
    const w = world('vm')
    service.book = blankWorkbook('wb1', 'Budget')
    const item = { id: 'item2', sessionId: 'thread1', kind: 'sheet', title: 'Budget', source: { at: 'file', host: 'env_test', path: join(dir, 'files', 'Budget.tcsheet') } } as unknown as CanvasItem
    const got = await checkInExcel(w.s, item, owner, undefined, w.ask)
    expect(got).toMatchObject({ kind: 'paged', drawnBy: 'excel', drops: [] })
    // What Excel was handed is a real .xlsx: the one the model writer makes of the sheet as it stands.
    expect(w.excel.renders[0].bytes.subarray(0, 2).toString('latin1')).toBe('PK')
  })
})

describe('his press', () => {
  it('wakes a sleeping VM for his own press at this host, and for his phone that may approve', async () => {
    // A workbook each: the second press must not be answered from the first's kept picture.
    for (const [by, name] of [[owner, 'formulas.xlsx'], [phone, 'formats.xlsx']] as const) {
      const w = world('vm', { vm: { state: 'hibernated', woken: 0 } })
      const item = itemOf(book(name))
      expect(await excelReach(w.s, item, owner, w.ask)).toEqual({ app: 'excel', state: 'asleep' })
      // Asking whether Excel is there woke nothing.
      expect(w.vm.woken).toBe(0)
      expect(await checkInExcel(w.s, item, by, undefined, w.ask)).toMatchObject({ drawnBy: 'excel', pages: 3 })
      expect(w.vm.woken).toBe(1)
    }
  })

  it('refuses a thread, another host of his and a key that cannot approve, before the workbook is read or anything wakes', async () => {
    const w = world('vm', { vm: { state: 'hibernated', woken: 0 } })
    const item = itemOf(book('formulas.xlsx'))
    const others: Caller[] = [
      { kind: 'model', caps: [], sessionId: 's1' },
      { kind: 'remote', caps: ['read', 'operate', 'approve'], peer: 'env_mac' },
      { kind: 'remote', caps: ['read', 'operate'] }
    ]
    for (const by of others) await expect(checkInExcel(w.s, item, by, undefined, w.ask)).rejects.toThrow(NEEDS_PRESS)
    // And none of them is told Excel is there: no window offers a press that would be refused.
    for (const by of others) expect(await excelReach(w.s, item, by, w.ask)).toEqual({ app: 'excel', state: 'none' })
    expect(w.asked).toEqual([])
    expect(w.vm.woken).toBe(0)
    expect(w.excel.renders).toEqual([])
    expect(tree()).toEqual([])
  })
})

describe('Excel out of reach', () => {
  it('says not open for an Excel he has shut on his own computer, and starts none', async () => {
    const w = world('mac')
    w.excel.running = false
    const item = itemOf(book('formulas.xlsx'))
    expect(await excelReach(w.s, item, owner, w.ask)).toEqual({ app: 'excel', state: 'not open' })
    expect(await checkInExcel(w.s, item, owner, undefined, w.ask)).toEqual({ notInReach: 'not open' })
    expect(w.excel.renders).toEqual([])
    expect(tree()).toEqual([])
  })

  it('says none on a Mac and a PC, whose Excel is not proven as a renderer, and on a host with no Office', async () => {
    for (const place of ['mac', 'windows', null] as const) {
      const w = world(place, { proven: RENDER_PROVEN })
      const item = itemOf(book('formulas.xlsx'))
      expect(await excelReach(w.s, item, owner, w.ask)).toEqual({ app: 'excel', state: 'none' })
      expect(await checkInExcel(w.s, item, owner, undefined, w.ask)).toEqual({ notInReach: 'none' })
      expect(w.excel.renders).toEqual([])
    }
    // The VM is the one carrier whose own proof passed.
    expect(RENDER_PROVEN.vm.has('xlsx→pdf+excel')).toBe(true)
    expect(await excelReach(world('vm', { proven: RENDER_PROVEN }).s, itemOf(book('formulas.xlsx')), owner, world('vm', { proven: RENDER_PROVEN }).ask)).toEqual({ app: 'excel', state: 'ready' })
  })

  it('never answers a kept picture once Excel is shut: the press looks again before anything else', async () => {
    const w = world('mac')
    const item = itemOf(book('formulas.xlsx'))
    expect(await checkInExcel(w.s, item, owner, undefined, w.ask)).toMatchObject({ drawnBy: 'excel' })
    w.excel.running = false
    expect(await checkInExcel(w.s, item, owner, undefined, w.ask)).toEqual({ notInReach: 'not open' })
    expect(w.excel.renders).toHaveLength(1)
  })

  it('says none where no runner is up, without a throw', async () => {
    const w = world('vm')
    expect(await excelReach(w.s, itemOf(book('formulas.xlsx')), owner)).toEqual({ app: 'excel', state: 'none' })
    expect(await excelReach(w.s, itemOf(book('formulas.xlsx')), owner, async () => Promise.reject(new Error('the helper did not answer')))).toEqual({ app: 'excel', state: 'none' })
    // And a press there is answered the same, by the runner this host does not have.
    expect(await checkInExcel(w.s, itemOf(book('formulas.xlsx')), owner)).toEqual({ notInReach: 'none' })
    expect(w.excel.renders).toEqual([])
  })

  it('says a busy Excel in the office pillar\'s own words, and keeps nothing of a failed draw', async () => {
    const w = world('vm')
    const item = itemOf(book('formulas.xlsx'))
    w.excel.fail = new OfficeError('Excel has a dialog open', 'busy')
    await expect(checkInExcel(w.s, item, owner, undefined, w.ask)).rejects.toThrow('Excel is busy with a dialog: try again once it is closed.')
    // A failed draw keeps nothing.
    expect(tree()).toEqual([])
  })
})

describe('workbooks that never go', () => {
  it('keeps a workbook others can open here: Excel is not asked, the workbook is not read, nothing is written', async () => {
    const w = world('vm')
    // A file on another host of his is one others can open (files/policy.ts `sharedOf`).
    const item = itemOf(book('formulas.xlsx'), 'env_other')
    expect(await excelReach(w.s, item, owner, w.ask)).toEqual({ app: 'excel', state: 'none' })
    expect(w.asked).toEqual([])
    expect(await checkInExcel(w.s, item, owner, undefined, w.ask)).toEqual({ notInReach: 'none' })
    expect(w.excel.renders).toEqual([])
    expect(tree()).toEqual([])
  })

  it('keeps a macro workbook here: the pair takes an .xlsx, and Excel refuses macros under that name', async () => {
    const w = world('vm')
    const item = itemOf(book('formulas.xlsx', 'Macros.xlsm'))
    expect(await excelReach(w.s, item, owner, w.ask)).toEqual({ app: 'excel', state: 'none' })
    expect(await checkInExcel(w.s, item, owner, undefined, w.ask)).toEqual({ notInReach: 'none' })
    expect(w.excel.renders).toEqual([])
  })

  it('says none for a spreadsheet Google holds: it is drawn there', async () => {
    const w = world('vm')
    const item = { id: 'g1', sessionId: 'thread1', kind: 'sheet', title: 'Budget', source: { at: 'google', mime: 'application/vnd.google-apps.spreadsheet', fileId: 'abc', account: 'me@example.com' } } as unknown as CanvasItem
    expect(await excelReach(w.s, item, owner, w.ask)).toEqual({ app: 'excel', state: 'none' })
    expect(await checkInExcel(w.s, item, owner, undefined, w.ask)).toEqual({ notInReach: 'none' })
  })
})
