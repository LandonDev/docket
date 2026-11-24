import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from './db'
import { ensureOutboxTables } from './work/outbox/store'
import { ensureFilesTables } from './work/files/tables'

/**
 * The queries Work makes of tables that grow with every thread, held act and deleted file are answered by an index,
 * never a scan of the whole table (the Work performance pass, docs/agents/work-perf.md). Each is the SQL its caller
 * runs: routines/host.ts `treeOf` and `threadOfRun`, review/gather/threads.ts `scanThreads`, outbox/store.ts
 * `decidedSince` and `owedTasks`, files/word.ts's trash look.
 */
describe("Work's queries are searches, not scans", () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  const plan = (sql: string, ...args: (string | number)[]): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail).join(' | ')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-work-indexes-'))
    db = openDb(join(dir, 'test.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("a thread's tree walks its children by parent", () => {
    const got = plan(`WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT s.id FROM sessions s JOIN tree t ON s.parent_id = t.id) SELECT id FROM tree`, 'a')
    expect(got).toContain('sessions_parent')
    expect(got).not.toMatch(/SCAN s\b(?! USING)/)
  })

  it("a routine run's thread is found by its run", () => {
    const got = plan(`SELECT id FROM sessions WHERE routine_run_id = ? LIMIT 1`, 'run')
    expect(got).toMatch(/SEARCH sessions USING (COVERING )?INDEX sessions_routine_run/)
  })

  it("the weekly review reads Work's threads alone", () => {
    const got = plan(`SELECT id, parent_id, workspace_id, cold, routine_run_id, master_id, started_by, status, created_at, updated_at FROM sessions WHERE scope = 'work'`)
    expect(got).toMatch(/SEARCH sessions USING INDEX sessions_work_scope/)
  })

  it('what was decided of one kind in one job, and the tasks owed, are searches of the held table', () => {
    ensureOutboxTables(db)
    const decided = plan(`SELECT * FROM work_held_acts WHERE kind = ? AND workspace_id = ? AND decided_at IS NOT NULL AND decided_at >= ? ORDER BY decided_at DESC, rowid DESC LIMIT ?`, 'mail.send', 'ws', 0, 500)
    expect(decided).toMatch(/SEARCH work_held_acts USING INDEX work_held_acts_decided/)
    const owed = plan(`SELECT * FROM work_held_acts WHERE task = 'owed' ORDER BY rowid ASC LIMIT 50`)
    expect(owed).toMatch(/SEARCH work_held_acts USING INDEX work_held_acts_owed/)
  })

  it('a deleted document is looked for by where it was', () => {
    ensureFilesTables(db)
    expect(plan(`SELECT 1 FROM work_files_trash WHERE was_at = ? LIMIT 1`, '/w/a.tcdoc')).toMatch(/SEARCH work_files_trash USING COVERING INDEX work_files_trash_by_was/)
  })
})
