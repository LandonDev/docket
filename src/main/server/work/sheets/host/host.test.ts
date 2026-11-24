import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IWorkbookData } from '@univerjs/core'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { changeRuns, type SuggestionCell } from 'work-kit/sheet/suggest'
import { SET_RANGE_VALUES } from '../mutations'
import { blankWorkbook, gz, LifeosBackend, TcsheetBackend, type Op, type SheetBackend, type StoredSuggestion } from './backends'
import { SheetHost } from './host'

/**
 * The Work service's sheet host over a store kept in memory the way LifeOS
 * keeps it (a snapshot, ops compare-and-set on rev, suggestion rows), over a
 * .tcsheet, and over LifeOS's functions through a fake Convex.
 */

class MemoryBackend implements SheetBackend {
  ops: Op[] = []
  rows: StoredSuggestion[] = []
  snaps = new Map<number, IWorkbookData>()
  constructor(
    data: IWorkbookData,
    public shared = true
  ) {
    this.snaps.set(0, structuredClone(data))
  }
  async load() {
    const snapRev = Math.max(...this.snaps.keys())
    return { title: 'Budget', shared: this.shared, snapshot: structuredClone(this.snaps.get(snapRev)!), snapRev, rev: this.ops.at(-1)?.rev ?? 0 }
  }
  async sharedNow() {
    return this.shared
  }
  async opsAfter(rev: number) {
    return this.ops.filter((o) => o.rev > rev)
  }
  async append(baseRev: number, ops: { by: string; mutations: Op['mutations'] }[]) {
    const rev = this.ops.at(-1)?.rev ?? 0
    if (rev !== baseRev) return { stale: rev }
    let r = rev
    for (const op of ops) this.ops.push({ rev: ++r, by: op.by, at: r, mutations: structuredClone(op.mutations) })
    return { rev: r }
  }
  async cutSnapshot(rev: number, data: IWorkbookData) {
    this.snaps.set(rev, data)
  }
  async snapshotAt(rev: number) {
    const best = Math.max(...[...this.snaps.keys()].filter((r) => r <= rev))
    return { rev: best, data: structuredClone(this.snaps.get(best)!) }
  }
  async suggestions() {
    return structuredClone(this.rows)
  }
  async addSuggestions(changeSet: string, by: string, reason: string | undefined, cells: Omit<StoredSuggestion, 'id' | 'changeSet' | 'by' | 'reason' | 'state'>[]) {
    for (const c of cells) this.rows.push({ ...c, id: `s${this.rows.length + 1}`, changeSet, by, ...(reason ? { reason } : {}), state: 'pending' })
  }
  async setSuggestions(updates: (Partial<StoredSuggestion> & { id: string })[]) {
    for (const u of updates) Object.assign(this.rows.find((r) => r.id === u.id)!, u)
  }
}

/** A budget: B2:B4 amounts, B5 their sum. */
function budget(): IWorkbookData {
  const wb = blankWorkbook('book', 'Budget')
  wb.sheets.sheet1!.cellData = {
    0: { 0: { v: 'Item' }, 1: { v: 'Amount' } },
    1: { 0: { v: 'Rent' }, 1: { v: 1200 } },
    2: { 0: { v: 'Food' }, 1: { v: 300 } },
    3: { 0: { v: 'Bus' }, 1: { v: 60 } },
    4: { 0: { v: 'Total' }, 1: { f: '=SUM(B2:B4)' } }
  }
  return wb
}

const hosts: SheetHost[] = []
afterEach(() => {
  for (const h of hosts.splice(0)) h.close()
})
const hostOf = (backend: SheetBackend): SheetHost => {
  const h = new SheetHost(() => backend)
  hosts.push(h)
  return h
}
const REF = { lifeos: 'sheet-1' }
const insertRow = (unitId: string, row: number) => ({ id: 'sheet.mutation.insert-row', params: { unitId, subUnitId: 'sheet1', range: { startRow: row, endRow: row, startColumn: 0, endColumn: 25, rangeType: 1 } } })
const setCell = (row: number, col: number, cell: unknown) => ({ id: SET_RANGE_VALUES, params: { unitId: 'book', subUnitId: 'sheet1', cellValue: { [row]: { [col]: cell } } } })

