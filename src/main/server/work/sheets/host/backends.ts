import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { IWorkbookData } from '@univerjs/core'
import type { ConvexCall } from 'work-kit/collab-server'
import type { SheetCellJson, SheetMutationJson, SheetSuggestionState } from '@shared/contract-work-sheets'
import { readEntry, readText, readZip, writeZip } from '../patch/zip'

/**
 * Where the Work service keeps a sheet that is a snapshot and an op log
 * (docs/agents/work-sheets.md "Sheets the service holds"): a LifeOS sheet in
 * LifeOS's `sheets`, `sheetOps`, `sheetSnapshots` and `sheetSuggestionCells`
 * (M17), or a `.tcsheet` file on this host. A snapshot is Univer's workbook
 * as JSON, gzipped.
 */

export interface Op {
  rev: number
  by: string
  at: number
  mutations: SheetMutationJson[]
}

export interface StoredSuggestion {
  /** the store's own id (a Convex id for LifeOS) */
  id: string
  changeSet: string
  by: string
  reason?: string
  sheet: string
  row: number
  col: number
  base: SheetCellJson | null
  proposed: SheetCellJson | null
  state: SheetSuggestionState
}

export type SuggestionUpdate = Partial<Pick<StoredSuggestion, 'state' | 'row' | 'col' | 'base' | 'proposed'>> & { id: string }

export interface Loaded {
  title: string
  shared: boolean
  /** LifeOS: the row's sector, held against a caller's fence */
  sector?: string
  snapshot: IWorkbookData
  snapRev: number
  rev: number
}

export interface SheetBackend {
  load(): Promise<Loaded>
  /** every op after `rev`, oldest first */
  opsAfter(rev: number): Promise<Op[]>
  /** appends at `baseRev`; `stale` when someone else appended first */
  append(baseRev: number, ops: { by: string; mutations: SheetMutationJson[] }[]): Promise<{ rev: number } | { stale: number }>
  cutSnapshot(rev: number, data: IWorkbookData): Promise<void>
  /** the newest snapshot at or before `rev` */
  snapshotAt(rev: number): Promise<{ rev: number; data: IWorkbookData }>
  suggestions(): Promise<StoredSuggestion[]>
  addSuggestions(changeSet: string, by: string, reason: string | undefined, cells: Omit<StoredSuggestion, 'id' | 'changeSet' | 'by' | 'reason' | 'state'>[], origin?: unknown): Promise<void>
  setSuggestions(updates: SuggestionUpdate[]): Promise<void>
}

/** The op count between snapshots (M17's `SHEET_SNAPSHOT_EVERY`). */
export const SNAPSHOT_EVERY = 500
/** An op larger than this goes to LifeOS as a file (M17: 32 KiB inline at most). */
const INLINE_MAX = 32 * 1024
const OPS_PAGE = 200

export const gz = (data: IWorkbookData): Uint8Array => gzipSync(Buffer.from(JSON.stringify(data)))
export const ungz = (bytes: Uint8Array): IWorkbookData => JSON.parse(gunzipSync(bytes).toString('utf8')) as IWorkbookData

/** An empty workbook of one sheet, as Univer opens it. */
export function blankWorkbook(id: string, title: string): IWorkbookData {
  return {
    id,
    name: title,
    appVersion: '1.5.2',
    locale: 'enUS' as IWorkbookData['locale'],
    styles: {},
    sheetOrder: ['sheet1'],
    sheets: { sheet1: { id: 'sheet1', name: 'Sheet1', rowCount: 1000, columnCount: 26, cellData: {} } }
  } as IWorkbookData
}

const cellText = (c: SheetCellJson | null): string | null => (c === null ? null : JSON.stringify(c))
const cellOf = (s: string | null | undefined): SheetCellJson | null => (s ? (JSON.parse(s) as SheetCellJson) : null)

// ── LifeOS ──────────────────────────────────────────────────────────

interface SheetRow {
  _id: string
  title: string
  sector: string
  rev: number
  snapshotRev: number
  shared: boolean
  snapshotUrl: string | null
}

export class LifeosBackend implements SheetBackend {
  constructor(
    private convex: ConvexCall,
    readonly id: string,
    private fetcher: typeof fetch = fetch
  ) {}

