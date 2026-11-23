import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ClientRequest } from '@shared/contract'
import { columnLetter, type Cell, type ReceiptLine } from '@shared/work/money'
import type { ConvertJob, ConvertResult } from '../formats/jobs'
import type { Caller, WorkCtx } from '../modules'
import { ensureMoneyTables } from './store'

/**
 * What Money's tests stand on: a Work service that keeps each sheet as a
 * grid in memory and answers the `/internal/sheet/*` routes Money calls, a
 * database with two jobs in folders of their own, and a context over both.
 * Not for the app: only test files import this.
 */

interface Sheet {
  title: string
  rev: number
  shared: boolean
  cells: Map<string, Cell>
  /** change sets that wait as suggestions */
  suggested: { at: string; v?: Cell; f?: string }[][]
  /** raw mutations it was sent */
  applied: unknown[]
}

const A1 = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/
const colOf = (letters: string): number => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1

export interface StandIn {
  sheets: Map<string, Sheet>
  /** every route asked, in order */
  asked: { route: string; body: Record<string, unknown> }[]
  internal(route: string, body: unknown): Promise<unknown>
  /** a sheet's rows as plain arrays, for a test to read */
  grid(path: string): Cell[][]
  /** his own edit, typed into the sheet */
  type(path: string, at: string, v: Cell): void
}

export function standInSheets(): StandIn {
  const sheets = new Map<string, Sheet>()
  const asked: StandIn['asked'] = []
  const of = (body: Record<string, unknown>): Sheet => {
    const path = (body.sheet as { tcsheet: string }).tcsheet
    const s = sheets.get(path)
    if (!s) throw new Error(`There is no file at ${path}.`)
    return s
  }
  const set = (s: Sheet, at: string, v: Cell): void => void (v === null || v === undefined || v === '' ? s.cells.delete(at) : s.cells.set(at, v))
  return {
    sheets,
    asked,
    async internal(route, raw) {
      const body = raw as Record<string, unknown>
      asked.push({ route, body })
      switch (route) {
        case '/internal/sheet/create': {
          const path = (body.at as { tcsheet: string }).tcsheet
          if (sheets.has(path)) throw new Error(`There is a file at ${path} already.`)
          sheets.set(path, { title: body.title as string, rev: 0, shared: false, cells: new Map(), suggested: [], applied: [] })
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, '')
          return { sheet: { tcsheet: path } }
        }
        case '/internal/sheet/open': {
          const s = of(body)
          return { title: s.title, rev: s.rev, shared: s.shared, suggestions: [] }
        }
        case '/internal/sheet/cells': {
          const s = of(body)
          const cells = body.cells as { at: string; v?: Cell; f?: string }[]
          if (body.suggest === true) {
            s.suggested.push(cells)
            return { changeSetId: `cs${s.suggested.length}`, count: cells.length }
          }
          for (const c of cells) set(s, c.at, c.f !== undefined ? `=${c.f.replace(/^=/, '')}` : c.v)
          return { rev: ++s.rev, count: cells.length }
        }
        case '/internal/sheet/range': {
          const s = of(body)
          const m = A1.exec(body.range as string)
          if (!m) throw new Error(`${String(body.range)} is not a range`)
          const [c0, r0, c1, r1] = [colOf(m[1]), Number(m[2]), colOf(m[3] ?? m[1]), Number(m[4] ?? m[2])]
          const cells: { at: string; v?: Cell }[][] = []
          for (let r = r0; r <= r1; r++) {
            const line: { at: string; v?: Cell }[] = []
            for (let c = c0; c <= c1; c++) {
              const at = `${columnLetter(c)}${r}`
              line.push(s.cells.has(at) ? { at, v: s.cells.get(at) } : { at })
            }
            cells.push(line)
          }
          return { sheet: 'Sheet1', cells }
        }
        case '/internal/sheet/apply': {
          const s = of(body)
          if (body.baseRev !== s.rev) return { conflict: true, rev: s.rev }
          s.applied.push(...(body.mutations as unknown[]))
          return { rev: ++s.rev }
        }
        default:
          throw new Error(`the stand-in serves no ${route}`)
      }
    },
    grid(path) {
      const s = sheets.get(path)!
      const rows: Cell[][] = []
      for (const [at, v] of s.cells) {
        const m = A1.exec(at)!
        const [c, r] = [colOf(m[1]), Number(m[2]) - 1]
        while (rows.length <= r) rows.push([])
        rows[r][c] = v
      }
      return rows.map((row) => Array.from(row, (v) => v ?? ''))
    },
    type(path, at, v) {
      const s = sheets.get(path)!
      set(s, at, v)
      s.rev++
    }
  }
}

export const LOCAL: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
/** A key over the tunnel: it reaches only what stands under a folder named `managed`. */
export const REMOTE: Caller = { kind: 'remote', caps: ['read', 'operate'] }