describe('the sheet host', () => {
  it('reads computed values and writes cells at once, as a revision in the store', async () => {
    const store = new MemoryBackend(budget(), false)
    const host = hostOf(store)
    expect((await host.range(REF, 'B5')).cells[0][0]).toEqual({ at: 'B5', v: 1560, f: '=SUM(B2:B4)' })
    expect(await host.cells(REF, [{ at: 'B3', v: 400 }], 'agent:h:t1', false)).toEqual({ rev: 1, count: 1 })
    expect((await host.range(REF, 'Sheet1!B5')).cells[0][0].v).toBe(1660)
    expect(store.ops.map((o) => [o.rev, o.by])).toEqual([[1, 'agent:h:t1']])
  })

  it("keeps an agent's idea as cell suggestions that step as runs, and rebases them across the owner's row insert", async () => {
    const store = new MemoryBackend(budget())
    const host = hostOf(store)
    // The agent proposes two neighbouring amounts and the total's label: two changes to step through.
    const got = await host.cells(REF, [{ at: 'B3', v: 350 }, { at: 'B4', v: 80 }, { at: 'A5', v: 'Sum' }], 'agent:h:t1', true, 'Prices went up')
    expect(got.count).toBe(3)
    let open = (await host.open(REF)).suggestions
    expect(open.map((s) => [s.row, s.col, s.base?.v, s.proposed?.v, s.state])).toEqual([
      [2, 1, 300, 350, 'pending'],
      [3, 1, 60, 80, 'pending'],
      [4, 0, 'Total', 'Sum', 'pending']
    ])
    const runs = changeRuns(open.map((s) => ({ ...s, column: s.col }) as unknown as SuggestionCell))
    expect(runs.map((r) => [r.range.startRow, r.range.endRow, r.cells.length])).toEqual([
      [2, 3, 2],
      [4, 4, 1]
    ])
    expect(store.ops).toEqual([])

    // He inserts a row above Food: every suggestion below moves down one, and still holds.
    // (The grid's insert command sends the formulas it moved with the insert, as here.)
    expect(await host.apply(REF, 0, [insertRow('book', 2), setCell(5, 1, { f: '=SUM(B2:B5)' })], 'owner')).toEqual({ rev: 1 })
    open = (await host.open(REF)).suggestions
    expect(open.map((s) => [s.row, s.col, s.proposed?.v, s.state])).toEqual([
      [3, 1, 350, 'pending'],
      [4, 1, 80, 'pending'],
      [5, 0, 'Sum', 'pending']
    ])
    // He types over Bus's amount himself: that suggestion no longer holds what the agent saw.
    await host.apply(REF, 1, [setCell(4, 1, { v: 65 })], 'owner')
    open = (await host.open(REF)).suggestions
    expect(open.find((s) => s.row === 4)?.state).toBe('conflict')

    // Accepting the first run writes it as his own edit; the total follows.
    await host.review(REF, { ids: [open[0].id] }, 'accept')
    expect((await host.range(REF, 'B4')).cells[0][0].v).toBe(350)
    expect((await host.range(REF, 'B6')).cells[0][0].v).toBe(1200 + 350 + 65)
    expect(store.ops.at(-1)?.by).toBe('owner')
    await expect(host.review(REF, { ids: [open[1].id] }, 'accept')).rejects.toThrow(/changed since/)
    await host.review(REF, 'all', 'reject')
    expect((await host.open(REF)).suggestions).toEqual([])
  })

  it('moves an edit made on an older revision through the row insert it missed; a stale insert answers a conflict', async () => {
    const store = new MemoryBackend(budget())
    const host = hostOf(store)
    await host.apply(REF, 0, [insertRow('book', 0)], 'owner')
    expect(await host.apply(REF, 0, [setCell(2, 1, { v: 2 })], 'guest:L')).toEqual({ rev: 2 })
    expect((await host.range(REF, 'B4')).cells[0][0].v).toBe(2)
    expect(await host.apply(REF, 0, [insertRow('book', 3)], 'owner')).toEqual({ conflict: true, rev: 2 })
    expect(await host.since(REF, 0)).toMatchObject({ rev: 2, ops: [{ rev: 1, by: 'owner' }, { rev: 2, by: 'guest:L' }] })
  })

  it('a formula the engine cannot read does not take the sheet down: it is stored, replayed by a cold host, and both still answer', async () => {
    const unhandled: unknown[] = []
    const seen = (err: unknown): void => void unhandled.push(err)
    process.on('unhandledRejection', seen)
    try {
      const store = new MemoryBackend(budget())
      const host = hostOf(store)
      // a lambda written as an Excel file writes it, and a formula of forty thousand characters: each makes Univer's calculation throw
      const bad = { 20: { 0: { f: '=_xlfn.MAP({1,2},_xlfn.LAMBDA(_xlpm.x,_xlpm.x*2))' } }, 21: { 0: { f: `=${'1+'.repeat(20_000)}1` } } }
      expect(await host.apply(REF, 0, [{ id: 'sheet.mutation.set-range-values', params: { unitId: 'book', subUnitId: 'sheet1', cellValue: bad } }], 'owner')).toEqual({ rev: 1 })
      expect((await host.range(REF, 'B5')).cells[0][0].v).toBe(1560)
      // a later edit lands and is read back
      expect(await host.apply(REF, 1, [{ id: 'sheet.mutation.set-range-values', params: { unitId: 'book', subUnitId: 'sheet1', cellValue: { 22: { 0: { v: 7 } } } } }], 'owner')).toEqual({ rev: 2 })
      expect((await host.range(REF, 'A23')).cells[0][0].v).toBe(7)
      // a cold host replays the op and opens
      const cold = hostOf(store)
      expect((await cold.open(REF)).rev).toBe(2)
      expect((await cold.range(REF, 'A23')).cells[0][0].v).toBe(7)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', seen)
    }
  }, 60_000)

  it('refuses an op the engine cannot apply and never stores it, so the sheet still opens', async () => {
    const store = new MemoryBackend(budget())
    const host = hostOf(store)
    // (a guest's op that names no sheet of the workbook is refused before the engine is asked)
    await expect(host.apply(REF, 0, [{ id: 'sheet.mutation.insert-row', params: { unitId: 'book' } }], 'guest:L')).rejects.toThrow('that sheet is not in the workbook')
    await expect(host.apply(REF, 0, [{ id: 'sheet.mutation.insert-row', params: { unitId: 'book' } }], 'owner')).rejects.toThrow(/could not be applied/)
    await expect(host.apply(REF, 0, [{ id: 'nobody.mutation.at-all', params: {} }], 'owner')).rejects.toThrow(/could not be applied/)
    expect(store.ops).toEqual([])
    expect((await host.range(REF, 'B5')).cells[0][0].v).toBe(1560)
    expect((await hostOf(store).range(REF, 'B5')).cells[0][0].v).toBe(1560)
  })

  it('hands the workbook over in frames at its revision', async () => {
    const host = hostOf(new MemoryBackend(budget()))
    const a = await host.snapshot(REF, 0, 0, 100)
    const b = await host.snapshot(REF, 0, 100, a.size)
    const json = Buffer.concat([Buffer.from(a.data, 'base64'), Buffer.from(b.data, 'base64')]).toString('utf8')
    expect(JSON.parse(json).sheets.sheet1.cellData[1][1].v).toBe(1200)
    await expect(host.snapshot(REF, 3, 0, 100)).rejects.toThrow(/moved on/)
  })

  it('lists history, compares two revisions and restores one', async () => {
    const host = hostOf(new MemoryBackend(budget()))
    await host.cells(REF, [{ at: 'B2', v: 1000 }], 'owner', false)
    await host.cells(REF, [{ at: 'B3', v: 500 }, { at: 'A4', v: 'Train' }], 'agent:h:t1', false)
    const { revisions } = await host.history(REF)
    expect(revisions.map((r) => [r.rev, r.label])).toEqual([
      [2, '2 cells'],
      [1, '1 cell'],
      [0, 'Made']
    ])
    const diff = await host.compare(REF, 0, 2, 100)
    expect(diff.cells.map((c) => [c.sheetName, c.row, c.col, c.before?.v, c.after?.v])).toEqual([
      ['Sheet1', 1, 1, 1200, 1000],
      ['Sheet1', 2, 1, 300, 500],
      ['Sheet1', 3, 0, 'Bus', 'Train'],
      ['Sheet1', 4, 1, 1560, 1560]
    ].filter((c) => c[3] !== c[4]))
    expect((await host.restore(REF, 1, 'owner')).rev).toBe(3)
    expect((await host.range(REF, 'A4:B4')).cells[0].map((c) => c.v)).toEqual(['Bus', 60])
    expect((await host.range(REF, 'B2')).cells[0][0].v).toBe(1000)
  })

  it("restores a cell's text runs: the same words with another word bold, and plain words over runs", async () => {
    // Council r1 (Sol 11): a restore compared values and formulas alone, and left the newer runs in place.
    const host = hostOf(new MemoryBackend(budget()))
    const doc = (st: number, ed: number) => ({ id: 'd', documentStyle: {}, body: { dataStream: 'Rent due\r\n', textRuns: [{ st, ed, ts: { bl: 1 } }], paragraphs: [{ startIndex: 8 }] } })
    let rev = ((await host.apply(REF, 0, [setCell(1, 0, { v: null, p: doc(0, 4) })], 'owner')) as { rev: number }).rev
    rev = ((await host.apply(REF, rev, [setCell(1, 0, { v: null, p: doc(5, 8) })], 'owner')) as { rev: number }).rev
    const cell = async () => (JSON.parse((await host.snapshotJson(REF)).json) as IWorkbookData).sheets.sheet1!.cellData![1]![0]!
    const bold = (c: { p?: unknown }) => ((c.p as { body?: { textRuns?: { st: number; ed: number }[] } } | null | undefined)?.body?.textRuns ?? []).map((r) => [r.st, r.ed])
    expect(bold(await cell())).toEqual([[5, 8]])
    await host.restore(REF, 1, 'owner')
    expect(bold(await cell())).toEqual([[0, 4]])
    // back to the plain word it held first: the runs go with the restore
    await host.restore(REF, 0, 'owner')
    const plain = await cell()
    expect([plain.v, plain.p ?? null]).toEqual(['Rent', null])
  })

  it('cuts a snapshot every 500 ops, and a fresh host opens from it', async () => {
    const store = new MemoryBackend(budget())
    const host = hostOf(store)
    let rev = 0
    for (let i = 0; i < 500; i++) rev = ((await host.apply(REF, rev, [setCell(1, 1, { v: i })], 'owner')) as { rev: number }).rev
    expect([...store.snaps.keys()]).toEqual([0, 500])
    expect((await hostOf(store).range(REF, 'B2')).cells[0][0].v).toBe(499)
  })
})

