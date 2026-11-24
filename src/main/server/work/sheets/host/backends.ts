import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
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
  /** whether others can edit it now, read afresh: a guest link made or ended since the load changes it */
  sharedNow(): Promise<boolean>
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

  async sharedNow(): Promise<boolean> {
    const row = (await this.convex('query', 'sheets:get', { id: this.id })) as SheetRow | null
    if (!row) throw new Error('There is no such sheet in LifeOS, or it is outside your sectors.')
    return row.shared === true
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
    // One query per open state: decided rows stay in LifeOS for good, and a query takes 5,000 at most.
    type Row = {
      _id: string
      changeSetId: string
      by: string
      sheet: string
      row: number
      col: number
      base: string | null
      proposed: string | null
      state: SheetSuggestionState
    }
    const rows: Row[] = []
    for (const state of ['pending', 'conflict', 'orphaned'] as const) rows.push(...((await this.convex('query', 'sheets:suggestions', { sheetId: this.id, state })) as Row[]))
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

/**
 * A `.tcsheet`: a zip of `meta.json`, `snapshots/<rev>.json.gz`, `ops.json` and `suggestions.json`, replaced
 * whole on every write. `suggestions.json` is always an empty list now: what an agent proposes is kept on this
 * host, outside the file (`TcsheetBackend`), so a file in a folder others sync carries none of it.
 */
interface Tcsheet {
  meta: { title: string; rev: number; snapRev: number }
  snapshots: Map<number, Uint8Array>
  ops: Op[]
  /** what a file written before that rule still holds: moved out on its first read */
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

/** A .tcsheet's revision, read from its meta alone; null for a file that is not one. */
export function tcsheetRev(path: string): number | null {
  try {
    const meta = JSON.parse(readText(readZip(new Uint8Array(readFileSync(path))), 'meta.json')) as { rev?: unknown }
    return typeof meta.rev === 'number' ? meta.rev : null
  } catch {
    return null
  }
}

export function readTcsheet(path: string): Tcsheet {
  const z = readZip(new Uint8Array(readFileSync(path)))
  const json = <T>(name: string): T => JSON.parse(readText(z, name)) as T
  const snapshots = new Map<number, Uint8Array>()
  for (const e of z.entries) {
    const m = /^snapshots\/(\d+)\.json\.gz$/.exec(e.name)
    if (m) snapshots.set(Number(m[1]), readEntry(z, e.name))
  }
  return { meta: json('meta.json'), snapshots, ops: json('ops.json'), suggestions: json('suggestions.json') }
}

/** How many snapshots a .tcsheet keeps beside the first: compare replays from the nearest. */
const KEEP_SNAPSHOTS = 4

/** A file's identity on disk now: a write by anything else changes it (a replace by rename its inode, an edit its time). */
const stampOf = (path: string): string => {
  const st = statSync(path)
  return `${st.ino}:${st.size}:${st.mtimeMs}`
}

export class TcsheetBackend implements SheetBackend {
  /** The file as last read or written: the service is its one writer, so it is read once. */
  private held: Tcsheet | null = null
  /** What agents propose over this file, as last read or written. */
  private proposed: StoredSuggestion[] | null = null
  /**
   * `side` is a folder of this host's own data: the suggestions waiting over the file are kept there,
   * one JSON file per path, and never in the `.tcsheet` (the owner's ruling: nothing an agent proposes
   * reaches a file others may sync before he approves). Without it they are kept in memory alone.
   */
  constructor(
    readonly path: string,
    private side?: string
  ) {}

  static create(path: string, title: string): void {
    if (existsSync(path)) throw new Error(`There is a file at ${path} already.`)
    writeTcsheet(path, { meta: { title, rev: 0, snapRev: 0 }, snapshots: new Map([[0, gz(blankWorkbook('workbook', title))]]), ops: [], suggestions: [] })
  }

  /** The real file the held workbook was read from: a write goes there, and only while the path still names it. */
  private bound: string | null = null

  /** The file on disk as last read or written here (its inode, size and time): another writer's bytes are another workbook. */
  private stamp: string | null = null

  private read(): Tcsheet {
    if (this.held) return this.held
    if (!existsSync(this.path)) throw new Error(`There is no file at ${this.path}.`)
    this.bound = realpathSync(this.path)
    this.stamp = stampOf(this.bound)
    return (this.held = readTcsheet(this.bound))
  }
  /**
   * The path names the file that was read: a folder link along it that came to point at another folder would have the
   * workbook held here written over another file. Refused instead; the sheet opens again from the file there now.
   */
  private same(): string {
    let now: string | null
    try {
      now = realpathSync(this.path)
    } catch {
      now = null
    }
    if (this.bound !== null && now !== this.bound) throw new Error(`${this.path} names another file than the one this sheet was opened from: open it again.`)
    // The same path with other bytes (OneDrive or a co-author put a newer workbook there): the one held here is older.
    if (this.bound !== null && this.stamp !== null && stampOf(this.bound) !== this.stamp) throw new Error(`${this.path} changed on disk since this sheet was opened: open it again.`)
    return this.bound ?? this.path
  }
  /** The proposals' file, keyed by the workbook's real path: a link that names another workbook after a restart finds none of these. */
  private sideFile(): string | null {
    if (!this.side) return null
    this.read()
    return join(this.side, `${createHash('sha256').update(this.bound ?? this.path).digest('hex').slice(0, 24)}.json`)
  }
  /**
   * The suggestions waiting over the file. One a file written before the rule still carries is taken out of it here.
   * The side file names the archive they were made over (its stamp, written again at each write here): read cold over
   * another (a workbook put at the same path while the host was down, or a side file from before this rule), they can
   * no longer be shown to stand where the agent saw them, and wait only to be dropped (`orphaned`).
   */
  private waiting(): StoredSuggestion[] {
    if (this.proposed) return this.proposed
    const at = this.sideFile()
    const kept = at && existsSync(at) ? (JSON.parse(readFileSync(at, 'utf8')) as StoredSuggestion[] | { file: string; list: StoredSuggestion[] }) : null
    const t = this.read()
    if (!kept) this.proposed = []
    else if (!Array.isArray(kept) && kept.file === this.stamp) this.proposed = kept.list
    else {
      const list = Array.isArray(kept) ? kept : kept.list
      this.keep(list.map((x) => (x.state === 'pending' || x.state === 'conflict' ? { ...x, state: 'orphaned' as const } : x)))
    }
    const proposed = this.proposed ?? []
    if (t.suggestions.length) {
      const known = new Set(proposed.map((s) => s.id))
      this.keep([...proposed, ...t.suggestions.filter((s) => !known.has(s.id))])
      const carried = t.suggestions
      t.suggestions = []
      try {
        this.write(t)
      } catch {
        // A file he may only read still opens: it keeps what it carried, and they are shown from here.
        t.suggestions = carried
      }
    }
    return this.proposed ?? proposed
  }
  private keep(list: StoredSuggestion[]): void {
    this.proposed = list
    const at = this.sideFile()
    if (!at) return
    if (!list.length) return rmSync(at, { force: true })
    mkdirSync(dirname(at), { recursive: true })
    const tmp = `${at}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify({ file: this.stamp, list }), { mode: 0o600 })
    renameSync(tmp, at)
  }
  private write(t: Tcsheet): void {
    const at = this.same()
    writeTcsheet(at, t)
    this.held = t
    this.stamp = stampOf(at)
    // (the side file names the archive as it now stands)
    if (this.proposed?.length) this.keep(this.proposed)
  }

  async load(): Promise<Loaded> {
    const t = this.read()
    return { title: t.meta.title, shared: false, snapshot: ungz(t.snapshots.get(t.meta.snapRev)!), snapRev: t.meta.snapRev, rev: t.meta.rev }
  }
  async sharedNow(): Promise<boolean> {
    return false
  }
  async opsAfter(rev: number): Promise<Op[]> {
    return this.read().ops.filter((o) => o.rev > rev)
  }
  async append(baseRev: number, ops: { by: string; mutations: SheetMutationJson[] }[]): Promise<{ rev: number } | { stale: number }> {
    const t = this.read()
    if (t.meta.rev !== baseRev) return { stale: t.meta.rev }
    const at = Date.now()
    for (const op of ops) t.ops.push({ rev: ++t.meta.rev, by: op.by, at, mutations: op.mutations })
    this.write(t)
    return { rev: t.meta.rev }
  }
  async cutSnapshot(rev: number, data: IWorkbookData): Promise<void> {
    const t = this.read()
    t.snapshots.set(rev, gz(data))
    t.meta.snapRev = rev
    const old = [...t.snapshots.keys()].filter((r) => r > 0).sort((a, b) => b - a).slice(KEEP_SNAPSHOTS)
    for (const r of old) t.snapshots.delete(r)
    this.write(t)
  }
  async snapshotAt(rev: number): Promise<{ rev: number; data: IWorkbookData }> {
    const t = this.read()
    const best = [...t.snapshots.keys()].filter((r) => r <= rev).sort((a, b) => b - a)[0] ?? 0
    return { rev: best, data: ungz(t.snapshots.get(best)!) }
  }
  async suggestions(): Promise<StoredSuggestion[]> {
    return this.waiting()
  }
  async addSuggestions(changeSet: string, by: string, reason: string | undefined, cells: Omit<StoredSuggestion, 'id' | 'changeSet' | 'by' | 'reason' | 'state'>[]): Promise<void> {
    const added = cells.map((c): StoredSuggestion => ({ ...c, id: `${changeSet}:${c.sheet}:${c.row}:${c.col}`, changeSet, by, ...(reason ? { reason } : {}), state: 'pending' }))
    this.keep([...this.waiting(), ...added])
  }
  async setSuggestions(updates: SuggestionUpdate[]): Promise<void> {
    if (!updates.length) return
    const list = this.waiting()
    for (const u of updates) {
      const s = list.find((x) => x.id === u.id)
      if (s) Object.assign(s, u)
    }
    // decided cells are kept no longer
    this.keep(list.filter((s) => s.state !== 'accepted' && s.state !== 'rejected'))
  }
}