export interface Bench {
  db: DatabaseSync
  root: string
  sheets: StandIn
  ctx: WorkCtx
  pushed: unknown[]
  /** every conversion asked, in order */
  converted: ConvertJob[]
  /** what the reader gives back for a picture, by the file's name; a name not here reads as nothing */
  lines: Map<string, ReceiptLine[]>
  /** a PDF's text blocks, by the file's name; a name not here is a scan (no text layer) */
  blocks: Map<string, { page: number; bbox: [number, number, number, number]; text: string }[]>
  /** set to make every conversion fail */
  readerDown: boolean
  /** the calendar LifeOS answers with, for any sector; `lifeos.down` makes it refuse, `lifeos.asked` counts the reads */
  lifeos: { events: unknown[]; down: boolean; connected: boolean; asked: { fn: string; args: Record<string, unknown> }[] }
  /** the two jobs' folders */
  ref: string
  purdue: string
}

/** Two jobs on one host: `ws-ref` (ref) under a folder a remote key reaches, `ws-purdue` (purdue) under one it does not. A third, code, workspace has no money. */
export function bench(): Bench {
  const db = new DatabaseSync(':memory:')
  const root = mkdtempSync(join(tmpdir(), 'money-'))
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, path TEXT, kind TEXT, sector TEXT, created_at INTEGER)')
  const ref = join(root, 'managed', 'Ref')
  const purdue = join(root, 'elsewhere', 'Purdue')
  for (const [id, name, path, kind, sector, at] of [
    ['ws-ref', 'Ref', ref, 'work', 'ref', 1],
    ['ws-purdue', 'Purdue', purdue, 'work', 'purdue', 2],
    ['repo', 'temp-code', join(root, 'managed', 'repo'), 'code', 'cosmic', 3]
  ] as const) {
    mkdirSync(path, { recursive: true })
    db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run(id, name, path, kind, sector, at)
  }
  ensureMoneyTables(db)
  const sheets = standInSheets()
  const pushed: unknown[] = []
  const converted: ConvertJob[] = []
  const lines = new Map<string, ReceiptLine[]>()
  const blocks = new Map<string, { page: number; bbox: [number, number, number, number]; text: string }[]>()
  const out = { readerDown: false }
  let jobs = 0
  // The conversion runner, standing in: a picture's lines from `lines`, a PDF's text from `blocks`, a page or a JPEG as a copy of the input.
  const convert = async (job: ConvertJob): Promise<ConvertResult> => {
    converted.push(job)
    if (out.readerDown) throw new Error('No host in reach has the reader.')
    const dir = join(root, 'data', 'jobs', String(++jobs))
    mkdirSync(dir, { recursive: true })
    const output = join(dir, `out.${job.to === 'lines' || job.to === 'extract' ? 'json' : job.to}`)
    // A page drawn from a PDF keeps its name, so the stand-in reader finds its lines by it.
    const name = basename(job.input) === 'out.png' || basename(job.input) === 'out.jpg' ? (drawnFrom.get(job.input) ?? basename(job.input)) : basename(job.input)
    if (job.to === 'lines') writeFileSync(output, JSON.stringify(lines.get(name) ?? []))
    else if (job.to === 'extract') writeFileSync(output, JSON.stringify({ pages: 1, sizes: [], blocks: blocks.get(name) ?? [], tables: [], warnings: [] }))
    else {
      copyFileSync(job.input, output)
      drawnFrom.set(output, name)
    }
    return { output, ranOn: 'env_box', warnings: [] }
  }
  const drawnFrom = new Map<string, string>()
  const lifeos: Bench['lifeos'] = { events: [], down: false, connected: true, asked: [] }
  const ctx = {
    db,
    host: 'env_box',
    dataDir: join(root, 'data'),
    log: () => {},
    enabled: () => true,
    push: (p: unknown) => void pushed.push(p),
    reaches: (by: Caller, path: string) => by.kind !== 'remote' || path.startsWith(join(root, 'managed')),
    scopeOf: (sessionId: string) => (sessionId === 't-ref' ? { sessionId, workspaceId: 'ws-ref', sector: 'ref' } : sessionId === 't-purdue' ? { sessionId, workspaceId: 'ws-purdue', sector: 'purdue' } : null),
    service: { internal: sheets.internal },
    convert,
    lifeos: {
      connected: () => lifeos.connected,
      owner: () => ({
        query: async (fn: string, args: Record<string, unknown>) => {
          lifeos.asked.push({ fn, args })
          if (lifeos.down) throw new Error('LifeOS did not answer')
          return lifeos.events
        },
        mutation: async (fn: string) => {
          throw new Error(`Money writes nothing to LifeOS (${fn})`)
        }
      })
    },
    canvas: { get: () => null, paneOf: (id: string) => id }
  } as unknown as WorkCtx
  return {
    db,
    root,
    sheets,
    ctx,
    pushed,
    converted,
    lines,
    blocks,
    lifeos,
    get readerDown() {
      return out.readerDown
    },
    set readerDown(v: boolean) {
      out.readerDown = v
    },
    ref,
    purdue
  }
}

export const req = (method: string, params: unknown): ClientRequest => ({ id: '1', method, params }) as ClientRequest