  private async bytes(url: string): Promise<Uint8Array> {
    const res = await this.fetcher(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`LifeOS did not hand over a file (${res.status})`)
    return new Uint8Array(await res.arrayBuffer())
  }
  private async upload(bytes: Uint8Array, type: string): Promise<string> {
    const url = (await this.convex('mutation', 'sheets:generateUploadUrl', {})) as string
    const res = await this.fetcher(url, { method: 'POST', headers: { 'Content-Type': type }, body: Buffer.from(bytes), signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`LifeOS did not take the file (${res.status})`)
    return ((await res.json()) as { storageId: string }).storageId
  }

  async load(): Promise<Loaded> {
    const row = (await this.convex('query', 'sheets:get', { id: this.id })) as SheetRow | null
    if (!row) throw new Error('There is no such sheet in LifeOS, or it is outside your sectors.')
    const snapshot = row.snapshotUrl ? ungz(await this.bytes(row.snapshotUrl)) : blankWorkbook(this.id, row.title)
    return { title: row.title, shared: row.shared, sector: row.sector, snapshot, snapRev: row.snapshotUrl ? row.snapshotRev : 0, rev: row.rev }
  }

  async opsAfter(rev: number): Promise<Op[]> {
    const out: Op[] = []
    for (let after = rev; ; ) {
      const page = (await this.convex('query', 'sheets:ops', { sheetId: this.id, after })) as { rev: number; by: string; at: number; mutations?: string; mutationsUrl?: string | null }[]
      for (const o of page) {
        const text = o.mutations ?? (o.mutationsUrl ? Buffer.from(await this.bytes(o.mutationsUrl)).toString('utf8') : '[]')
        out.push({ rev: o.rev, by: o.by, at: o.at, mutations: JSON.parse(text) as SheetMutationJson[] })
      }
      if (page.length < OPS_PAGE) return out
      after = page[page.length - 1].rev
    }
  }

  async append(baseRev: number, ops: { by: string; mutations: SheetMutationJson[] }[]): Promise<{ rev: number } | { stale: number }> {
    let rev = baseRev
    for (let i = 0; i < ops.length; i += OPS_PAGE) {
      const page: ({ by: string; mutations: string } | { by: string; mutationsFile: string })[] = []
      for (const op of ops.slice(i, i + OPS_PAGE)) {
        const text = JSON.stringify(op.mutations)
        page.push(Buffer.byteLength(text) > INLINE_MAX ? { by: op.by, mutationsFile: await this.upload(Buffer.from(text), 'application/json') } : { by: op.by, mutations: text })
      }
      try {
        rev = ((await this.convex('mutation', 'sheets:appendOps', { sheetId: this.id, baseRev: rev, ops: page })) as { rev: number }).rev
      } catch (err) {
        const data = (err as { data?: { code?: string; rev?: number } }).data
        if (data?.code === 'stale-rev' && typeof data.rev === 'number') return { stale: data.rev }
        throw err
      }
    }
    return { rev }
  }

  async cutSnapshot(rev: number, data: IWorkbookData): Promise<void> {
    const file = await this.upload(gz(data), 'application/gzip')
    await this.convex('mutation', 'sheets:snapshot', { sheetId: this.id, rev, file })
  }

  async snapshotAt(rev: number): Promise<{ rev: number; data: IWorkbookData }> {
    const all = (await this.convex('query', 'sheets:snapshots', { sheetId: this.id })) as { rev: number; url?: string | null; fileUrl?: string | null }[]
    const best = all.filter((s) => s.rev <= rev && (s.url ?? s.fileUrl)).sort((a, b) => b.rev - a.rev)[0]
    if (!best) {
      const row = (await this.convex('query', 'sheets:get', { id: this.id })) as SheetRow
      return { rev: 0, data: blankWorkbook(this.id, row.title) }
    }
    return { rev: best.rev, data: ungz(await this.bytes((best.url ?? best.fileUrl)!)) }
  }

  async suggestions(): Promise<StoredSuggestion[]> {
    const rows = (await this.convex('query', 'sheets:suggestions', { sheetId: this.id })) as {
      _id: string
      changeSetId: string
      by: string
      sheet: string
      row: number
      col: number
      base: string | null
      proposed: string | null
      state: SheetSuggestionState
    }[]
    return rows.map((r) => ({ id: r._id, changeSet: r.changeSetId, by: r.by, sheet: r.sheet, row: r.row, col: r.col, base: cellOf(r.base), proposed: cellOf(r.proposed), state: r.state }))
  }

  async addSuggestions(changeSet: string, by: string, _reason: string | undefined, cells: Omit<StoredSuggestion, 'id' | 'changeSet' | 'by' | 'reason' | 'state'>[], origin?: unknown): Promise<void> {
    await this.convex('mutation', 'sheets:suggest', {
      sheetId: this.id,
      changeSetId: changeSet,
      by,
      ...(origin ? { origin } : {}),
      cells: cells.map((c) => ({ sheet: c.sheet, row: c.row, col: c.col, base: cellText(c.base), proposed: cellText(c.proposed) }))
    })
  }

  async setSuggestions(updates: SuggestionUpdate[]): Promise<void> {
    if (!updates.length) return
    await this.convex('mutation', 'sheets:setSuggestions', {
      sheetId: this.id,
      cells: updates.map((u) => ({
        id: u.id,
        ...(u.state ? { state: u.state } : {}),
        ...(u.row !== undefined ? { row: u.row } : {}),
        ...(u.col !== undefined ? { col: u.col } : {}),
        ...('base' in u ? { base: cellText(u.base ?? null) } : {}),
        ...('proposed' in u ? { proposed: cellText(u.proposed ?? null) } : {})
      }))
    })
  }
}

// ── .tcsheet ────────────────────────────────────────────────────────

/** A `.tcsheet`: a zip of `meta.json`, `snapshots/<rev>.json.gz`, `ops.json` and `suggestions.json`, replaced whole on every write. */
interface Tcsheet {
  meta: { title: string; rev: number; snapRev: number }
  snapshots: Map<number, Uint8Array>
  ops: Op[]
  suggestions: StoredSuggestion[]
}

const EMPTY_ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)])

