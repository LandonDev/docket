import type { DatabaseSync } from 'node:sqlite'
import { lifeosAddress } from '../lifeos/ctx'
import type { WorkCtx } from '../modules'
import { GoogleApi, GoogleTokens, tokenUrlOf } from './client'
import { serviceBlocks, type BlocksOf } from './docs'
import type { DocBase } from './write'

/**
 * What every part of the pillar shares (docs/agents/work-google.md): one
 * token holder per host, the files this host has read from Google, and the
 * `fetch` all of it goes through (the fake's, in tests).
 */

export function ensureGoogleTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_google_files (
    account TEXT NOT NULL,
    file_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    version TEXT,
    ours TEXT,
    behind TEXT,
    mirror TEXT,
    base TEXT,
    PRIMARY KEY (account, file_id)
  )`)
  // The shares his press let through, by the thread that asked: only that thread's tree may take one back.
  db.exec(`CREATE TABLE IF NOT EXISTS work_google_shares (
    account TEXT NOT NULL,
    file_id TEXT NOT NULL,
    permission_id TEXT NOT NULL,
    session_id TEXT,
    PRIMARY KEY (account, file_id, permission_id)
  )`)
}

export interface FileRow {
  account: string
  fileId: string
  kind: 'doc' | 'sheet' | 'slides'
  name: string
  /** Drive's version when this host last read or wrote the file */
  version: string | null
  /** the version this host's own last write made: a poll that finds it is not someone else's change */
  ours?: string | null
  /** set when Google moved while his edits waited in the mirror */
  behind: string | null
  mirror: string | null
  base: DocBase | null
}

interface Raw {
  account: string
  file_id: string
  kind: FileRow['kind']
  name: string
  version: string | null
  ours: string | null
  behind: string | null
  mirror: string | null
  base: string | null
}

export class GoogleFiles {
  constructor(private db: DatabaseSync) {}

  get(account: string, fileId: string): FileRow | null {
    const r = this.db.prepare('SELECT * FROM work_google_files WHERE account = ? AND file_id = ?').get(account.toLowerCase(), fileId) as Raw | undefined
    return r ? { account: r.account, fileId: r.file_id, kind: r.kind, name: r.name, version: r.version, ours: r.ours, behind: r.behind, mirror: r.mirror, base: r.base ? (JSON.parse(r.base) as DocBase) : null } : null
  }

  put(row: FileRow): void {
    this.db
      .prepare('INSERT OR REPLACE INTO work_google_files (account, file_id, kind, name, version, ours, behind, mirror, base) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.account.toLowerCase(), row.fileId, row.kind, row.name, row.version, row.ours ?? null, row.behind, row.mirror, row.base ? JSON.stringify(row.base) : null)
  }

  update(account: string, fileId: string, patch: Partial<Pick<FileRow, 'version' | 'ours' | 'behind' | 'base' | 'name'>>): void {
    const row = this.get(account, fileId)
    if (row) this.put({ ...row, ...patch })
  }

  all(): FileRow[] {
    const rows = this.db.prepare('SELECT account, file_id FROM work_google_files').all() as { account: string; file_id: string }[]
    return rows.map((r) => this.get(r.account, r.file_id)!).filter(Boolean)
  }
}

export interface Google {
  fetch: typeof fetch
  tokens: GoogleTokens
  api(account: string): GoogleApi
  files: GoogleFiles
  blocksOf: BlocksOf
}

export interface GoogleDeps {
  fetch?: typeof fetch
  tokenUrl?: string
  blocksOf?: BlocksOf
}

let depsFor: GoogleDeps = {}
let made = new WeakMap<WorkCtx['db'], Google>()

/** A test hands its fake's fetch and token address, and the mirror's blocks. */
export function setGoogleDeps(deps: GoogleDeps): void {
  depsFor = deps
}

/** This host's Google, made once per database. */
export function googleOf(ctx: WorkCtx): Google {
  const hit = made.get(ctx.db)
  if (hit) return hit
  const f = depsFor.fetch ?? fetch
  const tokens = new GoogleTokens({ fetch: f, tokenUrl: depsFor.tokenUrl ?? tokenUrlOf(lifeosAddress().mcpUrl), jwt: () => ctx.lifeos.jwt() })
  const apis = new Map<string, GoogleApi>()
  const g: Google = {
    fetch: f,
    tokens,
    api: (account) => {
      const key = account.toLowerCase()
      let api = apis.get(key)
      if (!api) apis.set(key, (api = new GoogleApi(tokens, key, { fetch: f })))
      return api
    },
    files: new GoogleFiles(ctx.db),
    blocksOf: depsFor.blocksOf ?? serviceBlocks
  }
  made.set(ctx.db, g)
  return g
}

/** Forgets every host's Google (a test between cases). */
export function resetGoogle(): void {
  depsFor = {}
  made = new WeakMap()
}
