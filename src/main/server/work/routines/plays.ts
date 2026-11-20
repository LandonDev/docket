import type { DatabaseSync } from 'node:sqlite'
import { nanoid } from 'nanoid'
import { PLAY_TAKES, type PlayRow, type PlayTake } from '@shared/contract-work-routines'

/**
 * A workspace's plays (docs/agents/work-plays.md): saved work he starts by
 * hand. One row each; a proposal is a row with `proposed = 1` until he adds
 * it. A play holds no state of a run: the threads it started are ordinary
 * Work threads and stay when it goes.
 */

export const PLAYS_TABLE = 'work_routines_plays'

export function ensurePlayTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PLAYS_TABLE} (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      name          TEXT NOT NULL,
      instructions  TEXT NOT NULL,
      takes         TEXT NOT NULL DEFAULT '[]',
      proposed      INTEGER NOT NULL DEFAULT 0,
      made_in       TEXT,
      starter       TEXT,
      created_by    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS work_routines_plays_workspace ON ${PLAYS_TABLE}(workspace_id);
  `)
}

export type Play = Omit<PlayRow, 'host'>

type Row = Record<string, string | number | null>

const takesOf = (text: unknown): PlayTake[] => {
  try {
    const parsed = JSON.parse(String(text)) as unknown
    return Array.isArray(parsed) ? PLAY_TAKES.filter((t) => parsed.includes(t)) : []
  } catch {
    return []
  }
}

const playOf = (r: Row): Play => ({
  id: String(r.id),
  workspaceId: String(r.workspace_id),
  name: String(r.name),
  instructions: String(r.instructions),
  takes: takesOf(r.takes),
  proposed: r.proposed === 1,
  madeIn: (r.made_in as string | null) ?? null,
  starter: (r.starter as string | null) ?? null,
  createdBy: r.created_by === 'model' ? 'model' : 'owner',
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at)
})

export interface NewPlay {
  workspaceId: string
  name: string
  instructions: string
  takes: readonly PlayTake[]
  proposed?: boolean
  madeIn?: string | null
  starter?: string | null
  createdBy: 'owner' | 'model'
}

export class PlayStore {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): Play | null {
    const row = this.db.prepare(`SELECT * FROM ${PLAYS_TABLE} WHERE id = ?`).get(id) as Row | undefined
    return row ? playOf(row) : null
  }

  /** Proposals first, then by name. */
  list(workspaceId: string): Play[] {
    const rows = this.db.prepare(`SELECT * FROM ${PLAYS_TABLE} WHERE workspace_id = ? ORDER BY proposed DESC, name COLLATE NOCASE, created_at`).all(workspaceId) as Row[]
    return rows.map(playOf)
  }

  create(n: NewPlay, now: number): Play {
    const id = nanoid(12)
    this.db
      .prepare(
        `INSERT INTO ${PLAYS_TABLE} (id, workspace_id, name, instructions, takes, proposed, made_in, starter, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, n.workspaceId, n.name, n.instructions, JSON.stringify(n.takes), n.proposed ? 1 : 0, n.madeIn ?? null, n.starter ?? null, n.createdBy, now, now)
    return this.get(id)!
  }

  /** His edit, or his Add on a proposal: either way it is a play of his now. */
  update(id: string, n: Pick<NewPlay, 'name' | 'instructions' | 'takes'>, now: number): Play | null {
    this.db
      .prepare(`UPDATE ${PLAYS_TABLE} SET name = ?, instructions = ?, takes = ?, proposed = 0, updated_at = ? WHERE id = ?`)
      .run(n.name, n.instructions, JSON.stringify(n.takes), now, id)
    return this.get(id)
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM ${PLAYS_TABLE} WHERE id = ?`).run(id)
  }

  removeWorkspace(workspaceId: string): void {
    this.db.prepare(`DELETE FROM ${PLAYS_TABLE} WHERE workspace_id = ?`).run(workspaceId)
  }

  /** A play, proposed or not, already named this in the workspace (letter case aside). */
  named(workspaceId: string, name: string): Play | null {
    const row = this.db.prepare(`SELECT * FROM ${PLAYS_TABLE} WHERE workspace_id = ? AND name = ? COLLATE NOCASE LIMIT 1`).get(workspaceId, name.trim()) as Row | undefined
    return row ? playOf(row) : null
  }
}