describe('a .tcsheet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tcsheet-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('is made empty, written, suggested on and reopened: the cells from the file, what an agent proposes from this host\'s data', async () => {
    const path = join(dir, 'Plan.tcsheet')
    const side = join(dir, 'host-data', 'suggestions')
    TcsheetBackend.create(path, 'Plan')
    const ref = { tcsheet: path }
    const host = hostOf(new TcsheetBackend(path, side))
    expect((await host.open(ref)).title).toBe('Plan')
    await host.cells(ref, [{ at: 'A1', v: 2 }, { at: 'A2', f: 'A1*21' }], 'owner', false)
    const written = readFileSync(path)
    await host.cells(ref, [{ at: 'A1', v: 3 }], 'agent:h:t1', true, 'Three is right')
    // The suggestion is not in the file: it holds what it held.
    expect(readFileSync(path).equals(written)).toBe(true)
    const again = new SheetHost(() => new TcsheetBackend(path, side))
    hosts.push(again)
    expect((await again.range(ref, 'A2')).cells[0][0]).toEqual({ at: 'A2', v: 42, f: '=A1*21' })
    expect((await again.open(ref)).suggestions).toMatchObject([{ row: 0, col: 0, proposed: { v: 3 }, reason: 'Three is right', state: 'pending' }])
    // A host with no folder of its own keeps them in memory, and still never in the file.
    const bare = new SheetHost(() => new TcsheetBackend(path))
    hosts.push(bare)
    expect((await bare.open(ref)).suggestions).toEqual([])
    await bare.cells(ref, [{ at: 'B1', v: 9 }], 'agent:h:t1', true)
    expect((await bare.open(ref)).suggestions).toHaveLength(1)
    expect(readFileSync(path).equals(written)).toBe(true)
  })
})