export function writeTcsheet(path: string, t: Tcsheet): void {
  const enc = new TextEncoder()
  const files = new Map<string, Uint8Array>([
    ['meta.json', enc.encode(JSON.stringify(t.meta))],
    ['ops.json', enc.encode(JSON.stringify(t.ops))],
    ['suggestions.json', enc.encode(JSON.stringify(t.suggestions))]
  ])
  for (const [rev, bytes] of t.snapshots) files.set(`snapshots/${rev}.json.gz`, bytes)
  const tmp = join(dirname(path), `.${randomUUID()}.tcsave`)
  writeFileSync(tmp, writeZip(readZip(EMPTY_ZIP), new Map(), new Set(), files))
  renameSync(tmp, path)
}

function readTcsheet(path: string): Tcsheet {
  const z = readZip(new Uint8Array(readFileSync(path)))
  const json = <T>(name: string): T => JSON.parse(readText(z, name)) as T
  const snapshots = new Map<number, Uint8Array>()
  for (const e of z.entries) {
    const m = /^snapshots\/(\d+)\.json\.gz$/.exec(e.name)
    if (m) snapshots.set(Number(m[1]), readEntry(z, e.name))
  }
  return { meta: json('meta.json'), snapshots, ops: json('ops.json'), suggestions: json('suggestions.json') }
}

export class TcsheetBackend implements SheetBackend {
  constructor(readonly path: string) {}

  static create(path: string, title: string): void {
    if (existsSync(path)) throw new Error(`There is a file at ${path} already.`)
    writeTcsheet(path, { meta: { title, rev: 0, snapRev: 0 }, snapshots: new Map([[0, gz(blankWorkbook('workbook', title))]]), ops: [], suggestions: [] })
  }

  private read(): Tcsheet {
    if (!existsSync(this.path)) throw new Error(`There is no file at ${this.path}.`)
    return readTcsheet(this.path)
  }

  async load(): Promise<Loaded> {
    const t = this.read()
    return { title: t.meta.title, shared: false, snapshot: ungz(t.snapshots.get(t.meta.snapRev)!), snapRev: t.meta.snapRev, rev: t.meta.rev }
  }
  async opsAfter(rev: number): Promise<Op[]> {
    return this.read().ops.filter((o) => o.rev > rev)
  }
  async append(baseRev: number, ops: { by: string; mutations: SheetMutationJson[] }[]): Promise<{ rev: number } | { stale: number }> {
    const t = this.read()
    if (t.meta.rev !== baseRev) return { stale: t.meta.rev }
    const at = Date.now()
    for (const op of ops) t.ops.push({ rev: ++t.meta.rev, by: op.by, at, mutations: op.mutations })
    writeTcsheet(this.path, t)
    return { rev: t.meta.rev }
  }
  async cutSnapshot(rev: number, data: IWorkbookData): Promise<void> {
    const t = this.read()
    t.snapshots.set(rev, gz(data))
    t.meta.snapRev = rev
    writeTcsheet(this.path, t)
  }
  async snapshotAt(rev: number): Promise<{ rev: number; data: IWorkbookData }> {
    const t = this.read()
    const best = [...t.snapshots.keys()].filter((r) => r <= rev).sort((a, b) => b - a)[0] ?? 0
    return { rev: best, data: ungz(t.snapshots.get(best)!) }
  }
  async suggestions(): Promise<StoredSuggestion[]> {
    return this.read().suggestions
  }
  async addSuggestions(changeSet: string, by: string, reason: string | undefined, cells: Omit<StoredSuggestion, 'id' | 'changeSet' | 'by' | 'reason' | 'state'>[]): Promise<void> {
    const t = this.read()
    for (const c of cells) t.suggestions.push({ ...c, id: `${changeSet}:${c.sheet}:${c.row}:${c.col}`, changeSet, by, ...(reason ? { reason } : {}), state: 'pending' })
    writeTcsheet(this.path, t)
  }
  async setSuggestions(updates: SuggestionUpdate[]): Promise<void> {
    if (!updates.length) return
    const t = this.read()
    for (const u of updates) {
      const s = t.suggestions.find((x) => x.id === u.id)
      if (s) Object.assign(s, u)
    }
    // decided cells leave the file
    t.suggestions = t.suggestions.filter((s) => s.state !== 'accepted' && s.state !== 'rejected')
    writeTcsheet(this.path, t)
  }
}