describe("a sheet's shared, after it was loaded", () => {
  it('reads afresh on every open: a guest link made since the load is what an agent\'s write is decided by', async () => {
    const store = new MemoryBackend(budget(), false)
    const host = hostOf(store)
    expect((await host.open(REF)).shared).toBe(false)
    store.shared = true
    expect((await host.open(REF)).shared).toBe(true)
    store.shared = false
    expect((await host.open(REF)).shared).toBe(false)
  })

  it("asks LifeOS for the row's shared, and fails the open when the row is gone", async () => {
    let shared = false
    let gone = false
    const convex = async (_kind: string, fn: string): Promise<unknown> => {
      if (fn === 'sheets:get') return gone ? null : { _id: 's1', title: 'Budget', sector: 'cosmic', rev: 0, snapshotRev: 0, shared, snapshotUrl: null }
      if (fn === 'sheets:ops' || fn === 'sheets:suggestions') return []
      throw new Error(`unexpected ${fn}`)
    }
    const host = hostOf(new LifeosBackend(convex, 's1'))
    expect((await host.open({ lifeos: 's1' })).shared).toBe(false)
    shared = true
    expect((await host.open({ lifeos: 's1' })).shared).toBe(true)
    gone = true
    await expect(host.open({ lifeos: 's1' })).rejects.toThrow('There is no such sheet in LifeOS')
  })
})

describe('a LifeOS sheet', () => {
  it('loads from its snapshot and ops, appends with compare-and-set, and keeps suggestions as LifeOS rows', async () => {
    const files = new Map<string, Uint8Array>([['snap0', gz(budget())]])
    const calls: [string, Record<string, unknown>][] = []
    const ops: { rev: number; by: string; at: number; mutations: string }[] = [{ rev: 1, by: 'owner', at: 1, mutations: JSON.stringify([setCell(1, 1, { v: 900 })]) }]
    const rows: Record<string, unknown>[] = []
    const convex = async (_kind: string, fn: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push([fn, args])
      switch (fn) {
        case 'sheets:get':
          return { _id: 's1', title: 'Budget', sector: 'cosmic', rev: ops.at(-1)!.rev, snapshotRev: 0, shared: true, snapshotUrl: 'https://files/snap0' }
        case 'sheets:ops':
          return ops.filter((o) => o.rev > (args.after as number))
        case 'sheets:appendOps': {
          const rev = ops.at(-1)!.rev
          if (args.baseRev !== rev) throw Object.assign(new Error('stale'), { data: { code: 'stale-rev', rev } })
          for (const o of args.ops as { by: string; mutations: string }[]) ops.push({ rev: ops.at(-1)!.rev + 1, by: o.by, at: 2, mutations: o.mutations })
          return { rev: ops.at(-1)!.rev }
        }
        case 'sheets:suggestions':
          return rows
        case 'sheets:suggest':
          for (const c of args.cells as Record<string, unknown>[]) rows.push({ _id: `c${rows.length}`, changeSetId: args.changeSetId, by: args.by, state: 'pending', ...c })
          return rows.map((r) => r._id)
        case 'sheets:setSuggestions':
          for (const u of args.cells as Record<string, unknown>[]) Object.assign(rows.find((r) => r._id === u.id)!, u)
          return null
      }
      throw new Error(`unexpected ${fn}`)
    }
    const fetcher = (async (url: string) => new Response(Buffer.from(files.get(url.split('/').pop()!)!))) as unknown as typeof fetch
    const host = hostOf(new LifeosBackend(convex, 's1', fetcher))
    expect((await host.range({ lifeos: 's1' }, 'B5')).cells[0][0].v).toBe(900 + 300 + 60)
    await host.cells({ lifeos: 's1' }, [{ at: 'B3', v: 1 }], 'agent:h:t1', true, undefined, { host: 'h', threadId: 't1' })
    expect(rows).toMatchObject([{ sheet: 'sheet1', row: 2, col: 1, base: JSON.stringify({ v: 300 }), proposed: JSON.stringify({ v: 1 }), state: 'pending' }])
    expect(calls.find(([fn]) => fn === 'sheets:suggest')?.[1]).toMatchObject({ sheetId: 's1', by: 'agent:h:t1', origin: { host: 'h', threadId: 't1' } })
    expect(await host.apply({ lifeos: 's1' }, 1, [insertRow('s1', 0)], 'owner')).toEqual({ rev: 2 })
    expect(rows[0]).toMatchObject({ row: 3, state: 'pending' })
    // Made before the insert it missed: moved down one row with it.
    expect(await host.apply({ lifeos: 's1' }, 1, [setCell(0, 0, { v: 'x' })], 'owner')).toEqual({ rev: 3 })
    expect((await host.range({ lifeos: 's1' }, 'A2')).cells[0][0].v).toBe('x')
  })
})
